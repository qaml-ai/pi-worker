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
	/** R2 bucket for reading script files. Required if you want file execution. */
	bucket?: R2Bucket;
	/** Custom tool name. Default: "execute" */
	name?: string;
	/** Custom tool description. Auto-generated from helper names if not provided. */
	description?: string;
	/** Timeout in ms. Default: 60000 (60s). */
	timeout?: number;
}

// The entrypoint module — imports user code as a separate module and calls it.
// This avoids string interpolation of user code into the module source.
const ENTRYPOINT_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import userModule from "./user-code.js";

export class Runner extends WorkerEntrypoint {
  async run(helpers) {
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
		`\n\nFor inline code: write the body of an async function. Use 'return' for results.\n` +
		`For file execution: pass a path to a script in R2 that exports a default async function receiving { ${helperNames.join(", ")} }.`;

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

			if (file) {
				if (!options?.bucket) throw new Error("R2 bucket required for file execution");
				const key = file.replace(/^\/+/, "");
				const obj = await options.bucket.get(key);
				if (!obj) throw new Error(`File not found: ${file}`);
				userCode = await obj.text();
				// If the file doesn't have an export, wrap it
				if (!userCode.includes("export")) {
					userCode = wrapInlineCode(userCode, helperNames);
				}
			} else if (code) {
				userCode = wrapInlineCode(code, helperNames);
			} else {
				throw new Error("Provide either 'code' (inline) or 'file' (R2 path)");
			}

			const id = `exec-${++callCount}-${Date.now()}`;

			try {
				const stub = loader.get(`sandbox-${id}`, () => ({
					compatibilityDate: "2025-06-01",
					compatibilityFlags: ["nodejs_compat"],
					mainModule: "main.js",
					modules: {
						"main.js": ENTRYPOINT_SOURCE,
						"user-code.js": userCode,
					},
					globalOutbound: null,
					env: {},
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
