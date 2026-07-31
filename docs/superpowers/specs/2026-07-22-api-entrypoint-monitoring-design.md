# API Entry-Point Monitoring — Design Spec

**Date:** 2026-07-22
**Status:** Approved; code-complete (built alongside this spec), environment deployment pending
**Related:** [2026-07-17-d365-native-architecture-design.md](2026-07-17-d365-native-architecture-design.md) (the base architecture this extends),
[plans/2026-07-22-completion-master-plan.md](../plans/2026-07-22-completion-master-plan.md) (Phase 4)

## Context

The monitoring layer covers interfaces entering through **file** entry points by
watching (polling flows), because files can't announce themselves. Interfaces entering
through **API entry points** (OData/custom services into D365, async messages) already
touch D365 when they run — they don't need watching, they **self-report** into the same
monitoring pipeline: same engine skeleton, same append-only audit idea, same app.
One monitor, two rule packs.

## Entry point

One Custom API, called by the integration itself or by an F&O business-event flow:

**`fwm_ReportApiMessage`** — request: `InterfaceId` (string), `MessageId` (string),
`Action` (`Received` | `Processed` | `Failed`), `CorrelationId` (optional),
`ErrorCode` (optional). Response: `Status` (the recorded status, or `NO_CHANGE`).
Runs in the Custom API's main-operation transaction: message state change + audit event
commit atomically — same guarantee as the file plugin.

Three reporting-contract options per integration (all Power-Platform-only):
1. The integration calls `fwm_ReportApiMessage` directly (best: sub-second).
2. An **F&O business event** triggers a flow that calls it (for F&O-side processing).
3. A scheduled flow polls the integration's own log table and reports on its behalf.

## Statuses (`fwm_apistatus` global choice — values in `Schema.cs`)

| Status | Value | Meaning |
|---|---|---|
| `MSG_RECEIVED` | 100000000 | Message arrived, processing pending |
| `MSG_PROCESSED` | 100000001 | Completed OK (terminal) |
| `MSG_DUPLICATE` | 100000002 | Same message id re-received after terminal (terminal) |
| `MSG_FAILED` | 100000003 | Completed with error; `ErrorCode` recorded (terminal) |
| `MSG_TIMEOUT` | 100000004 | Received but unprocessed past the interface's `ProcessingTimeoutSeconds` |
| `FEED_MISSING_BY_SLA` | 100000005 | Feed-level heartbeat: nothing received today by the SLA deadline |

### Transition allow-list (normative — `ApiTransitionPolicy`)

| From | To | Allowed |
|---|---|---|
| (none) | MSG_RECEIVED | yes |
| (none) | FEED_MISSING_BY_SLA | yes (heartbeat sweep) |
| MSG_RECEIVED | MSG_PROCESSED / MSG_FAILED / MSG_TIMEOUT | yes |
| MSG_TIMEOUT | MSG_PROCESSED / MSG_FAILED | yes — late completion is real and recordable |
| MSG_PROCESSED / MSG_FAILED | MSG_DUPLICATE | yes (re-receive after terminal) |
| MSG_DUPLICATE | anything | no — terminal |
| FEED_MISSING_BY_SLA | FEED_MISSING_BY_SLA | yes — sentinel re-emits on a later missed day |

Anything unlisted is invalid (throws, transaction rolls back). Re-reports that change
nothing (`Received` while in flight, repeated `Processed`) are no-ops — idempotent by
design, no event spam.

## Data model

- **`fwm_apimessage`** — message rows are their own state (a message has identity; a
  file sighting doesn't, which is why files needed a separate observation table).
  Columns: interface id, message id (alternate key with interface id), correlation id,
  current/previous status, batch id, received/processed timestamps, error code,
  status-changed-at. Heartbeat sentinel row uses message id `__heartbeat__`.
- **`fwm_apievent`** — append-only audit, mirror of `fwm_fileevent` (event id alternate
  key; message id null on heartbeat events). Same nobody-writes security stance.
- **`fwm_interface` additions** — `fwm_interfacetype` choice (File/Api),
  `fwm_processingtimeoutseconds`. The registry stays ONE table for all interfaces.

## Sweep

Custom API **`fwm_CheckApiSla`** (`InterfaceId` → `EventCount`), called per API
interface by the existing sweep flow cadence:
1. **Timeouts:** every `MSG_RECEIVED` older than `ProcessingTimeoutSeconds` →
   `MSG_TIMEOUT` + event (once — TIMEOUT doesn't re-fire on later sweeps).
2. **Heartbeat:** past the UTC `SlaDeadline` with zero non-sentinel messages received
   today → one `FEED_MISSING_BY_SLA` event, sentinel-idempotent per UTC day.

## Implementation map

| Piece | Where |
|---|---|
| `ApiStatus`, `ApiTransitionPolicy`, `ApiMessageEngine` (pure logic) | `d365/FileWatcherMonitoring.Plugins/ApiEngine.cs` |
| `ApiMessageProcessor` (storage + sweep), entity mapping | `d365/FileWatcherMonitoring.Dataverse/ApiProcessors.cs` |
| `ReportApiMessagePlugin`, `CheckApiSlaPlugin` (Custom API backings) | `d365/FileWatcherMonitoring.Dataverse/ApiPlugins.cs` |
| Tables/choices/keys/Custom API registration | `d365/deploy/provision.py` (idempotent; re-run adds only the new pieces) |
| Tests — 16 transition, 6 report, 4 sweep cases | `d365/FileWatcherMonitoring.Dataverse.Tests/ApiMonitoringTests.cs` |
| Drift guards (choice values, columns, key budgets vs `Schema.cs`) | `d365/deploy/tests/test_provision.py` |

## Alerting & app

Alert flow gains a twin on `fwm_apievent` create for `MSG_FAILED` / `MSG_TIMEOUT` /
`FEED_MISSING_BY_SLA`. App gains API Message + API Event views and dashboard tiles
(failed today, timed out, silent feeds) — additions folded into the
[app build spec](../plans/2026-07-22-model-driven-app-and-security.md) pattern.

## Out of scope

- Payload/content inspection — monitoring sees lifecycle metadata only (mirror of the
  file side's no-content principle).
- Per-message retry/reprocessing orchestration — the monitor records and alerts; the
  integration owns its retries.
- Synchronous OData CRUD calls that fail loudly to their caller — monitoring adds no
  value where the caller already gets an immediate error; this targets async/
  fire-and-forget feeds whose failures are silent.
