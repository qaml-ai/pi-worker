/**
 * Drop-in replacement for @mariozechner/pi-ai's validation module.
 * Skips ajv schema validation (which uses new Function() and fails in Workers).
 * Tool arguments are trusted from the LLM without runtime validation.
 */

export function validateToolCall(tools: any[], toolCall: any) {
	const tool = tools.find((t: any) => t.name === toolCall.name);
	if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
	return toolCall.arguments;
}

export function validateToolArguments(_tool: any, toolCall: any) {
	return toolCall.arguments;
}
