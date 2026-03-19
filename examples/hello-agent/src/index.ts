/**
 * Minimal micro agent example.
 *
 * POST { prompt } → agent reads/writes files in R2 → returns response.
 */

import { createMicroAgent } from "pi-worker";

interface Env {
	ANTHROPIC_API_KEY: string;
	FILES: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ usage: "POST { prompt: string }" });
		}

		const { prompt: userPrompt } = (await request.json()) as { prompt?: string };
		if (!userPrompt) return Response.json({ error: "Missing 'prompt'" }, { status: 400 });

		const { prompt, getResponse } = createMicroAgent({
			bucket: env.FILES,
			apiKey: env.ANTHROPIC_API_KEY,
			systemPrompt: "You are a helpful coding assistant. Use the file tools to read, write, edit, and list files.",
		});

		await prompt(userPrompt);

		return Response.json({ response: getResponse() });
	},
};
