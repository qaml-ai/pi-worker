/**
 * Codegen Worker — generates multi-file Cloudflare Worker projects.
 *
 * Agent operates on an in-memory filesystem (Map). Only the final zip
 * is written to R2 for download. No per-file R2 operations.
 *
 * POST /generate { prompt }     → { jobId }
 * GET  /jobs/:id                → { status, downloadUrl?, error? }
 * GET  /download/:key?sig=...   → file download
 * POST /debug { prompt }        → { projectId, transcript } (sync, for dev)
 */

import {
	Agent,
	getModel,
	createMemoryTools,
	createDownloadHandler,
} from "pi-worker";
import { zipSync, strToU8 } from "fflate";
import { typeCheckFromMap } from "./typecheck-mem.js";

interface Env {
	OPENROUTER_API_KEY: string;
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

function zipFiles(files: Map<string, string>, prefix: string): Uint8Array {
	const entries: Record<string, Uint8Array> = {};
	for (const [key, content] of files) {
		if (!key.startsWith(prefix)) continue;
		const rel = key.slice(prefix.length);
		if (rel) entries[rel] = strToU8(content);
	}
	if (Object.keys(entries).length === 0) throw new Error("No files to zip");
	return zipSync(entries, { level: 6 });
}

function runAgent(prompt: string, projectId: string, apiKey: string, modelId?: string) {
	const files = new Map<string, string>();
	const prefix = `${projectId}/`;

	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model: getModel("openrouter", (modelId || "google/gemini-3-flash-preview") as any),
			thinkingLevel: "off",
			tools: createMemoryTools(files),
		},
		getApiKey: async () => apiKey,
	});

	return { agent, files, prefix };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		const served = await downloads.serve(request);
		if (served) return served;

		// GET /jobs/:id
		if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
			const jobId = url.pathname.slice("/jobs/".length);
			const raw = await env.JOBS.get(jobId);
			if (!raw) return Response.json({ error: "Job not found" }, { status: 404 });
			return Response.json(JSON.parse(raw));
		}

		// POST /debug — synchronous with transcript
		if (request.method === "POST" && url.pathname === "/debug") {
			const body = (await request.json()) as { prompt?: string; model?: string };
			if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

			const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const { agent, files, prefix } = runAgent(body.prompt, projectId, env.OPENROUTER_API_KEY, body.model);

			const transcript: any[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					transcript.push({ event: "tool_call", tool: (e as any).toolName, args: (e as any).args });
				} else if (e.type === "tool_execution_end") {
					const ev = e as any;
					const text = ev.result?.content?.[0]?.text ?? "";
					transcript.push({ event: "tool_result", tool: ev.toolName, isError: ev.isError, result: text.slice(0, 500) });
				}
			});

			await agent.prompt(`Project directory: "${projectId}"\n\n${body.prompt}`);

			// Typecheck
			const tc = await typeCheckFromMap(files, prefix);

			return Response.json({
				projectId,
				transcript,
				typeCheck: { success: tc.success, errors: tc.diagnostics.filter((d: any) => d.severity === "error").length },
				fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
				error: agent.state.error,
			});
		}

		// POST /generate — enqueue
		if (request.method === "POST" && url.pathname === "/generate") {
			const body = (await request.json()) as { prompt?: string };
			if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

			const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			await env.JOBS.put(jobId, JSON.stringify({ status: "pending", createdAt: Date.now() } as JobStatus), { expirationTtl: 3600 });
			await env.CODEGEN_QUEUE.send({ jobId, prompt: body.prompt });

			return Response.json({ jobId, status: "pending" });
		}

		return Response.json({
			endpoints: {
				"POST /generate": "{ prompt } → { jobId }",
				"GET /jobs/:id": "→ { status, downloadUrl?, error? }",
				"POST /debug": "{ prompt } → { transcript, typeCheck } (sync, dev only)",
			},
		});
	},

	// ---------------------------------------------------------------------------
	// Queue consumer
	// ---------------------------------------------------------------------------

	async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			const { jobId, prompt } = msg.body;

			const updateStatus = async (update: Partial<JobStatus>) => {
				const raw = await env.JOBS.get(jobId);
				const current: JobStatus = raw ? JSON.parse(raw) : { status: "running", createdAt: Date.now() };
				await env.JOBS.put(jobId, JSON.stringify({ ...current, ...update }), { expirationTtl: 3600 });
			};

			try {
				await updateStatus({ status: "running" });

				const projectId = jobId.replace("job_", "proj_");
				const { agent, files, prefix } = runAgent(prompt, projectId, env.OPENROUTER_API_KEY);

				const toolCalls: string[] = [];
				agent.subscribe((e) => {
					if (e.type === "tool_execution_start") toolCalls.push((e as any).toolName);
				});

				await agent.prompt(`Project directory: "${projectId}"\n\n${prompt}`);

				if (agent.state.error) {
					await updateStatus({ status: "error", error: agent.state.error, toolCalls, completedAt: Date.now() });
					msg.ack();
					continue;
				}

				// Typecheck with auto-fix
				let tc = await typeCheckFromMap(files, prefix);
				let fixes = 0;
				while (!tc.success && fixes < 2) {
					fixes++;
					const errors = tc.diagnostics
						.filter((d: any) => d.severity === "error")
						.map((d: any) => `${d.file ?? "?"}:${d.line ?? "?"} - ${d.message}`)
						.join("\n");
					await agent.prompt(`TypeScript errors found. Fix them:\n\n${errors}`);
					if (agent.state.error) break;
					tc = await typeCheckFromMap(files, prefix);
				}

				// Zip in-memory, write once to R2
				const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);
				const zipData = zipFiles(files, prefix);
				const downloadPath = await downloads.store(`${projectId}.zip`, zipData, {
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
					typeCheck: { success: tc.success, errors: tc.diagnostics.filter((d: any) => d.severity === "error").length, fixes },
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
