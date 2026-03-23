# Codegen Worker

AI agent that generates complete Cloudflare Worker apps from a text prompt.

**Live:** https://codegen-worker.miguel-85b.workers.dev

## How it works

Two agents run in sequence:

1. **Design agent** — picks style, theme color, font, and border radius based on your prompt, then scaffolds a React Router 7 + shadcn/ui + Tailwind v4 starter project
2. **Codegen agent** — customizes the scaffolded project: installs shadcn components, writes routes, edits files, adds bindings

Async generation is orchestrated with **Cloudflare Workflows**. The workflow instance id is the job id returned from `/generate`.

The result is a downloadable zip of a deployable Cloudflare Worker project.

## API

### Generate a project (async, workflow-based)

```bash
# 1. Start a job
curl -X POST https://codegen-worker.miguel-85b.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Build a todo app with D1 database, a sidebar layout, and dark mode toggle"}'
# → {"jobId":"job_1234_abc","status":"pending"}

# 2. Poll for completion
curl https://codegen-worker.miguel-85b.workers.dev/jobs/job_1234_abc
# → {"status":"running",...}
# → {"status":"complete","downloadUrl":"/download/...","typeCheck":{"success":true},...}

# 3. Download the zip
curl -o project.zip "https://codegen-worker.miguel-85b.workers.dev/download/..."
```

### Debug mode (sync, for development)

Returns immediately with a full transcript of both agents:

```bash
curl -X POST https://codegen-worker.miguel-85b.workers.dev/debug \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a fitness tracker with charts and a dashboard"}'
```

Response includes:
- `design` — the style/theme/font the design agent chose
- `transcript` — every tool call the codegen agent made
- `typeCheck` — always reports success at runtime right now
- `fileCount` — total files in the project

You can override the model:
```bash
curl -X POST .../debug \
  -H "Content-Type: application/json" \
  -d '{"prompt": "...", "model": "anthropic/claude-sonnet-4"}'
```

## What gets generated

A complete project with:

```
package.json              # Dependencies (React 19, React Router 7, Tailwind v4, shadcn)
tsconfig.json             # Base TypeScript config
tsconfig.cloudflare.json  # Cloudflare TS config
tsconfig.node.json        # Vite/node TS config
wrangler.jsonc            # Cloudflare Workers deployment config
components.json           # shadcn/ui configuration
vite.config.ts            # Vite bundler config
react-router.config.ts    # SSR framework config
app/
  app.css                 # Themed CSS (OKLch colors, light/dark mode)
  entry.server.tsx        # SSR entry
  root.tsx                # App layout
  routes.ts               # Route config
  routes/                 # Page routes
  lib/utils.ts            # cn() utility
  components/ui/          # Installed shadcn components
workers/
  app.ts                  # Worker entry point
```

## Design options

The design agent automatically picks from these based on your prompt:

| Option | Values | Description |
|--------|--------|-------------|
| Style | mira, nova, vega, lyra, maia | Component design language |
| Theme | neutral, blue, indigo, emerald, orange, red, ... (20 colors) | Primary brand color |
| Font | figtree, inter, noto-sans, nunito-sans | Typeface |
| Radius | default, none, small, medium, large | Border roundness |

Example: "Build a fitness tracker" → nova style, orange theme, medium radius.

## Runtime notes

- Async jobs use **Cloudflare Workflows**
- `/jobs/:id` polls the workflow instance directly
- runtime typechecking is currently **disabled** to keep generation fast and reliable

## Deploy your own

```bash
cd examples/codegen-worker

# Create resources
wrangler r2 bucket create codegen-files

# Set secrets
wrangler secret put OPENROUTER_API_KEY
wrangler secret put DOWNLOAD_SECRET  # any random string

# Deploy
wrangler deploy
```

## Local development

```bash
# From repo root
bun install
bun run --filter pi-worker build

# Run locally
cd examples/codegen-worker
echo "OPENROUTER_API_KEY=sk-or-..." > .dev.vars
echo "DOWNLOAD_SECRET=$(openssl rand -hex 32)" >> .dev.vars
wrangler dev
```
