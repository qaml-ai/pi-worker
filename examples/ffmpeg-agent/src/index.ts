/**
 * FFmpeg Agent — pi-mono agent with R2-mounted sandbox.
 *
 * R2 is mounted directly into the sandbox at /data. ffmpeg reads input
 * and writes output there — no file transfer through the Worker.
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
	R2_ENDPOINT: string; // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
}

function createFfmpegHelpers(sandbox: ReturnType<typeof getSandbox>) {
	return {
		async ffmpeg(args: string) {
			await sandbox.mkdir("/data/output", { recursive: true });
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
			const r = await sandbox.exec("ls -la /data/output/ 2>/dev/null || echo '(empty)'");
			return r.stdout;
		},
	};
}

const SYSTEM_PROMPT = `You are a media processing agent with ffmpeg.

Tools:
- read, write, edit, ls: manage files in R2 storage (paths like "input/video.mp4")
- execute: run JavaScript code with ffmpeg helpers

The R2 bucket is mounted at /data in the sandbox. Files you write to R2
are immediately available to ffmpeg at /data/<path>, and ffmpeg outputs
written to /data/ are immediately in R2.

The "execute" tool runs code with these helpers:
  await ffmpeg("-i /data/input/video.mp4 -vf scale=480:-1 /data/output/out.gif")
  await ffprobe("/data/input/video.mp4")
  await listOutputs()

You can also pass URLs directly to ffmpeg:
  await ffmpeg("-i https://example.com/video.mp4 /data/output/out.mp4")

Always write outputs to /data/output/. Always use -y flag.`;

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
		const sessionId = `ffmpeg-${Date.now()}`;
		const sandbox = getSandbox(env.SANDBOX, sessionId);

		try {
			// Mount R2 bucket at /data, scoped to this session's prefix
			await sandbox.mountBucket("ffmpeg-agent-files", "/data", {
				endpoint: env.R2_ENDPOINT,
				prefix: `/${sessionId}/`,
				credentials: {
					accessKeyId: env.R2_ACCESS_KEY_ID,
					secretAccessKey: env.R2_SECRET_ACCESS_KEY,
				},
			});

			// Upload input files to R2 under session prefix — they appear at /data/input/ in sandbox
			const fileNames: string[] = [];
			if (files.length > 0) {
				for (const file of files) {
					const key = `${sessionId}/input/${file.name}`;
					await env.FILES.put(key, await file.arrayBuffer());
					fileNames.push(file.name);
				}
			}

			const agent = new Agent({
				initialState: {
					systemPrompt: SYSTEM_PROMPT,
					model: getModel("openrouter", "google/gemini-3-flash-preview"),
					thinkingLevel: "off",
					tools: [
						createR2ReadTool(env.FILES),
						createR2WriteTool(env.FILES),
						createR2EditTool(env.FILES),
						createR2LsTool(env.FILES),
						createExecuteTool(env.LOADER, createFfmpegHelpers(sandbox), { bucket: env.FILES }),
					],
				},
				getApiKey: async () => env.OPENROUTER_API_KEY,
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") toolCalls.push((e as any).toolName);
			});

			const userPrompt = files.length > 0
				? `Input files in R2 at input/: ${fileNames.join(", ")} (available in sandbox at /data/input/)\n\n${prompt}`
				: prompt;

			await agent.prompt(userPrompt);

			// Output files are already in R2 under sessionId/output/ — just sign them
			const listed = await env.FILES.list({ prefix: `${sessionId}/output/` });
			const response = lastText(agent);

			if (listed.objects.length === 0) {
				return Response.json({ response, toolCalls, error: agent.state.error });
			}

			const outputUrls: Record<string, string> = {};
			for (const obj of listed.objects) {
				const name = obj.key.replace(`${sessionId}/output/`, "");
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
