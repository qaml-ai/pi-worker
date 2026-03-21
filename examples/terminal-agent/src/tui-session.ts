/**
 * Worker-side session powered by pi's real AgentSession + InteractiveMode.
 *
 * We reuse as much actual pi code as possible:
 * - createAgentSession()
 * - AgentSession event handling/state
 * - InteractiveMode TUI
 * - pi-tui rendering/components
 *
 * Worker-specific adaptations:
 * - custom WorkerTerminal transport
 * - in-memory settings/session/auth managers
 * - Worker-native tools from pi-worker
 * - minimal ResourceLoader (no fs discovery)
 */

import { createExecuteTool, sanitizePath } from "pi-worker";
import { createSqliteTools } from "./sqlite-tools.js";
import {
	AuthStorage,
	createAgentSession,
	InteractiveMode,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "pi-coding-agent-worker";
import { WorkerTerminal } from "./pi-fork/worker-terminal.js";

interface Env {
	CF_GATEWAY_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_GATEWAY_NAME: string;
	AI_GATEWAY_MODEL?: string;
	fileTools: any[];
	fileStore: {
		get(path: string): Promise<string | undefined>;
		put(path: string, content: string): Promise<void>;
		list(): Promise<string[]>;
	};
	LOADER?: any;
	OUTBOUND?: any;
}

export interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

export interface PersistedPiState {
	messages?: any[];
	sessionEntries?: any[];
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

const SYSTEM_PROMPT = `You are a helpful AI coding assistant running inside a terminal.
You have file tools to read, write, edit, and list files in a persistent SQLite-backed filesystem.
You also have an execute tool to run JavaScript code in an isolated V8 sandbox.
The execute environment supports local relative imports from the filesystem and package imports resolved through esm.sh. File-based scripts can import other local files and many ESM packages. Inline execute also supports imports when you provide a full ES module with an explicit export default async function.
This session is persistent — the user can disconnect and reconnect, and the conversation
history and files will still be here.

Important: bash is not available in this environment. Do not tell the user you can run bash commands, and do not suggest using bash. Use the file tools and execute tool instead.

Be concise and direct. When asked to create or modify files, use the file tools.
When asked to run code, use the execute tool with inline code or write a file first and execute it.
For multi-file code or package usage, prefer writing a script file and then executing it.
After completing tasks, briefly confirm what you did.`;

function buildGatewayModel(env: Env, preferredModel?: { provider: string; id: string }) {
	const rawId = preferredModel?.id?.trim() || env.AI_GATEWAY_MODEL?.trim() || "dynamic/pi";
	const id = rawId === "auto" ? "dynamic/pi" : rawId;
	return {
		provider: "ai-gateway",
		id,
		name: `AI Gateway (${id})`,
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CF_ACCOUNT_ID)}/${encodeURIComponent(env.CF_GATEWAY_NAME)}/compat`,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	} as any;
}

function registerGatewayProvider(modelRegistry: ModelRegistry, env: Env) {
	const model = buildGatewayModel(env);
	modelRegistry.registerProvider("ai-gateway", {
		baseUrl: model.baseUrl,
		apiKey: "CF_GATEWAY_TOKEN",
		authHeader: true,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				compat: model.compat,
			},
		],
	});
}

function hideBuiltInProviders(modelRegistry: ModelRegistry, hiddenProviders: string[]) {
	const hidden = new Set(hiddenProviders);
	const originalGetAll = modelRegistry.getAll.bind(modelRegistry);
	const originalGetAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const originalFind = modelRegistry.find.bind(modelRegistry);
	(modelRegistry as any).getAll = () => originalGetAll().filter((m) => !hidden.has(m.provider));
	(modelRegistry as any).getAvailable = () => originalGetAvailable().filter((m) => !hidden.has(m.provider));
	(modelRegistry as any).find = (provider: string, modelId: string) => {
		if (hidden.has(provider)) return undefined;
		return originalFind(provider, modelId);
	};
}

function createEmptyExtensionRuntime() {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const runtime: any = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		registerProvider: (name: string, config: unknown, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name: string) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r: any) => r.name !== name);
		},
	};
	return runtime;
}

function createResourceLoader(systemPrompt: string) {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createEmptyExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};
}

export class TuiSession {
	private readonly sendFn: (msg: string) => void;
	private readonly env: Env;
	private readonly history: HistoryEntry[];
	private readonly persistedState?: PersistedPiState;
	private readonly onStateChange?: (state: PersistedPiState) => void;
	private readonly terminal: WorkerTerminal;

	private session?: Awaited<ReturnType<typeof createAgentSession>>["session"];
	private mode?: InteractiveMode;
	private startPromise?: Promise<void>;
	private ready = false;

	constructor(
		sendFn: (msg: string) => void,
		env: Env,
		history: HistoryEntry[],
		persistedState?: PersistedPiState,
		onStateChange?: (state: PersistedPiState) => void,
	) {
		this.sendFn = sendFn;
		this.env = env;
		this.history = history;
		this.persistedState = persistedState;
		this.onStateChange = onStateChange;
		this.terminal = new WorkerTerminal(sendFn, { cols: 80, rows: 24, kittyProtocolActive: false });
	}

	private persistState(): void {
		if (!this.session || !this.onStateChange) return;
		const model = this.session.model;
		const sm: any = this.session.sessionManager;
		this.onStateChange({
			messages: this.session.agent.state.messages,
			sessionEntries: sm?.fileEntries,
			model: model ? { provider: model.provider, id: model.id } : undefined,
			thinkingLevel: this.session.thinkingLevel,
		});
	}

	private async ensureStarted(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("ai-gateway", this.env.CF_GATEWAY_TOKEN);
		const modelRegistry = new ModelRegistry(authStorage);
		registerGatewayProvider(modelRegistry, this.env);
		hideBuiltInProviders(modelRegistry, ["openrouter"]);
		const settingsManager = SettingsManager.inMemory({
			theme: "dark",
			ui: {
				quietStartup: true,
				collapseChangelog: true,
				showImages: false,
			},
			thinking: { hideBlock: false },
			compaction: { enabled: false },
			retry: { enabled: false },
		} as any);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = createResourceLoader(SYSTEM_PROMPT);
		const customTools: any[] = [...this.env.fileTools];

		if (this.env.LOADER) {
			customTools.push(createExecuteTool(this.env.LOADER, {
				readFile: async (path: string) => {
					const content = await this.env.fileStore.get(sanitizePath(path));
					if (content === undefined) throw new Error(`File not found: ${path}`);
					return content;
				},
				writeFile: async (path: string, content: string) => {
					await this.env.fileStore.put(sanitizePath(path), String(content));
					return `Wrote ${String(content).length} bytes to ${path}`;
				},
				listFiles: async (path = ".") => {
					const rawPath = String(path).trim();
					const dirPath = rawPath === "." || rawPath === "/"
						? ""
						: sanitizePath(rawPath);
					const prefix = dirPath ? `${dirPath}/` : "";
					const entries = new Set<string>();
					for (const key of await this.env.fileStore.list()) {
						if (!key.startsWith(prefix)) continue;
						const rest = key.slice(prefix.length);
						if (!rest) continue;
						const slashIdx = rest.indexOf("/");
						entries.add(slashIdx === -1 ? rest : rest.slice(0, slashIdx + 1));
					}
					return [...entries].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
				},
			}, {
				readFile: async (path: string) => this.env.fileStore.get(sanitizePath(path)),
				globalOutbound: this.env.OUTBOUND,
				outboundBinding: this.env.OUTBOUND,
			}));
		}

		const model = buildGatewayModel(this.env, this.persistedState?.model);

		const { session } = await createAgentSession({
			cwd: "/",
			agentDir: "/.pi/agent",
			authStorage,
			modelRegistry,
			model,
			thinkingLevel: (this.persistedState?.thinkingLevel as any) || "medium",
			customTools,
			resourceLoader: resourceLoader as any,
			sessionManager,
			settingsManager,
		});

		this.session = session;

		if (this.persistedState?.sessionEntries?.length) {
			const sm: any = this.session.sessionManager;
			sm.fileEntries = this.persistedState.sessionEntries;
			sm._buildIndex?.();
			const ctx = sm.buildSessionContext();
			this.session.agent.replaceMessages(ctx.messages);
			if (ctx.thinkingLevel) this.session.setThinkingLevel(ctx.thinkingLevel as any);
			if (ctx.model?.modelId) {
				try {
					await this.session.setModel(buildGatewayModel(this.env, {
						provider: ctx.model.provider,
						id: ctx.model.modelId,
					}));
				} catch {}
			}
		} else if (this.persistedState?.messages?.length) {
			this.session.agent.replaceMessages(this.persistedState.messages as any);
		} else if (this.history.length > 0) {
			// Fallback: seed simple textual history if we only have legacy role/text entries.
			const sm: any = this.session.sessionManager;
			for (const entry of this.history) {
				sm.appendMessage({
					role: entry.role,
					content: [{ type: "text", text: entry.text }],
					timestamp: new Date(entry.timestamp).toISOString(),
				});
			}
			const ctx = sm.buildSessionContext();
			this.session.agent.replaceMessages(ctx.messages);
		}

		this.session.subscribe((event: any) => {
			if (event.type === "message_end" || event.type === "agent_end" || event.type === "turn_end") {
				this.persistState();
			}
		});

		this.mode = new InteractiveMode(this.session, {
			verbose: false,
			terminal: this.terminal,
		} as any);

		void this.mode.run().catch((error) => {
			this.sendFn(`\r\n\x1b[31mInteractive mode error: ${error?.message || error}\x1b[0m\r\n`);
		});

		this.ready = true;
	}

	start(): void {
		void this.ensureStarted();
	}

	stop(): void {
		this.mode = undefined;
		this.session?.dispose();
		this.session = undefined;
		this.ready = false;
	}

	getHistory(): HistoryEntry[] {
		const messages = this.session?.agent?.state?.messages;
		if (!messages?.length) return this.history;
		const out: HistoryEntry[] = [];
		for (const msg of messages as any[]) {
			const text = Array.isArray(msg.content)
				? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
				: "";
			if (!text) continue;
			if (msg.role === "user" || msg.role === "assistant") {
				out.push({ role: msg.role, text, timestamp: Date.now() });
			}
		}
		return out;
	}

	getPersistedState(): PersistedPiState {
		if (!this.session) return this.persistedState || {};
		const sm: any = this.session.sessionManager;
		return {
			messages: this.session.agent.state.messages,
			sessionEntries: sm?.fileEntries,
			model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : undefined,
			thinkingLevel: this.session.thinkingLevel,
		};
	}

	isBusy(): boolean {
		return !!this.session?.isStreaming;
	}

	setSize(cols: number, rows: number): boolean {
		const changed = cols !== this.terminal.columns || rows !== this.terminal.rows;
		this.terminal.resize(cols, rows);
		return changed;
	}

	async redraw(): Promise<void> {
		await this.ensureStarted();
		const ui = (this.mode as any)?.ui;
		ui?.requestRender?.(true);
	}

	async handleInput(data: string): Promise<void> {
		await this.ensureStarted();
		this.terminal.receiveInput(data);
	}
}
