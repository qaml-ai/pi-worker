/**
 * Drop-in replacement for @mariozechner/pi-ai's validation module.
 * Skips ajv schema validation (which uses new Function() and fails in Workers).
 *
 * Configured via wrangler alias:
 *   "alias": { "@mariozechner/pi-ai/dist/utils/validation.js": "pi-worker/dist/validation-noop.js" }
 *
 * Remove once https://github.com/badlogic/pi-mono/pull/2396 is merged.
 */

let warned = false;

export function validateToolCall(tools: any[], toolCall: any) {
	const tool = tools.find((t: any) => t.name === toolCall.name);
	if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
	return toolCall.arguments;
}

export function validateToolArguments(_tool: any, toolCall: any) {
	if (!warned) {
		console.warn("[pi-worker] ajv validation disabled — using validation-noop. Remove alias once pi-mono#2396 is merged.");
		warned = true;
	}
	return toolCall.arguments;
}
