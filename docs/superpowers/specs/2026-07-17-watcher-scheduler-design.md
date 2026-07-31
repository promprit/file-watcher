# Watcher Scheduler — Design Spec

> **⚠️ SUPERSEDED (2026-07-17):** the architecture pivoted to a D365-native build (Dataverse + Power Platform); this component's production role is replaced per the [D365-native design spec](2026-07-17-d365-native-architecture-design.md). The TypeScript implementation described here remains in-repo as part of the frozen executable reference spec.

**Date:** 2026-07-17
**Status:** Approved (pending final spec review)
**Related:** [docs/monorepo-architecture.md](../../monorepo-architecture.md),
[2026-07-16-folder-adapter-design.md](./2026-07-16-folder-adapter-design.md),
[2026-07-16-engine-postgres-integration-design.md](./2026-07-16-engine-postgres-integration-design.md)

## Context

Three pieces now exist and are merged (fork and upstream both): the Watcher
Engine (`processObservation`/`checkMissingSla`, fully TDD'd), the folder
adapter (`Adapter` contract + `folderAdapter`), and the junior-authored
Engine+`PostgresStateRepository` integration (real DB-backed state,
replacing `InMemoryStateRepository`, with its own integration tests and a
demo script). Nothing yet ties them together into something that actually
runs — that's this spec.

`ConnectionManager`, `SecretProvider`, `AdapterRegistry`, and
`gateway-client` (the eventual event sender to POST `FileEvent`s to
Gateway) are all still empty stubs. Gateway itself is fully empty — there's
no real HTTP receiver to send events to yet.

**A known gap surfaced by the junior's demo script:** DB-loaded
`InterfaceConfig` rows don't have `stuckThresholdSeconds`/`slaDeadline` —
those aren't real columns in `interface_config` (only the DB-schema-shaped
`stuckThresholdMinutes`/`expectedSchedule`/`slaThresholdMinutes` exist,
per the reconciliation's documented model-coexistence). The demo script
hardcoded the two engine fields inline per call. This spec generalizes
that same workaround rather than adding a migration.

## Scope

Build `apps/watcher/src/scheduler/scheduler.ts` — one function, `runOnce`,
that does a single pass over all enabled interfaces: load config, dispatch
to the right adapter, run it through the Engine, hand any produced events
to a caller-supplied sink.

**Out of scope:**
- A real continuous per-interface timer loop (`setInterval` respecting each
  interface's own `pollIntervalSeconds`, skipping a tick if the prior run
  for that interface is still in-flight) — `runOnce` is the fully-tested
  deliverable; the timer wrapper is a thin, deferred follow-up. Nothing
  calls `runOnce` in production yet anyway (no process entry point exists).
- `ConnectionManager`/`SecretProvider` — the folder adapter needs no
  secrets, so `ConnectionContext` is built directly from `ConnectionConfig`
  fields. Real secret resolution is deferred until an adapter that actually
  needs it (SFTP) exists.
- Adding `stuck_threshold_seconds`/`sla_deadline` as real DB columns — a
  global `EngineDefaults` merge covers the gap for now (see Architecture).
- Any adapter beyond folder (SFTP/Blob/SharePoint) and their
  `AdapterRegistry` entries.
- `gateway-client`/event delivery — `runOnce` takes a pluggable `sink`
  callback instead of POSTing anywhere.

## Architecture

**File:** `apps/watcher/src/scheduler/scheduler.ts` (+
`apps/watcher/test/integration/scheduler/scheduler.integration.test.ts` —
needs real Postgres + real filesystem, same bucket as the junior's
`test/integration/engine/`, already excluded from the fast `npm test` suite
via `apps/watcher/test/integration/**`).

```ts
export interface EngineDefaults {
  stuckThresholdSeconds: number;
  slaDeadline: string;
}

export type AdapterRegistry = Record<string, Adapter>; // storageType -> Adapter

export interface InterfaceRunResult {
  interfaceId: string;
  status: 'ok' | 'error';
  eventCount: number;
  error?: unknown;
}

export async function runOnce(
  deps: {
    interfaceConfigRepo: InterfaceConfigRepository;
    connectionConfigRepo: ConnectionConfigRepository;
    stateRepo: StateRepository;
    adapterRegistry: AdapterRegistry;
    engineDefaults: EngineDefaults;
  },
  sink: (event: FileEvent) => void,
  now: Date = new Date()
): Promise<InterfaceRunResult[]>
```

`sink` decouples the Scheduler from event delivery — tests pass an
array-collecting function; production will eventually pass the
not-yet-built `gateway-client`'s sender. `adapterRegistry` starts with
exactly one entry: `{ FOLDER: folderAdapter }`.

## Per-interface flow

For each `InterfaceConfig` where `enabledFlag === true` (loaded via
`interfaceConfigRepo.findAll(true)`), **sequentially** (see Approach
decision below):

1. Merge `engineDefaults` onto the loaded config:
   `{ ...interfaceConfig, ...engineDefaults }` → `fullConfig`. This
   unconditionally overrides `stuckThresholdSeconds`/`slaDeadline` with the
   global defaults — not "defaults only if missing." Those two fields
   aren't actually nullable on `InterfaceConfig` (they're typed as required
   `number`/`string`), so there's no clean way to detect "the DB didn't
   provide a real value" versus "the DB provided this exact value" without
   adding real, currently-nonexistent DB columns. Applying the global
   default unconditionally is the honest MVP behavior — every interface
   gets the same stuck/SLA thresholds until real per-interface columns
   exist (a follow-up migration, not this spec).
2. `connectionConfigRepo.findByRef(fullConfig.connectionRef)` — if `null`,
   record `{ interfaceId, status: 'error', eventCount: 0, error }`, move to
   the next interface.
3. `adapterRegistry[connectionConfig.storageType]` — if `undefined` (e.g.
   `'SFTP'`, not registered), record an error result
   (`"Unsupported storage type: SFTP"`) and continue. Matches the
   architecture doc's `ADAPTER_TYPE_NOT_SUPPORTED` case.
4. Build `ConnectionContext { connectionRef, storageType, endpoint:
   connectionConfig.endpoint }` and `InterfaceScope { interfaceId,
   inboundPath: fullConfig.inboundPath, filePattern: fullConfig.filePattern
   }`.
5. `adapter.observe(context, scope)` → `FileObservation[]`.
6. For each observation: `processObservation(observation, fullConfig,
   stateRepo, now)` — if it returns a `FileEvent` (not `null`), call
   `sink(event)`.
7. `checkMissingSla(fullConfig, stateRepo, now)` → `FileEvent[]` — call
   `sink(event)` for each.
8. Steps 2-7 wrapped in one try/catch per interface — any thrown error
   (`AdapterError`, `InvalidStateTransitionError`, a DB connection failure)
   is caught, recorded as `{ status: 'error', error }`, and the loop moves
   to the next interface. This is the "isolate failures per interface"
   requirement — one interface's failure never stops the pass.
9. On success, record `{ interfaceId, status: 'ok', eventCount: <total
   events sent to sink for this interface> }`.

`runOnce` returns the full `InterfaceRunResult[]`, one entry per attempted
interface, in load order.

## Approach: sequential vs. concurrent interface processing

Interfaces are processed **sequentially** (a plain `for` loop), not via
`Promise.allSettled`. Each interface's state rows are keyed by
`interfaceId` so there's no shared-mutable-state risk either way, and
parallelizing later is a safe, mechanical change if a real multi-interface
scale problem ever justifies it — YAGNI for now. Sequential also keeps
test assertions and failure traces deterministic.

## Error handling

Every thrown error inside a single interface's processing block is caught
at that interface's boundary and downgraded to an `error`-status result —
the Scheduler never lets one interface's exception propagate out of
`runOnce` and abort the rest of the pass. This is a different error
posture than the Engine itself (`processObservation`/`checkMissingSla` are
fail-fast, no internal catch) — the Scheduler is exactly the layer meant to
catch those fail-fast throws and turn them into per-interface isolation,
matching the architecture doc's explicit Scheduler responsibility.

## Testing

Real filesystem + real Postgres — same convention as the junior's
`test/integration/engine/engine-with-postgres.integration.test.ts`.

**Setup per test:** real temp directory (`fs.mkdtempSync`, like the folder
adapter's own tests) with real files written into it; real
`ConnectionConfigRepository`/`InterfaceConfigRepository` rows inserted
against the live test DB (`storageType: 'FOLDER'`, `endpoint: <temp dir>`);
real `PostgresStateRepository`.

**Cases:**
- Happy path: one enabled `FOLDER` interface, one matching file in the temp
  dir → `runOnce` returns one `ok` result, `sink` receives a
  `FILE_DETECTED` event.
- Disabled interface (`enabledFlag: false`) is skipped entirely — not even
  attempted, not in the result array.
- Missing `ConnectionConfig` (bad `connectionRef`) → `error` result for
  that interface, doesn't throw, doesn't stop other interfaces.
- Unregistered `storageType` (e.g. `'SFTP'`) → `error` result, same
  isolation guarantee.
- `folderAdapter.observe` throwing `AdapterError` (nonexistent
  `inboundPath`) → `error` result, isolated from other interfaces.
- Two enabled interfaces, one fails (bad connection ref) and one succeeds
  → both attempted, correct mixed result array, the successful one's
  events still reach `sink`.
- `engineDefaults` correctly merged: an interface with `slaDeadline` in the
  past and no files present emits `FILE_MISSING_BY_SLA` via
  `checkMissingSla`.

## Out of scope (follow-up work)

- Real continuous per-interface timer loop wrapping `runOnce`.
- `ConnectionManager`/`SecretProvider` (needed once a secret-requiring
  adapter like SFTP exists).
- SFTP/Blob/SharePoint adapters and their `AdapterRegistry` entries.
- `stuck_threshold_seconds`/`sla_deadline` as real DB columns (currently
  covered by `EngineDefaults`).
- `gateway-client`/event delivery to a real Gateway.
- A process entry point that actually calls `runOnce` (e.g. on a cron/
  interval) — nothing invokes the Scheduler in production yet.
