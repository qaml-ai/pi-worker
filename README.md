# pi-worker-agents

A monorepo for running pi-style coding agents and related tools on **Cloudflare Workers**.

This repo contains:
- reusable Worker-focused packages
- worker-friendly forks of pi runtime pieces
- deployable examples, including a full terminal-native agent

## Highlights

### `examples/terminal-agent`
The most complete example in the repo.

A browser terminal UI backed by:
- a SQLite-backed Durable Object session store
- persistent files
- dynamic worker sandboxes for code execution
- published session-scoped Workers
- Durable Object alarm-powered cron jobs

Read more here:
- [`examples/terminal-agent/README.md`](./examples/terminal-agent/README.md)
- live deployment: [`https://pi.camelai.dev`](https://pi.camelai.dev)

## Repo structure

```txt
.
├── packages/
│   ├── pi-worker/                # reusable Cloudflare Worker helpers/tools
│   ├── pi-coding-agent-worker/   # worker-friendly fork of pi-coding-agent
│   └── pi-tui-worker/            # worker-friendly fork of pi-tui
├── examples/
│   ├── hello-agent/              # minimal example
│   ├── ffmpeg-agent/             # ffmpeg-focused worker example
│   ├── codegen-worker/           # code generation / scaffold example
│   ├── terminal-agent/           # full browser terminal agent
│   └── terminal-agent-outbound/  # outbound helper worker for terminal-agent
└── tmp/                          # scratch / investigation area
```

## Packages

### `packages/pi-worker`
Core Worker-oriented primitives and helpers.

Includes utilities like:
- file tool implementations
- execute tool support using Dynamic Worker Loaders
- in-memory / R2 / SQLite-backed helper patterns
- download helpers

### `packages/pi-coding-agent-worker`
A worker-friendly fork/wrapper around `@mariozechner/pi-coding-agent`.

Used so pi's coding-agent runtime can run in Cloudflare Workers instead of a normal Node CLI environment.

### `packages/pi-tui-worker`
A worker-friendly fork/wrapper around `@mariozechner/pi-tui`.

This underpins terminal-style UI behavior in Worker-compatible environments.

## Examples

### `examples/hello-agent`
A tiny example showing the basic shape of a Worker-based pi agent.

### `examples/ffmpeg-agent`
An example focused on media tooling / ffmpeg workflows.

### `examples/codegen-worker`
A codegen/scaffolding example for generating Worker projects and related files.

### `examples/terminal-agent`
The flagship example.

Features:
- terminal UI in the browser
- persistent Durable Object sessions
- persistent SQLite-backed filesystem
- code execution in dynamic sandbox Workers
- publish-a-file-as-a-Worker
- cron jobs that feed prompts back into the session

### `examples/terminal-agent-outbound`
A tiny helper Worker used by `terminal-agent` so dynamic sandboxes can perform outbound fetches safely through a service binding.

## Getting started

Install dependencies from the repo root:

```sh
npm install
```

Then work inside an example directory, for example:

```sh
cd examples/terminal-agent
npm run dev
```

## Development model

This repo is currently organized as a **monorepo-first** codebase.

That means:
- packages in `packages/` are the source of truth
- examples in `examples/` consume those local workspace packages
- the terminal-agent example is the best place to start if you want to see the whole stack working together

## Testing

Package tests and example tests live alongside their code.

For example, the terminal agent example has worker-pool tests:

```sh
cd examples/terminal-agent
npm test
```

## Notes

- Some examples require local secrets in `.dev.vars`.
- `tmp/` is not productized code; it is used for experiments and debugging.
- This repo is actively experimental, but the terminal-agent example is real and deployable.

## Recommended place to start

If you're new to the repo, start with:
1. [`examples/terminal-agent/README.md`](./examples/terminal-agent/README.md)
2. `examples/terminal-agent/src/index.ts`
3. `packages/pi-worker/src/index.ts`

## License

MIT
