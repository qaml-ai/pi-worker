/**
 * Generate TypeScript type declarations for Cloudflare Worker bindings
 * from a parsed wrangler config. Same approach as `wrangler types` —
 * just string templates, no compiler needed.
 */

interface WranglerConfig {
	kv_namespaces?: Array<{ binding: string }>;
	r2_buckets?: Array<{ binding: string }>;
	d1_databases?: Array<{ binding: string }>;
	durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
	services?: Array<{ binding: string }>;
	queues?: { producers?: Array<{ binding: string }> };
	vectorize?: Array<{ binding: string }>;
	hyperdrive?: Array<{ binding: string }>;
	ai?: { binding: string };
	vars?: Record<string, string | number | boolean>;
	[key: string]: unknown;
}

const BINDING_TYPE_MAP: Record<string, { configKey: string; tsType: string; nameField: string }> = {
	kv_namespaces:  { configKey: "kv_namespaces",  tsType: "KVNamespace",            nameField: "binding" },
	r2_buckets:     { configKey: "r2_buckets",      tsType: "R2Bucket",               nameField: "binding" },
	d1_databases:   { configKey: "d1_databases",    tsType: "D1Database",             nameField: "binding" },
	services:       { configKey: "services",        tsType: "Fetcher",                nameField: "binding" },
	vectorize:      { configKey: "vectorize",       tsType: "VectorizeIndex",         nameField: "binding" },
	hyperdrive:     { configKey: "hyperdrive",      tsType: "Hyperdrive",             nameField: "binding" },
};

/**
 * Generate an Env interface declaration from a wrangler config object.
 * Returns a `.d.ts` string that can be injected into the type checker.
 */
export function generateBindingTypes(config: WranglerConfig): string {
	const members: string[] = [];

	// Standard bindings (array-based)
	for (const [key, mapping] of Object.entries(BINDING_TYPE_MAP)) {
		const bindings = config[mapping.configKey] as Array<Record<string, string>> | undefined;
		if (!bindings) continue;
		for (const binding of bindings) {
			const name = binding[mapping.nameField];
			if (name) {
				members.push(`    ${name}: ${mapping.tsType};`);
			}
		}
	}

	// Durable Objects
	if (config.durable_objects?.bindings) {
		for (const binding of config.durable_objects.bindings) {
			if (binding.name) {
				members.push(`    ${binding.name}: DurableObjectNamespace;`);
			}
		}
	}

	// Queue producers
	if (config.queues?.producers) {
		for (const producer of config.queues.producers) {
			if (producer.binding) {
				members.push(`    ${producer.binding}: Queue;`);
			}
		}
	}

	// AI binding
	if (config.ai?.binding) {
		members.push(`    ${config.ai.binding}: Ai;`);
	}

	// Plain variables
	if (config.vars) {
		for (const [name, value] of Object.entries(config.vars)) {
			const tsType = typeof value === "number" ? "number"
				: typeof value === "boolean" ? "boolean"
				: "string";
			members.push(`    ${name}: ${tsType};`);
		}
	}

	if (members.length === 0) {
		return "interface Env {}\n";
	}

	return `interface Env {\n${members.join("\n")}\n}\n`;
}

/**
 * Parse a wrangler.jsonc string and generate binding types.
 */
export function generateBindingTypesFromJsonc(jsoncContent: string): string {
	// Strip comments (// and /* */) for JSON.parse
	const json = jsoncContent
		.replace(/\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		// Strip trailing commas
		.replace(/,(\s*[}\]])/g, "$1");

	try {
		const config = JSON.parse(json) as WranglerConfig;
		return generateBindingTypes(config);
	} catch {
		return "interface Env {}\n";
	}
}
