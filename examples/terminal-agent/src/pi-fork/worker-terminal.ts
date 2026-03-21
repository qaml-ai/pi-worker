/**
 * Worker-compatible terminal adapter for pi-tui.
 *
 * This implements the same surface area as pi-tui's Terminal interface,
 * but instead of talking to process.stdin/stdout it talks to our WebSocket
 * session plumbing.
 *
 * The browser (ghostty-web) sends keyboard input + resize messages to the
 * Worker. The Worker-side TUI writes ANSI back through `send`.
 */

export interface WorkerTerminalOptions {
	cols?: number;
	rows?: number;
	kittyProtocolActive?: boolean;
}

export class WorkerTerminal {
	private onInput?: (data: string) => void;
	private onResize?: () => void;
	private _cols: number;
	private _rows: number;
	private _kittyProtocolActive: boolean;
	private readonly send: (data: string) => void;

	constructor(send: (data: string) => void, options: WorkerTerminalOptions = {}) {
		this.send = send;
		this._cols = options.cols ?? 80;
		this._rows = options.rows ?? 24;
		// ghostty-web is kitty-ish enough on the frontend, but keep this configurable
		this._kittyProtocolActive = options.kittyProtocolActive ?? false;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop(): void {
		this.onInput = undefined;
		this.onResize = undefined;
	}

	async drainInput(_maxMs = 1000, _idleMs = 50): Promise<void> {
		// No stdin buffer to drain in the Worker transport.
	}

	write(data: string): void {
		this.send(data);
	}

	get columns(): number {
		return this._cols;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	setKittyProtocolActive(active: boolean): void {
		this._kittyProtocolActive = active;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.send(`\x1b[${lines}B`);
		else if (lines < 0) this.send(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.send("\x1b[?25l");
	}

	showCursor(): void {
		this.send("\x1b[?25h");
	}

	clearLine(): void {
		this.send("\x1b[K");
	}

	clearFromCursor(): void {
		this.send("\x1b[J");
	}

	clearScreen(): void {
		this.send("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.send(`\x1b]0;${title}\x07`);
	}

	/** Deliver browser keyboard input to the TUI. */
	receiveInput(data: string): void {
		this.onInput?.(data);
	}

	/** Update terminal size and notify the TUI. */
	resize(cols: number, rows: number): void {
		const changed = cols !== this._cols || rows !== this._rows;
		this._cols = cols;
		this._rows = rows;
		if (changed) this.onResize?.();
	}
}
