import { describe, it, expect } from "vitest";
import { createShadcnTool } from "./shadcn-tool.js";

describe("createShadcnTool", () => {
	it("installs a single component (radix-mira style)", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		const result = await tool.execute("test", { components: ["button"] });
		const text = result.content[0].text;

		expect(text).toContain("button");
		expect(files.has("app/components/ui/button.tsx")).toBe(true);

		const buttonContent = files.get("app/components/ui/button.tsx")!;
		expect(buttonContent).toContain("React");
		expect(buttonContent).toContain("variant");
		expect(buttonContent).not.toContain("@/registry/");
		expect(buttonContent).toContain("~/lib/utils");
	}, 15000);

	it("installs multiple components", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["button", "card", "badge"] });

		expect(files.has("app/components/ui/button.tsx")).toBe(true);
		expect(files.has("app/components/ui/card.tsx")).toBe(true);
		expect(files.has("app/components/ui/badge.tsx")).toBe(true);
	}, 15000);

	it("adds npm dependencies to package.json", async () => {
		const files = new Map([
			["package.json", '{"name":"test","dependencies":{}}'],
		]);
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["sonner"] });

		const pkg = JSON.parse(files.get("package.json")!);
		expect(pkg.dependencies["sonner"]).toBeDefined();
	}, 15000);

	it("creates cn() utility", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["button"] });

		expect(files.has("app/lib/utils.ts")).toBe(true);
		const utils = files.get("app/lib/utils.ts")!;
		expect(utils).toContain("cn(");
		expect(utils).toContain("clsx");
		expect(utils).toContain("twMerge");
	}, 15000);

	it("respects prefix option", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files, { prefix: "proj_123/" });

		await tool.execute("test", { components: ["button"] });

		expect(files.has("proj_123/app/components/ui/button.tsx")).toBe(true);
		expect(files.has("proj_123/app/lib/utils.ts")).toBe(true);
	}, 15000);

	it("reads style from components.json", async () => {
		const files = new Map<string, string>();
		files.set("components.json", JSON.stringify({ style: "radix-nova" }));
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["button"] });

		const button = files.get("app/components/ui/button.tsx")!;
		expect(button).toBeDefined();
		expect(button).toContain("React");
	}, 15000);

	it("reads style from prefixed components.json", async () => {
		const files = new Map<string, string>();
		files.set("proj/components.json", JSON.stringify({ style: "radix-mira" }));
		const tool = createShadcnTool(files, { prefix: "proj/" });

		await tool.execute("test", { components: ["button"] });

		expect(files.has("proj/app/components/ui/button.tsx")).toBe(true);
	}, 15000);

	it("sanitizes broken icon-placeholder imports from the registry", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["checkbox"] });

		const checkbox = files.get("app/components/ui/checkbox.tsx")!;
		expect(checkbox).not.toContain("icon-placeholder");
		expect(checkbox).toContain('from "lucide-react"');
		expect(checkbox).toContain("<CheckIcon />");
	}, 15000);

	it("handles missing components gracefully", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		const result = await tool.execute("test", { components: ["nonexistent-component-xyz"] });
		const text = result.content[0].text;

		expect(text).toContain("Failed");
		expect(text).toContain("nonexistent-component-xyz");
	}, 15000);
});
