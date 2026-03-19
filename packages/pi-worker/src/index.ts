/**
 * pi-worker — Run pi-mono agents in Cloudflare Workers.
 *
 * Four primitives:
 * 1. R2-backed file tools (read, write, edit, ls) with optional prefix for tenant isolation
 * 2. Generic execute tool (run code in a Dynamic Worker Loader with injected helpers)
 * 3. Signed download URLs (store, sign, serve)
 * 4. Validation noop (wrangler alias target for ajv workaround)
 */

// R2 file tools
export {
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
	type R2ToolOptions,
	// Exported for testing
	sanitizePath,
	normalizeForFuzzyMatch,
	fuzzyFindText,
	generateDiffString,
} from "./r2-tools.js";

// In-memory file tools
export {
	createMemoryReadTool,
	createMemoryWriteTool,
	createMemoryEditTool,
	createMemoryLsTool,
	createMemoryTools,
	type MemoryToolOptions,
} from "./memory-tools.js";

// Code execution tool
export { createExecuteTool, type ExecuteToolHelpers, type ExecuteToolOptions } from "./execute-tool.js";

// shadcn/ui component installer
export { createShadcnTool, type ShadcnToolOptions } from "./shadcn-tool.js";

// Signed download URLs
export { createDownloadHandler, type DownloadHandler, type StoreOptions } from "./downloads.js";

// Re-exports from pi-mono
export { Agent } from "@mariozechner/pi-agent-core";
export { getModel } from "@mariozechner/pi-ai";
