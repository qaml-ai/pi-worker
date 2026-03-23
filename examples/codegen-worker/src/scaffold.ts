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

	const presetUrl = buildPresetUrl(opts);
	const preset = await fetchPreset(presetUrl);
	const css = generateCss(preset, fontConfig);
	const p = prefix;

	files.set(`${p}package.json`, JSON.stringify({
		name: projectName,
		private: true,
		type: "module",
		scripts: {
			build: "react-router build",
			"cf-typegen": "bun wrangler types",
			postinstall: "bun run cf-typegen",
			deploy: "bun run build && bun wrangler deploy",
			dev: "react-router dev",
			preview: "bun run build && vite preview",
			typecheck: "bun run cf-typegen && react-router typegen && tsc -b",
		},
		dependencies: {
			[fontConfig.package]: "^5.2.5",
			"class-variance-authority": "^0.7.1",
			clsx: "^2.1.1",
			isbot: "^5.1.31",
			"lucide-react": "^0.562.0",
			"radix-ui": "^1.4.3",
			react: "^19.1.1",
			"react-dom": "^19.1.1",
			"react-router": "^7.10.0",
			"tailwind-merge": "^3.4.0",
			"tw-animate-css": "^1.4.0",
		},
		devDependencies: {
			"@cloudflare/vite-plugin": "1.22.1",
			"@react-router/dev": "^7.10.0",
			"@tailwindcss/vite": "^4.1.13",
			"@types/node": "^22",
			"@types/react": "^19.1.13",
			"@types/react-dom": "^19.1.9",
			tailwindcss: "^4.1.13",
			typescript: "^5.9.2",
			vite: "8.0.0-beta.16",
			wrangler: "^4.16.0",
		},
	}, null, 2));

	files.set(`${p}tsconfig.json`, JSON.stringify({
		files: [],
		references: [
			{ path: "./tsconfig.node.json" },
			{ path: "./tsconfig.cloudflare.json" },
		],
		compilerOptions: {
			checkJs: true,
			verbatimModuleSyntax: true,
			skipLibCheck: true,
			strict: true,
			noEmit: true,
			baseUrl: ".",
			paths: {
				"~/*": ["./app/*"],
			},
			types: ["./worker-configuration.d.ts"],
		},
	}, null, 2));

	files.set(`${p}tsconfig.cloudflare.json`, JSON.stringify({
		extends: "./tsconfig.json",
		include: [
			".react-router/types/**/*",
			"app/**/*",
			"app/**/.server/**/*",
			"app/**/.client/**/*",
			"workers/**/*",
			"worker-configuration.d.ts",
		],
		compilerOptions: {
			composite: true,
			strict: true,
			lib: ["DOM", "DOM.Iterable", "ES2022"],
			types: ["vite/client"],
			target: "ES2022",
			module: "ES2022",
			moduleResolution: "bundler",
			jsx: "react-jsx",
			baseUrl: ".",
			rootDirs: [".", "./.react-router/types"],
			paths: {
				"~/*": ["./app/*"],
			},
			esModuleInterop: true,
			resolveJsonModule: true,
		},
	}, null, 2));

	files.set(`${p}tsconfig.node.json`, JSON.stringify({
		extends: "./tsconfig.json",
		include: ["vite.config.ts"],
		compilerOptions: {
			composite: true,
			strict: true,
			types: ["node"],
			lib: ["ES2022"],
			target: "ES2022",
			module: "ES2022",
			moduleResolution: "bundler",
		},
	}, null, 2));

	files.set(`${p}wrangler.jsonc`, `/**
 * For more details on how to configure Wrangler, refer to:
 * https://developers.cloudflare.com/workers/wrangler/configuration/
 */
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${projectName}",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-02-28",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true
  },
  "assets": {
    "directory": "./build/client"
  }
}
`);

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
			prefix: "",
		},
		iconLibrary: "lucide",
		aliases: {
			components: "~/components",
			utils: "~/lib/utils",
			ui: "~/components/ui",
			lib: "~/lib",
			hooks: "~/hooks",
		},
		registries: {},
	}, null, 2));

	files.set(`${p}vite.config.ts`, `import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    alias: {
      "~": resolve(__dirname, "./app"),
    },
  },
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "virtual:cloudflare/worker-entry",
        },
      },
    },
  },
  define: {
    __filename: "'index.ts'",
  },
  optimizeDeps: command === "build" ? { noDiscovery: true } : {},
}));
`);

	files.set(`${p}react-router.config.ts`, `import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
`);

	files.set(`${p}app/app.css`, css);

	files.set(`${p}app/entry.server.tsx`, `import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

export function handleError(error: unknown) {
  console.error(error);
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        responseStatusCode = 500;
        if (shellRendered) {
          console.error(error);
        }
      },
    }
  );
  shellRendered = true;

  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
`);

	files.set(`${p}app/root.tsx`, `import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details = error.status === 404
      ? "The requested page could not be found."
      : error.statusText || details;
  } else if (error && error instanceof Error) {
    details = error.message;
    stack = import.meta.env.DEV ? error.stack : undefined;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
`);

	files.set(`${p}app/routes.ts`, `import type { RouteConfig } from "@react-router/dev/routes";
import { index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
] satisfies RouteConfig;
`);

	files.set(`${p}app/routes/home.tsx`, `export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-bold">Hello World</h1>
    </div>
  );
}
`);

	files.set(`${p}app/lib/utils.ts`, `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`);

	files.set(`${p}workers/app.ts`, `import { createRequestHandler } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
`);

	files.set(`${p}public/.gitkeep`, "");
}

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
