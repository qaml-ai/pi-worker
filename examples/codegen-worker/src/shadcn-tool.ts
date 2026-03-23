/**
 * shadcn/ui component installer tool for pi-mono agents.
 *
 * Equivalent to `npx shadcn add <component>` but operates on an
 * in-memory filesystem. Fetches component source + dependencies
 * from the shadcn registry and writes them to the files map.
 */

import { Type, type Static } from "@sinclair/typebox";

const REGISTRY_URL = "https://ui.shadcn.com/r/styles";
const DEFAULT_STYLE = "radix-mira";
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
	style?: string;
	prefix?: string;
	/** Base directory for components. Default: "app/components" */
	componentDir?: string;
}

const addSchema = Type.Object({
	components: Type.Array(Type.String(), {
		description: "Component names to install (e.g. ['button', 'card', 'dialog'])",
	}),
});

export function createShadcnTool(
	files: Map<string, string>,
	options?: ShadcnToolOptions,
) {
	const prefix = options?.prefix ?? "";
	const componentDir = options?.componentDir ?? "app/components";

	function getRegistryBase(): string {
		const componentsJson = files.get(`${prefix}components.json`);
		if (componentsJson) {
			try {
				const config = JSON.parse(componentsJson);
				if (config.style) return `${REGISTRY_URL}/${config.style}`;
			} catch {}
		}
		return `${REGISTRY_URL}/${options?.style ?? DEFAULT_STYLE}`;
	}

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
			console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_add_start", components, registryBase: getRegistryBase() }));
			const installed: string[] = [];
			const failed: string[] = [];
			const addedDeps: Set<string> = new Set();
			const visited = new Set<string>();

			const queue = [...components];
			while (queue.length > 0) {
				const name = queue.shift()!;
				if (visited.has(name)) continue;
				visited.add(name);

				try {
					console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_component_fetch_start", name }));
					const item = await fetchComponent(getRegistryBase(), name);
					if (!item) {
						console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_component_fetch_failed", name }));
						failed.push(name);
						continue;
					}
					console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_component_fetch_done", name, files: item.files.length, dependencies: item.dependencies?.length || 0, registryDependencies: item.registryDependencies?.length || 0 }));

					for (const file of item.files) {
						const cleanPath = file.path.replace(/^registry\/[^/]+\//, "");
						const filePath = `${prefix}${componentDir}/${cleanPath}`;
						files.set(filePath, sanitizeRegistryContent(file.content));
					}

					if (item.dependencies) {
						for (const dep of item.dependencies) addedDeps.add(dep);
					}

					if (item.registryDependencies) {
						for (const regDep of item.registryDependencies) {
							if (!visited.has(regDep)) queue.push(regDep);
						}
					}

					installed.push(name);
				} catch (error: any) {
					console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_component_exception", name, error: error?.message || String(error) }));
					failed.push(name);
				}
			}

			if (addedDeps.size > 0) {
				updatePackageJson(files, prefix, addedDeps);
			}

			ensureUtils(files, prefix);

			const summary = [
				`Installed: ${installed.join(", ") || "(none)"}`,
				failed.length > 0 ? `Failed: ${failed.join(", ")}` : null,
				addedDeps.size > 0 ? `Added deps: ${[...addedDeps].join(", ")}` : null,
			].filter(Boolean).join("\n");
			console.log(JSON.stringify({ at: new Date().toISOString(), id: prefix || "(root)", step: "shadcn_add_done", installed, failed, addedDeps: [...addedDeps] }));

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

function sanitizeRegistryContent(content: string): string {
	let next = content
		.replace(/@\/registry\/[^/]+\/lib\//g, "~/lib/")
		.replace(/@\/registry\/[^/]+\/ui\//g, "~/components/ui/")
		.replace(/@\/registry\/[^/]+\/hooks\//g, "~/hooks/")
		.replace(/from "@\/lib\//g, 'from "~/lib/')
		.replace(/from "@\/components\//g, 'from "~/components/')
		.replace(/from "@\/hooks\//g, 'from "~/hooks/');

	const iconImportMatch = next.match(/<IconPlaceholder[\s\S]*?lucide="([A-Za-z0-9_]+)"[\s\S]*?\/>/);
	if (next.includes("@/app/(create)/components/icon-placeholder") && iconImportMatch?.[1]) {
		const iconName = iconImportMatch[1];
		next = next.replace(
			/import\s+\{\s*IconPlaceholder\s*\}\s+from\s+"@\/app\/\(create\)\/components\/icon-placeholder"\s*\n?/,
			`import { ${iconName} } from "lucide-react"\n`,
		);
		next = next.replace(/<IconPlaceholder[\s\S]*?\/>/, `<${iconName} />`);
	}

	return next;
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

function ensureUtils(files: Map<string, string>, prefix: string) {
	const utilsPath = `${prefix}app/lib/utils.ts`;
	if (files.has(utilsPath)) return;

	files.set(utilsPath, `import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`);

	updatePackageJson(files, prefix, new Set(["clsx", "tailwind-merge"]));
}
