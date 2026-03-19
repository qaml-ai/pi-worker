/**
 * Codegen Worker — generates multi-file Cloudflare Worker projects.
 *
 * POST { prompt } → agent generates files in R2 → typechecks → zips → returns signed download URL
 */

import { createMicroAgent } from "pi-worker";
import { zipSync, strToU8 } from "fflate";
import { typeCheckR2Project } from "./typecheck.js";

interface Env {
	ANTHROPIC_API_KEY: string;
	DOWNLOAD_SECRET: string;
	FILES: R2Bucket;
}

const SYSTEM_PROMPT = `You are a Cloudflare Worker codebase generator. When the user describes an app, you create a complete, production-ready multi-file Cloudflare Worker project.

IMPORTANT RULES:
1. All file paths MUST be prefixed with the project directory you are given
2. Always create at minimum: package.json, wrangler.jsonc, tsconfig.json, src/index.ts
3. Use TypeScript, modern ES modules, and Cloudflare Workers best practices
4. Include any bindings (KV, R2, D1, Durable Objects) in wrangler.jsonc if needed
5. Write clean, well-structured code split across multiple files
6. Do NOT include node_modules, lock files, or .git
7. After creating all files, call ls on the project root to confirm the structure`;

// ---------------------------------------------------------------------------
// Signed download URLs
// ---------------------------------------------------------------------------

const DOWNLOAD_TTL_MS = 30 * 60 * 1000;

async function hmac(secret: string, data: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signUrl(origin: string, key: string, secret: string): Promise<string> {
	const expires = Date.now() + DOWNLOAD_TTL_MS;
	const mac = await hmac(secret, `${key}:${expires}`);
	return `${origin}/download/${encodeURIComponent(key)}?expires=${expires}&sig=${mac}`;
}

async function verifyToken(key: string, expires: string | null, sig: string | null, secret: string): Promise<boolean> {
	if (!expires || !sig) return false;
	const ms = parseInt(expires, 10);
	if (isNaN(ms) || Date.now() > ms) return false;
	return (await hmac(secret, `${key}:${expires}`)) === sig;
}

// ---------------------------------------------------------------------------
// Zip project files from R2
// ---------------------------------------------------------------------------

async function zipProject(bucket: R2Bucket, prefix: string): Promise<string> {
	const files: Record<string, Uint8Array> = {};
	let cursor: string | undefined, hasMore = true;

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

	const zipKey = `${prefix}__download.zip`;
	await bucket.put(zipKey, zipSync(files, { level: 6 }), {
		httpMetadata: { contentType: "application/zip", contentDisposition: 'attachment; filename="project.zip"' },
	});
	return zipKey;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Signed download
		if (request.method === "GET" && url.pathname.startsWith("/download/")) {
			const key = decodeURIComponent(url.pathname.slice("/download/".length));
			if (!(await verifyToken(key, url.searchParams.get("expires"), url.searchParams.get("sig"), env.DOWNLOAD_SECRET))) {
				return new Response("Link expired or invalid", { status: 403 });
			}
			const obj = await env.FILES.get(key);
			if (!obj) return new Response("Not found", { status: 404 });
			return new Response(obj.body, {
				headers: {
					"content-type": obj.httpMetadata?.contentType || "application/octet-stream",
					"content-disposition": obj.httpMetadata?.contentDisposition || "attachment",
				},
			});
		}

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
			const { agent, prompt, getResponse } = createMicroAgent({
				bucket: env.FILES,
				apiKey: env.ANTHROPIC_API_KEY,
				systemPrompt: SYSTEM_PROMPT,
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					const ev = e as any;
					toolCalls.push(`${ev.toolName}(${JSON.stringify(ev.args).slice(0, 100)})`);
				}
			});

			await prompt(`Project directory: "${projectId}"\n\n${body.prompt}`);

			if (agent.state.error) {
				return Response.json({ error: agent.state.error }, { status: 500 });
			}

			// Typecheck + auto-fix loop
			let tc = await typeCheckR2Project(env.FILES, prefix);
			let fixes = 0;
			while (!tc.success && fixes < 2) {
				fixes++;
				const errors = tc.diagnostics
					.filter((d) => d.severity === "error")
					.map((d) => `${d.file ?? "?"}:${d.line ?? "?"} - ${d.message}`)
					.join("\n");
				await prompt(`TypeScript errors found. Fix them:\n\n${errors}`);
				if (agent.state.error) break;
				tc = await typeCheckR2Project(env.FILES, prefix);
			}

			const zipKey = await zipProject(env.FILES, prefix);
			const downloadUrl = await signUrl(url.origin, zipKey, env.DOWNLOAD_SECRET);

			return Response.json({
				downloadUrl,
				projectId,
				summary: getResponse(),
				typeCheck: { success: tc.success, errors: tc.diagnostics.filter((d) => d.severity === "error").length, fixes },
				toolCalls,
			});
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};
