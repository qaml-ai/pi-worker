/**
 * In-memory project scaffolding — equivalent to create-worker but writes
 * to a Map instead of disk. Called before the agent starts so the agent
 * gets a pre-configured project to customize.
 */

export interface ScaffoldOptions {
	/** UI style preset. Default: "mira" */
	style?: "vega" | "nova" | "maia" | "lyra" | "mira";
	/** Theme color. Default: "neutral" */
	theme?: string;
	/** Base gray color. Default: "neutral" */
	baseColor?: "neutral" | "zinc" | "gray" | "stone";
	/** Font family. Default: "figtree" */
	font?: "inter" | "noto-sans" | "nunito-sans" | "figtree";
	/** Border radius. Default: "default" */
	radius?: "default" | "none" | "small" | "medium" | "large";
}

const DEFAULTS: Required<ScaffoldOptions> = {
	style: "mira",
	theme: "neutral",
	baseColor: "neutral",
	font: "figtree",
	radius: "default",
};

const FONT_CONFIG: Record<string, { package: string; fontFamily: string }> = {
	inter: { package: "@fontsource-variable/inter", fontFamily: "'Inter Variable', sans-serif" },
	"noto-sans": { package: "@fontsource-variable/noto-sans", fontFamily: "'Noto Sans Variable', sans-serif" },
	"nunito-sans": { package: "@fontsource-variable/nunito-sans", fontFamily: "'Nunito Sans Variable', sans-serif" },
	figtree: { package: "@fontsource-variable/figtree", fontFamily: "'Figtree Variable', sans-serif" },
};

/**
 * Scaffold a React Router 7 + shadcn/ui + Cloudflare Workers project
 * into an in-memory file Map. Fetches the shadcn preset from the API
 * and generates themed CSS.
 */
export async function scaffoldProject(
	files: Map<string, string>,
	prefix: string,
	projectName: string,
	options?: ScaffoldOptions,
): Promise<void> {
	const opts = { ...DEFAULTS, ...options };
	const fontConfig = FONT_CONFIG[opts.font] || FONT_CONFIG.figtree;

	// Fetch shadcn preset (CSS variables for the theme)
	const presetUrl = buildPresetUrl(opts);
	const preset = await fetchPreset(presetUrl);

	// Generate CSS from preset + template
	const css = generateCss(preset, fontConfig);

	// Write all project files
	const p = prefix;

	// package.json
	files.set(`${p}package.json`, JSON.stringify({
		name: projectName,
		private: true,
		type: "module",
		scripts: {
			dev: "react-router dev",
			build: "react-router build",
			deploy: "bun run build && wrangler deploy",
		},
		dependencies: {
			react: "^19",
			"react-dom": "^19",
			"react-router": "^7",
			"@react-router/cloudflare": "^7",
			"radix-ui": "^1",
			"class-variance-authority": "^0.7",
			"clsx": "^2",
			"tailwind-merge": "^3",
			"lucide-react": "^0.5",
			"tailwindcss": "^4",
			"@tailwindcss/postcss": "^4",
			"tw-animate-css": "^1",
			[fontConfig.package]: "*",
		},
		devDependencies: {
			"@cloudflare/workers-types": "^4",
			"@cloudflare/vite-plugin": "^1",
			typescript: "^5",
			vite: "^6",
			wrangler: "^4",
		},
	}, null, 2));

	// tsconfig.json
	files.set(`${p}tsconfig.json`, JSON.stringify({
		compilerOptions: {
			target: "ES2022",
			module: "ES2022",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			jsx: "react-jsx",
			paths: { "~/*": ["./app/*"] },
			types: ["@cloudflare/workers-types"],
		},
		include: ["app", "workers"],
	}, null, 2));

	// wrangler.jsonc
	files.set(`${p}wrangler.jsonc`, `{
  "name": "${projectName}",
  "main": "./workers/app.ts",
  "compatibility_date": "2025-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./build/client"
  }
}
`);

	// components.json (for shadcn CLI compatibility)
	files.set(`${p}components.json`, JSON.stringify({
		$schema: "https://ui.shadcn.com/schema.json",
		style: `radix-${opts.style}`,
		rsc: false,
		tsx: true,
		tailwind: {
			config: "",
			css: "app/app.css",
			baseColor: opts.baseColor,
			cssVariables: true,
		},
		iconLibrary: "lucide",
		aliases: {
			components: "~/components",
			utils: "~/lib/utils",
			ui: "~/components/ui",
			lib: "~/lib",
			hooks: "~/hooks",
		},
	}, null, 2));

	// postcss.config.mjs
	files.set(`${p}postcss.config.mjs`, `export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
`);

	// vite.config.ts
	files.set(`${p}vite.config.ts`, `import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    reactRouter(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
  ],
});
`);

	// react-router.config.ts
	files.set(`${p}react-router.config.ts`, `import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
} satisfies Config;
`);

	// app/app.css (generated from shadcn preset)
	files.set(`${p}app/app.css`, css);

	// app/root.tsx
	files.set(`${p}app/root.tsx`, `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
`);

	// app/routes.ts
	files.set(`${p}app/routes.ts`, `import type { RouteConfig } from "@react-router/dev/routes";
import { index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
] satisfies RouteConfig;
`);

	// app/routes/home.tsx (placeholder)
	files.set(`${p}app/routes/home.tsx`, `export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-bold">Hello World</h1>
    </div>
  );
}
`);

	// app/lib/utils.ts
	files.set(`${p}app/lib/utils.ts`, `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`);

	// workers/app.ts
	files.set(`${p}workers/app.ts`, `import { createRequestHandler } from "@react-router/cloudflare";

const handler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default {
  fetch: handler,
} satisfies ExportedHandler;
`);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function buildPresetUrl(opts: Required<ScaffoldOptions>): string {
	const params = new URLSearchParams({
		base: "radix",
		style: opts.style,
		baseColor: opts.baseColor,
		theme: opts.theme,
		iconLibrary: "lucide",
		font: opts.font,
		radius: opts.radius,
		menuColor: "default",
		menuAccent: "subtle",
		template: "vite",
	});
	return `https://ui.shadcn.com/init?${params}`;
}

async function fetchPreset(url: string): Promise<any> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Failed to fetch shadcn preset: ${resp.status}`);
	return resp.json();
}

function generateCss(preset: any, fontConfig: { package: string; fontFamily: string }): string {
	const { light, dark } = preset.cssVars;

	const lightVars = Object.entries(light)
		.map(([k, v]) => `    --${k}: ${v};`)
		.join("\n");

	const darkVars = Object.entries(dark)
		.map(([k, v]) => `    --${k}: ${v};`)
		.join("\n");

	const themeColors = Object.keys(light)
		.filter((k) => k !== "radius")
		.map((k) => `    --color-${k}: var(--${k});`)
		.join("\n");

	return CSS_TEMPLATE
		.replace("{{FONT_IMPORT}}", fontConfig.package)
		.replace("{{FONT_FAMILY}}", fontConfig.fontFamily)
		.replace("{{LIGHT_VARS}}", lightVars)
		.replace("{{DARK_VARS}}", darkVars)
		.replace("{{THEME_COLORS}}", themeColors);
}

const CSS_TEMPLATE = `@import "tailwindcss";
@import "tw-animate-css";
@import "{{FONT_IMPORT}}";

@custom-variant dark (&:is(.dark *));

@custom-variant data-open {
  &:where([data-state="open"]),
  &:where([data-open]:not([data-open="false"])) {
    @slot;
  }
}

@custom-variant data-closed {
  &:where([data-state="closed"]),
  &:where([data-closed]:not([data-closed="false"])) {
    @slot;
  }
}

@custom-variant data-checked {
  &:where([data-state="checked"]),
  &:where([data-checked]:not([data-checked="false"])) {
    @slot;
  }
}

@custom-variant data-unchecked {
  &:where([data-state="unchecked"]),
  &:where([data-unchecked]:not([data-unchecked="false"])) {
    @slot;
  }
}

@custom-variant data-selected {
  &:where([data-selected="true"]) {
    @slot;
  }
}

@custom-variant data-disabled {
  &:where([data-disabled="true"]),
  &:where([data-disabled]:not([data-disabled="false"])) {
    @slot;
  }
}

@custom-variant data-active {
  &:where([data-state="active"]),
  &:where([data-active]:not([data-active="false"])) {
    @slot;
  }
}

@custom-variant data-horizontal {
  &:where([data-orientation="horizontal"]) {
    @slot;
  }
}

@custom-variant data-vertical {
  &:where([data-orientation="vertical"]) {
    @slot;
  }
}

@utility no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

:root {
{{LIGHT_VARS}}
}

.dark {
{{DARK_VARS}}
}

@theme inline {
    --font-sans: {{FONT_FAMILY}};
{{THEME_COLORS}}
    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
    --radius-2xl: calc(var(--radius) + 8px);
    --radius-3xl: calc(var(--radius) + 12px);
    --radius-4xl: calc(var(--radius) + 16px);

    @keyframes accordion-down {
        from { height: 0; }
        to { height: var(--radix-accordion-content-height, var(--accordion-panel-height, auto)); }
    }

    @keyframes accordion-up {
        from { height: var(--radix-accordion-content-height, var(--accordion-panel-height, auto)); }
        to { height: 0; }
    }
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply font-sans bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
`;
