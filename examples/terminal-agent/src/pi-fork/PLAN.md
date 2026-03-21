# Worker fork plan for pi interactive mode

Goal: reuse as much of the real `pi` interactive mode as possible while running inside a Cloudflare Worker with a browser-hosted ghostty terminal.

## What we can likely reuse directly

### `@mariozechner/pi-tui`

High-confidence reusable pieces:
- `TUI`
- `Container`, `Text`, `Spacer`, `Markdown`, `Loader`, `Editor`, `Input`
- `matchesKey`, key parsing helpers
- terminal diff rendering logic

The main requirement is a custom terminal implementation. `pi-tui` already abstracts this via the `Terminal` interface.

### `interactive-mode` components

Potentially reusable with light patching:
- message components
- footer
- borders
- selectors
- custom editor wrappers
- markdown/theme plumbing

## Main seam to patch

In upstream `InteractiveMode`, the constructor hardcodes:

```ts
this.ui = new TUI(new ProcessTerminal(), ...)
```

For Workers, this should become something like:

```ts
this.ui = new TUI(options.terminal ?? new ProcessTerminal(), ...)
```

That is the highest-value patch.

## Node-only pieces to disable or replace initially

These are the main blockers found in upstream `interactive-mode.js`:
- `child_process` (`spawn`, `spawnSync`)
- clipboard helpers
- external editor integration
- tmux checks
- version/package update checks
- `ensureTool("fd")` / `ensureTool("rg")`
- `process.exit`, suspend/resume handling
- local filesystem temp-file flows
- path/cwd assumptions from `process.cwd()`

## Practical strategy

### Phase 1: minimal fork
- Vendor `InteractiveMode` + required components into this repo
- Add `terminal` injection support
- Disable unsupported commands/features behind flags
- Keep the Worker/browser transport dumb: browser sends keys+resize, Worker sends ANSI

### Phase 2: session adapter
- Create a Worker-side adapter that looks enough like pi's `AgentSession` for the forked mode
- Back it with our existing Worker `Agent` + tools + persistent history

### Phase 3: feature re-enable
- queueing / steering / follow-up
- tool collapse state
- thinking toggle
- footer/status line
- model / settings UI where feasible

## Files added so far
- `worker-terminal.ts`: Worker-compatible terminal transport implementing pi-tui's terminal surface

## Recommended next coding step
1. Add `@mariozechner/pi-coding-agent` as a dependency for the example or a dedicated package.
2. Vendor a small patched copy of `InteractiveMode`.
3. Replace `ProcessTerminal` with injected `WorkerTerminal`.
4. Stub unsupported features behind no-op methods so the TUI can boot.
