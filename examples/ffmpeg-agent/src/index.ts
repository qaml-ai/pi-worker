/**
 * FFmpeg Agent — the LLM writes a TypeScript function that calls ffmpeg().
 *
 * Uses Codemode so the agent writes code against a typed ffmpeg() API
 * instead of making tool calls. The code runs in an isolated Worker
 * via DynamicWorkerExecutor, and ffmpeg() calls are proxied to a
 * Sandbox container.
 *
 * POST multipart/form-data:
 *   - prompt: what to do (e.g. "extract audio as mp3")
 *   - file: one or more input files (optional — can also use URLs)
 *
 * Returns the processed output file(s) directly.
 */

import { tool } from "ai";
import { z } from "zod/v4";
import { streamText } from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	OPENROUTER_API_KEY: string;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	LOADER: any; // WorkerLoader binding for Codemode executor
}

// ---------------------------------------------------------------------------
// ffmpeg tool definition for Codemode
// ---------------------------------------------------------------------------

function createFfmpegTools(sandbox: ReturnType<typeof getSandbox>) {
	return {
		ffmpeg: tool({
			description:
				"Run an ffmpeg command. Pass the full argument string (without the 'ffmpeg' prefix). " +
				"Input files are at /workspace/<filename> for uploaded files, or use URLs directly. " +
				"Write outputs to /workspace/output/. Always use -y flag.",
			parameters: z.object({
				args: z.string().describe("ffmpeg arguments, e.g. '-i /workspace/input.mp4 -vf scale=480:-1 /workspace/output/out.gif'"),
			}),
			execute: async ({ args }) => {
				await sandbox.mkdir("/workspace/output", { recursive: true });
				const result = await sandbox.exec(`ffmpeg -y ${args}`, { timeout: 120_000 });
				return result.success
					? { success: true, stderr: result.stderr.slice(-1000) }
					: { success: false, exitCode: result.exitCode, stderr: result.stderr.slice(-2000) };
			},
		}),

		ffprobe: tool({
			description: "Inspect a media file with ffprobe. Returns JSON metadata.",
			parameters: z.object({
				path: z.string().describe("Path to file (/workspace/<file>) or URL"),
			}),
			execute: async ({ path }) => {
				const result = await sandbox.exec(
					`ffprobe -v quiet -print_format json -show_format -show_streams "${path}"`,
					{ timeout: 30_000 },
				);
				return result.success
					? { success: true, metadata: JSON.parse(result.stdout) }
					: { success: false, error: result.stderr.slice(-1000) };
			},
		}),

		listOutputs: tool({
			description: "List output files in /workspace/output/",
			parameters: z.object({}),
			execute: async () => {
				const result = await sandbox.exec("ls -la /workspace/output/ 2>/dev/null || echo '(empty)'");
				return { files: result.stdout };
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
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
		if (!prompt) return Response.json({ error: "Missing 'prompt' field" }, { status: 400 });

		const files = formData.getAll("file") as File[];
		const sessionId = `ffmpeg-${Date.now()}`;

		try {
			const sandbox = getSandbox(env.SANDBOX, sessionId);

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

			// Set up Codemode: LLM writes code that calls ffmpeg()/ffprobe()
			const tools = createFfmpegTools(sandbox);
			const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
			const codemode = createCodeTool({ tools, executor });

			const openrouter = createOpenAICompatible({
				baseURL: "https://openrouter.ai/api/v1",
				name: "openrouter",
				apiKey: env.OPENROUTER_API_KEY,
			});

			const systemPrompt = [
				"You are an ffmpeg expert. Write code to process media files.",
				"Available functions: ffmpeg({ args }), ffprobe({ path }), listOutputs({})",
				"Input files are at /workspace/<filename>. You can also pass URLs directly to ffmpeg -i.",
				"Always write outputs to /workspace/output/.",
				files.length > 0 ? `Uploaded files: ${fileNames.join(", ")}` : "No files uploaded — use URLs if the user provides them.",
			].join("\n");

			const result = await streamText({
				model: openrouter("google/gemini-3-flash-preview"),
				system: systemPrompt,
				prompt,
				tools: { codemode },
				maxSteps: 5,
			});

			// Wait for completion
			const response = await result.text;

			// Collect output files
			const lsResult = await sandbox.exec("ls /workspace/output/ 2>/dev/null");
			const outputNames = lsResult.stdout.trim().split("\n").filter(Boolean);

			if (outputNames.length === 0) {
				return Response.json({ error: "No output files produced", response }, { status: 500 });
			}

			// Single file → return it directly
			if (outputNames.length === 1) {
				const file = await sandbox.readFile(`/workspace/output/${outputNames[0]}`, { encoding: "base64" });
				const binary = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
				const ext = outputNames[0].split(".").pop() || "bin";
				const mimeTypes: Record<string, string> = {
					mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
					gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
					mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
				};
				return new Response(binary, {
					headers: {
						"content-type": mimeTypes[ext] || "application/octet-stream",
						"content-disposition": `attachment; filename="${outputNames[0]}"`,
					},
				});
			}

			// Multiple files → return as JSON with base64
			const outputs: Record<string, string> = {};
			for (const name of outputNames) {
				const file = await sandbox.readFile(`/workspace/output/${name}`, { encoding: "base64" });
				outputs[name] = file.content;
			}
			return Response.json({ files: outputs, response });
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};
