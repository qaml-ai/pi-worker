/**
 * Minimal micro agent — just R2 file tools + pi-mono Agent.
 */

import {
	Agent,
	getModel,
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
} from "pi-worker";

interface Env {
	OPENROUTER_API_KEY: string;
	FILES: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ usage: "POST { prompt: string }" });
		}

		const { prompt } = (await request.json()) as { prompt?: string };
		if (!prompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful coding assistant. Use the file tools to manage files in storage.",
				model: getModel("openrouter", "google/gemini-3-flash-preview"),
				thinkingLevel: "off",
				tools: [
					createR2ReadTool(env.FILES),
					createR2WriteTool(env.FILES),
					createR2EditTool(env.FILES),
					createR2LsTool(env.FILES),
				],
			},
			getApiKey: async () => env.OPENROUTER_API_KEY,
		});

		await agent.prompt(prompt);

		const msgs = agent.state.messages.filter((m) => m.role === "assistant");
		const last = msgs[msgs.length - 1];
		const response = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";

		return Response.json({ response });
	},
};
