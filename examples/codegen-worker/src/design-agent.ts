/**
 * Design Agent — picks the right style, theme, font, and radius for a project
 * based on the user's app description, then scaffolds the project.
 *
 * Runs before the codegen agent. Has one tool: scaffold().
 */

import { Agent, getModel } from "pi-worker";
import { Type, type Static } from "@sinclair/typebox";
import { scaffoldProject, type ScaffoldOptions } from "./scaffold.js";

const DESIGN_PROMPT = `You are a UI design expert. Given a description of a web app, choose the best visual design options and scaffold the project.

You have one tool: scaffold. You MUST call it exactly once.

OPTIONS:

**style** — The overall component design language:
- "mira" — Clean, modern, professional. Best for dashboards, SaaS apps, admin panels. (DEFAULT)
- "nova" — Rounded, friendly, approachable. Best for consumer apps, social, creative tools.
- "vega" — Sharp, dense, enterprise. Best for data-heavy apps, financial tools, analytics.
- "lyra" — Soft, elegant, refined. Best for portfolios, marketing sites, luxury brands.
- "maia" — Warm, organic, natural. Best for health, wellness, education apps.

**theme** — The primary color that defines the brand:
- "neutral" — Professional gray. Safe default for business tools.
- "blue" — Trust, reliability. Banks, enterprise, communication tools.
- "indigo" — Creative, modern. Design tools, dev tools, AI products.
- "violet" — Premium, innovative. Creative platforms, luxury.
- "emerald" — Growth, health. Finance, health, sustainability.
- "green" — Nature, success. Agriculture, environment, wellness.
- "teal" — Calm, medical. Healthcare, science, analytics.
- "cyan" — Tech, fresh. Developer tools, monitoring, IoT.
- "sky" — Open, friendly. Social, weather, travel.
- "amber" — Warm, attention. Food, construction, alerts.
- "orange" — Energy, fun. Entertainment, fitness, gaming.
- "red" — Urgent, bold. News, emergency, sales.
- "rose" — Soft, caring. Dating, beauty, baby products.
- "pink" — Playful, young. Fashion, social, creative.
- "fuchsia" — Bold, vibrant. Music, art, nightlife.
- "purple" — Royal, mystical. Astrology, gaming, luxury.
- "lime" — Fresh, eco. Organic, sustainability, food.
- "yellow" — Optimistic, bright. Kids, education, productivity.

**font** — The primary typeface:
- "figtree" — Modern geometric sans. Clean and versatile. (DEFAULT)
- "inter" — Highly legible UI font. Best for data-dense interfaces.
- "noto-sans" — Global language support. Best for i18n apps.
- "nunito-sans" — Friendly rounded sans. Best for consumer apps.

**radius** — Border radius for all components:
- "default" — Standard rounded corners (0.625rem). (DEFAULT)
- "none" — Square corners. Sharp, technical look.
- "small" — Slightly rounded. Subtle, professional.
- "medium" — Moderately rounded. Balanced, modern.
- "large" — Very rounded. Soft, friendly feel.

GUIDELINES:
- Match the style to the app's purpose and audience
- Pick a theme color that aligns with the brand/industry
- Choose a font that supports the app's information density
- Select radius that matches the overall tone (sharp = serious, round = friendly)
- When in doubt, use the defaults (mira, neutral, figtree, default)
- You MUST call scaffold exactly once — don't overthink it`;

const scaffoldSchema = Type.Object({
	style: Type.Optional(Type.Union([
		Type.Literal("mira"), Type.Literal("nova"), Type.Literal("vega"),
		Type.Literal("lyra"), Type.Literal("maia"),
	], { description: "Component design language" })),
	theme: Type.Optional(Type.String({ description: "Primary brand color (e.g. blue, emerald, violet)" })),
	font: Type.Optional(Type.Union([
		Type.Literal("figtree"), Type.Literal("inter"),
		Type.Literal("noto-sans"), Type.Literal("nunito-sans"),
	], { description: "Primary typeface" })),
	radius: Type.Optional(Type.Union([
		Type.Literal("default"), Type.Literal("none"), Type.Literal("small"),
		Type.Literal("medium"), Type.Literal("large"),
	], { description: "Border radius" })),
});

export interface DesignResult {
	options: ScaffoldOptions;
}

/**
 * Run the design agent — it picks design options and scaffolds the project.
 * Returns the scaffold options it chose.
 */
export async function runDesignAgent(
	prompt: string,
	files: Map<string, string>,
	prefix: string,
	projectName: string,
	apiKey: string,
	modelId?: string,
): Promise<DesignResult> {
	let chosenOptions: ScaffoldOptions = {};

	const scaffoldTool = {
		name: "scaffold" as const,
		label: "scaffold",
		description: "Scaffold the project with the chosen design options. Call this exactly once.",
		parameters: scaffoldSchema,
		execute: async (_id: string, opts: Static<typeof scaffoldSchema>) => {
			chosenOptions = opts;
			await scaffoldProject(files, prefix, projectName, opts);

			const summary = [
				`Scaffolded with:`,
				`  Style: ${opts.style || "mira"}`,
				`  Theme: ${opts.theme || "neutral"}`,
				`  Font: ${opts.font || "figtree"}`,
				`  Radius: ${opts.radius || "default"}`,
			].join("\n");

			return {
				content: [{ type: "text" as const, text: summary }],
				details: {},
			};
		},
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: DESIGN_PROMPT,
			model: getModel("openrouter", (modelId || "google/gemini-3-flash-preview") as any),
			thinkingLevel: "off",
			tools: [scaffoldTool],
		},
		getApiKey: async () => apiKey,
	});

	await agent.prompt(prompt);

	if (agent.state.error) {
		throw new Error(`Design agent failed: ${agent.state.error}`);
	}

	// If the agent didn't call scaffold (shouldn't happen), do it with defaults
	if (files.size === 0) {
		await scaffoldProject(files, prefix, projectName);
	}

	return { options: chosenOptions };
}
