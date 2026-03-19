/**
 * FFmpeg Agent — pi-mono agent with R2-mounted sandbox.
 *
 * Containers are shared across requests (pooled by SANDBOX binding).
 * R2 is mounted once at /data. Per-request isolation is handled by:
 * - R2 tool prefix: agent sees "input/video.mp4", R2 key is "<requestId>/input/video.mp4"
 * - Sandbox paths: ffmpeg operates on /data/<requestId>/ subdirectory
 * - Signed URLs: scoped to the request's R2 prefix
 */

import {
	Agent,
	getModel,
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
	createExecuteTool,
	createDownloadHandler,
} from "pi-worker";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	OPENROUTER_API_KEY: string;
	DOWNLOAD_SECRET: string;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	LOADER: any;
	FILES: R2Bucket;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_ENDPOINT: string;
}

// Number of containers in the pool. Requests are routed to a random container.
const POOL_SIZE = 3;

function createFfmpegHelpers(sandbox: ReturnType<typeof getSandbox>, workdir: string) {
	return {
		async ffmpeg(args: string) {
			await sandbox.mkdir(`${workdir}/output`, { recursive: true });
			const r = await sandbox.exec(`ffmpeg -y ${args}`, { timeout: 120_000 });
			return r.success
				? { success: true, stderr: r.stderr.slice(-1000) }
				: { success: false, exitCode: r.exitCode, stderr: r.stderr.slice(-2000) };
		},
		async ffprobe(path: string) {
			const r = await sandbox.exec(
				`ffprobe -v quiet -print_format json -show_format -show_streams "${path}"`,
				{ timeout: 30_000 },
			);
			return r.success
				? { success: true, metadata: JSON.parse(r.stdout) }
				: { success: false, error: r.stderr.slice(-1000) };
		},
		async listOutputs() {
			const r = await sandbox.exec(`ls -la ${workdir}/output/ 2>/dev/null || echo '(empty)'`);
			return r.stdout;
		},
	};
}

const SYSTEM_PROMPT = `You are a media processing agent with ffmpeg.

Tools:
- read, write, edit, ls: manage your files (isolated per request)
- execute: run JavaScript code with ffmpeg helpers

The "execute" tool runs code with these helpers:
  await ffmpeg("-i /data/WORKDIR/input/video.mp4 -vf scale=480:-1 /data/WORKDIR/output/out.gif")
  await ffprobe("/data/WORKDIR/input/video.mp4")
  await listOutputs()

You can also pass URLs directly to ffmpeg:
  await ffmpeg("-i https://example.com/video.mp4 /data/WORKDIR/output/out.mp4")

Always write outputs to /data/WORKDIR/output/. Always use -y flag.
Replace WORKDIR with the working directory provided in the prompt.`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		const served = await downloads.serve(request);
		if (served) return served;

		if (request.method !== "POST") {
			return Response.json({
				usage: "POST multipart/form-data with 'prompt' and optional file(s)",
				examples: [
					"curl -F 'prompt=convert to 480p gif' -F file=@video.mp4 <url>",
					"curl -F 'prompt=extract audio from https://example.com/video.mp4 as mp3' <url>",
				],
			});
		}

		const formData = await request.formData();
		const prompt = formData.get("prompt") as string | null;
		if (!prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

		const files = formData.getAll("file") as File[];
		const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		// Pick a container from the pool — stable ID means container reuse
		const containerSlot = Math.floor(Math.random() * POOL_SIZE);
		const sandbox = getSandbox(env.SANDBOX, `ffmpeg-pool-${containerSlot}`);

		// Per-request working directory inside the shared mount
		const workdir = `/data/${requestId}`;

		try {
			// Mount the whole R2 bucket once (idempotent — no-ops if already mounted)
			try {
				await sandbox.mountBucket("ffmpeg-agent-files", "/data", {
					endpoint: env.R2_ENDPOINT,
					credentials: {
						accessKeyId: env.R2_ACCESS_KEY_ID,
						secretAccessKey: env.R2_SECRET_ACCESS_KEY,
					},
				});
			} catch (e: any) {
				// Ignore "already mounted" errors on reused containers
				if (!e.message?.includes("already mounted") && !e.message?.includes("mount point")) throw e;
			}

			// Upload input files to R2 under request prefix
			const fileNames: string[] = [];
			if (files.length > 0) {
				for (const file of files) {
					const key = `${requestId}/input/${file.name}`;
					await env.FILES.put(key, await file.arrayBuffer());
					fileNames.push(file.name);
				}
			}

			const agent = new Agent({
				initialState: {
					systemPrompt: SYSTEM_PROMPT.replaceAll("WORKDIR", requestId),
					model: getModel("openrouter", "google/gemini-3-flash-preview"),
					thinkingLevel: "off",
					tools: [
						createR2ReadTool(env.FILES, { prefix: requestId }),
						createR2WriteTool(env.FILES, { prefix: requestId }),
						createR2EditTool(env.FILES, { prefix: requestId }),
						createR2LsTool(env.FILES, { prefix: requestId }),
						createExecuteTool(env.LOADER, createFfmpegHelpers(sandbox, workdir), { bucket: env.FILES }),
					],
				},
				getApiKey: async () => env.OPENROUTER_API_KEY,
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") toolCalls.push((e as any).toolName);
			});

			const userPrompt = files.length > 0
				? `Working directory: ${requestId}\nInput files at ${workdir}/input/: ${fileNames.join(", ")}\n\n${prompt}`
				: `Working directory: ${requestId}\n\n${prompt}`;

			await agent.prompt(userPrompt);

			// Output files are already in R2 under requestId/output/
			const listed = await env.FILES.list({ prefix: `${requestId}/output/` });
			const response = lastText(agent);

			if (listed.objects.length === 0) {
				return Response.json({ response, toolCalls, error: agent.state.error });
			}

			const outputUrls: Record<string, string> = {};
			for (const obj of listed.objects) {
				const name = obj.key.replace(`${requestId}/output/`, "");
				if (!name) continue;
				const path = await downloads.sign(obj.key);
				outputUrls[name] = new URL(path, request.url).href;
			}

			return Response.json({ outputs: outputUrls, response, toolCalls });
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};

function lastText(agent: Agent): string {
	const msgs = agent.state.messages.filter((m) => m.role === "assistant");
	const last = msgs[msgs.length - 1];
	return last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
}
