# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture pivot (2026-07-17): the real build now happens inside D365

This repo no longer produces a deployable system. The architecture pivoted from two external
Node services (Watcher + Gateway) to a **D365-native solution**: Dataverse tables, a C# plugin
port of the Watcher Engine, Power Automate flows as adapters, and a model-driven Power App for
monitoring — all living in the client's D365 F&O environment and its linked Dataverse, built
there (not here). The client provisions nothing beyond the D365 environment + Power Apps.

**Normative design:**
[`docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md`](docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md)
— read it before doing anything architectural. The phased build plan is
[`docs/superpowers/plans/2026-07-17-d365-native-implementation.md`](docs/superpowers/plans/2026-07-17-d365-native-implementation.md).
The old external-services design ([`docs/monorepo-architecture.md`](docs/monorepo-architecture.md))
is superseded and kept as historical record; the pre-pivot specs and plans under
`docs/superpowers/` carry banners marking them historical/superseded (the Watcher Engine spec
stays normative for rule/state semantics).

**What this repo is now:**
- **Design home** — specs and plans under `docs/superpowers/` (specs in
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`; check for prior art before redesigning
  anything).
- **Executable reference spec** — the TypeScript Watcher Engine in `apps/watcher/src/engine/`
  (rule pipeline, state-transition allow-list, batch IDs, missing-SLA sweep) plus its vitest
  suite. The C# plugin port must match its decisions case-for-case (parity matrix:
  `docs/superpowers/specs/parity/engine-test-parity.md`; module-by-module port plan:
  `docs/superpowers/plans/2026-07-17-ts-to-d365-code-migration.md`). **Frozen: keep tests green, no new
  features.** If a spec ambiguity is found, fix TS + spec together, then port.
- **Reference-only code** — folder adapter and scheduler `runOnce` (superseded by Power
  Automate flows), Postgres repositories/migrations (superseded by Dataverse tables).
- **Removed** — `apps/gateway/` and `apps/watcher/src/gateway-client/`: the Gateway
  (HTTP intake, outbox, retry, dead-letter, D365 sink) is not built at all. Inside Dataverse,
  the state update and event insert share one plugin transaction, which makes the outbox
  pattern redundant. Do not resurrect it.

## Commands

npm workspaces are wired up (`apps/*`, `packages/*`).

```bash
npm install                # install all workspace deps
npm test                   # fast suite: vitest at root (builds contracts+testing first); excludes integration tests
npm run build              # tsc at root (legacy placeholder entry point)
npm run test:integration -w @apps/watcher   # integration tests — need Postgres up (below) + DATABASE_URL
npm run migrate:up -w @apps/watcher         # node-pg-migrate, needs DATABASE_URL
npm run demo -w @apps/watcher               # engine demo script (needs Postgres)
cp .env.example .env       # local env file (gitignored)
docker compose -f infrastructure/compose/docker-compose.yml up -d   # Postgres 15 + Redis 7 for the reference suite
```

No lint/typecheck scripts exist. **README.md is stale:** it says `docker compose up -d` and
references `docker/init.sql`; the real paths are `infrastructure/compose/docker-compose.yml`
and `infrastructure/docker/init.sql`.

## What lives where

- `apps/watcher/src/engine/` — the frozen reference engine + tests (see pivot note above).
- `apps/watcher/src/adapters/`, `scheduler/`, `database/` — reference-only TS.
- `packages/contracts/` — shared types; documentation-only now (the Dataverse tables and
  Custom API contracts defined in the D365 spec are the schema of record).
- `docs/superpowers/specs/` — design specs; `docs/superpowers/plans/` — implementation plans.
- `infrastructure/` — local dev Postgres/Redis for the reference suite only.

## Key invariants (unchanged by the pivot — normative for any port)

- Five-status file lifecycle: `FILE_DETECTED`, `FILE_STABLE`, `FILE_DUPLICATE`, `FILE_STUCK`,
  `FILE_MISSING_BY_SLA`, with the transition **allow-list** in the engine spec (anything not
  listed is invalid).
- Rule pipeline order: duplicate → stuck-file → stability; first non-null wins; missing-SLA is
  an absence-driven sweep outside the pipeline (sentinel-row idempotency).
- One `batch_id` per file lifecycle, generated only for brand-new files.
- State is a snapshot (current + previous status), not a history log; the event table is the
  append-only audit trail.
- Adapters/flows observe and normalize metadata only (no moves, deletes, content reads);
  the engine decides. No secrets in any table — connection credentials live in Power Automate
  connection references (formerly the secret-provider abstraction).
