/**
 * Generic code execution tool using Dynamic Worker Loaders.
 *
 * The agent writes JavaScript code that calls typed helper functions
 * you provide. The code runs in an isolated V8 isolate — no network,
 * no filesystem, just the helpers you inject.
 *
 * @example
 * ```ts
 * const execute = createExecuteTool(env.LOADER, {
 *   ffmpeg: async (args: string) => { ... },
 *   ffprobe: async (path: string) => { ... },
 * });
 * ```
 *
 * The agent can then:
 * - Pass inline code: execute({ code: 'return await ffmpeg("-i in.mp4 out.gif")' })
 * - Pass a file from R2: execute({ file: "scripts/convert.js" })
 *   The file should export default async ({ ffmpeg, ffprobe }) => { ... }
 */

import { Type, type Static } from "@sinclair/typebox";

/** Map of helper function names to their implementations. */
export type ExecuteToolHelpers = Record<string, (...args: any[]) => Promise<any>>;

interface WorkerLoader {
	get(id: string, cb: () => any): { getEntrypoint(name: string): any };
}

const executeSchema = Type.Object({
	code: Type.Optional(Type.String({
		description: "Inline JavaScript to execute. Write the body of an async function — helper functions are available as globals. Use 'return' for results.",
	})),
	file: Type.Optional(Type.String({
		description: "Path to a .js/.ts file in R2 to execute. The file should export a default async function that receives the helpers object.",
	})),
});

export interface ExecuteToolOptions {
	/** R2 bucket for reading script files. Required if you want file execution. */
	bucket?: R2Bucket;
	/** Custom tool name. Default: "execute" */
	name?: string;
	/** Custom tool description. Auto-generated from helper names if not provided. */
	description?: string;
}

/**
 * Create a code execution tool backed by Dynamic Worker Loaders.
 *
 * @param loader - The WorkerLoader binding from wrangler config
 * @param helpers - Map of function names to implementations. These become
 *                  globals in the executed code.
 * @param options - Optional configuration
 */
export function createExecuteTool(
	loader: WorkerLoader,
	helpers: ExecuteToolHelpers,
	options?: ExecuteToolOptions,
) {
	let callCount = 0;
	const helperNames = Object.keys(helpers);

	const defaultDescription =
		`Execute JavaScript code in an isolated V8 sandbox.\n\n` +
		`Available functions in your code:\n` +
		helperNames.map((n) => `- ${n}()`).join("\n") +
		`\n\nFor inline code: write the body of an async function. Use 'return' for results.\n` +
		`For file execution: pass a path to a script in R2 that exports a default async function receiving { ${helperNames.join(", ")} }.`;

	return {
		name: options?.name ?? ("execute" as const),
		label: options?.name ?? "execute",
		description: options?.description ?? defaultDescription,
		parameters: executeSchema,
		execute: async (
			_id: string,
			{ code, file }: Static<typeof executeSchema>,
		) => {
			let sourceCode: string;

			if (file) {
				if (!options?.bucket) throw new Error("R2 bucket required for file execution");
				const key = file.replace(/^\/+/, "");
				const obj = await options.bucket.get(key);
				if (!obj) throw new Error(`File not found: ${file}`);
				sourceCode = await obj.text();

				// Wrap: call the default export with helpers
				sourceCode = `
${sourceCode}

if (typeof module !== 'undefined' && module.default) {
  return await module.default({ ${helperNames.join(", ")} });
}`;
			} else if (code) {
				sourceCode = code;
			} else {
				throw new Error("Provide either 'code' (inline) or 'file' (R2 path)");
			}

			// Build the helper destructuring for the module
			const helperParams = helperNames.join(", ");

			const moduleSource = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class Runner extends WorkerEntrypoint {
  async run(helpers) {
    const { ${helperParams} } = helpers;
    ${sourceCode}
  }
}

export default {
  fetch() { return new Response("executor"); }
};
`;

			const id = `exec-${++callCount}-${Date.now()}`;

			try {
				const stub = loader.get(`sandbox-${id}`, () => ({
					compatibilityDate: "2025-06-01",
					compatibilityFlags: ["nodejs_compat"],
					mainModule: "main.js",
					modules: { "main.js": moduleSource },
					globalOutbound: null,
					env: {},
				}));

				const runner = stub.getEntrypoint("Runner");
				const result = await runner.run(helpers);

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
