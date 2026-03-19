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
		// import type references: /// <reference types="..." />
		// These are less common but handle them too
		ts.forEachChild(node, visit);
	});
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
): Promise<boolean> {
	const pkg = await fetchPkgJson(name, version);
	if (!pkg) {
		const scopedName = name.startsWith("@")
			? name.replace("@", "").replace("/", "__")
			: name;
		const typesPkg = await fetchPkgJson(`@types/${scopedName}`, "latest");
		if (!typesPkg) return false;
		return fetchPackageTypes(`@types/${scopedName}`, "latest", importPaths, files);
	}

	let anySuccess = false;

	for (const importPath of importPaths) {
		const subpath = importPath === name ? "." : "./" + importPath.slice(name.length + 1);
		const typesPath = resolveTypesPath(pkg, subpath);
		if (!typesPath) continue;

		// Fetch the entry .d.ts and all its internal imports recursively
		const fetched = await fetchDtsTree(name, version, typesPath);

		for (const [filePath, content] of fetched) {
			// Map the package-internal path to a node_modules path the compiler can find
			const nodeModulesPath = toNodeModulesPath(name, subpath, typesPath, filePath);
			files.set(nodeModulesPath, content);
		}

		if (fetched.size > 0) anySuccess = true;
	}

	return anySuccess;
}

/**
 * Fetch a .d.ts file and recursively fetch all its relative imports.
 * Returns a Map of package-relative paths to content.
 */
async function fetchDtsTree(
	name: string,
	version: string,
	entryPath: string,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const queue = [entryPath.replace(/^\.\//, "")];
	const visited = new Set<string>();

	while (queue.length > 0 && result.size < MAX_FILES_PER_PACKAGE) {
		const batch = queue.splice(0, 10); // fetch in batches of 10
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
			});

		await Promise.all(fetches);
	}

	return result;
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
			if (typeof entry === "string" && entry.endsWith(".d.ts")) return entry;
			if (typeof entry === "object" && entry !== null) {
				const t = entry.types ?? entry.import?.types ?? entry.require?.types ?? entry.default?.types;
				if (t) return t;
			}
		}
	}
	if (subpath === ".") {
		return pkg.types || pkg.typings || null;
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
