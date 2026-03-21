interface Env {
  LOADER: any;
}

const files: Record<string, string> = {
  "url-import.js": `
import { z } from "https://esm.sh/zod@3.24.1";

export default async function () {
  const schema = z.object({ name: z.string() });
  return schema.parse({ name: "url-import-ok" });
}
`,
  "bare-import.js": `
import { z } from "zod";

export default async function () {
  const schema = z.object({ name: z.string() });
  return schema.parse({ name: "bare-import-ok" });
}
`,
  "relative-main.js": `
import { value } from "./relative-dep.js";

export default async function () {
  return { value };
}
`,
  "relative-dep.js": `
export const value = "relative-import-ok";
`,
};

const ENTRYPOINT_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import userModule from "./user-code.js";

export class Runner extends WorkerEntrypoint {
  async run() {
    if (typeof userModule === "function") return await userModule();
    if (typeof userModule?.default === "function") return await userModule.default();
    throw new Error("user-code.js must export a default function");
  }
}

export default { fetch() { return new Response("ok"); } };
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

async function buildModules(entryFile: string) {
  const modules: Record<string, string> = { "main.js": ENTRYPOINT_SOURCE };
  const seen = new Map<string, string>();
  let counter = 0;

  async function load(specifier: string, parent: { kind: "local"; id: string } | { kind: "remote"; url: string } | null): Promise<string> {
    let kind: "local" | "remote";
    let sourceKey: string;
    let code: string;
    let remoteUrl: string | undefined;

    const isRemote = specifier.startsWith("http://") || specifier.startsWith("https://");
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");

    if (!parent) {
      kind = "local";
      sourceKey = normalizeLocalPath(specifier);
      code = files[sourceKey];
      if (code == null) throw new Error(`File not found: ${specifier}`);
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
        code = files[sourceKey];
        if (code == null) throw new Error(`File not found: ${specifier} (resolved to ${sourceKey})`);
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

  const entryModuleId = await load(entryFile, null);
  modules["user-code.js"] = `export { default } from "./${entryModuleId}";`;
  return modules;
}

async function runInLoader(loader: any, file: string) {
  const modules = await buildModules(file);
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stub = loader.get(`sandbox-${id}`, () => ({
    compatibilityDate: "2025-06-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "main.js",
    modules,
  }));
  const runner = stub.getEntrypoint("Runner");
  return runner.run();
}

async function exec(loader: any, file: string) {
  try {
    const result = await runInLoader(loader, file);
    return { ok: true, result };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ endpoints: ["/url-import", "/bare-import", "/relative-import"] });
    }
    if (url.pathname === "/url-import") return Response.json(await exec(env.LOADER, "url-import.js"));
    if (url.pathname === "/bare-import") return Response.json(await exec(env.LOADER, "bare-import.js"));
    if (url.pathname === "/relative-import") return Response.json(await exec(env.LOADER, "relative-main.js"));
    return new Response("Not found", { status: 404 });
  },
};
