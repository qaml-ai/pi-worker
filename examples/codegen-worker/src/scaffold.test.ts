import { describe, it, expect } from "vitest";
import { scaffoldProject } from "./scaffold.js";

describe("scaffoldProject", () => {
	it("creates all required files with defaults", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app");

		expect(files.has("proj/package.json")).toBe(true);
		expect(files.has("proj/tsconfig.json")).toBe(true);
		expect(files.has("proj/wrangler.jsonc")).toBe(true);
		expect(files.has("proj/components.json")).toBe(true);
		expect(files.has("proj/app/app.css")).toBe(true);
		expect(files.has("proj/app/root.tsx")).toBe(true);
		expect(files.has("proj/app/routes.ts")).toBe(true);
		expect(files.has("proj/app/routes/home.tsx")).toBe(true);
		expect(files.has("proj/app/lib/utils.ts")).toBe(true);
		expect(files.has("proj/workers/app.ts")).toBe(true);
	}, 15000);

	it("uses default style (mira) and font (figtree)", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app");

		const components = JSON.parse(files.get("proj/components.json")!);
		expect(components.style).toBe("radix-mira");

		const css = files.get("proj/app/app.css")!;
		expect(css).toContain("Figtree Variable");

		const pkg = JSON.parse(files.get("proj/package.json")!);
		expect(pkg.dependencies["@fontsource-variable/figtree"]).toBeDefined();
	}, 15000);

	it("applies blue theme colors", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app", { theme: "blue" });

		const css = files.get("proj/app/app.css")!;
		// Blue theme should have different primary colors than neutral
		expect(css).toContain("--primary:");
		expect(css).toContain("--background:");
		// Blue theme uses non-zero chroma in OKLch
		expect(css).toMatch(/--primary:\s*oklch\([^)]*[1-9]/);
	}, 15000);

	it("neutral vs blue have different CSS vars", async () => {
		const neutralFiles = new Map<string, string>();
		await scaffoldProject(neutralFiles, "p/", "app", { theme: "neutral" });

		const blueFiles = new Map<string, string>();
		await scaffoldProject(blueFiles, "p/", "app", { theme: "blue" });

		const neutralCss = neutralFiles.get("p/app/app.css")!;
		const blueCss = blueFiles.get("p/app/app.css")!;

		// They should be different
		expect(neutralCss).not.toBe(blueCss);

		// Extract primary color from each
		const neutralPrimary = neutralCss.match(/--primary:\s*([^;]+)/)?.[1];
		const bluePrimary = blueCss.match(/--primary:\s*([^;]+)/)?.[1];
		console.log("neutral primary:", neutralPrimary);
		console.log("blue primary:", bluePrimary);
		expect(neutralPrimary).not.toBe(bluePrimary);
	}, 15000);

	it("changes font when specified", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app", { font: "inter" });

		const css = files.get("proj/app/app.css")!;
		expect(css).toContain("Inter Variable");
		expect(css).not.toContain("Figtree");

		const pkg = JSON.parse(files.get("proj/package.json")!);
		expect(pkg.dependencies["@fontsource-variable/inter"]).toBeDefined();
	}, 15000);

	it("changes style in components.json", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app", { style: "nova" });

		const components = JSON.parse(files.get("proj/components.json")!);
		expect(components.style).toBe("radix-nova");
	}, 15000);

	it("has dark mode CSS variables", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app", { theme: "blue" });

		const css = files.get("proj/app/app.css")!;
		expect(css).toContain(".dark {");
		// Dark mode should have different background
		const lightBg = css.match(/:root\s*\{[^}]*--background:\s*([^;]+)/)?.[1];
		const darkBg = css.match(/\.dark\s*\{[^}]*--background:\s*([^;]+)/)?.[1];
		console.log("light bg:", lightBg);
		console.log("dark bg:", darkBg);
		expect(lightBg).not.toBe(darkBg);
	}, 15000);

	it("sets project name in wrangler and package.json", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "cool-app");

		const pkg = JSON.parse(files.get("proj/package.json")!);
		expect(pkg.name).toBe("cool-app");

		const wrangler = files.get("proj/wrangler.jsonc")!;
		expect(wrangler).toContain('"cool-app"');
	}, 15000);

	it("CSS has theme color mappings", async () => {
		const files = new Map<string, string>();
		await scaffoldProject(files, "proj/", "my-app");

		const css = files.get("proj/app/app.css")!;
		// Should have @theme inline block with color mappings
		expect(css).toContain("@theme inline");
		expect(css).toContain("--color-primary: var(--primary)");
		expect(css).toContain("--color-background: var(--background)");
		expect(css).toContain("--radius-sm:");
		expect(css).toContain("--radius-lg:");
	}, 15000);
});
