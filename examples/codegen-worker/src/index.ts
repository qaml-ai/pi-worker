/**
 * Codegen Worker — generates multi-file Cloudflare Worker projects.
 *
 * Queue-based: returns a job ID immediately, runs the agent in a queue consumer.
 *
 * POST /generate { prompt }     → { jobId }
 * GET  /jobs/:id                → { status, downloadUrl?, error? }
 * GET  /download/:key?sig=...   → file download
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
	JOBS: KVNamespace;
	CODEGEN_QUEUE: Queue<JobMessage>;
}

interface JobMessage {
	jobId: string;
	prompt: string;
}

interface JobStatus {
	status: "pending" | "running" | "complete" | "error";
	downloadUrl?: string;
	summary?: string;
	typeCheck?: { success: boolean; errors: number; fixes: number };
	toolCalls?: string[];
	error?: string;
	createdAt: number;
	completedAt?: number;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Worker (HTTP handler)
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		// Serve signed downloads
		const served = await downloads.serve(request);
		if (served) return served;

		// GET /jobs/:id — check job status
		if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
			const jobId = url.pathname.slice("/jobs/".length);
			const raw = await env.JOBS.get(jobId);
			if (!raw) return Response.json({ error: "Job not found" }, { status: 404 });
			return Response.json(JSON.parse(raw));
		}

		// POST /generate — enqueue a new job
		if (request.method === "POST" && url.pathname === "/generate") {
			const body = (await request.json()) as { prompt?: string };
			if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

			const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const status: JobStatus = { status: "pending", createdAt: Date.now() };

			await env.JOBS.put(jobId, JSON.stringify(status), { expirationTtl: 3600 });
			await env.CODEGEN_QUEUE.send({ jobId, prompt: body.prompt });

			return Response.json({ jobId, status: "pending" });
		}

		return Response.json({
			endpoints: {
				"POST /generate": "{ prompt } → { jobId }",
				"GET /jobs/:id": "→ { status, downloadUrl?, error? }",
			},
			example: {
				"1. Start": "curl -X POST /generate -d '{\"prompt\": \"URL shortener with D1\"}'",
				"2. Poll": "curl /jobs/<jobId>",
				"3. Download": "curl <downloadUrl>",
			},
		});
	},

	// ---------------------------------------------------------------------------
	// Queue consumer (runs the agent — up to 15 min timeout)
	// ---------------------------------------------------------------------------

	async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			const { jobId, prompt } = msg.body;

			const updateStatus = async (update: Partial<JobStatus>) => {
				const raw = await env.JOBS.get(jobId);
				const current: JobStatus = raw ? JSON.parse(raw) : { status: "running", createdAt: Date.now() };
				const updated = { ...current, ...update };
				await env.JOBS.put(jobId, JSON.stringify(updated), { expirationTtl: 3600 });
			};

			try {
				await updateStatus({ status: "running" });

				const projectId = jobId.replace("job_", "proj_");
				const prefix = `${projectId}/`;

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
					if (e.type === "tool_execution_start") toolCalls.push((e as any).toolName);
				});

				await agent.prompt(`Project directory: "${projectId}"\n\n${prompt}`);

				if (agent.state.error) {
					await updateStatus({ status: "error", error: agent.state.error, toolCalls });
					msg.ack();
					continue;
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
				const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);
				const zipData = await zipProject(env.FILES, prefix);
				const zipKey = `${prefix}__download.zip`;
				const downloadPath = await downloads.store(zipKey, zipData, {
					contentType: "application/zip",
					filename: "project.zip",
				});

				const msgs = agent.state.messages.filter((m) => m.role === "assistant");
				const last = msgs[msgs.length - 1];
				const summary = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";

				await updateStatus({
					status: "complete",
					downloadUrl: downloadPath,
					summary,
					typeCheck: {
						success: tc.success,
						errors: tc.diagnostics.filter((d) => d.severity === "error").length,
						fixes,
					},
					toolCalls,
					completedAt: Date.now(),
				});
			} catch (error: any) {
				await updateStatus({ status: "error", error: error.message, completedAt: Date.now() });
			}

			msg.ack();
		}
	},
};
