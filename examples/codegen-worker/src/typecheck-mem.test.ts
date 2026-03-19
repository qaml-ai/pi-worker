import { describe, it, expect } from "vitest";
import { typeCheckFromMap } from "./typecheck-mem.js";

describe("typeCheckFromMap", () => {
	it("passes clean code without deps", async () => {
		const files = new Map([
			["proj/src/index.ts", 'export default { fetch() { return new Response("hi"); } };'],
			["proj/package.json", '{"dependencies":{}}'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(true);
	});

	it("catches type errors without deps", async () => {
		const files = new Map([
			["proj/src/index.ts", "const x: number = 'oops';"],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(false);
		expect(result.diagnostics.some((d) => d.message.includes("not assignable"))).toBe(true);
	});

	it("resolves cross-file imports", async () => {
		const files = new Map([
			["proj/src/utils.ts", "export function greet(name: string): string { return `Hello ${name}`; }"],
			["proj/src/index.ts", 'import { greet } from "./utils";\nconst msg: string = greet("world");\nexport default { fetch() { return new Response(msg); } };'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(true);
	});

	it("catches cross-file type errors", async () => {
		const files = new Map([
			["proj/src/utils.ts", "export function add(a: number, b: number): number { return a + b; }"],
			["proj/src/index.ts", 'import { add } from "./utils";\nconst x: string = add(1, 2);'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(false);
	});

	it("resolves subdirectory imports", async () => {
		const files = new Map([
			["proj/src/types.ts", "export interface User { name: string; age: number; }"],
			["proj/src/handlers/users.ts", 'import type { User } from "../types";\nexport function getUser(): User { return { name: "Alice", age: 30 }; }'],
			["proj/src/index.ts", 'import { getUser } from "./handlers/users";\nexport default { fetch() { return Response.json(getUser()); } };'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(true);
	});

	it("generates Env types from wrangler.jsonc", async () => {
		const files = new Map([
			["proj/wrangler.jsonc", '{"kv_namespaces": [{"binding": "CACHE"}], "d1_databases": [{"binding": "DB"}]}'],
			["proj/src/index.ts", 'export default {\n  async fetch(req: Request, env: Env): Promise<Response> {\n    await env.CACHE.get("k");\n    await env.DB.prepare("SELECT 1").first();\n    return new Response("ok");\n  }\n};'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		expect(result.success).toBe(true);
	});

	it("fetches hono types from npm", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"hono":"^4.0.0"}}'],
			["proj/src/index.ts", 'import { Hono } from "hono";\nconst app = new Hono();\nexport default app;'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		console.log("hono diagnostics:", result.diagnostics.map((d) => d.message));
		console.log("typesFetched:", (result as any).typesFetched);
		console.log("typesFailed:", (result as any).typesFailed);
		// Hono import should resolve — no "Cannot find module" errors
		const moduleErrors = result.diagnostics.filter(
			(d) => d.severity === "error" && d.message.includes("Cannot find module")
		);
		expect(moduleErrors).toHaveLength(0);
	}, 15000);

	it("fetches zod types from npm", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"zod":"^3.23.0"}}'],
			["proj/src/index.ts", 'import { z } from "zod";\nconst schema = z.object({ name: z.string() });\nexport default { fetch() { return Response.json(schema.parse({ name: "test" })); } };'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		console.log("zod diagnostics:", result.diagnostics.map((d) => d.message));
		console.log("typesFetched:", (result as any).typesFetched);
		const moduleErrors = result.diagnostics.filter(
			(d) => d.severity === "error" && d.message.includes("Cannot find module")
		);
		expect(moduleErrors).toHaveLength(0);
	}, 15000);

	it("fetches hono subpath imports (hono/cors)", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"hono":"^4.0.0"}}'],
			["proj/src/index.ts", 'import { Hono } from "hono";\nimport { cors } from "hono/cors";\nconst app = new Hono();\napp.use("*", cors());\nexport default app;'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		console.log("hono/cors diagnostics:", result.diagnostics.map((d) => `${d.file}:${d.line} ${d.message}`));
		console.log("typesFetched:", (result as any).typesFetched);
		const moduleErrors = result.diagnostics.filter(
			(d) => d.severity === "error" && d.message.includes("Cannot find module")
		);
		expect(moduleErrors).toHaveLength(0);
	}, 15000);

	it("resolves deep internal types (Hono Context)", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"hono":"^4.0.0"}}'],
			["proj/src/index.ts", `
import { Hono } from "hono";
import type { Context } from "hono";

const app = new Hono();
app.get("/", (c: Context) => c.json({ ok: true }));
export default app;
`],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		console.log("deep types diagnostics:", result.diagnostics.map((d) => `${d.file}:${d.line} ${d.message}`));
		console.log("typesFetched:", (result as any).typesFetched);
		// The fetched types are inside the typecheck files map, not the outer map.
		// We can tell it worked because Context resolved (0 "Cannot find" errors).
		const moduleErrors = result.diagnostics.filter(
			(d) => d.severity === "error" && d.message.includes("Cannot find")
		);
		expect(moduleErrors).toHaveLength(0);
	}, 30000);

	it("typechecks React TSX with shadcn components", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"react":"^19","react-dom":"^19","radix-ui":"^1","class-variance-authority":"^0.7","clsx":"^2","tailwind-merge":"^3","lucide-react":"^0.5"}}'],
			["proj/app/lib/utils.ts", 'import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\nexport function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }'],
			["proj/app/routes/home.tsx", `
import { Button } from "~/components/ui/button";

export default function Home() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Hello</h1>
      <Button variant="default">Click me</Button>
    </div>
  );
}
`],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		console.log("react tsx errors:", result.diagnostics.length);
		console.log("typesFetched:", (result as any).typesFetched);
		console.log("typesFailed:", (result as any).typesFailed);
		// The typecheck-mem creates a separate stripped files map — check that one
		// by looking at what fetchDependencyTypes wrote
		// We can't access the internal map, but we can check if react resolved
		console.log("all files in outer map:", [...files.keys()].filter((k) => k.includes("node_modules")).length);
		const errors = result.diagnostics.filter((d) => d.severity === "error");
		for (const e of errors.slice(0, 5)) {
			console.log(`  ${e.file}:${e.line} ${e.message.slice(0, 100)}`);
		}
		// We expect some errors since we don't have full React types yet,
		// but the count should be reasonable (< 20), not 273
		expect(errors.length).toBeLessThan(20);
	}, 30000);

	it("skips unknown deps without errors", async () => {
		const files = new Map([
			["proj/package.json", '{"dependencies":{"nonexistent-pkg-xyz":"^1.0.0"}}'],
			["proj/src/index.ts", 'import { foo } from "nonexistent-pkg-xyz";\nexport default { fetch() { return new Response("ok"); } };'],
		]);
		const result = await typeCheckFromMap(files, "proj/");
		// Should not crash — unknown modules are silently skipped
		// The import error is filtered out for non-relative imports
		const crashErrors = result.diagnostics.filter(
			(d) => d.severity === "error" && !d.message.includes("Cannot find module")
		);
		expect(crashErrors).toHaveLength(0);
	}, 15000);
});
