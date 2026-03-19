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
	createUploadTool,
	createDownloadTool,
} from "./sandbox-tools.js";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	OPENROUTER_API_KEY: string;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	FILES: R2Bucket;
}

const SYSTEM_PROMPT = `You are a media processing agent with access to ffmpeg and a full Linux sandbox.

Files are stored in R2. Use "ls", "read", "write", "edit" to manage them.

To process media with ffmpeg:
1. Use "ls" to find the input file in R2
2. Use "upload" to copy it into the sandbox at /workspace/
3. Use "ffmpeg" to process it
4. Use "download" to save the output back to R2

Always use absolute paths in the sandbox (/workspace/).
Always use the -y flag in ffmpeg arguments.`;

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

			const sandboxTools = [
				createFfmpegTool(sandbox),
				createUploadTool(sandbox, env.FILES),
				createDownloadTool(sandbox, env.FILES),
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
				fileTools: true, // R2 tools (read, write, edit, ls) + sandbox tools
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
