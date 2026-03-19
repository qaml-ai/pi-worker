import { describe, it, expect } from "vitest";
import { createShadcnTool } from "./shadcn-tool.js";

describe("createShadcnTool", () => {
	it("installs a single component", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		const result = await tool.execute("test", { components: ["button"] });
		const text = result.content[0].text;

		expect(text).toContain("button");
		expect(files.has("src/components/ui/button.tsx")).toBe(true);

		const buttonContent = files.get("src/components/ui/button.tsx")!;
		expect(buttonContent).toContain("React");
		expect(buttonContent).toContain("variant");
	}, 15000);

	it("installs multiple components", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["button", "card", "badge"] });

		expect(files.has("src/components/ui/button.tsx")).toBe(true);
		expect(files.has("src/components/ui/card.tsx")).toBe(true);
		expect(files.has("src/components/ui/badge.tsx")).toBe(true);
	}, 15000);

	it("adds npm dependencies to package.json", async () => {
		const files = new Map([
			["package.json", '{"name":"test","dependencies":{}}'],
		]);
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["dialog"] });

		const pkg = JSON.parse(files.get("package.json")!);
		expect(pkg.dependencies["@radix-ui/react-dialog"]).toBeDefined();
	}, 15000);

	it("creates cn() utility", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files);

		await tool.execute("test", { components: ["button"] });

		expect(files.has("src/lib/utils.ts")).toBe(true);
		const utils = files.get("src/lib/utils.ts")!;
		expect(utils).toContain("cn(");
		expect(utils).toContain("clsx");
		expect(utils).toContain("twMerge");
	}, 15000);

	it("respects prefix option", async () => {
		const files = new Map<string, string>();
		const tool = createShadcnTool(files, { prefix: "proj_123/" });

		await tool.execute("test", { components: ["button"] });

		expect(files.has("proj_123/src/components/ui/button.tsx")).toBe(true);
		expect(files.has("proj_123/src/lib/utils.ts")).toBe(true);
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
