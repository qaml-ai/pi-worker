/**
 * FFmpeg Agent — pi-mono agent with R2 file tools + code execution.
 *
 * The agent can:
 * 1. Manage files in R2 (read, write, edit, ls)
 * 2. Write scripts and execute them via Dynamic Worker Loader
 * 3. The executed code has typed helpers: ffmpeg(), ffprobe(), listOutputs()
 *    that proxy to a Sandbox container
 *
 * POST multipart/form-data:
 *   - prompt: what to do
 *   - file: input files (optional — can also use URLs)
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { createR2ReadTool, createR2WriteTool, createR2EditTool, createR2LsTool } from "pi-worker";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	OPENROUTER_API_KEY: string;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	LOADER: any;
	FILES: R2Bucket;
}

// ---------------------------------------------------------------------------
// Execute tool — runs code in a Dynamic Worker Loader with ffmpeg helpers
// ---------------------------------------------------------------------------

const executeSchema = Type.Object({
	code: Type.Optional(Type.String({
		description: "Inline JavaScript code to execute. The code is an async function body with helpers available: ffmpeg(args), ffprobe(path), listOutputs(). Use 'return' to return results.",
	})),
	file: Type.Optional(Type.String({
		description: "Path to a .js or .ts file in R2 to execute. The file should export a default async function that receives { ffmpeg, ffprobe, listOutputs } as its argument.",
	})),
});

function createExecuteTool(
	env: Env,
	sandbox: ReturnType<typeof getSandbox>,
	bucket: R2Bucket,
) {
	let callCount = 0;

	// The helper functions that code can call — proxied to the sandbox
	async function ffmpeg(args: string) {
		await sandbox.mkdir("/workspace/output", { recursive: true });
		const result = await sandbox.exec(`ffmpeg -y ${args}`, { timeout: 120_000 });
		return result.success
			? { success: true, stderr: result.stderr.slice(-1000) }
			: { success: false, exitCode: result.exitCode, stderr: result.stderr.slice(-2000) };
	}

	async function ffprobe(path: string) {
		const result = await sandbox.exec(
			`ffprobe -v quiet -print_format json -show_format -show_streams "${path}"`,
			{ timeout: 30_000 },
		);
		return result.success
			? { success: true, metadata: JSON.parse(result.stdout) }
			: { success: false, error: result.stderr.slice(-1000) };
	}

	async function listOutputs() {
		const result = await sandbox.exec("ls -la /workspace/output/ 2>/dev/null || echo '(empty)'");
		return result.stdout;
	}

	return {
		name: "execute" as const,
		label: "execute",
		description:
			"Execute JavaScript code with ffmpeg helpers. Either pass inline code, or a path to a script file in R2.\n\n" +
			"Available helpers in your code:\n" +
			"- await ffmpeg(args: string) — run ffmpeg (without 'ffmpeg' prefix). Returns { success, stderr } or { success, exitCode, stderr }\n" +
			"- await ffprobe(path: string) — inspect media file. Returns { success, metadata } or { success, error }\n" +
			"- await listOutputs() — list files in /workspace/output/\n\n" +
			"For inline code: write the body of an async function. Use 'return' for results.\n" +
			"For file execution: the file should export a default async function receiving { ffmpeg, ffprobe, listOutputs }.",
		parameters: executeSchema,
		execute: async (
			_id: string,
			{ code, file }: Static<typeof executeSchema>,
		) => {
			let sourceCode: string;

			if (file) {
				// Read script from R2
				const key = file.replace(/^\/+/, "");
				const obj = await bucket.get(key);
				if (!obj) throw new Error(`File not found in R2: ${file}`);
				const fileContent = await obj.text();

				// Wrap file content: assume it exports default async function
				sourceCode = `
${fileContent}

// If the file has a default export, call it with the helpers
if (typeof module !== 'undefined' && module.default) {
  return await module.default({ ffmpeg, ffprobe, listOutputs });
}
`;
			} else if (code) {
				sourceCode = code;
			} else {
				throw new Error("Provide either 'code' (inline) or 'file' (R2 path)");
			}

			// Build module source for the Dynamic Worker Loader
			const id = `exec-${++callCount}-${Date.now()}`;
			const moduleSource = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class Runner extends WorkerEntrypoint {
  async run(helpers) {
    const ffmpeg = helpers.ffmpeg;
    const ffprobe = helpers.ffprobe;
    const listOutputs = helpers.listOutputs;

    ${sourceCode}
  }
}

export default {
  fetch() { return new Response("executor"); }
};
`;

			try {
				const stub = env.LOADER.get(`sandbox-${id}`, () => ({
					compatibilityDate: "2025-06-01",
					compatibilityFlags: ["nodejs_compat"],
					mainModule: "main.js",
					modules: { "main.js": moduleSource },
					globalOutbound: null,
					env: {},
				}));

				const runner = stub.getEntrypoint("Runner");
				const result = await runner.run({ ffmpeg, ffprobe, listOutputs });

				const output = typeof result === "string"
					? result
					: JSON.stringify(result, null, 2);

				return {
					content: [{ type: "text" as const, text: output ?? "(no return value)" }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Execution error: ${err.message}` }],
					details: {},
				};
			}
		},
	};
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a media processing agent with ffmpeg and a file system.

Tools:
- read, write, edit, ls: manage files in R2 storage
- execute: run JavaScript code with ffmpeg helpers

The "execute" tool lets you write code that calls:
  await ffmpeg("-i /workspace/input.mp4 -vf scale=480:-1 /workspace/output/out.gif")
  await ffprobe("/workspace/input.mp4")
  await listOutputs()

Input files uploaded by the user are pre-loaded at /workspace/<filename>.
You can also pass URLs directly to ffmpeg: ffmpeg("-i https://example.com/video.mp4 ...")
Always write outputs to /workspace/output/.
Always use -y flag in ffmpeg args.

You can also write scripts to R2 with "write" and execute them with execute({ file: "path" }).
Scripts should export a default async function: export default async ({ ffmpeg, ffprobe, listOutputs }) => { ... }`;

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

			const model = getModel("openrouter", "google/gemini-3-flash-preview");

			const tools: any[] = [
				createR2ReadTool(env.FILES),
				createR2WriteTool(env.FILES),
				createR2EditTool(env.FILES),
				createR2LsTool(env.FILES),
				createExecuteTool(env, sandbox, env.FILES),
			];

			const agent = new Agent({
				initialState: {
					systemPrompt: SYSTEM_PROMPT,
					model,
					thinkingLevel: "off",
					tools,
				},
				getApiKey: async () => env.OPENROUTER_API_KEY,
			});

			const toolCalls: string[] = [];
			agent.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					toolCalls.push((e as any).toolName);
				}
			});

			const userPrompt = files.length > 0
				? `Input files at /workspace/: ${fileNames.join(", ")}\n\n${prompt}`
				: prompt;

			await agent.prompt(userPrompt);

			// Collect output files from sandbox
			const lsResult = await sandbox.exec("ls /workspace/output/ 2>/dev/null");
			const outputNames = lsResult.stdout.trim().split("\n").filter(Boolean);

			const response = getLastText(agent);

			if (outputNames.length === 0) {
				return Response.json({ response, toolCalls, error: agent.state.error });
			}

			// Single file → return binary
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

			// Multiple files → JSON with base64
			const outputs: Record<string, string> = {};
			for (const name of outputNames) {
				const file = await sandbox.readFile(`/workspace/output/${name}`, { encoding: "base64" });
				outputs[name] = file.content;
			}
			return Response.json({ files: outputs, response, toolCalls });
		} catch (error: any) {
			return Response.json({ error: error.message }, { status: 500 });
		}
	},
};

function getLastText(agent: Agent): string {
	const msgs = agent.state.messages.filter((m) => m.role === "assistant");
	const last = msgs[msgs.length - 1];
	return last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
}
