# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install deps (root only — no workspaces wired up yet, see below)
npm run build             # tsc compile, root src/ -> dist/
npm run dev                # ts-node src/index.ts, no compilation
npm start                  # node dist/index.js (run compiled output)
cp .env.example .env       # local env file (gitignored)
docker compose -f infrastructure/compose/docker-compose.yml up -d   # Postgres 15 + Redis 7 for local dev
docker compose -f infrastructure/compose/docker-compose.yml ps      # verify containers healthy
```

No test runner, lint, or typecheck script exists yet — `apps/*/test/` and `packages/*/src/` are empty
scaffolding (`.gitkeep` only). Do not assume `npm test` or `npm run lint` work.

## Repo state: mid-migration

This repo is transitioning from a flat single-app layout to an npm-workspaces monorepo. Both exist
side by side right now:

- **Root (legacy, functional):** `package.json`, `src/index.ts`, `tsconfig.json` — a placeholder
  entry point that logs and exits. Builds and runs today via the commands above.
- **`apps/watcher/`, `apps/gateway/`, `packages/contracts/`, `packages/observability/`,
  `packages/testing/`** — the target monorepo structure. All currently empty `.gitkeep` stubs, no code,
  no per-package `package.json`/`tsconfig.json` yet. Root `package.json` does **not** have an npm
  `workspaces` field configured yet, despite the architecture doc calling for it.

When adding real implementation code, it belongs under `apps/*` or `packages/*` per the architecture
doc below — not under root `src/`.

**README.md is stale in two places:** it says `docker compose up -d` (implying a root
`docker-compose.yml`) and references `docker/init.sql` — the actual files live under
`infrastructure/compose/docker-compose.yml` and `infrastructure/docker/init.sql`. Use the paths in the
Commands section above, not the README.

## Architecture

Full design is in [`docs/monorepo-architecture.md`](docs/monorepo-architecture.md) — read it before
implementing any component. Summary:

**Two deployable services, one shared contracts package:**

- **Watcher** (`apps/watcher/`) — polls file sources (SFTP/Blob/SharePoint/folder adapters), decides
  file lifecycle events (`FILE_DETECTED`, `FILE_STABLE`, `FILE_DUPLICATE`, `FILE_STUCK`,
  `FILE_MISSING_BY_SLA`) via the Watcher Engine, persists operational state to its own
  `watcher_state` table, and POSTs `FileEvent`s to the Gateway.
- **Gateway** (`apps/gateway/`) — receives `FileEvent`s via HTTP, validates/enriches/masks them,
  persists to an outbox (`event_outbox` table) before ACKing the Watcher, then delivers to D365 via a
  sink abstraction (`sinks/d365/`) with retry + dead-lettering (`dead_letter_event` table).
- **`packages/contracts/`** — shared types (`FileObservation`, `FileEvent`, `InterfaceConfig`,
  `ConnectionConfig`) that both services depend on so they can't drift on event shape.

**Key architectural decisions** (see the doc for full rationale):
- Watcher and Gateway own separate DB schemas (same Postgres server in dev, splittable in prod).
  Watcher never talks to D365 directly — only the Gateway's sink does.
- Outbox pattern on the Gateway: event persisted *before* ACKing the Watcher, so a Gateway crash
  mid-flight doesn't lose events (Watcher retries, Gateway dedupes on `event_id`).
- Adapters are technology-specific and business-neutral — they only return normalized
  `FileObservation`s (list/metadata, no moves/deletes in MVP). The Watcher Engine (not the adapter)
  owns all lifecycle/state decisions.
- Sinks are pluggable behind a registry (`sink-registry.ts`) — D365 is the current sink, not a
  permanent coupling; SigNoz/others can be added later without touching Gateway core logic.
- Secrets are only ever touched by a `secret-provider.ts` abstraction (env vars now, Key Vault later)
  — never logged, never accessed directly by adapters or connection code.

## Design specs

Non-trivial components get a design spec under `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
before implementation (via the brainstorming skill). Check that directory for prior art before
redesigning a component from scratch — e.g. the Watcher Engine's rule pipeline, state-transition
matrix, and scope boundaries are already spec'd there.
