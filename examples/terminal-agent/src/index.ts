/**
 * Terminal Agent — WebSocket-based AI assistant with Durable Object persistence.
 *
 * Architecture:
 * - Worker: routes HTTP, serves frontend, upgrades WebSocket connections
 * - TerminalSession (Durable Object): persists chat history + files, runs the agent
 * - Frontend: ghostty-web terminal connected via WebSocket
 *
 * Routes:
 *   GET  /                → redirect to new session
 *   GET  /s/:id           → frontend (HTML with ghostty-web)
 *   GET  /ws/:id          → WebSocket upgrade → Durable Object
 *   GET  /api/sessions/:id → session metadata (JSON)
 */

import {
	Agent,
	getModel,
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
} from "pi-worker";
import { renderFrontend } from "./frontend.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	OPENROUTER_API_KEY: string;
	FILES: R2Bucket;
	SESSIONS: DurableObjectNamespace;
}

interface WsInMessage {
	type: "prompt";
	text: string;
}

interface WsOutMessage {
	type: "history" | "assistant_text" | "tool_call" | "tool_result" | "error" | "thinking";
	[key: string]: unknown;
}

interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Worker (fetch handler)
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// GET / → redirect to a new session
		if (url.pathname === "/") {
			const id = crypto.randomUUID().slice(0, 8);
			return Response.redirect(new URL(`/s/${id}`, url.origin).toString(), 302);
		}

		// GET /s/:id → serve frontend
		const sessionMatch = url.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
		if (sessionMatch && request.method === "GET") {
			return new Response(renderFrontend(sessionMatch[1]), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		// GET /ws/:id → WebSocket → Durable Object
		const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
		if (wsMatch) {
			const sessionId = wsMatch[1];
			const doId = env.SESSIONS.idFromName(sessionId);
			const stub = env.SESSIONS.get(doId);
			return stub.fetch(request);
		}

		// GET /api/sessions/:id → session info
		const apiMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
		if (apiMatch && request.method === "GET") {
			const doId = env.SESSIONS.idFromName(apiMatch[1]);
			const stub = env.SESSIONS.get(doId);
			return stub.fetch(new Request(new URL("/info", url.origin)));
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

// ---------------------------------------------------------------------------
// Durable Object — TerminalSession
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful AI coding assistant running inside a terminal.
You have file tools to read, write, edit, and list files in persistent R2 storage.
This session is persistent — the user can disconnect and reconnect, and the conversation
history and files will still be here.

Be concise and direct. Format code with markdown fences. When asked to create or modify
files, use the file tools. After writing files, briefly confirm what you did.`;

export class TerminalSession implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private sockets: Set<WebSocket> = new Set();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// /info endpoint
		if (url.pathname === "/info") {
			const history = (await this.state.storage.get<HistoryEntry[]>("history")) || [];
			return Response.json({
				messageCount: history.length,
				createdAt: await this.state.storage.get("createdAt"),
				lastActivity: await this.state.storage.get("lastActivity"),
			});
		}

		// WebSocket upgrade
		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.state.acceptWebSocket(server);
		this.sockets.add(server);

		// Send history to the new client
		const history = (await this.state.storage.get<HistoryEntry[]>("history")) || [];
		if (history.length > 0) {
			server.send(JSON.stringify({ type: "history", entries: history }));
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
		let msg: WsInMessage;
		try {
			msg = JSON.parse(data);
		} catch {
			this.send(ws, { type: "error", message: "Invalid JSON" });
			return;
		}

		if (msg.type !== "prompt" || !msg.text?.trim()) {
			this.send(ws, { type: "error", message: "Send { type: 'prompt', text: '...' }" });
			return;
		}

		const userText = msg.text.trim();

		// Persist user message
		const history = (await this.state.storage.get<HistoryEntry[]>("history")) || [];
		history.push({ role: "user", text: userText, timestamp: Date.now() });

		// Mark timestamps
		if (!await this.state.storage.get("createdAt")) {
			await this.state.storage.put("createdAt", Date.now());
		}
		await this.state.storage.put("lastActivity", Date.now());

		// Build the agent with R2 file tools (files persist across sessions)
		const agent = new Agent({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
				model: getModel("openrouter", "google/gemini-3-flash-preview"),
				thinkingLevel: "off",
				tools: [
					createR2ReadTool(this.env.FILES),
					createR2WriteTool(this.env.FILES),
					createR2EditTool(this.env.FILES),
					createR2LsTool(this.env.FILES),
				],
			},
			getApiKey: async () => this.env.OPENROUTER_API_KEY,
		});

		// Stream tool events to all connected clients
		agent.subscribe((e) => {
			if (e.type === "tool_execution_start") {
				this.broadcast({ type: "tool_call", tool: (e as any).toolName, args: (e as any).args });
			} else if (e.type === "tool_execution_end") {
				const ev = e as any;
				const text = ev.result?.content?.[0]?.text ?? "";
				this.broadcast({
					type: "tool_result",
					tool: ev.toolName,
					isError: ev.isError,
					result: text.slice(0, 500),
				});
			}
		});

		// Build context from recent history for multi-turn conversation
		const contextMessages = history.slice(-20).map((h) => `${h.role}: ${h.text}`).join("\n");
		const prompt = history.length > 1
			? `Previous conversation:\n${contextMessages}\n\nRespond to the latest user message.`
			: userText;

		this.broadcast({ type: "thinking" });

		try {
			await agent.prompt(prompt);

			// Extract assistant response
			const msgs = agent.state.messages.filter((m) => m.role === "assistant");
			const last = msgs[msgs.length - 1];
			const response = last?.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("") ?? "(no response)";

			// Persist assistant response
			history.push({ role: "assistant", text: response, timestamp: Date.now() });
			await this.state.storage.put("history", history);
			await this.state.storage.put("lastActivity", Date.now());

			this.broadcast({ type: "assistant_text", text: response });
		} catch (error: any) {
			this.broadcast({ type: "error", message: error.message || "Agent error" });

			// Still persist history so far
			await this.state.storage.put("history", history);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.sockets.delete(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.sockets.delete(ws);
	}

	/** Send a message to a single WebSocket. */
	private send(ws: WebSocket, msg: WsOutMessage): void {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			this.sockets.delete(ws);
		}
	}

	/** Broadcast a message to all connected WebSockets. */
	private broadcast(msg: WsOutMessage): void {
		const payload = JSON.stringify(msg);
		for (const ws of this.sockets) {
			try {
				ws.send(payload);
			} catch {
				this.sockets.delete(ws);
			}
		}
	}
}
