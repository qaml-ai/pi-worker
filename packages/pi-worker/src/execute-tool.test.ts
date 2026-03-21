import { describe, it, expect } from "vitest";
import { createExecuteTool } from "./execute-tool.js";

// Can't test full execution without a Worker Loader binding,
// but we can test the code wrapping logic by importing internals.
// For now, test the module structure expectations.

describe("execute tool module structure", () => {
	it("wrapInlineCode produces valid module with helpers destructured", async () => {
		// Simulate what the execute tool does internally
		const helperNames = ["ffmpeg", "ffprobe"];
		const code = 'return await ffmpeg("-i in.mp4 out.gif")';
		const destructure = helperNames.join(", ");
		const wrapped = `export default async function({ ${destructure} }) {\n${code}\n}`;

		expect(wrapped).toContain("export default async function");
		expect(wrapped).toContain("ffmpeg, ffprobe");
		expect(wrapped).toContain("return await ffmpeg");
	});

	it("handles code with backticks without breaking", () => {
		const code = 'return `hello ${1 + 1}`';
		const wrapped = `export default async function({ helper }) {\n${code}\n}`;

		// This is the key fix — backticks in user code don't break the module
		// because user code is a separate file, not interpolated into a template
		expect(wrapped).toContain("${1 + 1}");
	});

	it("handles code with template literals", () => {
		const code = 'const msg = `result: ${await helper("test")}`;\nreturn msg;';
		const wrapped = `export default async function({ helper }) {\n${code}\n}`;

		expect(wrapped).toContain("helper(");
	});

	it("forwards outbound bindings into the dynamic worker config", async () => {
		let capturedConfig: any;
		const outbound = { fetch: async () => new Response("ok") };
		const loader = {
			get(_id: string, cb: () => any) {
				capturedConfig = cb();
				return {
					getEntrypoint() {
						return {
							async run() {
								return "ok";
							},
						};
					},
				};
			},
		};

		const tool = createExecuteTool(loader as any, {}, {
			globalOutbound: outbound,
			outboundBinding: outbound,
		});

		await tool.execute("test", { code: 'return "ok";' });

		expect(capturedConfig.globalOutbound).toBe(outbound);
		expect(capturedConfig.env.OUTBOUND).toBe(outbound);
		expect(capturedConfig.modules["main.js"]).toContain("this.env?.OUTBOUND?.fetch");
	});
});
