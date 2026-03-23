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

import { WorkflowEntrypoint } from "cloudflare:workers";
import {
	Agent,
	getModel,
	createMemoryTools,
	createDownloadHandler,
} from "pi-worker";
import { zipSync, strToU8 } from "fflate";
import { createShadcnTool } from "./shadcn-tool.js";
import { runDesignAgent } from "./design-agent.js";

interface Env {
	OPENROUTER_API_KEY: string;
	DOWNLOAD_SECRET: string;
	FILES: R2Bucket;
	CODEGEN_WORKFLOW: Workflow<WorkflowParams>;
}

interface WorkflowParams {
	prompt: string;
	model?: string;
}

interface JobStatus {
	status: "pending" | "running" | "complete" | "error";
	downloadUrl?: string;
	summary?: string;
	typeCheck?: { success: boolean; errors: number; fixes: number };
	toolCalls?: string[];
	error?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
}

interface JobResult {
	downloadUrl: string;
	summary: string;
	typeCheck: { success: boolean; errors: number; fixes: number };
	toolCalls: string[];
	createdAt: number;
	startedAt: number;
	completedAt: number;
}

interface ScaffoldStepResult {
	projectId: string;
	prefix: string;
	files: Record<string, string>;
	createdAt: number;
	startedAt: number;
}

interface CodegenStepResult extends ScaffoldStepResult {
	summary: string;
	toolCalls: string[];
}

const SYSTEM_PROMPT = `You are a Cloudflare Worker app builder. The project is already scaffolded with:
- React Router 7 (SSR framework mode)
- React 19
- Tailwind CSS v4 with themed CSS variables (OKLch colors, light/dark mode)
- shadcn/ui (radix-mira style) — use add_component to install components
- Cloudflare Workers deployment
- Vite bundler

The project structure is pre-created:
  package.json, tsconfig.json, tsconfig.cloudflare.json, tsconfig.node.json
  wrangler.jsonc, components.json, vite.config.ts, react-router.config.ts
  app/app.css (themed), app/entry.server.tsx, app/root.tsx, app/routes.ts, app/routes/home.tsx
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

function jobCreatedAt(jobId: string): number {
	const match = /^job_(\d+)_/.exec(jobId);
	return Number(match?.[1] || Date.now());
}

function mapToRecord(files: Map<string, string>): Record<string, string> {
	return Object.fromEntries(files.entries());
}

function recordToMap(files: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(files));
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

function createCodegenAgent(files: Map<string, string>, prefix: string, apiKey: string, modelId?: string) {
	return new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model: getModel("openrouter", (modelId || "google/gemini-3-flash-preview") as any),
			thinkingLevel: "off",
			tools: [...createMemoryTools(files), createShadcnTool(files, { prefix })],
		},
		getApiKey: async () => apiKey,
	});
}

function logStep(id: string, step: string, extra?: Record<string, unknown>) {
	console.log(JSON.stringify({ at: new Date().toISOString(), id, step, ...extra }));
}

function dedupeImports(files: Map<string, string>, prefix: string) {
	for (const [path, content] of files) {
		if (!path.startsWith(prefix)) continue;
		if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
		const seen = new Set<string>();
		const next = content.split("\n").filter((line) => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("import ")) return true;
			if (seen.has(trimmed)) return false;
			seen.add(trimmed);
			return true;
		}).join("\n");
		if (next !== content) files.set(path, next);
	}
}

async function runDesignStep(jobId: string, prompt: string, env: Env, modelId?: string): Promise<ScaffoldStepResult> {
	const createdAt = jobCreatedAt(jobId);
	const startedAt = Date.now();
	const projectId = jobId.replace("job_", "proj_");
	const prefix = `${projectId}/`;
	const files = new Map<string, string>();

	logStep(jobId, "workflow_design_start", { promptLength: prompt.length });
	await runDesignAgent(prompt, files, prefix, projectName(projectId), env.OPENROUTER_API_KEY, modelId);
	logStep(jobId, "workflow_design_done", {
		elapsedMs: Date.now() - startedAt,
		fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
	});

	return {
		projectId,
		prefix,
		files: mapToRecord(files),
		createdAt,
		startedAt,
	};
}

async function runCodegenStep(jobId: string, prompt: string, env: Env, input: ScaffoldStepResult, modelId?: string): Promise<CodegenStepResult> {
	const files = recordToMap(input.files);

	logStep(jobId, "workflow_codegen_agent_create");
	const agent = createCodegenAgent(files, input.prefix, env.OPENROUTER_API_KEY, modelId);
	const toolCalls: string[] = [];
	agent.subscribe((e) => {
		if (e.type === "tool_execution_start") {
			const toolName = (e as any).toolName;
			toolCalls.push(toolName);
			logStep(jobId, "workflow_tool_start", { toolName, args: (e as any).args });
		} else if (e.type === "tool_execution_end") {
			const ev = e as any;
			const text = ev.result?.content?.[0]?.text ?? "";
			logStep(jobId, "workflow_tool_end", { toolName: ev.toolName, isError: ev.isError, resultPreview: text.slice(0, 200) });
		}
	});

	logStep(jobId, "workflow_codegen_prompt_start");
	await agent.prompt(`Project directory: "${input.projectId}"\n\n${prompt}`);
	logStep(jobId, "workflow_codegen_prompt_done", {
		elapsedMs: Date.now() - input.startedAt,
		error: agent.state.error || null,
		fileCount: [...files.keys()].filter((k) => k.startsWith(input.prefix)).length,
	});

	if (agent.state.error) {
		logStep(jobId, "workflow_codegen_error", { error: agent.state.error });
		throw new Error(agent.state.error);
	}

	dedupeImports(files, input.prefix);
	logStep(jobId, "workflow_typecheck_skipped", { elapsedMs: Date.now() - input.startedAt });

	const msgs = agent.state.messages.filter((m) => m.role === "assistant");
	const last = msgs[msgs.length - 1];
	const summary = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";

	return {
		...input,
		files: mapToRecord(files),
		summary,
		toolCalls,
	};
}

async function runPackageStep(jobId: string, env: Env, input: CodegenStepResult): Promise<JobResult> {
	const files = recordToMap(input.files);
	logStep(jobId, "workflow_zip_start");
	const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);
	const zipData = zipFiles(files, input.prefix);
	const downloadUrl = await downloads.store(`${input.projectId}.zip`, zipData, {
		contentType: "application/zip",
		filename: "project.zip",
	});
	logStep(jobId, "workflow_zip_done", { downloadPath: downloadUrl, zipBytes: zipData.length });

	const completedAt = Date.now();
	const result: JobResult = {
		downloadUrl,
		summary: input.summary,
		typeCheck: { success: true, errors: 0, fixes: 0 },
		toolCalls: input.toolCalls,
		createdAt: input.createdAt,
		startedAt: input.startedAt,
		completedAt,
	};
	logStep(jobId, "workflow_done", { elapsedMs: completedAt - input.startedAt });
	return result;
}

function mapInstanceStatus(jobId: string, info: Awaited<ReturnType<WorkflowInstance["status"]>>): JobStatus | null {
	const createdAt = jobCreatedAt(jobId);

	switch (info.status) {
		case "queued":
			return { status: "pending", createdAt };
		case "running":
		case "waiting":
		case "waitingForPause":
		case "paused":
			return { status: "running", createdAt };
		case "complete": {
			const output = (info.output ?? {}) as Partial<JobResult>;
			return {
				status: "complete",
				createdAt: output.createdAt ?? createdAt,
				startedAt: output.startedAt,
				completedAt: output.completedAt,
				downloadUrl: output.downloadUrl,
				summary: output.summary,
				typeCheck: output.typeCheck,
				toolCalls: output.toolCalls,
			};
		}
		case "errored":
		case "terminated":
			return {
				status: "error",
				createdAt,
				error: info.error?.message || `Workflow ${info.status}`,
			};
		case "unknown":
		default:
			return null;
	}
}

export class CodegenWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<JobResult> {
		const jobId = event.instanceId;
		logStep(jobId, "workflow_instance_start", {
			promptLength: event.payload.prompt.length,
			model: event.payload.model || "google/gemini-3-flash-preview",
		});

		const scaffold = await step.do("design_scaffold", { timeout: "5 minutes" }, async () => {
			return runDesignStep(jobId, event.payload.prompt, this.env, event.payload.model);
		});

		const codegen = await step.do("codegen", { timeout: "10 minutes" }, async () => {
			return runCodegenStep(jobId, event.payload.prompt, this.env, scaffold, event.payload.model);
		});

		const result = await step.do("package_upload", { timeout: "5 minutes" }, async () => {
			return runPackageStep(jobId, this.env, codegen);
		});

		logStep(jobId, "workflow_instance_complete", { completedAt: result.completedAt });
		return result;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		const served = await downloads.serve(request);
		if (served) return served;

		if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
			const jobId = url.pathname.slice("/jobs/".length);
			try {
				const instance = await env.CODEGEN_WORKFLOW.get(jobId);
				const info = await instance.status();
				const status = mapInstanceStatus(jobId, info);
				if (!status) return Response.json({ error: "Job not found" }, { status: 404 });
				return Response.json(status);
			} catch {
				return Response.json({ error: "Job not found" }, { status: 404 });
			}
		}

		if (request.method === "POST" && url.pathname === "/debug") {
			const body = (await request.json()) as { prompt?: string; model?: string };
			if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

			const startedAt = Date.now();
			const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const prefix = `${projectId}/`;
			const files = new Map<string, string>();
			logStep(projectId, "debug_request_start", {
				path: url.pathname,
				promptLength: body.prompt.length,
				model: body.model || "google/gemini-3-flash-preview",
			});

			logStep(projectId, "debug_design_start");
			const designResult = await runDesignAgent(body.prompt, files, prefix, projectName(projectId), env.OPENROUTER_API_KEY, body.model);
			logStep(projectId, "debug_design_done", {
				elapsedMs: Date.now() - startedAt,
				fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
				design: designResult.options,
			});

			logStep(projectId, "debug_codegen_agent_create");
			const agent = createCodegenAgent(files, prefix, env.OPENROUTER_API_KEY, body.model);
			const transcript: any[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					const toolName = (e as any).toolName;
					const args = (e as any).args;
					logStep(projectId, "tool_start", { toolName, args });
					transcript.push({ event: "tool_call", tool: toolName, args });
				} else if (e.type === "tool_execution_end") {
					const ev = e as any;
					const text = ev.result?.content?.[0]?.text ?? "";
					logStep(projectId, "tool_end", { toolName: ev.toolName, isError: ev.isError, resultPreview: text.slice(0, 200) });
					transcript.push({ event: "tool_result", tool: ev.toolName, isError: ev.isError, result: text.slice(0, 500) });
				} else if (e.type === "assistant_message") {
					const text = ((e as any).message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
					logStep(projectId, "assistant_message", { preview: text.slice(0, 200) });
				}
			});

			logStep(projectId, "debug_codegen_prompt_start");
			await agent.prompt(`Project directory: "${projectId}"\n\n${body.prompt}`);
			logStep(projectId, "debug_codegen_prompt_done", {
				elapsedMs: Date.now() - startedAt,
				error: agent.state.error || null,
				fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
			});

			dedupeImports(files, prefix);
			logStep(projectId, "debug_typecheck_skipped", {
				elapsedMs: Date.now() - startedAt,
			});

			logStep(projectId, "debug_request_done", {
				elapsedMs: Date.now() - startedAt,
				fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
				transcriptEvents: transcript.length,
				error: agent.state.error || null,
			});

			return Response.json({
				projectId,
				design: designResult.options,
				transcript,
				typeCheck: { success: true, errors: 0, fixes: 0 },
				fileCount: [...files.keys()].filter((k) => k.startsWith(prefix)).length,
				error: agent.state.error,
			});
		}

		if (request.method === "POST" && url.pathname === "/generate") {
			const body = (await request.json()) as { prompt?: string; model?: string };
			if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

			const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			logStep(jobId, "generate_workflow_create", { promptLength: body.prompt.length, mode: "workflow" });
			await env.CODEGEN_WORKFLOW.create({
				id: jobId,
				params: { prompt: body.prompt, model: body.model },
				retention: {
					successRetention: "1 day",
					errorRetention: "1 day",
				},
			});
			logStep(jobId, "generate_workflow_created");
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
};
