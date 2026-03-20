/**
 * Terminal Agent — WebSocket-based AI assistant with Durable Object persistence.
 *
 * Uses SQLite-backed Durable Object storage for session history.
 * Streams agent output over WebSocket via ghostty-web frontend.
 *
 * Routes:
 *   GET  /                → redirect to new session
 *   GET  /s/:id           → frontend (HTML with ghostty-web)
 *   GET  /ws/:id          → WebSocket upgrade → Durable Object
 *   GET  /api/sessions/:id → session metadata (JSON)
 */

import { renderFrontend } from "./frontend.js";
import { TuiSession, type HistoryEntry } from "./tui-session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	OPENROUTER_API_KEY: string;
	FILES: R2Bucket;
	SESSIONS: DurableObjectNamespace;
	LOADER: any; // Dynamic Worker Loader
}

type ClientMessage =
	| { type: "prompt"; text: string };

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

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
			const doId = env.SESSIONS.idFromName(wsMatch[1]);
			return env.SESSIONS.get(doId).fetch(request);
		}

		const apiMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
		if (apiMatch && request.method === "GET") {
			const doId = env.SESSIONS.idFromName(apiMatch[1]);
			return env.SESSIONS.get(doId).fetch(new Request(new URL("/info", url.origin)));
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

// ---------------------------------------------------------------------------
// Durable Object — TerminalSession (SQLite-backed)
// ---------------------------------------------------------------------------

// Legacy class kept for migration — will be deleted in v3
export class TerminalSession implements DurableObject {
	constructor(private state: DurableObjectState, private _env: Env) {}
	async fetch(): Promise<Response> { return new Response("Migrated", { status: 410 }); }
}

export class TerminalSessionV2 implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private tuiSession?: TuiSession;
	private initialized = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;

		// Create SQLite table on first use
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
	}

	private loadHistory(): HistoryEntry[] {
		const rows = this.state.storage.sql.exec(
			"SELECT role, text, timestamp FROM history ORDER BY id"
		).toArray();
		return rows.map((r: any) => ({ role: r.role, text: r.text, timestamp: r.timestamp }));
	}

	private appendHistory(entry: HistoryEntry): void {
		this.state.storage.sql.exec(
			"INSERT INTO history (role, text, timestamp) VALUES (?, ?, ?)",
			entry.role, entry.text, entry.timestamp,
		);
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

	private getOrCreateSession(): TuiSession {
		if (!this.tuiSession) {
			const history = this.loadHistory();
			this.tuiSession = new TuiSession(
				(data) => this.broadcast(data),
				{ OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY, FILES: this.env.FILES, LOADER: this.env.LOADER },
				history,
			);
		}
		return this.tuiSession;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/info") {
			const count = (this.state.storage.sql.exec(
				"SELECT COUNT(*) as cnt FROM history"
			).toArray()[0] as any).cnt;
			return Response.json({
				messageCount: count,
				createdAt: this.getMeta("createdAt"),
				lastActivity: this.getMeta("lastActivity"),
			});
		}

		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.state.acceptWebSocket(server);

		const session = this.getOrCreateSession();
		session.start();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

		let msg: ClientMessage;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}

		if (msg.type !== "prompt" || !msg.text?.trim()) return;

		const session = this.getOrCreateSession();
		if (session.isBusy()) return;

		try {
			if (!this.getMeta("createdAt")) {
				this.setMeta("createdAt", String(Date.now()));
			}
			this.setMeta("lastActivity", String(Date.now()));

			await session.handlePrompt(msg.text);

			// Persist new history entries to SQLite
			const history = session.getHistory();
			// Get current DB count to find new entries
			const dbCount = (this.state.storage.sql.exec(
				"SELECT COUNT(*) as cnt FROM history"
			).toArray()[0] as any).cnt;
			for (let i = dbCount; i < history.length; i++) {
				this.appendHistory(history[i]);
			}
			this.setMeta("lastActivity", String(Date.now()));
		} catch (error: any) {
			// Surface errors to the client
			this.broadcast(`\r\n  \x1b[38;5;204m✗ Server error: ${error.message}\x1b[0m\r\n\r\n`);
			this.broadcast(`\x1b[1m\x1b[38;5;114m❯ \x1b[0m`);
		}
	}

	async webSocketClose(): Promise<void> {
		this.tuiSession = undefined;
	}

	async webSocketError(): Promise<void> {
		this.tuiSession = undefined;
	}

	private broadcast(data: string): void {
		for (const ws of this.state.getWebSockets()) {
			try { ws.send(data); } catch {}
		}
	}
}
