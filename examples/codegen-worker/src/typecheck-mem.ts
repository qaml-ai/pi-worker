/**
 * Type-check files from an in-memory Map.
 * Fetches .d.ts files for npm dependencies from unpkg.
 */

import { typeCheck, type TypeCheckResult } from "./typecheck.js";
import { fetchDependencyTypes } from "./fetch-types.js";

/**
 * Type-check all .ts files from a Map, stripping a prefix.
 * Fetches npm dependency types if package.json is present.
 */
export async function typeCheckFromMap(
	allFiles: Map<string, string>,
	prefix: string,
): Promise<TypeCheckResult> {
	const files = new Map<string, string>();

	for (const [key, content] of allFiles) {
		if (!key.startsWith(prefix)) continue;
		const rel = key.slice(prefix.length);
		if (!rel) continue;
		if (
			rel.endsWith(".ts") || rel.endsWith(".tsx") ||
			rel.endsWith("wrangler.jsonc") || rel.endsWith("wrangler.json") ||
			rel.endsWith("package.json")
		) {
			files.set(rel, content);
		}
	}

	if (files.size === 0) {
		return { success: true, diagnostics: [] };
	}

	// Fetch .d.ts files for npm dependencies
	let typesFetched: string[] = [];
	let typesFailed: string[] = [];
	if (files.has("package.json")) {
		const r = await fetchDependencyTypes(files);
		typesFetched = r.fetched;
		typesFailed = r.failed;
	}

	// Debug: check what's in files after fetch
	const nmCount = [...files.keys()].filter((k) => k.startsWith("node_modules/")).length;
	if (nmCount > 0) console.log(`[typecheck-mem] ${nmCount} node_modules files after fetch`);

	const result = typeCheck(files);

	// Attach fetch info for debugging
	(result as any).typesFetched = typesFetched;
	(result as any).typesFailed = typesFailed;

	return result;
}
