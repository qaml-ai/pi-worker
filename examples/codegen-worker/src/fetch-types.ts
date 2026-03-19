/**
 * Fetch type declarations for npm packages.
 *
 * 80/20 approach: for each dependency, fetch the top-level .d.ts file
 * from unpkg and inject it into the type checker as node_modules/{pkg}/index.d.ts.
 *
 * Limitations:
 * - Only fetches the single entry point types file
 * - No transitive dependencies
 * - No deep import paths (e.g., "hono/middleware" won't resolve)
 * - Falls back to @types/{pkg} if package doesn't ship its own types
 */

const UNPKG = "https://unpkg.com";
const FETCH_TIMEOUT_MS = 5000;

interface PkgJson {
	types?: string;
	typings?: string;
	exports?: Record<string, any>;
	main?: string;
}

/**
 * Given a map of files (which should include package.json), fetch .d.ts
 * files for all dependencies and add them to the files map as
 * node_modules/{pkg}/index.d.ts.
 */
export async function fetchDependencyTypes(
	files: Map<string, string>,
): Promise<{ fetched: string[]; failed: string[] }> {
	const pkgJsonContent = files.get("package.json");
	if (!pkgJsonContent) return { fetched: [], failed: [] };

	let deps: Record<string, string>;
	try {
		const pkg = JSON.parse(pkgJsonContent);
		deps = pkg.dependencies ?? {};
	} catch {
		return { fetched: [], failed: [] };
	}

	const fetched: string[] = [];
	const failed: string[] = [];

	// Fetch types for all deps in parallel
	const results = await Promise.allSettled(
		Object.entries(deps).map(async ([name, version]) => {
			const cleanVersion = String(version).replace(/^[\^~>=<]/, "");
			const dts = await fetchPackageTypes(name, cleanVersion);
			if (dts) {
				files.set(`node_modules/${name}/index.d.ts`, dts);
				fetched.push(name);
			} else {
				failed.push(name);
			}
		}),
	);

	return { fetched, failed };
}

async function fetchPackageTypes(
	name: string,
	version: string,
): Promise<string | null> {
	// Try the package itself first, then @types/{name}
	const dts = await tryFetchTypes(name, version);
	if (dts) return dts;

	// Try @types/
	const scopedName = name.startsWith("@")
		? name.replace("@", "").replace("/", "__")
		: name;
	return tryFetchTypes(`@types/${scopedName}`, "latest");
}

async function tryFetchTypes(
	name: string,
	version: string,
): Promise<string | null> {
	try {
		// Fetch package.json to find types entry point
		const pkgUrl = `${UNPKG}/${name}@${version}/package.json`;
		const pkgResp = await fetchWithTimeout(pkgUrl);
		if (!pkgResp.ok) return null;

		const pkg: PkgJson = await pkgResp.json();

		// Find the types entry point
		let typesPath = pkg.types || pkg.typings;

		// Check exports["."].types
		if (!typesPath && pkg.exports) {
			const dot = pkg.exports["."];
			if (typeof dot === "object" && dot !== null) {
				typesPath = dot.types ?? dot.import?.types ?? dot.default?.types;
			}
		}

		if (!typesPath) return null;

		// Normalize path
		if (!typesPath.startsWith("./") && !typesPath.startsWith("/")) {
			typesPath = "./" + typesPath;
		}

		// Fetch the actual .d.ts file
		const basePath = typesPath.replace(/^\.\//, "");
		const dtsUrl = `${UNPKG}/${name}@${version}/${basePath}`;
		const dtsResp = await fetchWithTimeout(dtsUrl);
		if (!dtsResp.ok) return null;

		let content = await dtsResp.text();

		// Basic sanity check — should look like a .d.ts file
		if (content.length < 10 || content.includes("<!DOCTYPE")) return null;

		// If the .d.ts is a thin barrel (just re-exports), follow one level
		const reExportMatch = content.match(/^export \* from ["'](.+?)["'];?\s*$/m);
		if (reExportMatch && content.trim().split("\n").length <= 3) {
			const reExportPath = reExportMatch[1];
			const dir = basePath.substring(0, basePath.lastIndexOf("/") + 1);

			// Try with .d.ts, /index.d.ts extensions
			const candidates = [
				dir + reExportPath.replace(/^\.\//, "") + ".d.ts",
				dir + reExportPath.replace(/^\.\//, "") + "/index.d.ts",
			];

			for (const candidate of candidates) {
				const innerUrl = `${UNPKG}/${name}@${version}/${candidate}`;
				const innerResp = await fetchWithTimeout(innerUrl);
				if (innerResp.ok) {
					const innerContent = await innerResp.text();
					if (innerContent.length > 10 && !innerContent.includes("<!DOCTYPE")) {
						// Prepend the original barrel so namespace exports still work
						content = innerContent + "\n" + content.replace(reExportMatch[0], "");
						break;
					}
				}
			}
		}

		return content;
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
