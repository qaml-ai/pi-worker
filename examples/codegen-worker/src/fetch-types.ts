/**
 * Fetch type declarations for npm packages.
 *
 * Uses the TypeScript compiler's AST to:
 * 1. Scan user source files for external import specifiers
 * 2. Fetch entry-point .d.ts files from unpkg
 * 3. Recursively follow internal relative imports within fetched .d.ts files
 *
 * This means if hono/index.d.ts imports ./context.d.ts which imports
 * ./types.d.ts, all three are fetched automatically.
 */

import ts from "typescript";

const UNPKG = "https://unpkg.com";
const FETCH_TIMEOUT_MS = 5000;
const MAX_DEPTH = 10; // prevent infinite loops
const MAX_FILES_PER_PACKAGE = 50; // cap fetches per package

interface PkgJson {
	types?: string;
	typings?: string;
	exports?: Record<string, any>;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export async function fetchDependencyTypes(
	files: Map<string, string>,
): Promise<{ fetched: string[]; failed: string[] }> {
	const pkgJsonContent = files.get("package.json");
	if (!pkgJsonContent) return { fetched: [], failed: [] };

	let deps: Record<string, string>;
	try {
		deps = JSON.parse(pkgJsonContent).dependencies ?? {};
	} catch {
		return { fetched: [], failed: [] };
	}

	// Scan user source files for external import specifiers using TS AST
	const importPaths = scanImports(files);

	// Group by package name
	const packageImports = new Map<string, Set<string>>();
	for (const path of importPaths) {
		const pkgName = path.startsWith("@")
			? path.split("/").slice(0, 2).join("/")
			: path.split("/")[0];
		if (!deps[pkgName]) continue;
		if (!packageImports.has(pkgName)) packageImports.set(pkgName, new Set());
		packageImports.get(pkgName)!.add(path);
	}

	// If project has React, ensure jsx-runtime is fetched (TS injects this import for jsx: react-jsx)
	if (deps["react"] && !importPaths.has("react/jsx-runtime")) {
		importPaths.add("react");
		importPaths.add("react/jsx-runtime");
		if (!packageImports.has("react")) packageImports.set("react", new Set());
		packageImports.get("react")!.add("react");
		packageImports.get("react")!.add("react/jsx-runtime");
	}

	const fetched: string[] = [];
	const failed: string[] = [];

	await Promise.allSettled(
		[...packageImports.entries()].map(async ([pkgName, paths]) => {
			const version = deps[pkgName].replace(/^[\^~>=<]+/, "");
			const ok = await fetchPackageTypes(pkgName, version, paths, files);
			if (ok) {
				fetched.push(...paths);
			} else {
				failed.push(pkgName);
			}
		}),
	);

	return { fetched, failed };
}

// -------------------------------------------------------------------------
// Import scanning (TS AST)
// -------------------------------------------------------------------------

function scanImports(files: Map<string, string>): Set<string> {
	const importPaths = new Set<string>();
	for (const [key, content] of files) {
		if (!key.endsWith(".ts") && !key.endsWith(".tsx")) continue;
		const sf = ts.createSourceFile(key, content, ts.ScriptTarget.Latest, false);
		ts.forEachChild(sf, function visit(node) {
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				const s = node.moduleSpecifier.text;
				if (!s.startsWith(".") && !s.startsWith("/")) importPaths.add(s);
			}
			if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				const s = node.moduleSpecifier.text;
				if (!s.startsWith(".") && !s.startsWith("/")) importPaths.add(s);
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
				const arg = node.arguments[0];
				if (ts.isStringLiteral(arg) && !arg.text.startsWith(".") && !arg.text.startsWith("/")) {
					importPaths.add(arg.text);
				}
			}
			ts.forEachChild(node, visit);
		});
	}
	return importPaths;
}

/**
 * Scan a .d.ts file for relative import specifiers (./foo, ../bar).
 */
function scanRelativeImports(content: string, fileName: string): string[] {
	const imports: string[] = [];
	const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false);
	ts.forEachChild(sf, function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const s = node.moduleSpecifier.text;
			if (s.startsWith(".")) imports.push(s);
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const s = node.moduleSpecifier.text;
			if (s.startsWith(".")) imports.push(s);
		}
		ts.forEachChild(node, visit);
	});

	// Also scan for /// <reference path="..." /> directives
	const refMatches = content.matchAll(/\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']\s*\/>/g);
	for (const m of refMatches) {
		if (m[1].startsWith(".")) imports.push(m[1]);
		else imports.push("./" + m[1]); // treat bare paths as relative
	}

	return imports;
}

// -------------------------------------------------------------------------
// Package type fetching with recursive internal resolution
// -------------------------------------------------------------------------

async function fetchPackageTypes(
	name: string,
	version: string,
	importPaths: Set<string>,
	files: Map<string, string>,
	/** The original package name when falling back to @types/ */
	originalName?: string,
): Promise<boolean> {
	let pkg = await fetchPkgJson(name, version);

	// If the package has no types entry, try @types/
	const hasTypes = pkg && (pkg.types || pkg.typings || (pkg.exports && resolveTypesPath(pkg, ".")));
	if (!hasTypes && !name.startsWith("@types/")) {
		const scopedName = name.startsWith("@")
			? name.replace("@", "").replace("/", "__")
			: name;
		const typesPkg = await fetchPkgJson(`@types/${scopedName}`, "latest");
		if (typesPkg) {
			return fetchPackageTypes(`@types/${scopedName}`, "latest", importPaths, files, name);
		}
	}
	if (!pkg) return false;

	const baseName = originalName || name;
	let anySuccess = false;

	for (const importPath of importPaths) {
		const subpath = importPath === baseName ? "." : "./" + importPath.slice(baseName.length + 1);
		const typesPath = resolveTypesPath(pkg, subpath);
		if (!typesPath) continue;

		// Fetch the entry .d.ts and all its internal imports recursively
		const { files: fetched, externalDeps } = await fetchDtsTree(name, version, typesPath);

		for (const [filePath, content] of fetched) {
			// Store under original package name so TS finds "react", not "@types/react"
			const nodeModulesPath = toNodeModulesPath(baseName, subpath, typesPath, filePath);
			files.set(nodeModulesPath, content);
		}

		// Fetch transitive external deps (e.g. csstype imported by @types/react)
		for (const dep of externalDeps) {
			if (files.has(`node_modules/${dep}/index.d.ts`)) continue; // already fetched
			const depPkg = await fetchPkgJson(dep, "latest");
			if (!depPkg) continue;
			const depTypesPath = depPkg.types || depPkg.typings;
			if (!depTypesPath) continue;
			const { files: depFiles } = await fetchDtsTree(dep, "latest", depTypesPath);
			for (const [fp, content] of depFiles) {
				files.set(`node_modules/${dep}/${fp}`, content);
			}
		}

		if (fetched.size > 0) anySuccess = true;
	}

	return anySuccess;
}

/**
 * Fetch a .d.ts file and recursively fetch all its relative imports.
 * Returns a Map of package-relative paths to content.
 */
interface FetchDtsTreeResult {
	files: Map<string, string>;
	externalDeps: Set<string>;
}

async function fetchDtsTree(
	name: string,
	version: string,
	entryPath: string,
): Promise<FetchDtsTreeResult> {
	const result = new Map<string, string>();
	const externalDeps = new Set<string>();
	const queue = [entryPath.replace(/^\.\//, "")];
	const visited = new Set<string>();

	while (queue.length > 0 && result.size < MAX_FILES_PER_PACKAGE) {
		const batch = queue.splice(0, 10);
		const fetches = batch
			.filter((p) => !visited.has(p))
			.map(async (filePath) => {
				visited.add(filePath);
				const content = await fetchSingleDts(name, version, filePath);
				if (!content) return;

				result.set(filePath, content);

				// Scan for relative imports and queue them
				const relImports = scanRelativeImports(content, filePath);
				const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1);

				for (const rel of relImports) {
					const resolved = resolveRelativePath(dir, rel);
					if (!resolved || visited.has(resolved)) continue;
					queue.push(resolved);
				}

				// Scan for external imports (e.g. "csstype" in @types/react)
				const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
				ts.forEachChild(sf, function visit(node) {
					if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
						const s = node.moduleSpecifier.text;
						if (!s.startsWith(".") && !s.startsWith("/")) externalDeps.add(s);
					}
					if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
						const s = node.moduleSpecifier.text;
						if (!s.startsWith(".") && !s.startsWith("/")) externalDeps.add(s);
					}
					ts.forEachChild(node, visit);
				});
			});

		await Promise.all(fetches);
	}

	return { files: result, externalDeps };
}

/**
 * Fetch a single .d.ts file, trying multiple extensions.
 */
async function fetchSingleDts(
	name: string,
	version: string,
	filePath: string,
): Promise<string | null> {
	// Try the path as-is, then with .d.ts, then /index.d.ts
	const candidates = filePath.endsWith(".d.ts")
		? [filePath]
		: [
				filePath + ".d.ts",
				filePath + "/index.d.ts",
				filePath + ".d.mts",
				// Some packages use .js extension in imports but have .d.ts files
				filePath.replace(/\.js$/, ".d.ts"),
				filePath.replace(/\.mjs$/, ".d.mts"),
			];

	for (const candidate of candidates) {
		const resp = await fetchWithTimeout(`${UNPKG}/${name}@${version}/${candidate}`);
		if (resp.ok) {
			const content = await resp.text();
			if (content.length > 5 && !content.includes("<!DOCTYPE")) {
				return content;
			}
		}
	}

	return null;
}

/**
 * Resolve a relative import path against a directory.
 */
function resolveRelativePath(dir: string, rel: string): string | null {
	const parts = (dir + rel.replace(/^\.\//, "")).split("/");
	const resolved: string[] = [];
	for (const p of parts) {
		if (p === "." || p === "") continue;
		if (p === "..") {
			if (resolved.length === 0) return null;
			resolved.pop();
		} else {
			resolved.push(p);
		}
	}
	return resolved.join("/");
}

/**
 * Map a package-internal file path to a node_modules path the compiler finds.
 */
function toNodeModulesPath(
	pkgName: string,
	subpath: string,
	entryPath: string,
	filePath: string,
): string {
	if (subpath === ".") {
		// Root import — file lives at node_modules/{pkg}/{filePath}
		return `node_modules/${pkgName}/${filePath}`;
	}

	// Subpath import — the entry point needs to be findable as
	// node_modules/{pkg}/{subpath}/index.d.ts, and internal files relative to it
	const subDir = subpath.replace("./", "");
	const entryDir = entryPath.replace(/^\.\//, "").substring(0, entryPath.lastIndexOf("/") + 1).replace(/^\.\//, "");

	if (filePath === entryPath.replace(/^\.\//, "")) {
		// This is the entry file itself
		return `node_modules/${pkgName}/${subDir}/index.d.ts`;
	}

	// Internal file — keep it relative to the package root
	return `node_modules/${pkgName}/${filePath}`;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function resolveTypesPath(pkg: PkgJson, subpath: string): string | null {
	if (pkg.exports) {
		const entry = pkg.exports[subpath];
		if (entry) {
			const resolved = extractTypesString(entry);
			if (resolved) return resolved;
		}
	}
	if (subpath === ".") {
		return pkg.types || pkg.typings || null;
	}
	return null;
}

/** Recursively extract a .d.ts path from a conditional exports entry. */
function extractTypesString(entry: any): string | null {
	if (!entry) return null;
	if (typeof entry === "string" && entry.endsWith(".d.ts")) return entry;
	if (typeof entry === "object") {
		// Try common keys: types, import.types, require.types, default
		for (const key of ["types", "import", "require", "default"]) {
			const result = extractTypesString(entry[key]);
			if (result) return result;
		}
	}
	return null;
}

async function fetchPkgJson(name: string, version: string): Promise<PkgJson | null> {
	try {
		const resp = await fetchWithTimeout(`${UNPKG}/${name}@${version}/package.json`);
		if (!resp.ok) return null;
		return resp.json();
	} catch {
		return null;
	}
}

async function fetchWithTimeout(url: string): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}
