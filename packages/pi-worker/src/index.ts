/**
 * pi-worker — Run pi-mono coding agents in Cloudflare Workers.
 *
 * Provides R2-backed file tools and a simple helper to create an Agent
 * that works entirely within the Workers runtime.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { createR2ReadTool, createR2WriteTool, createR2EditTool, createR2LsTool } from "./r2-tools.js";

export { createR2ReadTool, createR2WriteTool, createR2EditTool, createR2LsTool };
export { Agent } from "@mariozechner/pi-agent-core";
export { getModel } from "@mariozechner/pi-ai";

export interface MicroAgentOptions {
	/** R2 bucket for file operations. */
	bucket: R2Bucket;
	/** Anthropic API key (or other provider key). */
	apiKey: string;
	/** System prompt for the agent. */
	systemPrompt: string;
	/** Model to use. Defaults to claude-sonnet-4-20250514. */
	model?: Model<any>;
	/** Additional tools beyond the built-in R2 file tools. */
	tools?: any[];
	/** Prefix for all R2 keys (e.g., "proj_123/"). Scopes file tools to a subdirectory. */
	prefix?: string;
	/** Whether to include R2 file tools (read, write, edit, ls). Defaults to true. */
	fileTools?: boolean;
}

export interface MicroAgentResult {
	/** The pi-mono Agent instance (for subscribing to events, inspecting state, etc.). */
	agent: Agent;
	/** Send a prompt to the agent and wait for completion. */
	prompt: (message: string) => Promise<void>;
	/** Get the last assistant message text. */
	getResponse: () => string;
	/** Get all messages. */
	getMessages: () => any[];
}

/**
 * Create a micro agent with R2-backed file tools.
 *
 * @example
 * ```ts
 * const { prompt, getResponse } = createMicroAgent({
 *   bucket: env.FILES,
 *   apiKey: env.ANTHROPIC_API_KEY,
 *   systemPrompt: "You are a helpful coding assistant.",
 * });
 *
 * await prompt("Create a hello world function in src/index.ts");
 * console.log(getResponse());
 * ```
 */
export function createMicroAgent(options: MicroAgentOptions): MicroAgentResult {
	const {
		bucket,
		apiKey,
		systemPrompt,
		model = getModel("anthropic", "claude-sonnet-4-20250514"),
		tools: extraTools = [],
		prefix,
		fileTools = true,
	} = options;

	const tools: any[] = [];

	if (fileTools) {
		tools.push(
			createR2ReadTool(bucket),
			createR2WriteTool(bucket),
			createR2EditTool(bucket),
			createR2LsTool(bucket),
		);
	}

	tools.push(...extraTools);

	// Build the tool descriptions for the system prompt
	const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
	const fullSystemPrompt = `${systemPrompt}\n\nYou have these tools:\n${toolList}`;

	const agent = new Agent({
		initialState: {
			systemPrompt: fullSystemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		getApiKey: async () => apiKey,
	});

	const prompt = async (message: string) => {
		const fullMessage = prefix ? `File prefix: "${prefix}"\n\n${message}` : message;
		await agent.prompt(fullMessage);
	};

	const getResponse = () => {
		const msgs = agent.state.messages;
		const assistantMsgs = msgs.filter((m) => m.role === "assistant");
		const last = assistantMsgs[assistantMsgs.length - 1];
		return last?.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("") ?? "";
	};

	const getMessages = () => agent.state.messages;

	return { agent, prompt, getResponse, getMessages };
}
