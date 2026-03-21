# Remaining gaps vs real pi

This example now has the core behavior working:

- real `createAgentSession()`
- real `InteractiveMode`
- Worker-native tools
- slash command autocomplete
- warm reconnect redraw
- cold restore from DO SQLite

But there are still some things missing, stubbed, or downgraded compared to normal local pi.

## Major gaps

### 1. Resource discovery/loading is mostly stubbed
`createResourceLoader(...)` is currently a minimal Worker stub.

That means we are not really doing normal pi discovery/loading for:

- extensions from disk
- skills from disk
- prompt templates from disk
- themes from disk
- agents files / project context files
- path metadata

Right now most of those return empty lists.

### 2. File/path autocomplete is intentionally disabled
Slash command autocomplete was restored, but file/path autocomplete was not.

Current state:

- slash command completion works
- model completion works
- file/path completion does not

This was a deliberate tradeoff for Workers.

### 3. Full extension/skills/prompts/theme parity is not there
The extension runtime crash was fixed by returning an empty runtime stub, but since the resource loader is mostly stubbed and discovery is empty, we are not actually exercising full pi extension behavior.

So extensions are currently:

- no longer crashing the runtime
- but not feature-complete vs normal pi

## Medium gaps

### 4. Exact terminal screen state is not persisted across hibernation
This is now okay for the current architecture, but it is still different from a true terminal framebuffer approach.

After hibernation we restore:

- agent/session state
- messages/session entries
- model
- thinking level

We do **not** restore:

- exact rendered screen contents
- viewport/scrollback position
- cursor/editor position
- transient overlays/modals
- partial streaming UI state

### 5. Unsaved editor/transient UI state is probably lost
We currently do not persist things like:

- text typed into the editor but not submitted
- autocomplete popups
- open selectors/modals
- pending visual-only UI state

The agent/session survives; the exact interactive UI state does not.

### 6. Multi-client behavior is still rough
The reconnect redraw fix broadcasts ANSI to all connected sockets.

So if multiple browsers attach to one session:

- redraws affect all of them
- input ownership is shared
- this behaves more like a shared terminal than isolated clients

That may be acceptable, but it is still a limitation.

## Lower-priority gaps

### 7. Native/local integrations are removed or stubbed
Compared to stock pi, we have intentionally removed or patched around:

- local filesystem tools
- local bash/process tools
- clipboard-native integrations
- photon/native helper code
- other `createRequire` / local runtime assumptions

This is expected for Workers, but still a difference from local pi.

### 8. Theme loading is patched, not cleanly implemented
Built-in themes were inlined/patched for Worker compatibility.

This works for now, but it is not a clean upstream-quality solution yet.

### 9. Images are disabled
Current settings include `showImages: false`, so normal pi image display paths are effectively off.

### 10. `fd` / `rg` bootstrap is skipped
Interactive mode currently skips the normal bootstrap/discovery path for `fd`/`rg`, which is related to the missing file/path discovery behavior.

## What is no longer a gap
These previously-broken or uncertain areas are now working well enough:

- live TUI can stay in DO memory
- reconnect works by forcing a full redraw on first resize
- session state can be reconstructed from DO SQLite after live session drop/hibernation

## Priority recommendation
If the goal is “use as much real pi as possible”, the next highest-value missing feature is:

## A proper Worker-compatible `ResourceLoader`

That would restore the most parity in one step by enabling real support for:

- skills
- prompts
- extensions
- themes
- agents/context discovery

That is probably a bigger parity win than trying to persist an exact terminal framebuffer.
