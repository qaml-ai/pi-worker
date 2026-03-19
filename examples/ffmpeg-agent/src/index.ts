/**
 * FFmpeg Agent — pi-mono agent with R2 file tools + code execution.
 *
 * The agent writes JavaScript that calls ffmpeg()/ffprobe() helpers.
 * Code runs in a Dynamic Worker Loader. Helpers proxy to a Sandbox container.
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
}

function createFfmpegHelpers(sandbox: ReturnType<typeof getSandbox>) {
	return {
		async ffmpeg(args: string) {
			await sandbox.mkdir("/workspace/output", { recursive: true });
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
			const r = await sandbox.exec("ls -la /workspace/output/ 2>/dev/null || echo '(empty)'");
			return r.stdout;
		},
	};
}

const SYSTEM_PROMPT = `You are a media processing agent with ffmpeg and a file system.

Tools:
- read, write, edit, ls: manage files in R2 storage
- execute: run JavaScript code with ffmpeg helpers

The "execute" tool runs code with these helpers:
  await ffmpeg("-i /workspace/input.mp4 -vf scale=480:-1 /workspace/output/out.gif")
  await ffprobe("/workspace/input.mp4")
  await listOutputs()

Input files uploaded by the user are at /workspace/<filename>.
You can pass URLs directly to ffmpeg: ffmpeg("-i https://example.com/video.mp4 ...")
Always write outputs to /workspace/output/. Always use -y flag.

You can write scripts to R2, iterate with edit, then run them with execute({ file: "path" }).`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const downloads = createDownloadHandler(env.FILES, env.DOWNLOAD_SECRET);

		// Serve signed download links
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
			// Upload input files to sandbox
			const fileNames: string[] = [];
			if (files.length > 0) {
				await sandbox.mkdir("/workspace", { recursive: true });
				for (const file of files) {
					const buf = await file.arrayBuffer();
					const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
					await sandbox.writeFile(`/workspace/${file.name}`, base64, { encoding: "base64" });
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
				? `Input files at /workspace/: ${fileNames.join(", ")}\n\n${prompt}`
				: prompt;

			await agent.prompt(userPrompt);

			// Collect outputs → store in R2 → return signed URLs
			const lsResult = await sandbox.exec("ls /workspace/output/ 2>/dev/null");
			const outputNames = lsResult.stdout.trim().split("\n").filter(Boolean);
			const response = lastText(agent);

			if (outputNames.length === 0) {
				return Response.json({ response, toolCalls, error: agent.state.error });
			}

			const mimeTypes: Record<string, string> = {
				mp4: "video/mp4", webm: "video/webm", gif: "image/gif",
				png: "image/png", jpg: "image/jpeg", mp3: "audio/mpeg",
				wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
			};

			const outputUrls: Record<string, string> = {};
			for (const name of outputNames) {
				const f = await sandbox.readFile(`/workspace/output/${name}`, { encoding: "base64" });
				const bin = Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0));
				const ext = name.split(".").pop() || "bin";
				const key = `${sessionId}/${name}`;
				const path = await downloads.store(key, bin, {
					contentType: mimeTypes[ext] || "application/octet-stream",
					filename: name,
				});
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
