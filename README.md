# File Watcher / D365 Integration Engine

File monitoring service for D365 Finance & Operations integration. Watches file sources
(SFTP / Blob / SharePoint / local folder), detects lifecycle events (new file arrived, file
stable, duplicate, stuck, missing by SLA), and delivers those events reliably to D365 via a
Gateway middleware layer.

## Architecture

Two deployable services + one shared contracts package:

- **Watcher** (`apps/watcher/`) — polls configured file sources via adapters, runs each
  observation through the Watcher Engine to decide lifecycle events
  (`FILE_DETECTED`, `FILE_STABLE`, `FILE_DUPLICATE`, `FILE_STUCK`, `FILE_MISSING_BY_SLA`),
  persists its own operational state (`watcher_state`), and POSTs `FileEvent`s to the Gateway.
- **Gateway** (`apps/gateway/`) — receives `FileEvent`s over HTTP, validates/enriches/masks
  them, persists to an outbox (`event_outbox`) *before* ACKing the Watcher, then delivers to
  D365 via a pluggable sink (`sinks/d365/`) with retry and dead-lettering
  (`dead_letter_event`).
- **`packages/contracts/`** — shared types (`FileObservation`, `FileEvent`, `InterfaceConfig`,
  `ConnectionConfig`) so Watcher and Gateway can't drift on event shape.

Watcher never talks to D365 directly — only the Gateway's sink does. The outbox pattern means
a Gateway crash mid-flight doesn't lose events (Watcher retries, Gateway dedupes on
`event_id`).

Full design, rationale, data flow, and MVP scope:
[`docs/monorepo-architecture.md`](docs/monorepo-architecture.md).

## Repo state: mid-migration

This repo is transitioning from a flat single-app layout to an npm-workspaces monorepo. Both
exist side by side right now:

- **Root (legacy, functional):** `package.json`, `src/index.ts`, `tsconfig.json` — a
  placeholder entry point that logs and exits. Builds and runs today via the commands below.
- **`apps/watcher/`, `apps/gateway/`, `packages/contracts/`, `packages/observability/`,
  `packages/testing/`** — target monorepo structure. Currently empty `.gitkeep` stubs: no
  code, no per-package `package.json`/`tsconfig.json`, and the root `package.json` doesn't
  have an npm `workspaces` field wired up yet.

New implementation code belongs under `apps/*` or `packages/*`, not root `src/`.

No test runner, lint, or typecheck script exists yet — don't assume `npm test` or
`npm run lint` work.

## Prerequisites

- Docker Desktop
- Node.js LTS (via nvm)
- Git

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment file:
   ```bash
   cp .env.example .env
   ```

3. Start infrastructure (Postgres 15 + Redis 7):
   ```bash
   docker compose -f infrastructure/compose/docker-compose.yml up -d
   ```

4. Verify containers healthy:
   ```bash
   docker compose -f infrastructure/compose/docker-compose.yml ps
   ```

5. Build project:
   ```bash
   npm run build
   ```

## Development

- `npm run dev` — run with ts-node (no compilation)
- `npm run build` — compile TypeScript, `src/` -> `dist/`
- `npm start` — run compiled output (`dist/index.js`)

## Project Structure

```
file-watcher/
├── apps/
│   ├── watcher/                # Watcher service (target monorepo, currently .gitkeep stub)
│   └── gateway/                # Gateway service (target monorepo, currently .gitkeep stub)
├── packages/
│   ├── contracts/               # Shared event/config types (stub)
│   ├── observability/           # Shared logging/tracing/metrics (stub)
│   └── testing/                 # Shared test utilities (stub)
├── infrastructure/
│   ├── compose/
│   │   └── docker-compose.yml   # Postgres + Redis for local dev
│   └── docker/
│       └── init.sql             # DB bootstrap (local dev only)
├── docs/
│   ├── monorepo-architecture.md # Full architecture spec
│   └── superpowers/specs/       # Design specs for individual components
├── src/
│   └── index.ts                 # Legacy root entry point (placeholder)
├── .env.example                 # Environment template
├── package.json                 # Root deps & scripts (no workspaces field yet)
├── tsconfig.json
└── README.md                    # This file
```

## Next Steps

See [`docs/monorepo-architecture.md`](docs/monorepo-architecture.md) for the full roadmap.
Near-term:

1. Scaffold monorepo structure (per-package `package.json`/`tsconfig.json`, npm `workspaces`)
2. Implement `packages/contracts` (event schemas)
3. Implement Watcher MVP (scheduler, SFTP adapter, engine, state store)
4. Implement Gateway MVP (API, outbox, D365 sink)
5. Integration testing (Watcher → Gateway → D365)
