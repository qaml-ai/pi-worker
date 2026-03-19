/**
 * Type-check files from an in-memory Map instead of R2.
 * Wraps the existing typeCheck function.
 */

import { typeCheck, type TypeCheckResult } from "./typecheck.js";

/**
 * Type-check all .ts files from a Map, stripping a prefix to get relative paths.
 */
export function typeCheckFromMap(
	allFiles: Map<string, string>,
	prefix: string,
): TypeCheckResult {
	const files = new Map<string, string>();

	for (const [key, content] of allFiles) {
		if (!key.startsWith(prefix)) continue;
		const rel = key.slice(prefix.length);
		if (!rel) continue;
		// Include .ts files and config files (for binding type generation)
		if (rel.endsWith(".ts") || rel.endsWith(".tsx") || rel.endsWith("wrangler.jsonc") || rel.endsWith("wrangler.json") || rel.endsWith("package.json")) {
			files.set(rel, content);
		}
	}

	if (files.size === 0) {
		return { success: true, diagnostics: [] };
	}

	return typeCheck(files);
}
