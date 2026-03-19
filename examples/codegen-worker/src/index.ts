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
// Dynamic import — avoid loading the 9MB TS compiler at Worker startup
// This way the queue consumer doesn't OOM before processing messages
const loadTypeChecker = () => import("./typecheck-mem.js").then((m) => m.typeCheckFromMap);
import { scaffoldProject, type ScaffoldOptions } from "./scaffold.js";
import { createShadcnTool } from "./shadcn-tool.js";

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

const SYSTEM_PROMPT = `You are a Cloudflare Worker app builder. The project is already scaffolded with:
- React Router 7 (SSR framework mode)
- React 19
- Tailwind CSS v4 with themed CSS variables (OKLch colors, light/dark mode)
- shadcn/ui (radix-mira style) — use add_component to install components
- Cloudflare Workers deployment
- Vite bundler

The project structure is pre-created:
  package.json, tsconfig.json, wrangler.jsonc, components.json, postcss.config.mjs
  vite.config.ts, react-router.config.ts
  app/app.css (themed), app/root.tsx, app/routes.ts, app/routes/home.tsx
  app/lib/utils.ts (cn utility)
  workers/app.ts (worker entry)

YOUR JOB: Customize this project based on the user's request.

RULES:
1. All file paths MUST be prefixed with the project directory you are given
2. Use add_component to install shadcn components (e.g. add_component(["button", "card", "dialog"]))
3. Edit existing files with the edit tool — don't recreate files that already exist
4. Add new routes in app/routes/ and register them in app/routes.ts
5. Use React Router patterns: loaders for data, actions for mutations, <Form> for forms
6. Put shared types in app/types.ts, utilities in app/lib/
7. For data persistence, add D1/KV/R2 bindings to wrangler.jsonc and Durable Objects if needed
8. After making changes, use ls to confirm the structure`;

function projectName(projectId: string): string {
	return projectId.replace(/^proj_\d+_/, "app-");
}

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

async function runAgent(prompt: string, projectId: string, apiKey: string, modelId?: string, scaffoldOpts?: ScaffoldOptions) {
	const files = new Map<string, string>();
	const prefix = `${projectId}/`;

	// Scaffold the project before the agent starts — agent gets a pre-configured
	// React Router 7 + shadcn/ui + Tailwind v4 project to customize
	await scaffoldProject(files, prefix, projectName(projectId), scaffoldOpts);

	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model: getModel("openrouter", (modelId || "google/gemini-3-flash-preview") as any),
			thinkingLevel: "off",
			tools: [...createMemoryTools(files), createShadcnTool(files, { prefix })],
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
			const { agent, files, prefix } = await runAgent(body.prompt, projectId, env.OPENROUTER_API_KEY, body.model);

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
			const tc = await (await loadTypeChecker())(files, prefix);

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
				const { agent, files, prefix } = await runAgent(prompt, projectId, env.OPENROUTER_API_KEY);

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
				let tc = await (await loadTypeChecker())(files, prefix);
				let fixes = 0;
				while (!tc.success && fixes < 2) {
					fixes++;
					const errors = tc.diagnostics
						.filter((d: any) => d.severity === "error")
						.map((d: any) => `${d.file ?? "?"}:${d.line ?? "?"} - ${d.message}`)
						.join("\n");
					await agent.prompt(`TypeScript errors found. Fix them:\n\n${errors}`);
					if (agent.state.error) break;
					tc = await (await loadTypeChecker())(files, prefix);
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
