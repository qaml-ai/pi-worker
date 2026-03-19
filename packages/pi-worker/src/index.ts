/**
 * pi-worker — Run pi-mono agents in Cloudflare Workers.
 *
 * Three things:
 * 1. R2-backed file tools (read, write, edit, ls)
 * 2. Generic execute tool (run code in a Dynamic Worker Loader with injected helpers)
 * 3. Validation noop (wrangler alias target for ajv workaround)
 */

// R2 file tools
export { createR2ReadTool, createR2WriteTool, createR2EditTool, createR2LsTool } from "./r2-tools.js";

// Code execution tool
export { createExecuteTool, type ExecuteToolHelpers } from "./execute-tool.js";

// Signed download URLs
export { createDownloadHandler, type DownloadHandler, type StoreOptions } from "./downloads.js";

// Re-exports from pi-mono for convenience
export { Agent } from "@mariozechner/pi-agent-core";
export { getModel } from "@mariozechner/pi-ai";
