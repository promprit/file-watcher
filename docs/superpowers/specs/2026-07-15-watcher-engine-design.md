# Watcher Engine — Design Spec

> **ℹ️ STILL NORMATIVE FOR SEMANTICS (2026-07-17):** the rule pipeline, state-transition matrix, and lifecycle semantics defined here carry unchanged into the D365-native build — the C# plugin port must match them (see the [D365-native design spec](2026-07-17-d365-native-architecture-design.md)). Only the platform details (TypeScript service, Postgres, Gateway hand-off) are superseded; the TS engine is now the frozen executable reference spec.

**Date:** 2026-07-15
**Status:** Approved (pending final spec review)
**Related:** [docs/monorepo-architecture.md](../../monorepo-architecture.md)

## Context

`apps/watcher/src/engine/` and `packages/contracts/` currently exist as empty
`.gitkeep` scaffolding. This spec covers building the Common Watcher Engine —
the component that takes a `FileObservation` from an adapter, decides whether
anything meaningful happened, and produces a `FileEvent` for the Gateway.

Scope is the Engine and its direct dependencies (contracts, state repository
interface, rules). Adapters, the scheduler/orchestrator that calls the
Engine, the real Postgres-backed `StateRepository`, and the Gateway are all
out of scope — separate follow-up work.

## Scope: MVP rule set

All four rules from the architecture doc, not just the MVP-deferred subset:
`stability`, `duplicate`, `stuck-file`, `missing-sla`.

## Alignment with the org integration framework

The user supplied a reference diagram (general D365 F&O integration
framework: source systems → entry point → processing layer → D365 →
targets → monitoring, plus cross-cutting concerns). This design's
boundaries were checked against it:

| Framework layer | Watcher Engine piece | Fit |
|---|---|---|
| Entry Point → File/SFTP/Blob | `apps/watcher/src/adapters/*` (out of scope here) | matches |
| 2.1 Staging (store, track batch/status, source ref) | `WatcherState` via `StateRepository` | matches — snapshot only, see Audit trail below |
| 2.2 Validation → "duplicate check" | `duplicate.rule.ts`, `interface-matcher.ts` | matches |
| 2.2 Validation → field/type/legal-entity/reference-data | not in Engine — Gateway's `event-processor.ts` | correctly out of scope (different data: file metadata vs. business fields) |
| 2.3 Transformation & Mapping | not in Engine — Gateway's `enrichment-service.ts` / `d365-event.mapper.ts` | correctly out of scope; `event-builder.ts` only shapes `FileEvent`, no business mapping |
| 2.4 Orchestration | not in Engine — caller/scheduler (deferred) + Gateway outbox worker | correctly out of scope |
| 2.5 Error Handling & Reprocess (retry, dead-letter) | not in Engine — fail-fast/throw only | correctly out of scope — retry lives in Gateway + Event Sender |
| Cross-cutting: Config Mgmt | `InterfaceConfig` / `ConnectionConfig` contracts | matches |
| Monitoring — "end-to-end audit trail" | Gateway's `event_outbox` (every emitted `FileEvent` persisted there), not Watcher | matches, by explicit decision — see below |

**Audit trail decision:** `WatcherState` is a current-snapshot table
(`currentStatus`/`previousStatus`), not an append-only log. Durable audit
history is Gateway's `event_outbox`/`dead_letter_event`, since every
meaningful state change produces a `FileEvent` sent downstream. Watcher-side
history logging is explicitly deferred, not part of this build.

## Architecture

### Entry points

Two, because `missing-sla` reacts to the *absence* of a file, which can't be
expressed as a per-observation call.

```ts
function processObservation(
  observation: FileObservation,
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository
): Promise<FileEvent | null>

function checkMissingSla(
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,
  now: Date
): Promise<FileEvent[]>
```

Both are called by a future orchestrator/scheduler (out of scope). Neither
retries or POSTs anywhere — they return `FileEvent`s; sending them to the
Gateway is the caller's job (`gateway-client/event-sender.ts`, also out of
scope here).

### `processObservation` flow

1. `interface-matcher.ts` confirms the observation belongs to this
   interface. Defensive guard — throws if mismatched.
2. Load current `WatcherState` for `(interfaceId, filePath)` via
   `StateRepository.get()`.
3. Run the ordered rule pipeline: `duplicate` → `stuck-file` → `stability`.
   Each rule is `(observation, state, config) => RuleOutcome | null`. First
   non-null result wins. If no state exists and no rule fires, the implicit
   outcome is `FILE_DETECTED` (new file).
4. If nothing fires and it's not a new file → return `null` (no event).
5. `state-transition.policy.ts` validates `(currentStatus, proposedStatus)`
   is legal — throws `InvalidStateTransitionError` if not.
6. `batch-id.generator.ts` generates a new `batchId` only for a brand-new
   file; otherwise reuses `state.batchId` (one batch_id per file lifecycle,
   not shared across files).
7. `stateRepo.save()` persists the new state.
8. `event-builder.ts` builds the `FileEvent` from observation + new state +
   batch_id.
9. Return the `FileEvent`.

### `checkMissingSla` flow

Sweeps a single interface (called once per interface per scheduler cycle):
checks whether a file was expected by `interfaceConfig.slaDeadline` and no
`WatcherState` row reached `FILE_DETECTED` or later in the current window.
If so, builds and returns `FILE_MISSING_BY_SLA` event(s). Pure function
aside from the `StateRepository` read — same fail-fast contract as
`processObservation`.

### Error handling

Fail-fast. Any failure (state repo error, invalid transition, interface
mismatch) throws; the function that threw does no partial state save. The
caller (future batch loop) is responsible for catching per-observation and
aborting the rest of that interface's run — this was an explicit choice
over catch-and-continue.

### Concurrency

Sequential per interface. The Engine does not parallelize observation
processing. Cross-interface concurrency, if wanted, is the orchestrator's
concern (out of scope).

## Rule semantics

**`WatcherState`:**
```ts
interface WatcherState {
  interfaceId: string;
  filePath: string;
  currentStatus: FileStatus; // FILE_DETECTED | FILE_STABLE | FILE_DUPLICATE | FILE_STUCK | FILE_MISSING_BY_SLA
  previousStatus: FileStatus | null;
  batchId: string;
  firstDetectedAt: Date;
  statusChangedAt: Date;
  lastSeenAt: Date;
  lastKnownSize: number;
}
```

**`InterfaceConfig` additions** beyond the architecture doc's existing
example (`poll_interval_seconds`, `stability_check_seconds`):
- `stuckThresholdSeconds` — how long non-terminal before `FILE_STUCK`
- `slaDeadline` — expected arrival cutoff for `checkMissingSla`

**Rules (pipeline order for `processObservation`):**

1. **`duplicate.rule.ts`** — fires if state exists AND `currentStatus` is
   terminal (`FILE_STABLE` or `FILE_DUPLICATE`) AND path matches. →
   `FILE_DUPLICATE`. Basis: path + prior terminal status, no content
   checksum (adapters return metadata only in MVP).
2. **`stuck-file.rule.ts`** — fires if state exists, `currentStatus` is
   non-terminal, and `now - firstDetectedAt >= stuckThresholdSeconds`. →
   `FILE_STUCK`. Naturally observation-driven since adapters re-list the
   watched location every poll.
3. **`stability.rule.ts`** — fires if `lastKnownSize === observation.size`
   AND `now - statusChangedAt >= stabilityCheckSeconds` AND
   `currentStatus === FILE_DETECTED`. → `FILE_STABLE`.

**`missing-sla` decision logic** lives in `missing-sla-sweep.ts` as a pure
function (testable independently) but is not part of the `rules/` pipeline
array, since it's driven by absence-of-observation, not an observation.

**Valid state transitions** (enforced by `state-transition.policy.ts`):

| From | To | Allowed |
|---|---|---|
| (none — new file) | `FILE_DETECTED` | yes |
| `FILE_DETECTED` | `FILE_STABLE` | yes |
| `FILE_DETECTED` | `FILE_STUCK` | yes |
| `FILE_DETECTED` | `FILE_MISSING_BY_SLA` | no — a file that's been detected isn't missing |
| `FILE_STABLE` | `FILE_DUPLICATE` | yes (re-observed after terminal) |
| `FILE_STABLE` | `FILE_DETECTED` | no |
| `FILE_STUCK` | `FILE_STABLE` | yes (eventually stabilizes) |
| `FILE_STUCK` | `FILE_DUPLICATE` | no — not terminal yet |
| `FILE_DUPLICATE` | anything | no — terminal |
| (none) | `FILE_MISSING_BY_SLA` | yes (via `checkMissingSla`, no prior state) |

Any transition not listed above is invalid by default —
`assertValidTransition` uses an allow-list, not a deny-list.

## File layout

```
packages/contracts/src/
  observations/file-observation.ts   FileObservation { path, size, mtime, interfaceId }
  events/file-event.ts               FileEvent { eventId, eventType, batchId, interfaceId, filePath, occurredAt, ... }
  config/interface-config.ts         InterfaceConfig (+ stuckThresholdSeconds, slaDeadline)
  config/connection-config.ts        ConnectionConfig
  errors/error-codes.ts              InvalidStateTransitionError, AdapterTypeNotSupportedError, ...
  index.ts

apps/watcher/src/engine/
  watcher-engine.ts                  processObservation()
  missing-sla-sweep.ts               checkMissingSla()
  interface-matcher.ts               matchesInterface(observation, config): boolean
  batch-id.generator.ts              generateBatchId(): string
  event-builder.ts                   buildFileEvent(observation, state, ruleOutcome): FileEvent
  state-transition.policy.ts         assertValidTransition(from, to): void
  state/state-repository.ts          StateRepository interface (get/save)
  state/in-memory-state-repository.ts StateRepository impl for tests/dev
  rules/
    rule.ts                          shared Rule type
    duplicate.rule.ts
    stuck-file.rule.ts
    stability.rule.ts
```

Real Postgres-backed `StateRepository` (`apps/watcher/src/database/`) is
explicitly deferred to follow-up work — the Engine depends only on the
`StateRepository` interface.

## Testing

TDD per file. Each rule is a pure function, trivially unit-testable with
fixed `now` + state fixtures — no mocking beyond
`InMemoryStateRepository`. `packages/testing/src/fake-clock.ts` (currently
an empty stub) gets implemented alongside this work, since three of the four
rules are time-dependent and need deterministic `now` control to test.

## Out of scope (follow-up work)

- Adapters (SFTP, Blob, SharePoint, folder)
- Scheduler/orchestrator that calls `processObservation` / `checkMissingSla`
- Real Postgres-backed `StateRepository`
- `gateway-client/event-sender.ts` (POSTing `FileEvent` to Gateway)
- Gateway itself
- Watcher-side state history/audit logging (deliberately deferred — see
  Audit trail decision above)
