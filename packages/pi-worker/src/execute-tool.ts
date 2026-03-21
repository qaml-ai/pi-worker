/**
 * Generic code execution tool using Dynamic Worker Loaders.
 *
 * User code is loaded as a separate ES module (not string-interpolated
 * into the entrypoint), avoiding issues with backticks, template
 * literals, and escape sequences.
 *
 * @example
 * ```ts
 * const execute = createExecuteTool(env.LOADER, {
 *   ffmpeg: async (args: string) => { ... },
 *   ffprobe: async (path: string) => { ... },
 * });
 * ```
 */

import { Type, type Static } from "@sinclair/typebox";

export type ExecuteToolHelpers = Record<string, (...args: any[]) => Promise<any>>;

interface WorkerLoader {
	get(id: string, cb: () => any): { getEntrypoint(name: string): any };
}

const executeSchema = Type.Object({
	code: Type.Optional(Type.String({
		description: "Inline JavaScript to execute. Write the body of an async function — helper functions are available as globals. Use 'return' for results.",
	})),
	file: Type.Optional(Type.String({
		description: "Path to a .js/.ts file in R2 to execute. The file should export a default async function that receives the helpers object.",
	})),
});

export interface ExecuteToolOptions {
	/** R2 bucket for reading script files. Optional if readFile is provided. */
	bucket?: R2Bucket;
	/** Custom file reader for script files (e.g. SQLite-backed filesystem). */
	readFile?: (path: string) => Promise<string | undefined>;
	/** Custom tool name. Default: "execute" */
	name?: string;
	/** Custom tool description. Auto-generated from helper names if not provided. */
	description?: string;
	/** Timeout in ms. Default: 60000 (60s). */
	timeout?: number;
	/** Optional service binding to use as the sandbox's global outbound implementation. */
	globalOutbound?: any;
	/** Optional explicit outbound binding injected into env and used to shim global fetch(). */
	outboundBinding?: any;
}

// The entrypoint module — imports user code as a separate module and calls it.
// This avoids string interpolation of user code into the module source.
const ENTRYPOINT_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import userModule from "./user-code.js";

export class Runner extends WorkerEntrypoint {
  async run(helpers) {
    if (this.env?.OUTBOUND?.fetch) {
      globalThis.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return this.env.OUTBOUND.fetch(request);
      };
    }

    if (typeof userModule === "function") {
      return await userModule(helpers);
    }
    if (typeof userModule?.default === "function") {
      return await userModule.default(helpers);
    }
    throw new Error("user-code.js must export a default function");
  }
}

export default { fetch() { return new Response("executor"); } };
`;

/**
 * Wrap inline code (async function body) into a module that exports
 * a default function receiving helpers.
 */
function wrapInlineCode(code: string, helperNames: string[]): string {
	const destructure = helperNames.join(", ");
	return `export default async function({ ${destructure} }) {\n${code}\n}`;
}

const IMPORT_RE = /(import\s+(?:[^"'`]+?\s+from\s+)?|export\s+[^"'`]+?\s+from\s+)(["'])([^"']+)(\2)/g;
const MODULE_SYNTAX_RE = /^\s*(import\s|export\s)/m;

function normalizeLocalPath(path: string): string {
	return path.replace(/^\/+/, "").replace(/\/\/+/g, "/");
}

function dirname(path: string): string {
	const normalized = normalizeLocalPath(path);
	const idx = normalized.lastIndexOf("/");
	return idx === -1 ? "" : normalized.slice(0, idx + 1);
}

function resolveRelative(specifier: string, parentId: string): string {
	const base = dirname(parentId);
	const raw = `${base}${specifier}`.replace(/\/\/+/g, "/");
	const parts = raw.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

function resolveRemote(specifier: string, parentUrl: string): string {
	return new URL(specifier, parentUrl).toString();
}

function esmUrl(specifier: string): string {
	return `https://esm.sh/${specifier}?bundle&target=es2022`;
}

async function fetchText(url: string): Promise<{ code: string; url: string }> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
	return { code: await response.text(), url: response.url || url };
}

async function readLocalFile(path: string, options?: ExecuteToolOptions): Promise<string | undefined> {
	if (options?.readFile) return options.readFile(path);
	if (!options?.bucket) return undefined;
	const obj = await options.bucket.get(path);
	return obj ? obj.text() : undefined;
}

async function buildModules(entryFile: string, entryCode: string, options: ExecuteToolOptions | undefined) {
	const modules: Record<string, string> = { "main.js": ENTRYPOINT_SOURCE };
	const seen = new Map<string, string>();
	let counter = 0;

	async function load(
		specifier: string,
		parent: { kind: "local"; id: string } | { kind: "remote"; url: string } | null,
		inlineCode?: string,
	): Promise<string> {
		let kind: "local" | "remote";
		let sourceKey: string;
		let code: string;
		let remoteUrl: string | undefined;

		const isRemote = specifier.startsWith("http://") || specifier.startsWith("https://");
		const isRelative = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");

		if (!parent) {
			kind = "local";
			sourceKey = normalizeLocalPath(specifier);
			code = inlineCode ?? await readLocalFile(sourceKey, options) ?? "";
			if (!code) throw new Error(`File not found: ${specifier}`);
		} else if (isRemote) {
			kind = "remote";
			const fetched = await fetchText(specifier);
			sourceKey = fetched.url;
			code = fetched.code;
			remoteUrl = fetched.url;
		} else if (parent.kind === "remote") {
			const target = isRelative ? resolveRemote(specifier, parent.url) : esmUrl(specifier);
			kind = "remote";
			const fetched = await fetchText(target);
			sourceKey = fetched.url;
			code = fetched.code;
			remoteUrl = fetched.url;
		} else {
			if (isRelative) {
				kind = "local";
				sourceKey = resolveRelative(specifier, parent.id);
				const local = await readLocalFile(sourceKey, options);
				if (local == null) throw new Error(`File not found: ${specifier} (resolved to ${sourceKey})`);
				code = local;
			} else {
				kind = "remote";
				const fetched = await fetchText(esmUrl(specifier));
				sourceKey = fetched.url;
				code = fetched.code;
				remoteUrl = fetched.url;
			}
		}

		if (seen.has(sourceKey)) return seen.get(sourceKey)!;

		const moduleId = `dep-${++counter}.js`;
		seen.set(sourceKey, moduleId);

		let transformed = "";
		let lastIndex = 0;
		for (const match of code.matchAll(IMPORT_RE)) {
			const full = match[0];
			const dep = match[3];
			const start = match.index ?? 0;
			transformed += code.slice(lastIndex, start);
			const depModuleId = await load(dep, kind === "remote" ? { kind: "remote", url: remoteUrl! } : { kind: "local", id: sourceKey });
			transformed += full.replace(dep, `./${depModuleId}`);
			lastIndex = start + full.length;
		}
		transformed += code.slice(lastIndex);

		modules[moduleId] = transformed;
		return moduleId;
	}

	const entryModuleId = await load(entryFile, null, entryCode);
	modules["user-code.js"] = `export { default } from "./${entryModuleId}";`;
	return modules;
}

export function createExecuteTool(
	loader: WorkerLoader,
	helpers: ExecuteToolHelpers,
	options?: ExecuteToolOptions,
) {
	let callCount = 0;
	const helperNames = Object.keys(helpers);
	const timeoutMs = options?.timeout ?? 60_000;

	const defaultDescription =
		`Execute JavaScript code in an isolated V8 sandbox.\n\n` +
		`Available functions in your code:\n` +
		helperNames.map((n) => `- ${n}()`).join("\n") +
		`\n\nFor inline code: either write the body of an async function and use 'return' for results, or provide a full ES module when using import/export syntax.\n` +
		`Inline module mode requires an explicit export default async function receiving { ${helperNames.join(", ")} }.\n` +
		`For file execution: pass a path to a script in the agent filesystem that exports a default async function receiving { ${helperNames.join(", ")} }.\n` +
		`File-based execution supports relative imports from the agent filesystem, direct URL imports, and bare package imports resolved through esm.sh.`;

	return {
		name: options?.name ?? ("execute" as const),
		label: options?.name ?? "execute",
		description: options?.description ?? defaultDescription,
		parameters: executeSchema,
		execute: async (
			_id: string,
			{ code, file }: Static<typeof executeSchema>,
		) => {
			let userCode: string;
			let entryFile: string;

			if (file) {
				const key = normalizeLocalPath(file);
				const content = await readLocalFile(key, options);
				if (content === undefined) throw new Error(`File not found: ${file}`);
				userCode = content;
				entryFile = key;
				if (!userCode.includes("export")) {
					userCode = wrapInlineCode(userCode, helperNames);
				}
			} else if (code) {
				userCode = MODULE_SYNTAX_RE.test(code)
					? code
					: wrapInlineCode(code, helperNames);
				entryFile = "inline-entry.js";
			} else {
				throw new Error("Provide either 'code' (inline) or 'file' (filesystem path)");
			}

			const id = `exec-${++callCount}-${Date.now()}`;

			try {
				const modules = await buildModules(entryFile, userCode, options);
				const stub = loader.get(`sandbox-${id}`, () => ({
					compatibilityDate: "2025-06-01",
					compatibilityFlags: ["nodejs_compat"],
					mainModule: "main.js",
					modules,
					...(options?.globalOutbound ? { globalOutbound: options.globalOutbound } : {}),
					env: {
						...(options?.outboundBinding ? { OUTBOUND: options.outboundBinding } : {}),
					},
				}));

				const runner = stub.getEntrypoint("Runner");

				// Run with timeout
				const result = await Promise.race([
					runner.run(helpers),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs),
					),
				]);

				const output = typeof result === "string"
					? result
					: JSON.stringify(result, null, 2);

				return {
					content: [{ type: "text" as const, text: output ?? "(no return value)" }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Execution error: ${err.message}` }],
					details: {},
				};
			}
		},
	};
}
