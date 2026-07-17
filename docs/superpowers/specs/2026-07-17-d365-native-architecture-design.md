# D365-Native Architecture (Dataverse + Power Platform + F&O) — Design Spec

**Date:** 2026-07-17
**Status:** Approved
**Related:** [docs/monorepo-architecture.md](../../monorepo-architecture.md) (superseded by this spec),
[2026-07-15-watcher-engine-design.md](2026-07-15-watcher-engine-design.md) (rule/state semantics — still normative),
[2026-07-15-watcher-database-design.md](2026-07-15-watcher-database-design.md) (schema shapes carried into Dataverse),
[2026-07-17-watcher-scheduler-design.md](2026-07-17-watcher-scheduler-design.md)

## Context

The original architecture ran the file watcher as two external Node services — Watcher
(adapters + lifecycle engine + Postgres state) and Gateway (HTTP intake + outbox + D365
OData sink). The Watcher side is implemented and tested in TypeScript in this repo; the
Gateway was never started.

**Decision (2026-07-17): build the entire system inside D365 instead.** One combined
solution spanning D365 Finance & Operations and its linked Dataverse / Power Platform
environment.

**Hard constraint:** the client provisions nothing beyond the D365 environment and Power
Apps. No Azure subscription resources (Logic Apps, Functions, storage accounts, Key
Vault), no external services, no Node hosting. The single tolerated client-side footprint
is the free on-premises data gateway install, and only if on-prem network-folder sources
are in scope.

### Why the pivot works — two collapses

1. **The Gateway dissolves.** Its outbox / retry / dead-letter / HTTP contract existed
   solely to bridge an unreliable network hop between an external writer and D365. With
   the engine running inside Dataverse, the state update and the event insert happen in
   one plugin transaction — strictly stronger guarantees than outbox-plus-retry, with
   none of the code.
2. **The adapter problem dissolves.** The watcher only ever needed file *metadata*
   (path, size, modified time) — never file contents. Power Automate's native connectors
   (SFTP-SSH, Azure Blob Storage, SharePoint, File System via on-premises data gateway)
   list files and return exactly that metadata. No staging containers, no mirroring, no
   custom connection/secret code.

## Solution naming

- **Power Platform solution:** `FileWatcherMonitoring`
- **Publisher prefix:** `fwm_` (placeholder — confirm against the client's existing
  publisher conventions in P0; substitute 1:1 if they mandate another)

## Component mapping

| Original component | New home |
|---|---|
| `interface_config` table + repository | Dataverse table `fwm_interface` |
| `connection_config` table + repository | Dataverse table `fwm_connection` |
| `secret-provider.ts` / `credential_ref` | Power Automate **connection references** (credentials live in the maker portal, never in tables) |
| `watcher_state` + `PostgresStateRepository` | Dataverse table `fwm_filestate` |
| `FileEvent` + Gateway API + outbox + delivery worker + D365 sink | Dataverse table `fwm_fileevent`, inserted in the same plugin transaction as the state update |
| Watcher Engine + rules + transition policy | C# Dataverse plugin + Custom APIs (`fwm_ProcessObservation`, `fwm_CheckMissingSla`) |
| Adapters (SFTP / Blob / SharePoint / folder) | Scheduled Power Automate cloud flows using native connectors |
| Scheduler (`runOnce` + planned timer loop) | Flow recurrence per connection + one scheduled missing-SLA sweep flow |
| Gateway sink registry (future sinks) | Flows triggered on `fwm_fileevent` create (Teams/email/Service Bus later); optional forward to an F&O data entity via the Fin & Ops Apps connector |
| Config UI / reprocessing UI (deferred items) | Model-driven Power App (forms, views, dashboards, guarded reset action) |
| `packages/contracts` | Documentation-only; Dataverse tables + Custom API contracts become the schema of record |

## Data model (Dataverse)

Column sets mirror the Postgres schemas in
[2026-07-15-watcher-database-design.md](2026-07-15-watcher-database-design.md) 1:1 unless
noted. All tables are organization-owned, in solution `FileWatcherMonitoring`.

### `fwm_interface` (setup)

- `fwm_interfaceid` (primary name, e.g. "SA-034"), `fwm_name`, `fwm_sourcesystem`,
  `fwm_targetsystem`
- `fwm_connection` (lookup → `fwm_connection`)
- `fwm_inboundpath`, `fwm_filepattern`
- `fwm_pollintervalseconds`, `fwm_readinessrule` (choice), `fwm_stabilitycheckseconds`,
  `fwm_duplicatecheckenabled`
- `fwm_stuckthresholdseconds` — **real per-interface column**, retiring the scheduler
  spec's `EngineDefaults` global-override workaround (deliberate, documented divergence
  from the TS implementation)
- `fwm_expectedschedule`, `fwm_slathresholdminutes`, `fwm_alertowner`, `fwm_enabled`

### `fwm_connection` (setup)

- `fwm_connectionref` (primary name), `fwm_storagetype` (choice: SFTP, AzureBlob,
  SharePoint, NetworkFolder), `fwm_environment`, `fwm_endpoint`, `fwm_port`,
  `fwm_username`, `fwm_authenticationtype` (choice), `fwm_timeoutseconds`,
  `fwm_enabled`, `fwm_owner`
- **No credential column of any kind.** The polling flow for a connection authenticates
  via its Power Automate connection reference; this row is documentation + routing only.

### `fwm_filestate` (operational, snapshot — not history)

- `fwm_interface` (lookup), `fwm_filepath`, `fwm_filename`, `fwm_filesizebytes`
- `fwm_batchid` (GUID string)
- `fwm_previousstatus`, `fwm_currentstatus` (choice `fwm_filestatus`: FILE_DETECTED,
  FILE_STABLE, FILE_DUPLICATE, FILE_STUCK, FILE_MISSING_BY_SLA)
- `fwm_statuschangedat`, `fwm_firstdetectedat`, `fwm_lastseenat`
- **Alternate key** on (`fwm_interface`, `fwm_filepath`) — preserves the Postgres unique
  constraint; upsert semantics via the alternate key.
- The missing-SLA **sentinel row** convention (`fwm_filepath = "__sla_window__"`) carries
  over unchanged for sweep idempotency.

### `fwm_fileobservation` (intake, transient)

- `fwm_interface` (lookup), `fwm_filepath`, `fwm_filename`, `fwm_filesizebytes`,
  `fwm_modifiedat`, `fwm_observedat`
- Written by polling flows; the engine plugin fires on create. Rows are processing
  triggers, not history — bulk-delete job purges rows older than N days.

### `fwm_fileevent` (append-only audit trail)

- `fwm_eventid` (GUID, alternate key), `fwm_eventtype` (choice, same values as
  `fwm_filestatus`), `fwm_batchid`, `fwm_interface` (lookup), `fwm_filepath`,
  `fwm_occurredat`
- Inherits the durable-audit-trail role the engine spec assigned to the Gateway's
  `event_outbox`. Never updated, never deleted (retention policy is a client decision).

## Engine (C# Dataverse plugin)

One C# class per TS module — the TypeScript engine and its vitest suite are the
**executable reference spec**; the port must produce identical decisions.

| TS module | C# class |
|---|---|
| `watcher-engine.ts` (`processObservation`) | `WatcherEngine` (invoked by plugin on `fwm_fileobservation` create; also exposed as Custom API `fwm_ProcessObservation`) |
| `missing-sla-sweep.ts` (`checkMissingSla`) | `MissingSlaSweep` (Custom API `fwm_CheckMissingSla`, called by a scheduled flow) |
| `rules/duplicate.rule.ts` | `DuplicateRule` |
| `rules/stuck-file.rule.ts` | `StuckFileRule` |
| `rules/stability.rule.ts` | `StabilityRule` |
| `state-transition.policy.ts` | `StateTransitionPolicy` (allow-list, throws `InvalidStateTransitionException`) |
| `batch-id.generator.ts` | `BatchIdGenerator` |
| `event-builder.ts` | `EventBuilder` |
| `interface-matcher.ts` | `InterfaceMatcher` |
| `packages/testing/fake-clock.ts` | `IClock` abstraction injected for testability |

Pipeline order preserved: **duplicate → stuck-file → stability**, first non-null outcome
wins; no state + no rule fired ⇒ implicit `FILE_DETECTED`; no meaningful change ⇒ no
event. State write + `fwm_fileevent` insert occur in the plugin's transaction stage
(pre-operation/synchronous), so both commit or neither does. Fail-fast: the plugin throws
`InvalidPluginExecutionException`; per-observation isolation is preserved because each
observation row is an independent plugin invocation.

### State-transition matrix (normative, unchanged)

| From | To | Allowed |
|---|---|---|
| (none — new file) | FILE_DETECTED | yes |
| FILE_DETECTED | FILE_STABLE | yes |
| FILE_DETECTED | FILE_STUCK | yes |
| FILE_DETECTED | FILE_MISSING_BY_SLA | no |
| FILE_STABLE | FILE_DUPLICATE | yes |
| FILE_STABLE | FILE_DETECTED | no |
| FILE_STUCK | FILE_STABLE | yes |
| FILE_STUCK | FILE_DUPLICATE | no |
| FILE_DUPLICATE | anything | no — terminal |
| (none) | FILE_MISSING_BY_SLA | yes (via sweep) |
| FILE_MISSING_BY_SLA | FILE_MISSING_BY_SLA | yes — sentinel re-emits on a later day |

Allow-list, not deny-list: anything not in the table is invalid.

> Note: the last row was implicit in the original engine spec's table but explicit in the
> reference implementation (`VALID_TRANSITIONS` in `state-transition.policy.ts`) — it is what
> lets the sweep's sentinel row emit again on a later missed day. Surfaced while generating
> the parity test vectors; recorded here so the C# port carries it.

## Adapters (Power Automate flows)

One scheduled cloud flow per connection ("watch flow"), owned by a licensed service
account:

1. Recurrence trigger per `fwm_pollintervalseconds` (floor: 1 minute — sub-minute polling
   is unsupported and documented as such).
2. List files via the native connector for the connection's storage type — SFTP-SSH,
   Azure Blob Storage, SharePoint, or File System (on-premises data gateway).
3. For each interface on that connection: filter by `fwm_inboundpath` +
   `fwm_filepattern`, normalize each listing to a `fwm_fileobservation` row (path, name,
   size, modified time). Nothing else — **flows observe, the engine decides.** No moves,
   deletes, renames, or content reads (MVP unchanged from the adapter contract).
4. Flow concurrency control = 1 (replaces the scheduler's overlap-prevention lock).

The missing-SLA sweep is one additional scheduled flow calling `fwm_CheckMissingSla` per
enabled interface.

## Monitoring & alerting (model-driven app)

- App `File Watcher Monitoring` in the same solution: setup forms for `fwm_interface` /
  `fwm_connection`, views and dashboards over `fwm_filestate` and `fwm_fileevent`
  (stuck files, missing SLA today, duplicates today, disabled interfaces).
- Alert flow on `fwm_fileevent` create → Teams/email to `fwm_alertowner` for FILE_STUCK
  and FILE_MISSING_BY_SLA.
- Guarded "reset file state" action (privileged security role) covers the deferred
  reprocessing-UI requirement.
- Security roles: `FWM Integration Admin` (maintain setup), `FWM Integration Operator`
  (monitor, reset state).
- F&O visibility: events are natively in the F&O environment's linked Dataverse; if a
  copy must land in an F&O table, a flow forwards `fwm_fileevent` rows via the standard
  Fin & Ops Apps connector — still zero provisioning.

## Preserved vs discarded

**Preserved verbatim (normative):** five-status lifecycle and the full transition
allow-list; rule semantics and pipeline order; one batch_id per file lifecycle
(generated only for brand-new files); snapshot state semantics with the sentinel-row
convention; the observe/decide boundary; fail-fast with per-interface isolation.

**Discarded, with rationale:**
- **Outbox / retry / dead-letter / delivery worker** — bridged a network hop that no
  longer exists; a local Dataverse transaction is strictly stronger.
- **Gateway HTTP API + Watcher→Gateway wire contract + idempotency-by-event_id** — no
  second process, no redelivery path.
- **Enrichment/masking pipeline** — file metadata carries no sensitive business fields;
  the secrets concern is fully absorbed by connection references.
- **Sink registry as code** — event-triggered flows are the fan-out mechanism.
- **secret-provider abstraction** — no secrets exist anywhere in the solution's data.

## Fate of the existing TypeScript code

- **Frozen executable reference spec:** `apps/watcher/src/engine/**` and its tests,
  `packages/testing` fake-clock, Postgres integration tests. Tests must stay green; no
  new features. If the port surfaces a spec ambiguity: fix TS + spec together, then port.
- **Reference-only:** folder adapter and TS scheduler (superseded by flows).
- **Removed:** `apps/gateway/**` and `apps/watcher/src/gateway-client/` (empty stubs).
- **Parity matrix** (created in P2): `docs/superpowers/specs/parity/engine-test-parity.md`
  mapping every vitest case to its FakeXrmEasy test method.

## Testing

- **C# unit tests with FakeXrmEasy** mirroring the vitest suite case-for-case via the
  parity matrix; `IClock` gives the same deterministic-time control as `fake-clock.ts`.
- Consider generating shared JSON test vectors (inputs → expected outcome) from the TS
  suite so both harnesses consume one source of truth.
- Flow testing is manual/E2E in a dev environment (drop file → observe FILE_DETECTED →
  FILE_STABLE): flows contain no business logic by design, keeping the untestable surface
  minimal.

## Licensing

No Azure or infrastructure costs. Expected net-new licensing:

- **One Power Automate Premium seat (~$15/user/mo)** for the service account owning the
  polling flows (SFTP-SSH, Azure Blob, and File System are premium connectors).
  Microsoft's strictest reading for autonomous background flows is the Power Automate
  Process license (~$150/flow/mo) — confirm with the client's CSP in P0.
- Monitoring-app users holding D365 F&O Enterprise licenses are covered by in-context
  use rights; users without D365 licenses need Power Apps Premium ($20/user/mo) or
  pay-as-you-go (~$10/active user/app/mo).
- Dataverse capacity: metadata-only rows; included capacity expected to suffice (the
  observation purge job keeps the intake table bounded).

## Roadmap

- **P0 — Prerequisites:** D365 F&O environment with linked Dataverse + Power Apps (the
  client's only provisioning); maker/system-customizer access; licensing confirmation;
  publisher-prefix decision; plugin dev setup (Visual Studio, Dataverse SDK, PAC CLI).
- **P1 — Solution + tables + app:** solution, 5 tables + choices + alternate keys,
  model-driven app with setup forms, security roles. Exit: config enterable in the app.
- **P2 — Engine port + parity tests:** plugin + Custom APIs + FakeXrmEasy suite per the
  parity matrix. Exit: every parity row green.
- **P3 — First adapter flow (MVP):** SFTP (or Blob) watch flow end-to-end in dev. Exit: a
  dropped file produces FILE_DETECTED → FILE_STABLE state rows and events.
- **P4 — Remaining adapters:** Blob, SharePoint, File System (+ data-gateway runbook);
  missing-SLA sweep flow; observation purge job.
- **P5 — Monitoring polish:** dashboards, alert flows, guarded state-reset, optional
  event forwarding into an F&O data entity.

## Risks

1. **Polling granularity** — flow recurrence floor of 1 minute; sub-minute intervals
   unsupported (documented).
2. **Premium connector licensing** — service-account Premium seat vs Process license;
   verify with CSP in P0.
3. **On-prem data gateway** — the one client-side install, only for network-folder
   sources; if unacceptable, those sources drop out of scope.
4. **Plugin 2-minute execution limit** — fine for per-observation processing; the SLA
   sweep must page per interface.
5. **Observation volume** — large directories mean many Dataverse creates per poll;
   mitigate with connector-side path/pattern filtering and the purge job.
6. **Parity is manual** — no shared harness between vitest and FakeXrmEasy; enforce via
   the parity matrix + PR checklist, ideally shared JSON test vectors.

## Out of scope

- Any implementation in this repo beyond documentation (the solution, plugin, and flows
  are built in the client's D365 environment / ALM pipeline).
- File content handling of any kind (moves, deletes, reads, checksums) — MVP boundary
  unchanged.
- Event Grid push-based detection (would reintroduce an external writer; revisit only if
  latency SLAs ever demand it).
- Watcher-side state history logging (unchanged deferral — `fwm_fileevent` is the audit
  trail).
