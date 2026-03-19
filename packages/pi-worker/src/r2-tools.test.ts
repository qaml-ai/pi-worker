import { describe, it, expect } from "vitest";
import { normalizeForFuzzyMatch, fuzzyFindText, generateDiffString } from "./r2-tools.js";

describe("normalizeForFuzzyMatch", () => {
	it("strips trailing whitespace per line", () => {
		expect(normalizeForFuzzyMatch("hello   \nworld  ")).toBe("hello\nworld");
	});

	it("normalizes smart quotes to ASCII", () => {
		expect(normalizeForFuzzyMatch("\u201Chello\u201D")).toBe('"hello"');
		expect(normalizeForFuzzyMatch("\u2018world\u2019")).toBe("'world'");
	});

	it("normalizes Unicode dashes to hyphen", () => {
		expect(normalizeForFuzzyMatch("a\u2013b")).toBe("a-b"); // en-dash
		expect(normalizeForFuzzyMatch("a\u2014b")).toBe("a-b"); // em-dash
		expect(normalizeForFuzzyMatch("a\u2212b")).toBe("a-b"); // minus sign
	});

	it("normalizes special spaces to regular space", () => {
		expect(normalizeForFuzzyMatch("a\u00A0b")).toBe("a b"); // NBSP
		expect(normalizeForFuzzyMatch("a\u3000b")).toBe("a b"); // ideographic space
	});

	it("applies NFKC normalization", () => {
		expect(normalizeForFuzzyMatch("\uFB01")).toBe("fi"); // fi ligature
	});
});

describe("fuzzyFindText", () => {
	it("finds exact match", () => {
		const r = fuzzyFindText("hello world", "world");
		expect(r.found).toBe(true);
		expect(r.index).toBe(6);
		expect(r.matchLength).toBe(5);
	});

	it("returns not found for missing text", () => {
		const r = fuzzyFindText("hello world", "xyz");
		expect(r.found).toBe(false);
	});

	it("finds fuzzy match with trailing whitespace difference", () => {
		const r = fuzzyFindText("hello   \nworld", "hello\nworld");
		expect(r.found).toBe(true);
	});

	it("finds fuzzy match with smart quotes", () => {
		const r = fuzzyFindText('say \u201Chello\u201D', 'say "hello"');
		expect(r.found).toBe(true);
	});

	it("finds fuzzy match with en-dash", () => {
		const r = fuzzyFindText("2020\u20132025", "2020-2025");
		expect(r.found).toBe(true);
	});

	it("prefers exact match over fuzzy", () => {
		const content = 'const x = "hello"';
		const r = fuzzyFindText(content, '"hello"');
		expect(r.found).toBe(true);
		expect(r.contentForReplacement).toBe(content); // exact uses original
	});
});

describe("generateDiffString", () => {
	it("shows added lines with + prefix", () => {
		const d = generateDiffString("a\nb", "a\nnew\nb");
		expect(d.diff).toContain("+");
		expect(d.diff).toContain("new");
	});

	it("shows removed lines with - prefix", () => {
		const d = generateDiffString("a\nold\nb", "a\nb");
		expect(d.diff).toContain("-");
		expect(d.diff).toContain("old");
	});

	it("tracks first changed line", () => {
		const d = generateDiffString("a\nb\nc", "a\nB\nc");
		expect(d.firstChangedLine).toBe(2);
	});

	it("handles empty content", () => {
		const d = generateDiffString("", "hello");
		expect(d.diff).toContain("hello");
	});
});
