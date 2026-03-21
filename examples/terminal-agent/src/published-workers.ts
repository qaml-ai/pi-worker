import { Type, type Static } from "@sinclair/typebox";
import { sanitizePath } from "pi-worker";

export interface PublishedWorkerFileStore {
	get(path: string): Promise<string | undefined>;
	list(): Promise<string[]>;
	getUpdatedAt(path: string): Promise<number | undefined>;
}

interface WorkerLoader {
	get(id: string, cb: () => any): { getEntrypoint(name: string): { run(request: Request): Promise<Response> } };
}

export interface PublishedWorkerRouteStore {
	put(name: string, file: string): Promise<void>;
	get(name: string): Promise<{ name: string; file: string; updatedAt: number } | undefined>;
	delete(name: string): Promise<boolean>;
	list(): Promise<Array<{ name: string; file: string; updatedAt: number }>>;
}

export interface PublishedWorkerCacheEntry {
	version: string;
	modules: Record<string, string>;
	loaderId: string;
	publishedUpdatedAt: number;
	localDependencies: Array<{ path: string; updatedAt: number }>;
	remoteDependencies: string[];
}

export interface PublishedWorkerEnv {
	loader: WorkerLoader;
	fileStore: PublishedWorkerFileStore;
	routeStore: PublishedWorkerRouteStore;
	sessionId: string;
	outbound?: any;
	cache?: {
		get(key: string): PublishedWorkerCacheEntry | undefined;
		put(key: string, entry: PublishedWorkerCacheEntry): void;
		delete(key: string): void;
	};
}

const publishWorkerSchema = Type.Object({
	name: Type.String({ description: "Public worker name. Used at /w/<session>/<name>. Letters, numbers, '-', '_' only." }),
	file: Type.String({ description: "Path to the worker source file in the agent filesystem." }),
});

const unpublishWorkerSchema = Type.Object({
	name: Type.String({ description: "Previously published worker name." }),
});

const listWorkersSchema = Type.Object({});

const HTTP_ENTRYPOINT_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import userModule from "./user-code.js";

function pickHandler(mod) {
  if (typeof mod === "function") return mod;
  if (mod && typeof mod.fetch === "function") return mod.fetch.bind(mod);
  if (mod?.default) return pickHandler(mod.default);
  return null;
}

export class Runner extends WorkerEntrypoint {
  async run(request) {
    if (this.env?.OUTBOUND?.fetch) {
      globalThis.fetch = (input, init) => {
        const forwarded = input instanceof Request ? input : new Request(input, init);
        return this.env.OUTBOUND.fetch(forwarded);
      };
    }

    const handler = pickHandler(userModule);
    if (!handler) {
      throw new Error("Published worker must export either a default fetch handler function or default { fetch() {} }");
    }

    const response = await handler(request, this.env, this.ctx);
    if (response instanceof Response) return response;
    if (typeof response === "string") return new Response(response);
    return Response.json(response ?? null);
  }
}

export default { fetch() { return new Response("published-worker"); } };
`;

const IMPORT_RE = /(import\s+(?:[^"'`]+?\s+from\s+)?|export\s+[^"'`]+?\s+from\s+)(["'])([^"']+)(\2)/g;

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

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function computeVersion(input: {
	publishedUpdatedAt: number;
	entryFile: string;
	localDependencies: Array<{ path: string; updatedAt: number }>;
	remoteDependencies: string[];
}) {
	return sha256Hex(JSON.stringify(input));
}

async function isCacheEntryFresh(
	cacheEntry: PublishedWorkerCacheEntry,
	publishedUpdatedAt: number,
	fileStore: PublishedWorkerFileStore,
): Promise<boolean> {
	if (cacheEntry.publishedUpdatedAt !== publishedUpdatedAt) return false;
	for (const dependency of cacheEntry.localDependencies) {
		if ((await fileStore.getUpdatedAt(dependency.path)) !== dependency.updatedAt) return false;
	}
	return true;
}

async function buildModules(entryFile: string, entryCode: string, fileStore: PublishedWorkerFileStore) {
	const modules: Record<string, string> = { "main.js": HTTP_ENTRYPOINT_SOURCE };
	const seen = new Map<string, string>();
	const localDependencies = new Map<string, number>();
	const remoteDependencies = new Set<string>();
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
			code = inlineCode ?? await fileStore.get(sourceKey) ?? "";
			if (!code) throw new Error(`File not found: ${specifier}`);
			localDependencies.set(sourceKey, await fileStore.getUpdatedAt(sourceKey) ?? 0);
		} else if (isRemote) {
			kind = "remote";
			const fetched = await fetchText(specifier);
			sourceKey = fetched.url;
			code = fetched.code;
			remoteUrl = fetched.url;
			remoteDependencies.add(fetched.url);
		} else if (parent.kind === "remote") {
			const target = isRelative ? resolveRemote(specifier, parent.url) : esmUrl(specifier);
			kind = "remote";
			const fetched = await fetchText(target);
			sourceKey = fetched.url;
			code = fetched.code;
			remoteUrl = fetched.url;
			remoteDependencies.add(fetched.url);
		} else {
			if (isRelative) {
				kind = "local";
				sourceKey = resolveRelative(specifier, parent.id);
				const local = await fileStore.get(sourceKey);
				if (local == null) throw new Error(`File not found: ${specifier} (resolved to ${sourceKey})`);
				code = local;
				localDependencies.set(sourceKey, await fileStore.getUpdatedAt(sourceKey) ?? 0);
			} else {
				kind = "remote";
				const fetched = await fetchText(esmUrl(specifier));
				sourceKey = fetched.url;
				code = fetched.code;
				remoteUrl = fetched.url;
				remoteDependencies.add(fetched.url);
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
	modules["user-code.js"] = `export { default } from "./${entryModuleId}"; export * from "./${entryModuleId}";`;
	return {
		modules,
		localDependencies: [...localDependencies.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([path, updatedAt]) => ({ path, updatedAt })),
		remoteDependencies: [...remoteDependencies].sort(),
	};
}

function sanitizeWorkerName(name: string): string {
	const normalized = String(name).trim();
	if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
		throw new Error("Worker name must contain only letters, numbers, '-' and '_' characters");
	}
	return normalized;
}

export function createPublishedWorkerTools(env: PublishedWorkerEnv) {
	return [
		{
			name: "publish_worker" as const,
			label: "publish_worker",
			description: "Expose a filesystem-backed Cloudflare Worker at /w/<session>/<name>. The target file must export a default fetch handler function or default { fetch() {} }.",
			parameters: publishWorkerSchema,
			execute: async (_id: string, { name, file }: Static<typeof publishWorkerSchema>) => {
				const workerName = sanitizeWorkerName(name);
				const workerFile = sanitizePath(file);
				const content = await env.fileStore.get(workerFile);
				if (content == null) throw new Error(`File not found: ${file}`);
				await env.routeStore.put(workerName, workerFile);
				return {
					content: [{ type: "text" as const, text: `Published ${workerFile} at /w/${env.sessionId}/${workerName}` }],
					details: { name: workerName, file: workerFile, path: `/w/${env.sessionId}/${workerName}` },
				};
			},
		},
		{
			name: "unpublish_worker" as const,
			label: "unpublish_worker",
			description: "Remove a previously published worker endpoint.",
			parameters: unpublishWorkerSchema,
			execute: async (_id: string, { name }: Static<typeof unpublishWorkerSchema>) => {
				const workerName = sanitizeWorkerName(name);
				env.cache?.delete(workerName);
				const existed = await env.routeStore.delete(workerName);
				return {
					content: [{ type: "text" as const, text: existed ? `Unpublished /w/${env.sessionId}/${workerName}` : `No published worker named ${workerName}` }],
					details: { existed },
				};
			},
		},
		{
			name: "list_workers" as const,
			label: "list_workers",
			description: "List published worker endpoints for this session.",
			parameters: listWorkersSchema,
			execute: async () => {
				const workers = await env.routeStore.list();
				const text = workers.length === 0
					? "(no published workers)"
					: workers.map((worker) => `${worker.name} -> ${worker.file} -> /w/${env.sessionId}/${worker.name}`).join("\n");
				return { content: [{ type: "text" as const, text }], details: { workers } };
			},
		},
	];
}

export async function dispatchPublishedWorker(
	env: PublishedWorkerEnv,
	name: string,
	request: Request,
	workerPathname: string,
): Promise<Response> {
	const workerName = sanitizeWorkerName(name);
	const published = await env.routeStore.get(workerName);
	if (!published) {
		return Response.json({ error: `No published worker named ${workerName}` }, { status: 404 });
	}

	const entryCode = await env.fileStore.get(published.file);
	if (entryCode == null) {
		env.cache?.delete(workerName);
		return Response.json({ error: `Published file is missing: ${published.file}` }, { status: 404 });
	}

	let cacheEntry = env.cache?.get(workerName);
	if (!cacheEntry || !(await isCacheEntryFresh(cacheEntry, published.updatedAt, env.fileStore))) {
		const built = await buildModules(published.file, entryCode, env.fileStore);
		const version = await computeVersion({
			publishedUpdatedAt: published.updatedAt,
			entryFile: published.file,
			localDependencies: built.localDependencies,
			remoteDependencies: built.remoteDependencies,
		});
		cacheEntry = {
			version,
			modules: built.modules,
			loaderId: `published-${env.sessionId}-${workerName}-${version}`,
			publishedUpdatedAt: published.updatedAt,
			localDependencies: built.localDependencies,
			remoteDependencies: built.remoteDependencies,
		};
		env.cache?.put(workerName, cacheEntry);
	}

	const stub = env.loader.get(cacheEntry.loaderId, () => ({
		compatibilityDate: "2025-06-01",
		compatibilityFlags: ["nodejs_compat"],
		mainModule: "main.js",
		modules: cacheEntry.modules,
		...(env.outbound ? { globalOutbound: env.outbound } : {}),
		env: {
			...(env.outbound ? { OUTBOUND: env.outbound } : {}),
		},
	}));

	const runner = stub.getEntrypoint("Runner");
	const forwardedUrl = new URL(request.url);
	forwardedUrl.pathname = workerPathname || "/";
	const forwarded = new Request(forwardedUrl, request);
	return runner.run(forwarded);
}
