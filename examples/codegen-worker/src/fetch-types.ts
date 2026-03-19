/**
 * Fetch type declarations for npm packages.
 *
 * Scans source files for actual import paths, then fetches exactly those
 * types from unpkg. Handles both root imports ("hono") and subpath
 * imports ("hono/cors") via the package's exports map.
 */

const UNPKG = "https://unpkg.com";
const FETCH_TIMEOUT_MS = 5000;

interface PkgJson {
	types?: string;
	typings?: string;
	exports?: Record<string, any>;
}

/**
 * Scan source files for import specifiers and fetch their .d.ts files.
 */
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

	// Scan all .ts files for import specifiers
	const importPaths = new Set<string>();
	for (const [key, content] of files) {
		if (!key.endsWith(".ts") && !key.endsWith(".tsx")) continue;
		// Match: import ... from "pkg" or import ... from "pkg/subpath"
		const matches = content.matchAll(/(?:import|export)\s+.*?from\s+["']([^"'./][^"']*)["']/g);
		for (const m of matches) {
			importPaths.add(m[1]);
		}
	}

	// Group by package name (first segment or @scope/name)
	const packageImports = new Map<string, Set<string>>();
	for (const path of importPaths) {
		const pkgName = path.startsWith("@")
			? path.split("/").slice(0, 2).join("/")
			: path.split("/")[0];
		if (!deps[pkgName]) continue; // only fetch declared deps
		if (!packageImports.has(pkgName)) packageImports.set(pkgName, new Set());
		packageImports.get(pkgName)!.add(path);
	}

	const fetched: string[] = [];
	const failed: string[] = [];

	// Fetch types for each package in parallel
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

/**
 * Fetch types for a package and all its imported subpaths.
 */
async function fetchPackageTypes(
	name: string,
	version: string,
	importPaths: Set<string>,
	files: Map<string, string>,
): Promise<boolean> {
	// Fetch package.json
	const pkg = await fetchPkgJson(name, version);
	if (!pkg) {
		// Try @types/
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

		// Resolve the types entry for this subpath
		const typesPath = resolveTypesPath(pkg, subpath);
		if (!typesPath) continue;

		const dts = await fetchDtsFile(name, version, typesPath);
		if (!dts) continue;

		// Store in the files map where the TS compiler will find it
		if (subpath === ".") {
			files.set(`node_modules/${name}/index.d.ts`, dts);
		} else {
			const subDir = subpath.replace("./", "");
			files.set(`node_modules/${name}/${subDir}/index.d.ts`, dts);
		}
		anySuccess = true;
	}

	return anySuccess;
}

/**
 * Resolve the types .d.ts path from a package.json for a given subpath.
 */
function resolveTypesPath(pkg: PkgJson, subpath: string): string | null {
	// Check exports map first
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

	// For root import, fall back to types/typings field
	if (subpath === ".") {
		return pkg.types || pkg.typings || null;
	}

	return null;
}

/**
 * Fetch a .d.ts file, following barrel re-exports one level deep.
 */
async function fetchDtsFile(
	name: string,
	version: string,
	typesPath: string,
): Promise<string | null> {
	const basePath = typesPath.replace(/^\.\//, "");
	const resp = await fetchWithTimeout(`${UNPKG}/${name}@${version}/${basePath}`);
	if (!resp.ok) return null;

	let content = await resp.text();
	if (content.length < 10 || content.includes("<!DOCTYPE")) return null;

	// Follow thin barrel re-exports one level
	const reExport = content.match(/^export \* from ["'](.+?)["'];?\s*$/m);
	if (reExport && content.trim().split("\n").length <= 3) {
		const dir = basePath.substring(0, basePath.lastIndexOf("/") + 1);
		const rel = reExport[1].replace(/^\.\//, "");
		for (const ext of [".d.ts", "/index.d.ts"]) {
			const innerResp = await fetchWithTimeout(`${UNPKG}/${name}@${version}/${dir}${rel}${ext}`);
			if (innerResp.ok) {
				const inner = await innerResp.text();
				if (inner.length > 10 && !inner.includes("<!DOCTYPE")) {
					content = inner + "\n" + content.replace(reExport[0], "");
					break;
				}
			}
		}
	}

	return content;
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
