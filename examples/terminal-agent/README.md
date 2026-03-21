# pi worker agent

![pi worker agent Open Graph preview](./src/og-preview.png)

A terminal-style AI coding agent running fully on Cloudflare Workers.

It combines:
- a browser terminal UI (`ghostty-web`)
- a SQLite-backed Durable Object for persistent sessions and files
- pi's worker-friendly coding-agent runtime
- Dynamic Worker Loader sandboxes for code execution
- session-scoped published Workers
- Durable Object alarm-powered cron jobs

Live deployment in this repo currently targets:
- [`https://pi.camelai.dev`](https://pi.camelai.dev)

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/qaml-ai/pi-worker/tree/main/examples/terminal-agent)

Note: this example requires a `CF_GATEWAY_TOKEN` secret, so you may still need to finish a small amount of post-deploy setup in Cloudflare/Wrangler.

## What it can do

Inside a session, the agent can:
- read, write, edit, and list files in a persistent filesystem
- execute JavaScript in an isolated worker sandbox
- import local files and many packages through `esm.sh`
- publish a file as a Worker endpoint at `/w/<session>/<name>`
- create recurring cron jobs that send prompts back into the session

## Repo layout

```txt
examples/terminal-agent/
├── src/
│   ├── index.ts              # main Worker + Durable Object + loopback outbound entrypoint
│   ├── tui-session.ts        # pi agent session wiring
│   ├── frontend.ts           # browser terminal UI
│   ├── sqlite-tools.ts       # SQLite-backed file tools
│   ├── published-workers.ts  # publish file-backed Workers
│   ├── cron-tools.ts         # cron job tools + schedule parsing
│   └── pi-fork/              # worker-specific terminal/runtime shims
├── wrangler.jsonc
├── vitest.config.ts
└── wrangler.test.jsonc
```

## Architecture

### Main Worker
Routes:
- `/` → creates a new session and redirects to `/s/<id>`
- `/s/<id>` → serves the terminal web UI
- `/ws/<id>` → websocket for terminal I/O
- `/w/<session>/<name>` → published session Worker endpoint

### Durable Object
Each session lives in a SQLite-backed Durable Object.

It stores:
- message history
- pi session state
- persistent files
- published Worker metadata
- cron job metadata

### Execute tool
The execute tool uses Cloudflare's Dynamic Worker Loader to run user code in isolated workers.

Supports:
- local relative imports from the session filesystem
- package imports resolved through `esm.sh`
- outbound `fetch()` through a loopback outbound entrypoint in the same Worker

### Published Workers
The agent can expose a file as a real HTTP Worker endpoint.

Example route:

```txt
/w/<session>/<name>
```

Published Workers are cached by dependency version, so they are not rebuilt on every request.

### Cron jobs
Cron jobs are stored in the Durable Object and scheduled with alarms.

Each run:
- sends the stored prompt back into the same session
- computes the next matching run time
- re-arms the next earliest alarm

Current minimum interval:
- every 10 minutes

## Local development

### 1. Install dependencies
From the repo root:

```sh
npm install
```

### 2. Add local secrets
Create:

```txt
examples/terminal-agent/.dev.vars
```

With at least:

```env
CF_GATEWAY_TOKEN=your_cloudflare_ai_gateway_token
```

### 3. Start the app
From `examples/terminal-agent`:

```sh
npm run dev
```

The `predev` script builds the local worker packages first.

## Deploy

From `examples/terminal-agent`:

```sh
npm run deploy
```

## Config

Main config file:
- `examples/terminal-agent/wrangler.jsonc`

Important values:
- `CF_ACCOUNT_ID`
- `CF_GATEWAY_NAME`
- `AI_GATEWAY_MODEL`
- custom domain / routes
- Durable Object migrations
- worker loader binding

## Tests

From `examples/terminal-agent`:

```sh
npm test
```

There is worker-pool coverage for published Workers and dynamic loader behavior.

Note: depending on local environment, the Cloudflare Vitest worker pool may emit an upstream `node:os` warning even when assertions pass.

## Example capabilities to try

### Execute a local script
Ask the agent to run a file like:
- `examples/import-test.js`

### Publish a Worker
Create a file that exports either:

```ts
export default async function(request, env, ctx) {
  return new Response("hello");
}
```

or:

```ts
export default {
  async fetch(request, env, ctx) {
    return new Response("hello");
  },
};
```

Then publish it with the worker publishing tool.

### Create a cron job
Example schedule:

```txt
*/10 * * * *
```

This runs every 10 minutes in UTC.

## Notes

- Sessions are persistent across reconnects.
- Published Workers are session-scoped.
- Cron jobs are session-scoped.
- `bash` is intentionally not exposed in this environment.
- The frontend branding and Open Graph metadata live in `src/frontend.ts`.

## Status

This example is actively experimental, but it is real and deployable.
