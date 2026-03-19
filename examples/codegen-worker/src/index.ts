/**
 * Codegen Worker — generates multi-file Cloudflare Worker projects.
 *
 * POST { prompt } → agent writes files to R2 → typechecks → zips → returns signed download URL
 */

import {
	Agent,
	getModel,
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
	createDownloadHandler,
} from "pi-worker";
import { zipSync, strToU8 } from "fflate";
import { typeCheckR2Project } from "./typecheck.js";

interface Env {
	ANTHROPIC_API_KEY: string;
	DOWNLOAD_SECRET: string;
	FILES: R2Bucket;
}

const SYSTEM_PROMPT = `You are a Cloudflare Worker codebase generator. When the user describes an app, create a complete, production-ready multi-file project.

RULES:
1. All file paths MUST be prefixed with the project directory you are given (e.g. "proj_abc/src/index.ts")
2. You CAN and SHOULD create files in subdirectories — use paths like "proj_abc/src/handlers/users.ts"
3. Always create at minimum: package.json, wrangler.jsonc, tsconfig.json, src/index.ts
4. Use TypeScript, ES modules, and Cloudflare Workers best practices
5. Include bindings (KV, R2, D1, Durable Objects) in wrangler.jsonc if needed
6. Split code across multiple files — put types, handlers, utilities in separate files under src/
7. Do NOT include node_modules, lock files, or .git
8. After creating all files, use ls to confirm the structure`;

async function zipProject(bucket: R2Bucket, prefix: string): Promise<Uint8Array> {
	const files: Record<string, Uint8Array> = {};
	let cursor: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const listed = await bucket.list({ prefix, cursor, limit: 500 });
		for (const obj of listed.objects) {
			const body = await bucket.get(obj.key);
			if (!body) continue;
			const rel = obj.key.slice(prefix.length);
			if (rel) files[rel] = strToU8(await body.text());
		}
		hasMore = listed.truncated;
		if (listed.truncated && listed.cursor) cursor = listed.cursor;
	}

	if (Object.keys(files).length === 0) throw new Error("No files to zip");
	return zipSync(files, { level: 6 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		const served = await downloads.serve(request);
		if (served) return served;

		if (request.method !== "POST") {
			return Response.json({
				usage: "POST { prompt } — describe the Worker app you want, get a download URL",
				example: { prompt: "Create a URL shortener with D1 database" },
			});
		}

		const body = (await request.json()) as { prompt?: string };
		if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

		const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const prefix = `${projectId}/`;

		try {
			const agent = new Agent({
				initialState: {
					systemPrompt: SYSTEM_PROMPT,
					model: getModel("anthropic", "claude-sonnet-4-20250514"),
					thinkingLevel: "off",
					tools: [
						createR2WriteTool(env.FILES),
						createR2ReadTool(env.FILES),
						createR2EditTool(env.FILES),
						createR2LsTool(env.FILES),
					],
				},
				getApiKey: async () => env.ANTHROPIC_API_KEY,
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					toolCalls.push(`${(e as any).toolName}`);
				}
			});

			await agent.prompt(`Project directory: "${projectId}"\n\n${body.prompt}`);

			if (agent.state.error) {
				return Response.json({ error: agent.state.error }, { status: 500 });
			}

			// Typecheck with auto-fix loop
			let tc = await typeCheckR2Project(env.FILES, prefix);
			let fixes = 0;
			while (!tc.success && fixes < 2) {
				fixes++;
				const errors = tc.diagnostics
					.filter((d) => d.severity === "error")
					.map((d) => `${d.file ?? "?"}:${d.line ?? "?"} - ${d.message}`)
					.join("\n");
				await agent.prompt(`TypeScript errors found. Fix them:\n\n${errors}`);
				if (agent.state.error) break;
				tc = await typeCheckR2Project(env.FILES, prefix);
			}

			// Zip and store
			const zipData = await zipProject(env.FILES, prefix);
			const zipKey = `${prefix}__download.zip`;
			const downloadPath = await downloads.store(zipKey, zipData, {
				contentType: "application/zip",
				filename: "project.zip",
			});

			const msgs = agent.state.messages.filter((m) => m.role === "assistant");
			const last = msgs[msgs.length - 1];
			const summary = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";

			return Response.json({
				downloadUrl: new URL(downloadPath, request.url).href,
				projectId,
				summary,
				typeCheck: {
					success: tc.success,
					errors: tc.diagnostics.filter((d) => d.severity === "error").length,
					fixes,
				},
				toolCalls,
			});
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};
