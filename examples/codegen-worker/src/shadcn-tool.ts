/**
 * shadcn/ui component installer tool for pi-mono agents.
 *
 * Equivalent to `npx shadcn add <component>` but operates on an
 * in-memory filesystem. Fetches component source + dependencies
 * from the shadcn registry and writes them to the files map.
 *
 * @example
 * ```ts
 * const files = new Map<string, string>();
 * const tools = [
 *   ...createMemoryTools(files),
 *   createShadcnTool(files),
 * ];
 * ```
 */

import { Type, type Static } from "@sinclair/typebox";

const REGISTRY_BASE = "https://ui.shadcn.com/r/styles/radix-mira";
const FETCH_TIMEOUT_MS = 5000;

interface RegistryItem {
	name: string;
	type: string;
	dependencies?: string[];
	devDependencies?: string[];
	registryDependencies?: string[];
	files: Array<{
		path: string;
		content: string;
		type: string;
		target?: string;
	}>;
}

export interface ShadcnToolOptions {
	/** Style variant. Default: "new-york" */
	style?: string;
	/** Prefix for file paths in the map (e.g. "proj_123/"). */
	prefix?: string;
	/** Base directory for components. Default: "src/components" */
	componentDir?: string;
}

const addSchema = Type.Object({
	components: Type.Array(Type.String(), {
		description: "Component names to install (e.g. ['button', 'card', 'dialog'])",
	}),
});

/**
 * Create a tool that installs shadcn/ui components into the in-memory filesystem.
 *
 * The tool:
 * 1. Fetches component source from the shadcn registry
 * 2. Recursively resolves registry dependencies (other shadcn components)
 * 3. Writes component files to the filesystem
 * 4. Updates package.json with npm dependencies
 */
export function createShadcnTool(
	files: Map<string, string>,
	options?: ShadcnToolOptions,
) {
	const style = options?.style ?? "new-york";
	const prefix = options?.prefix ?? "";
	const componentDir = options?.componentDir ?? "src/components";
	const registryBase = `https://ui.shadcn.com/r/styles/${style}`;

	return {
		name: "add_component" as const,
		label: "add_component",
		description:
			"Install shadcn/ui components. Fetches real component source code from the registry, " +
			"resolves dependencies, and writes files. Like running `npx shadcn add button card dialog`.",
		parameters: addSchema,
		execute: async (
			_id: string,
			{ components }: Static<typeof addSchema>,
		) => {
			const installed: string[] = [];
			const failed: string[] = [];
			const addedDeps: Set<string> = new Set();
			const visited = new Set<string>();

			// Recursively install components and their registry dependencies
			const queue = [...components];
			while (queue.length > 0) {
				const name = queue.shift()!;
				if (visited.has(name)) continue;
				visited.add(name);

				try {
					const item = await fetchComponent(registryBase, name);
					if (!item) {
						failed.push(name);
						continue;
					}

					// Write component files (fix registry import paths)
					for (const file of item.files) {
						const filePath = `${prefix}${componentDir}/${file.path}`;
						const content = file.content
							.replace(/@\/registry\/[^/]+\/lib\//g, "@/lib/")
							.replace(/@\/registry\/[^/]+\/ui\//g, "@/components/ui/")
							.replace(/@\/registry\/[^/]+\/hooks\//g, "@/hooks/");
						files.set(filePath, content);
					}

					// Track npm dependencies
					if (item.dependencies) {
						for (const dep of item.dependencies) addedDeps.add(dep);
					}

					// Queue registry dependencies (other shadcn components)
					if (item.registryDependencies) {
						for (const regDep of item.registryDependencies) {
							if (!visited.has(regDep)) queue.push(regDep);
						}
					}

					installed.push(name);
				} catch {
					failed.push(name);
				}
			}

			// Update package.json with new dependencies
			if (addedDeps.size > 0) {
				updatePackageJson(files, prefix, addedDeps);
			}

			// Also ensure the cn() utility exists
			ensureUtils(files, prefix, componentDir);

			const summary = [
				`Installed: ${installed.join(", ") || "(none)"}`,
				failed.length > 0 ? `Failed: ${failed.join(", ")}` : null,
				addedDeps.size > 0 ? `Added deps: ${[...addedDeps].join(", ")}` : null,
			].filter(Boolean).join("\n");

			return {
				content: [{ type: "text" as const, text: summary }],
				details: { installed, failed, addedDeps: [...addedDeps] },
			};
		},
	};
}

async function fetchComponent(registryBase: string, name: string): Promise<RegistryItem | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(`${registryBase}/${name}.json`, { signal: controller.signal });
		if (!resp.ok) return null;
		return resp.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

function updatePackageJson(files: Map<string, string>, prefix: string, deps: Set<string>) {
	const pkgPath = `${prefix}package.json`;
	let pkg: any = {};

	const existing = files.get(pkgPath);
	if (existing) {
		try { pkg = JSON.parse(existing); } catch {}
	}

	if (!pkg.dependencies) pkg.dependencies = {};
	for (const dep of deps) {
		if (!pkg.dependencies[dep]) {
			pkg.dependencies[dep] = "latest";
		}
	}

	files.set(pkgPath, JSON.stringify(pkg, null, 2));
}

function ensureUtils(files: Map<string, string>, prefix: string, componentDir: string) {
	const utilsPath = `${prefix}src/lib/utils.ts`;
	if (files.has(utilsPath)) return;

	files.set(utilsPath, `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`);

	// Add clsx and tailwind-merge to package.json
	updatePackageJson(files, prefix, new Set(["clsx", "tailwind-merge"]));
}
