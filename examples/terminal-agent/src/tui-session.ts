/**
 * Terminal session — streams agent output over WebSocket as raw text.
 * All markdown rendering happens client-side.
 */

import {
	Agent,
	getModel,
	createR2ReadTool,
	createR2WriteTool,
	createR2EditTool,
	createR2LsTool,
	createExecuteTool,
} from "pi-worker";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;

function fg256(n: number): string { return `${ESC}38;5;${n}m`; }

const BLUE = fg256(75);
const GREEN = fg256(114);
const YELLOW = fg256(179);
const RED = fg256(204);
const GRAY = fg256(245);

const CR_LF = "\r\n";

// Protocol markers — client detects these to switch rendering modes
const STREAM_START = "\x01S\x01";
const STREAM_END = "\x01E\x01";
const HISTORY_START = "\x01H\x01";
const HISTORY_END = "\x01/H\x01";

interface Env {
	OPENROUTER_API_KEY: string;
	FILES: R2Bucket;
	LOADER?: any; // Dynamic Worker Loader binding
}

export interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

const SYSTEM_PROMPT = `You are a helpful AI coding assistant running inside a terminal.
You have file tools to read, write, edit, and list files in persistent R2 storage.
You also have an execute tool to run JavaScript code in an isolated V8 sandbox.
This session is persistent — the user can disconnect and reconnect, and the conversation
history and files will still be here.

Be concise and direct. When asked to create or modify files, use the file tools.
When asked to run code, use the execute tool with inline code or write a file first and execute it.
After completing tasks, briefly confirm what you did.`;

export class TuiSession {
	private writeFn: (data: string) => void;
	private env: Env;
	private history: HistoryEntry[];
	private busy = false;

	constructor(writeFn: (data: string) => void, env: Env, history: HistoryEntry[]) {
		this.writeFn = writeFn;
		this.env = env;
		this.history = history;
	}

	start(): void {
		this.write(`${BOLD}${BLUE}Terminal Agent${RESET} ${GRAY}— AI coding assistant with persistent sessions${RESET}${CR_LF}`);
		this.write(`${GRAY}Powered by ghostty-web + Cloudflare Durable Objects${RESET}${CR_LF}${CR_LF}`);

		const recent = this.history.slice(-10);
		if (recent.length > 0) {
			this.write(`${GRAY}┄┄┄ session restored (${this.history.length} messages) ┄┄┄${RESET}${CR_LF}${CR_LF}`);
			for (const entry of recent) {
				if (entry.role === "user") {
					this.write(`${BOLD}${GREEN}❯ ${RESET}${entry.text}${CR_LF}`);
				} else {
					this.write(HISTORY_START + entry.text + HISTORY_END);
				}
			}
		}

		this.writePrompt();
	}

	stop(): void {}

	async handlePrompt(text: string): Promise<void> {
		const userText = text.trim();
		if (!userText || this.busy) return;

		this.busy = true;
		this.history.push({ role: "user", text: userText, timestamp: Date.now() });

		try {
			let inStream = false;

			const startStream = () => {
				if (!inStream) {
					inStream = true;
					this.write(STREAM_START);
				}
			};

			const endStream = () => {
				if (inStream) {
					inStream = false;
					this.write(STREAM_END);
				}
			};

			const onTextDelta = (delta: string) => {
				startStream();
				this.write(delta);
			};

			const onToolStart = (toolName: string, args: Record<string, unknown>) => {
				endStream();
				// Show path if available, otherwise first short string arg
				const path = args.path as string | undefined;
				let detail = "";
				if (path) {
					detail = ` ${GRAY}${path}${RESET}`;
				} else {
					const shortArg = Object.entries(args).find(([k, v]) => typeof v === "string" && k !== "content" && (v as string).length < 80);
					if (shortArg) detail = ` ${GRAY}${shortArg[1]}${RESET}`;
				}
				this.write(`  ${YELLOW}⚡ ${toolName}${RESET}${detail}${CR_LF}`);
			};

			const onToolEnd = (_toolName: string, text: string, isError: boolean, args: Record<string, unknown>) => {
				if (isError) {
					this.write(`     ${RED}${text.split("\n")[0]?.slice(0, 100)}${RESET}${CR_LF}`);
					return;
				}
				// If any arg is a long multi-line string, show a box preview of it
				const longArg = Object.entries(args).find(
					([_, v]) => typeof v === "string" && (v as string).includes("\n") && (v as string).length > 80
				);
				if (longArg) {
					const lines = (longArg[1] as string).split("\n");
					const preview = lines.slice(0, 6);
					this.write(`     ${GRAY}┌──${RESET}${CR_LF}`);
					for (const line of preview) {
						this.write(`     ${GRAY}│${RESET} ${line.slice(0, 100)}${CR_LF}`);
					}
					if (lines.length > 6) {
						this.write(`     ${GRAY}│ ... ${lines.length - 6} more lines${RESET}${CR_LF}`);
					}
					this.write(`     ${GRAY}└──${RESET}${CR_LF}`);
				}
				// Always show the result
				if (text) {
					const resultLines = text.split("\n").slice(0, 5);
					for (const line of resultLines) {
						this.write(`     ${GREEN}→ ${RESET}${line.slice(0, 120)}${CR_LF}`);
					}
					if (text.split("\n").length > 5) {
						this.write(`     ${GRAY}... ${text.split("\n").length - 5} more lines${RESET}${CR_LF}`);
					}
				}
			};

			const response = await this.runAgent(userText, onTextDelta, onToolStart, onToolEnd);

			endStream();

			this.history.push({ role: "assistant", text: response, timestamp: Date.now() });
		} catch (error: any) {
			this.write(STREAM_END); // ensure stream is closed
			this.write(`${CR_LF}  ${RED}✗ Error: ${error.message || "Agent error"}${RESET}${CR_LF}${CR_LF}`);
		}

		this.writePrompt();
		this.busy = false;
	}

	getHistory(): HistoryEntry[] { return this.history; }
	isBusy(): boolean { return this.busy; }

	private write(data: string): void { this.writeFn(data); }
	private writePrompt(): void { this.write(`${BOLD}${GREEN}❯ ${RESET}`); }

	private async runAgent(
		userText: string,
		onTextDelta: (delta: string) => void,
		onToolStart: (name: string, args: Record<string, unknown>) => void,
		onToolEnd: (text: string, isError: boolean) => void,
	): Promise<string> {
		const tools: any[] = [
			createR2ReadTool(this.env.FILES),
			createR2WriteTool(this.env.FILES),
			createR2EditTool(this.env.FILES),
			createR2LsTool(this.env.FILES),
		];

		// Add JS execution tool if the Dynamic Worker Loader binding is available
		if (this.env.LOADER) {
			tools.push(createExecuteTool(this.env.LOADER, {
				fetch: async (url: string, init?: any) => {
					const res = await globalThis.fetch(url, init);
					return { status: res.status, body: await res.text() };
				},
			}, {
				bucket: this.env.FILES,
				description:
					`Execute JavaScript code in an isolated V8 sandbox.\n\n` +
					`Available functions:\n` +
					`- fetch(url, init?) — make HTTP requests\n\n` +
					`You can also read/write files in R2 via the file tools, then execute them with the 'file' parameter.\n` +
					`For inline code: write the body of an async function. Use 'return' for results.`,
			}));
		}

		const agent = new Agent({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
				model: getModel("openrouter", "google/gemini-3-flash-preview"),
				thinkingLevel: "off",
				tools,
			},
			getApiKey: async () => this.env.OPENROUTER_API_KEY,
		});

		const toolArgs = new Map<string, Record<string, unknown>>();
		agent.subscribe((e) => {
			if (e.type === "message_update") {
				const ev = e as any;
				const ame = ev.assistantMessageEvent;
				if (ame?.type === "text_delta" && ame.delta) {
					onTextDelta(ame.delta);
				}
			}
			if (e.type === "tool_execution_start") {
				const ev = e as any;
				toolArgs.set(ev.toolCallId || ev.toolName, ev.args || {});
				onToolStart(ev.toolName, ev.args || {});
			} else if (e.type === "tool_execution_end") {
				const ev = e as any;
				const text = ev.result?.content?.[0]?.text ?? "";
				const args = toolArgs.get(ev.toolCallId || ev.toolName) || {};
				onToolEnd(ev.toolName, text, ev.isError, args);
			}
		});

		const contextMessages = this.history.slice(-20).map((h) => `${h.role}: ${h.text}`).join("\n");
		const prompt = this.history.length > 1
			? `Previous conversation:\n${contextMessages}\n\nRespond to the latest user message.`
			: userText;

		await agent.prompt(prompt);

		const msgs = agent.state.messages.filter((m) => m.role === "assistant");
		const last = msgs[msgs.length - 1];
		return last?.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("") ?? "(no response)";
	}
}
