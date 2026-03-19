/**
 * In-memory TypeScript type checking using the compiler API.
 *
 * Uses a custom CompilerHost that reads files from a Map (pre-fetched from R2)
 * instead of the filesystem. TypeScript's compiler is pure JS so this works
 * in Workers.
 */

import ts from "typescript";
import { LIB_SHIM } from "./lib-shim.js";
import { generateBindingTypesFromJsonc } from "./binding-types.js";
import { fetchDependencyTypes } from "./fetch-types.js";

export interface TypeCheckResult {
	success: boolean;
	diagnostics: Array<{
		file?: string;
		line?: number;
		col?: number;
		message: string;
		severity: "error" | "warning" | "info";
	}>;
}

/**
 * Type-check a set of in-memory files.
 * @param files Map of filename → source code (e.g. "src/index.ts" → "export default ...")
 * @param compilerOptions Optional TS compiler options override
 */
export function typeCheck(
	files: Map<string, string>,
	compilerOptions?: ts.CompilerOptions,
): TypeCheckResult {
	// Detect if project has TSX files
	const hasTsx = [...files.keys()].some((f) => f.endsWith(".tsx"));

	const options: ts.CompilerOptions = compilerOptions ?? {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		noEmit: true,
		types: [],
		// Enable JSX if project has .tsx files
		...(hasTsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
	};

	// Inject lib shim for global types
	files.set("lib.d.ts", LIB_SHIM);

	// Auto-generate Env types from wrangler config if present
	const wranglerConfig = files.get("wrangler.jsonc") ?? files.get("wrangler.json");
	if (wranglerConfig) {
		const envTypes = generateBindingTypesFromJsonc(wranglerConfig);
		// Prepend to lib.d.ts so Env is available globally
		files.set("lib.d.ts", LIB_SHIM + "\n" + envTypes);
	}

	const fileNames = [...files.keys()].filter(
		(f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".d.ts"),
	);

	// Build a fileExists that checks all extension variants
	function fileExistsInMemory(fileName: string): boolean {
		return files.has(fileName);
	}

	// Create an in-memory CompilerHost
	const host: ts.CompilerHost = {
		getSourceFile(fileName, languageVersion) {
			const content = files.get(fileName);
			if (content !== undefined) {
				return ts.createSourceFile(fileName, content, languageVersion);
			}
			return undefined;
		},
		getDefaultLibFileName: () => "lib.d.ts",
		writeFile: () => {},
		getCurrentDirectory: () => "",
		getCanonicalFileName: (f) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: fileExistsInMemory,
		readFile: (fileName) => files.get(fileName),
		directoryExists: (dirName) => {
			const prefix = dirName.endsWith("/") ? dirName : dirName + "/";
			for (const key of files.keys()) {
				if (key.startsWith(prefix)) return true;
			}
			return false;
		},
		getDirectories: () => [],
	};

	const program = ts.createProgram(fileNames, options, host);
	const allDiagnostics = ts.getPreEmitDiagnostics(program);

	const diagnostics = allDiagnostics
		.filter((d) => {
			const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
			// Skip "Cannot find module" for non-relative imports (external packages)
			if (msg.includes("Cannot find module") && !msg.includes("./") && !msg.includes("../")) return false;
			return true;
		})
		.map((d) => {
			let file: string | undefined;
			let line: number | undefined;
			let col: number | undefined;

			if (d.file && d.start !== undefined) {
				file = d.file.fileName;
				const pos = d.file.getLineAndCharacterOfPosition(d.start);
				line = pos.line + 1;
				col = pos.character + 1;
			}

			return {
				file,
				line,
				col,
				message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
				severity: (d.category === ts.DiagnosticCategory.Error
					? "error"
					: d.category === ts.DiagnosticCategory.Warning
						? "warning"
						: "info") as "error" | "warning" | "info",
			};
		});

	const errors = diagnostics.filter((d) => d.severity === "error");

	return {
		success: errors.length === 0,
		diagnostics,
	};
}

/**
 * Fetch all .ts files from R2 under a prefix and type-check them.
 */
export async function typeCheckR2Project(
	bucket: R2Bucket,
	prefix: string,
): Promise<TypeCheckResult & { typesFetched?: string[]; typesFailed?: string[] }> {
	const files = new Map<string, string>();

	let cursor: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const listed = await bucket.list({ prefix, cursor, limit: 500 });

		for (const obj of listed.objects) {
			// Grab .ts files AND package.json + wrangler config for type generation
			const key = obj.key;
			const isRelevant =
				key.endsWith(".ts") || key.endsWith(".tsx") ||
				key.endsWith("package.json") || key.endsWith("wrangler.jsonc") || key.endsWith("wrangler.json");
			if (!isRelevant) continue;
			const body = await bucket.get(key);
			if (!body) continue;
			const relativePath = obj.key.slice(prefix.length);
			files.set(relativePath, await body.text());
		}

		hasMore = listed.truncated;
		if (listed.truncated && listed.cursor) cursor = listed.cursor;
	}

	if (files.size === 0) {
		return { success: true, diagnostics: [] };
	}

	// Fetch .d.ts files for npm dependencies
	const { fetched, failed } = await fetchDependencyTypes(files);

	const result = typeCheck(files);
	return { ...result, typesFetched: fetched, typesFailed: failed };
}
