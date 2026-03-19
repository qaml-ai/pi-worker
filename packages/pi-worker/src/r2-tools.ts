/**
 * R2-backed filesystem tools for pi-mono's agent.
 *
 * All tools accept an optional `prefix` for tenant isolation — the agent
 * sees paths like "src/index.ts" but they map to R2 keys like
 * "tenant_123/src/index.ts". The prefix is invisible to the agent.
 *
 * The edit tool uses pi-mono's real algorithm: fuzzy matching with Unicode
 * normalization, BOM preservation, CRLF/LF detection, and diff generation.
 */

import * as Diff from "diff";
import { Type, type Static } from "@sinclair/typebox";

export interface R2ToolOptions {
	/** Key prefix for tenant isolation. The agent never sees this prefix. */
	prefix?: string;
}

/**
 * Normalize and sanitize a path, then prepend the prefix.
 * Rejects path traversal attempts (../) and null bytes.
 */
function toKey(path: string, prefix?: string): string {
	const sanitized = sanitizePath(path);
	return prefix ? `${prefix.replace(/\/+$/, "")}/${sanitized}` : sanitized;
}

function dirPrefix(path: string, prefix?: string): string {
	const base = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";
	if (!path || path === "." || path === "/") return base;
	const sanitized = sanitizePath(path);
	return `${base}${sanitized}/`;
}

/** Exported for testing. */
export function sanitizePath(path: string): string {
	if (path.includes("\0")) throw new Error("Invalid path: null bytes not allowed");

	// Normalize: strip leading/trailing slashes, collapse doubles
	let normalized = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\/\/+/g, "/");

	// Resolve . and .. segments
	const parts = normalized.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") {
			if (resolved.length === 0) throw new Error(`Invalid path: "${path}" escapes root`);
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}

	if (resolved.length === 0) throw new Error(`Invalid path: "${path}" resolves to empty`);
	return resolved.join("/");
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export function createR2ReadTool(bucket: R2Bucket, options?: R2ToolOptions) {
	return {
		name: "read" as const,
		label: "read",
		description:
			"Read the contents of a file from storage. Output is truncated to 500 lines. Use offset/limit for large files.",
		parameters: readSchema,
		execute: async (_id: string, { path, offset, limit }: Static<typeof readSchema>) => {
			const obj = await bucket.get(toKey(path, options?.prefix));
			if (!obj) throw new Error(`File not found: ${path}`);

			const allLines = (await obj.text()).split("\n");
			const total = allLines.length;
			const start = offset ? Math.max(0, offset - 1) : 0;
			if (start >= total) throw new Error(`Offset ${offset} is beyond end of file (${total} lines)`);

			const end = Math.min(start + (limit ?? 500), total);
			let output = allLines.slice(start, end).join("\n");
			if (end < total) output += `\n\n[Showing lines ${start + 1}-${end} of ${total}. Use offset=${end + 1} to continue.]`;

			return { content: [{ type: "text" as const, text: output }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createR2WriteTool(bucket: R2Bucket, options?: R2ToolOptions) {
	return {
		name: "write" as const,
		label: "write",
		description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
		parameters: writeSchema,
		execute: async (_id: string, { path, content }: Static<typeof writeSchema>) => {
			await bucket.put(toKey(path, options?.prefix), content);
			return { content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }], details: {} };
		},
	};
}

// ---------------------------------------------------------------------------
// edit — fuzzy match, BOM, CRLF, diff
// ---------------------------------------------------------------------------

function detectLineEnding(c: string): "\r\n" | "\n" {
	const crlf = c.indexOf("\r\n"), lf = c.indexOf("\n");
	return lf === -1 || crlf === -1 ? "\n" : crlf < lf ? "\r\n" : "\n";
}
function normalizeToLF(t: string) { return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function restoreLineEndings(t: string, e: "\r\n" | "\n") { return e === "\r\n" ? t.replace(/\n/g, "\r\n") : t; }
function stripBom(c: string) { return c.startsWith("\uFEFF") ? { bom: "\uFEFF", text: c.slice(1) } : { bom: "", text: c }; }

// Exported for testing
export function normalizeForFuzzyMatch(text: string): string {
	return text.normalize("NFKC")
		.split("\n").map((l) => l.trimEnd()).join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

// Exported for testing
export function fuzzyFindText(content: string, oldText: string) {
	const exact = content.indexOf(oldText);
	if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, contentForReplacement: content };

	const fc = normalizeForFuzzyMatch(content), fo = normalizeForFuzzyMatch(oldText);
	const fi = fc.indexOf(fo);
	if (fi === -1) return { found: false, index: -1, matchLength: 0, contentForReplacement: content };

	return { found: true, index: fi, matchLength: fo.length, contentForReplacement: fc };
}

export function generateDiffString(oldContent: string, newContent: string, ctx = 4) {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const w = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	let oln = 1, nln = 1, lastChange = false, first: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i], raw = p.value.split("\n");
		if (raw.at(-1) === "") raw.pop();

		if (p.added || p.removed) {
			if (first === undefined) first = nln;
			for (const l of raw) {
				if (p.added) { output.push(`+${String(nln).padStart(w)} ${l}`); nln++; }
				else { output.push(`-${String(oln).padStart(w)} ${l}`); oln++; }
			}
			lastChange = true;
		} else {
			const next = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			if (lastChange || next) {
				let lines = raw, ss = 0, se = 0;
				if (!lastChange) { ss = Math.max(0, raw.length - ctx); lines = raw.slice(ss); }
				if (!next && lines.length > ctx) { se = lines.length - ctx; lines = lines.slice(0, ctx); }
				if (ss > 0) { output.push(` ${"".padStart(w)} ...`); oln += ss; nln += ss; }
				for (const l of lines) { output.push(` ${String(oln).padStart(w)} ${l}`); oln++; nln++; }
				if (se > 0) { output.push(` ${"".padStart(w)} ...`); oln += se; nln += se; }
			} else { oln += raw.length; nln += raw.length; }
			lastChange = false;
		}
	}
	return { diff: output.join("\n"), firstChangedLine: first };
}

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

export function createR2EditTool(bucket: R2Bucket, options?: R2ToolOptions) {
	return {
		name: "edit" as const,
		label: "edit",
		description: "Edit a file by replacing exact text. Supports fuzzy matching for smart quotes, Unicode dashes, and trailing whitespace.",
		parameters: editSchema,
		execute: async (_id: string, { path, oldText, newText }: Static<typeof editSchema>) => {
			const key = toKey(path, options?.prefix);
			const obj = await bucket.get(key);
			if (!obj) throw new Error(`File not found: ${path}`);

			const { bom, text: content } = stripBom(await obj.text());
			const ending = detectLineEnding(content);
			const nc = normalizeToLF(content), no = normalizeToLF(oldText), nn = normalizeToLF(newText);

			const match = fuzzyFindText(nc, no);
			if (!match.found) throw new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);

			const fc = normalizeForFuzzyMatch(nc), fo = normalizeForFuzzyMatch(no);
			if (fc.split(fo).length - 1 > 1) throw new Error(`Found multiple occurrences in ${path}. Provide more context to make it unique.`);

			const base = match.contentForReplacement;
			const result = base.substring(0, match.index) + nn + base.substring(match.index + match.matchLength);
			if (base === result) throw new Error(`No changes made to ${path}.`);

			await bucket.put(key, bom + restoreLineEndings(result, ending));
			const d = generateDiffString(base, result);

			return {
				content: [{ type: "text" as const, text: `Successfully replaced text in ${path}.\n\n${d.diff}` }],
				details: { diff: d.diff, firstChangedLine: d.firstChangedLine },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: root)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 500)" })),
});

export function createR2LsTool(bucket: R2Bucket, options?: R2ToolOptions) {
	return {
		name: "ls" as const,
		label: "ls",
		description: "List files and directories. Entries sorted alphabetically, '/' suffix for directories.",
		parameters: lsSchema,
		execute: async (_id: string, { path, limit }: Static<typeof lsSchema>) => {
			const prefix = dirPrefix(path || "", options?.prefix);
			const stripPrefix = prefix;
			const max = limit ?? 500;
			const listed = await bucket.list({ prefix: prefix || undefined, delimiter: "/", limit: max });

			const entries: string[] = [];
			for (const dp of listed.delimitedPrefixes) { const n = dp.slice(stripPrefix.length); if (n) entries.push(n); }
			for (const obj of listed.objects) { const n = obj.key.slice(stripPrefix.length); if (n) entries.push(n); }
			entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			if (entries.length === 0) return { content: [{ type: "text" as const, text: "(empty directory)" }], details: {} };

			let output = entries.join("\n");
			if (listed.truncated) output += `\n\n[${max} entries limit reached. Use limit=${max * 2} for more.]`;

			return { content: [{ type: "text" as const, text: output }], details: {} };
		},
	};
}
