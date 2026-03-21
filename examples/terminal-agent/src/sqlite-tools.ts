import { Type, type Static } from "@sinclair/typebox";
import { fuzzyFindText, generateDiffString, normalizeForFuzzyMatch, sanitizePath } from "pi-worker";

export interface SqliteTextFileStore {
	get(path: string): Promise<string | undefined>;
	put(path: string, content: string): Promise<void>;
	list(): Promise<string[]>;
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write" }),
	content: Type.String({ description: "Content to write to the file" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: root)" })),
});

function detectLineEnding(c: string): "\r\n" | "\n" {
	const crlf = c.indexOf("\r\n"), lf = c.indexOf("\n");
	return lf === -1 || crlf === -1 ? "\n" : crlf < lf ? "\r\n" : "\n";
}
function normalizeToLF(t: string) { return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function restoreLineEndings(t: string, e: "\r\n" | "\n") { return e === "\r\n" ? t.replace(/\n/g, "\r\n") : t; }
function stripBom(c: string) { return c.startsWith("\uFEFF") ? { bom: "\uFEFF", text: c.slice(1) } : { bom: "", text: c }; }

export function createSqliteReadTool(store: SqliteTextFileStore) {
	return {
		name: "read" as const,
		label: "read",
		description: "Read the contents of a file. Output is truncated to 500 lines. Use offset/limit for large files.",
		parameters: readSchema,
		execute: async (_id: string, { path, offset, limit }: Static<typeof readSchema>) => {
			const content = await store.get(sanitizePath(path));
			if (content === undefined) throw new Error(`File not found: ${path}`);

			const allLines = content.split("\n");
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

export function createSqliteWriteTool(store: SqliteTextFileStore) {
	return {
		name: "write" as const,
		label: "write",
		description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
		parameters: writeSchema,
		execute: async (_id: string, { path, content }: Static<typeof writeSchema>) => {
			await store.put(sanitizePath(path), content);
			return { content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }], details: {} };
		},
	};
}

export function createSqliteEditTool(store: SqliteTextFileStore) {
	return {
		name: "edit" as const,
		label: "edit",
		description: "Edit a file by replacing exact text. Supports fuzzy matching for smart quotes, Unicode dashes, and trailing whitespace.",
		parameters: editSchema,
		execute: async (_id: string, { path, oldText, newText }: Static<typeof editSchema>) => {
			const key = sanitizePath(path);
			const raw = await store.get(key);
			if (raw === undefined) throw new Error(`File not found: ${path}`);

			const { bom, text: content } = stripBom(raw);
			const ending = detectLineEnding(content);
			const nc = normalizeToLF(content), no = normalizeToLF(oldText), nn = normalizeToLF(newText);

			const match = fuzzyFindText(nc, no);
			if (!match.found) throw new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);

			const fc = normalizeForFuzzyMatch(nc), fo = normalizeForFuzzyMatch(no);
			if (fc.split(fo).length - 1 > 1) throw new Error(`Found multiple occurrences in ${path}. Provide more context to make it unique.`);

			const base = match.contentForReplacement;
			const result = base.substring(0, match.index) + nn + base.substring(match.index + match.matchLength);
			if (base === result) throw new Error(`No changes made to ${path}.`);

			await store.put(key, bom + restoreLineEndings(result, ending));
			const d = generateDiffString(base, result);
			return {
				content: [{ type: "text" as const, text: `Successfully replaced text in ${path}.\n\n${d.diff}` }],
				details: { diff: d.diff, firstChangedLine: d.firstChangedLine },
			};
		},
	};
}

export function createSqliteLsTool(store: SqliteTextFileStore) {
	return {
		name: "ls" as const,
		label: "ls",
		description: "List files and directories. Entries sorted alphabetically, '/' suffix for directories.",
		parameters: lsSchema,
		execute: async (_id: string, { path }: Static<typeof lsSchema>) => {
			const keys = await store.list();
			const rawPath = (path || "").trim();
			const dirPath = rawPath === "." || rawPath === "/"
				? ""
				: rawPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/\/+/g, "/");
			const fullPrefix = dirPath ? `${sanitizePath(dirPath)}/` : "";
			const entries = new Set<string>();
			for (const key of keys) {
				if (!key.startsWith(fullPrefix)) continue;
				const rest = key.slice(fullPrefix.length);
				if (!rest) continue;
				const slashIdx = rest.indexOf("/");
				entries.add(slashIdx === -1 ? rest : rest.substring(0, slashIdx + 1));
			}
			const sorted = [...entries].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			if (sorted.length === 0) {
				return { content: [{ type: "text" as const, text: "(empty directory)" }], details: {} };
			}
			return { content: [{ type: "text" as const, text: sorted.join("\n") }], details: {} };
		},
	};
}

export function createSqliteTools(store: SqliteTextFileStore) {
	return [
		createSqliteReadTool(store),
		createSqliteWriteTool(store),
		createSqliteEditTool(store),
		createSqliteLsTool(store),
	];
}
