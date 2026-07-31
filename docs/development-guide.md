# Development Guide

Working notes for anyone developing in this repository. Read
[`how-it-works.md`](how-it-works.md) first for the runtime picture, and the
[design specs](superpowers/specs/) before changing anything architectural.

## What this repository is

The design home and code source for a D365-native integration-monitoring solution:
Dataverse tables, a C# plugin engine, Power Automate flows as watchers, and a
model-driven app — all deployed into the client's D365 environment (see
[`../d365/deploy/README.md`](../d365/deploy/README.md)). The repository also contains
the original TypeScript engine, kept **frozen as the executable reference spec** — its
tests must stay green and it gets no new features. If a spec ambiguity is found, fix
the TypeScript + the spec together, then port the fix to C#.

## Commands

```bash
npm install                # workspace deps
npm test                   # 81 reference-engine tests (fast suite)
npm run parity:vectors -w @apps/watcher      # regenerate shared test vectors (idempotent)
dotnet test d365/FileWatcherMonitoring.Plugins.Tests     # 43 vector-driven parity tests
dotnet test d365/FileWatcherMonitoring.Dataverse.Tests   # 38 plugin/API-layer tests
dotnet build d365/FileWatcherMonitoring.Dataverse -c Release   # deployable plugin DLL
python3 -m unittest discover -s d365/deploy/tests        # 8 provisioning drift guards
dotnet run --project d365/FileWatcherMonitoring.Simulator -- ./watched   # local live demo
```

No lint/typecheck scripts exist. CI (`.github/workflows/ci.yml`) runs every suite plus
a vector-drift check on each push.

## What lives where

- `d365/` — production source: engine core (`FileWatcherMonitoring.Plugins`), Dataverse
  layer + plugins (`.Dataverse`), test projects, local simulator, and `deploy/`
  (provisioning + smoke scripts).
- `apps/watcher/src/engine/` — the frozen TypeScript reference engine + tests.
- `apps/watcher/src/{adapters,scheduler,database}/`, `packages/` — pre-pivot reference
  code kept for the reference suite; not deployed.
- `docs/superpowers/specs/` — dated design specs (check for prior art before designing);
  `docs/superpowers/plans/` — implementation plans and runbooks.
- `infrastructure/` — local Postgres/Redis for the reference suite's integration tests.

## Key invariants (normative — do not break)

- File lifecycle: `FILE_DETECTED`, `FILE_STABLE`, `FILE_DUPLICATE`, `FILE_STUCK`,
  `FILE_MISSING_BY_SLA`; transitions governed by an **allow-list** (anything unlisted
  is invalid and must throw). API messages likewise (`MSG_*` statuses, own allow-list).
- Rule pipeline order: duplicate → stuck-file → stability; first non-null wins.
  Missing-SLA is an absence-driven sweep outside the pipeline, sentinel-row idempotent.
- One batch id per file/message lifecycle, generated only at first detection.
- State tables are snapshots (current + previous status); the event tables are the
  append-only audit trail — nothing ever updates or deletes event rows.
- Flows observe and normalize metadata only (no moves, deletes, content reads); the
  plugin engine makes every decision. State change + event insert share one transaction.
- No secrets in any table — connector credentials live in Power Automate connection
  references only.
- Choice values, logical names, and key budgets are pinned in
  `d365/FileWatcherMonitoring.Dataverse/Schema.cs` and machine-checked against
  `d365/deploy/provision.py` by the drift-guard tests. Change them in both places or
  the suite fails.
