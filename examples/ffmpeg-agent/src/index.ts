/**
 * FFmpeg Agent — an AI agent with ffmpeg, shell access, and file tools.
 *
 * Uses Cloudflare Sandbox SDK to run ffmpeg in a container, and pi-worker
 * for the agent loop + R2 file storage.
 *
 * POST { prompt, inputKey? } → agent processes media → returns output R2 keys
 */

import { createMicroAgent, getModel } from "pi-worker";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
	createFfmpegTool,
	createExecTool,
	createUploadTool,
	createDownloadTool,
	createSandboxLsTool,
	createSandboxReadTool,
	createSandboxWriteTool,
} from "./sandbox-tools.js";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	OPENROUTER_API_KEY: string;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	FILES: R2Bucket;
}

const SYSTEM_PROMPT = `You are a media processing agent with access to ffmpeg and a full Linux sandbox.

You can:
- Run ffmpeg commands to convert, transcode, resize, trim, merge, and process video/audio
- Execute shell commands for file inspection (ffprobe, file, ls, etc.)
- Upload files from R2 storage into the sandbox for processing
- Download processed files from the sandbox back to R2 storage
- Read and write text files (scripts, configs, subtitles, etc.) in the sandbox

Workflow for processing media:
1. Upload the input file from R2 to the sandbox using the "upload" tool
2. Inspect it with ffprobe if needed (via "exec")
3. Run ffmpeg commands to process it
4. Download the output from the sandbox to R2 using the "download" tool

Files in the sandbox live at /workspace/. Always use absolute paths.
Always use ffmpeg -y flag to overwrite output files without prompting.`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({
				usage: "POST { prompt, inputKey? }",
				description: "AI agent with ffmpeg in a Cloudflare Sandbox container",
				example: {
					prompt: "Convert this video to a 480p GIF",
					inputKey: "uploads/video.mp4",
				},
			});
		}

		const body = (await request.json()) as { prompt?: string; inputKey?: string };
		if (!body.prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

		const sessionId = `ffmpeg-${Date.now()}`;

		try {
			const sandbox = getSandbox(env.SANDBOX, sessionId);

			// Create sandbox tools
			const sandboxTools = [
				createFfmpegTool(sandbox),
				createExecTool(sandbox),
				createUploadTool(sandbox, env.FILES),
				createDownloadTool(sandbox, env.FILES),
				createSandboxLsTool(sandbox),
				createSandboxReadTool(sandbox),
				createSandboxWriteTool(sandbox),
			];

			// Build the prompt — include the input file reference if provided
			let userPrompt = body.prompt;
			if (body.inputKey) {
				userPrompt = `The input file is in R2 at key "${body.inputKey}". ${body.prompt}`;
			}

			const { agent, prompt, getResponse } = createMicroAgent({
				bucket: env.FILES,
				apiKey: env.OPENROUTER_API_KEY,
				model: getModel("openrouter", "google/gemini-3-flash-preview"),
				systemPrompt: SYSTEM_PROMPT,
				tools: sandboxTools,
				fileTools: false, // Don't include R2 file tools — we use sandbox tools instead
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					const ev = e as any;
					toolCalls.push(ev.toolName);
				}
			});

			await prompt(userPrompt);

			return Response.json({
				response: getResponse(),
				toolCalls,
				error: agent.state.error,
			});
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};
