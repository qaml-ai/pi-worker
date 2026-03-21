/**
 * Terminal Agent — WebSocket-based AI assistant with Durable Object persistence.
 *
 * Uses SQLite-backed Durable Object storage.
 * Streams ANSI output over WebSocket to a ghostty-web frontend.
 * Browser sends raw keyboard input + resize events back to the Worker.
 *
 * This variant uses pi's real AgentSession + patched InteractiveMode.
 */

import { createSqliteTools } from "pi-worker";
import { renderFrontend } from "./frontend.js";
import { dispatchPublishedWorker } from "./published-workers.js";
import { TuiSession, type HistoryEntry, type PersistedPiState } from "./tui-session.js";

interface Env {
	CF_GATEWAY_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_GATEWAY_NAME: string;
	AI_GATEWAY_MODEL?: string;
	SESSIONS: DurableObjectNamespace;
	LOADER: any;
	OUTBOUND: Fetcher;
}

type ClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			const id = crypto.randomUUID().slice(0, 8);
			return Response.redirect(new URL(`/s/${id}`, url.origin).toString(), 302);
		}

		const sessionMatch = url.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
		if (sessionMatch && request.method === "GET") {
			return new Response(renderFrontend(sessionMatch[1]), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
		if (wsMatch) {
			const sessionId = wsMatch[1];
			const doId = env.SESSIONS.idFromName(sessionId);
			const forwarded = new Request(request, {
				headers: new Headers([...request.headers, ["x-session-name", sessionId]]),
			});
			return env.SESSIONS.get(doId).fetch(forwarded);
		}

		const workerMatch = url.pathname.match(/^\/w\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)(\/.*)?$/);
		if (workerMatch) {
			const [, sessionId, workerName, restPath] = workerMatch;
			const doId = env.SESSIONS.idFromName(sessionId);
			const headers = new Headers(request.headers);
			headers.set("x-session-name", sessionId);
			const forwardedUrl = new URL(`/worker/${workerName}${restPath || ""}${url.search}`, url.origin);
			return env.SESSIONS.get(doId).fetch(new Request(forwardedUrl, { method: request.method, headers, body: request.body, redirect: request.redirect }));
		}

		const apiMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
		if (apiMatch && request.method === "GET") {
			const doId = env.SESSIONS.idFromName(apiMatch[1]);
			return env.SESSIONS.get(doId).fetch(new Request(new URL("/info", url.origin)));
		}

		const hibernateMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/hibernate$/);
		if (hibernateMatch && request.method === "POST") {
			const doId = env.SESSIONS.idFromName(hibernateMatch[1]);
			return env.SESSIONS.get(doId).fetch(new Request(new URL("/hibernate", url.origin), {
				method: "POST",
			}));
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

export class TerminalSession implements DurableObject {
	constructor(private state: DurableObjectState, private _env: Env) {}
	async fetch(): Promise<Response> { return new Response("Migrated", { status: 410 }); }
}

export class TerminalSessionV2 implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private tuiSession?: TuiSession;
	private pendingInitialRedraw = new Set<WebSocket>();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;

		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			)
		`);
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS published_workers (
				name TEXT PRIMARY KEY,
				file TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	private loadHistory(): HistoryEntry[] {
		const rows = this.state.storage.sql.exec(
			"SELECT role, text, timestamp FROM history ORDER BY id"
		).toArray();
		return rows.map((r: any) => ({ role: r.role, text: r.text, timestamp: r.timestamp }));
	}

	private replaceHistory(entries: HistoryEntry[]): void {
		this.state.storage.sql.exec("DELETE FROM history");
		for (const entry of entries) {
			this.state.storage.sql.exec(
				"INSERT INTO history (role, text, timestamp) VALUES (?, ?, ?)",
				entry.role,
				entry.text,
				entry.timestamp,
			);
		}
	}

	private setMeta(key: string, value: string): void {
		this.state.storage.sql.exec(
			"INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
			key, value,
		);
	}

	private getMeta(key: string): string | null {
		const rows = this.state.storage.sql.exec(
			"SELECT value FROM metadata WHERE key = ?", key
		).toArray();
		return rows.length > 0 ? (rows[0] as any).value : null;
	}

	private loadPiState(): PersistedPiState | undefined {
		const raw = this.getMeta("piState");
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as PersistedPiState;
		} catch {
			return undefined;
		}
	}

	private getLastTerminalSize(): { cols: number; rows: number } | undefined {
		const cols = Number(this.getMeta("lastCols"));
		const rows = Number(this.getMeta("lastRows"));
		if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
		if (cols < 10 || rows < 5) return undefined;
		return { cols, rows };
	}

	private saveSessionState(): void {
		if (!this.tuiSession) return;
		this.replaceHistory(this.tuiSession.getHistory());
		this.setMeta("piState", JSON.stringify(this.tuiSession.getPersistedState()));
		this.setMeta("lastActivity", String(Date.now()));
	}

	private ensureSeedFiles(): void {
		const existing = this.state.storage.sql.exec(
			"SELECT 1 FROM files WHERE path = ? LIMIT 1",
			"examples/import-test.js",
		).toArray();
		if (existing.length > 0) return;
		this.state.storage.sql.exec(
			"INSERT INTO files (path, content, updated_at) VALUES (?, ?, ?)",
			"examples/import-test.js",
			[
				'import { z } from "zod";',
				'',
				'export default async function ({ listFiles, writeFile, readFile }) {',
				'  const schema = z.object({ ok: z.literal(true) });',
				'  await writeFile("examples/import-result.json", JSON.stringify(schema.parse({ ok: true }), null, 2));',
				'  const files = await listFiles("examples");',
				'  const result = await readFile("examples/import-result.json");',
				'  return { files, result: JSON.parse(result) };',
				'}',
			].join("\n"),
			Date.now(),
		);
		this.state.storage.sql.exec(
			"INSERT INTO files (path, content, updated_at) VALUES (?, ?, ?)",
			"examples/README.txt",
			[
				"Run the execute tool with file: examples/import-test.js to verify package imports and local filesystem helpers.",
				"",
				"You can also publish HTTP workers from files. Try examples/hello-worker.js with publish_worker name=hello file=examples/hello-worker.js.",
			].join("\n"),
			Date.now(),
		);
		this.state.storage.sql.exec(
			"INSERT INTO files (path, content, updated_at) VALUES (?, ?, ?)",
			"examples/hello-worker.js",
			[
				"export default {",
				"  async fetch(request) {",
				"    const url = new URL(request.url);",
				"    return Response.json({",
				"      ok: true,",
				"      pathname: url.pathname,",
				"      search: url.search,",
				"    });",
				"  },",
				"};",
			].join("\n"),
			Date.now(),
		);
	}

	private createFileStore() {
		return {
			get: async (path: string) => {
				const rows = this.state.storage.sql.exec(
					"SELECT content FROM files WHERE path = ?",
					path,
				).toArray();
				return rows.length > 0 ? (rows[0] as any).content as string : undefined;
			},
			getUpdatedAt: async (path: string) => {
				const rows = this.state.storage.sql.exec(
					"SELECT updated_at FROM files WHERE path = ?",
					path,
				).toArray();
				return rows.length > 0 ? Number((rows[0] as any).updated_at) : undefined;
			},
			put: async (path: string, content: string) => {
				this.state.storage.sql.exec(
					"INSERT OR REPLACE INTO files (path, content, updated_at) VALUES (?, ?, ?)",
					path,
					content,
					Date.now(),
				);
			},
			list: async () => {
				const rows = this.state.storage.sql.exec(
					"SELECT path FROM files ORDER BY path"
				).toArray();
				return rows.map((r: any) => r.path as string);
			},
		};
	}

	private createPublishedWorkerStore() {
		return {
			put: async (name: string, file: string) => {
				this.state.storage.sql.exec(
					"INSERT OR REPLACE INTO published_workers (name, file, updated_at) VALUES (?, ?, ?)",
					name,
					file,
					Date.now(),
				);
			},
			get: async (name: string) => {
				const rows = this.state.storage.sql.exec(
					"SELECT name, file, updated_at FROM published_workers WHERE name = ?",
					name,
				).toArray();
				if (rows.length === 0) return undefined;
				const row = rows[0] as any;
				return { name: row.name as string, file: row.file as string, updatedAt: Number(row.updated_at) };
			},
			delete: async (name: string) => {
				const before = this.state.storage.sql.exec(
					"SELECT 1 FROM published_workers WHERE name = ? LIMIT 1",
					name,
				).toArray().length > 0;
				this.state.storage.sql.exec("DELETE FROM published_workers WHERE name = ?", name);
				return before;
			},
			list: async () => {
				const rows = this.state.storage.sql.exec(
					"SELECT name, file, updated_at FROM published_workers ORDER BY name"
				).toArray();
				return rows.map((row: any) => ({
					name: row.name as string,
					file: row.file as string,
					updatedAt: Number(row.updated_at),
				}));
			},
		};
	}

	private getSessionId(): string {
		return this.getMeta("sessionName") || this.state.id.toString();
	}

	private getOrCreateSession(): TuiSession {
		if (!this.tuiSession) {
			this.ensureSeedFiles();
			const history = this.loadHistory();
			const piState = this.loadPiState();
			const fileStore = this.createFileStore();
			const fileTools = createSqliteTools(fileStore);
			this.tuiSession = new TuiSession(
				(msg) => this.broadcast(msg),
				{
					CF_GATEWAY_TOKEN: this.env.CF_GATEWAY_TOKEN,
					CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
					CF_GATEWAY_NAME: this.env.CF_GATEWAY_NAME,
					AI_GATEWAY_MODEL: this.env.AI_GATEWAY_MODEL,
					sessionId: this.getSessionId(),
					fileTools,
					fileStore,
					publishedWorkers: this.createPublishedWorkerStore(),
					LOADER: this.env.LOADER,
					OUTBOUND: this.env.OUTBOUND,
				},
				history,
				piState,
				(state) => {
					this.setMeta("piState", JSON.stringify(state));
					this.setMeta("lastActivity", String(Date.now()));
				},
			);
			const lastSize = this.getLastTerminalSize();
			if (lastSize) this.tuiSession.setSize(lastSize.cols, lastSize.rows);
		}
		return this.tuiSession;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionName = request.headers.get("x-session-name")?.trim();
		if (sessionName && !this.getMeta("sessionName")) {
			this.setMeta("sessionName", sessionName);
		}

		const publishedWorkerMatch = url.pathname.match(/^\/worker\/([a-zA-Z0-9_-]+)(\/.*)?$/);
		if (publishedWorkerMatch) {
			const [, workerName, workerPathname] = publishedWorkerMatch;
			return dispatchPublishedWorker({
				loader: this.env.LOADER,
				fileStore: this.createFileStore(),
				routeStore: this.createPublishedWorkerStore(),
				sessionId: this.getSessionId(),
				outbound: this.env.OUTBOUND,
			}, workerName, request, workerPathname || "/");
		}

		if (url.pathname === "/info") {
			const count = (this.state.storage.sql.exec(
				"SELECT COUNT(*) as cnt FROM history"
			).toArray()[0] as any).cnt;
			return Response.json({
				messageCount: count,
				createdAt: this.getMeta("createdAt"),
				lastActivity: this.getMeta("lastActivity"),
				liveSession: !!this.tuiSession,
				webSocketCount: this.state.getWebSockets().length,
			});
		}

		if (url.pathname === "/hibernate" && request.method === "POST") {
			this.saveSessionState();
			this.tuiSession?.stop();
			this.tuiSession = undefined;
			return Response.json({
				ok: true,
				message: "Live session dropped. Next reconnect will restore from DO SQLite.",
			});
		}

		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.state.acceptWebSocket(server);
		this.pendingInitialRedraw.add(server);

		const session = this.getOrCreateSession();
		session.start();

		if (!this.getMeta("createdAt")) this.setMeta("createdAt", String(Date.now()));
		this.setMeta("lastActivity", String(Date.now()));

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

		let msg: ClientMessage;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}

		const session = this.getOrCreateSession();

		if (msg.type === "resize") {
			this.setMeta("lastCols", String(msg.cols));
			this.setMeta("lastRows", String(msg.rows));
			const changed = session.setSize(msg.cols, msg.rows);
			if (this.pendingInitialRedraw.delete(_ws) || changed) {
				await session.redraw();
			}
			return;
		}

		if (msg.type !== "input" || typeof msg.data !== "string") return;

		try {
			if (this.pendingInitialRedraw.delete(_ws)) {
				await session.redraw();
			}
			await session.handleInput(msg.data);
			this.saveSessionState();
		} catch (error: any) {
			this.broadcast(`\r\n  \x1b[38;5;204m✗ Server error: ${error.message}\x1b[0m\r\n\r\n`);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.pendingInitialRedraw.delete(ws);
		this.saveSessionState();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.pendingInitialRedraw.delete(ws);
		this.saveSessionState();
	}

	private broadcast(data: string): void {
		for (const ws of this.state.getWebSockets()) {
			try { ws.send(data); } catch {}
		}
	}
}
