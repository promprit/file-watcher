# Power Automate Flow Runbook — watch flows + SLA sweep

> Execute in the client environment's maker portal (Task 5 of
> [`2026-07-17-ts-to-d365-code-migration.md`](2026-07-17-ts-to-d365-code-migration.md)).
> Flows contain **zero business logic** — they observe and normalize; the plugin decides.
> All flows live in solution `FileWatcherMonitoring` and are owned by the licensed
> service account, with credentials only in connection references.

## A. Watch flow (one per connection; clone per connector type)

**Name:** `FWM Watch — <connection_ref>`

1. **Trigger — Recurrence:** interval = the smallest `fwm_pollintervalseconds` among the
   connection's interfaces (floor 1 minute). **Settings → Concurrency control: ON,
   degree of parallelism 1** (replaces the TS scheduler's overlap lock).
2. **List rows (Dataverse):** table `fwm_interface`, filter
   `fwm_enabled eq true and <connection ref column> eq '<connection_ref>'`.
3. **Apply to each interface** (sequential):
   a. **Skip-if-not-due guard (optional until sub-recurrence intervals differ):**
      condition on last run timestamp vs `fwm_pollintervalseconds`.
   b. **List files** via the storage connector:
      - SFTP-SSH: *List files in folder* → folder = `fwm_inboundpath`
      - Azure Blob Storage: *List blobs* → container/prefix = `fwm_inboundpath`
      - SharePoint: *Get files (properties only)* → library/folder = `fwm_inboundpath`
      - File System (on-prem gateway): *List files in folder*
   c. **Filter array:** items where `IsFolder` is false **and** name matches
      `fwm_filepattern` (connectors lack regex — use the pattern verbatim only if it is a
      plain suffix/prefix; otherwise mirror the regex with `endsWith`/`startsWith`/
      `contains` equivalents and record the mapping on the interface row).
   d. **Apply to each file → Add a new row (Dataverse)** `fwm_fileobservation`:
      | Column | Value |
      |---|---|
      | `fwm_interfaceid` | interface's `fwm_interfaceid` |
      | `fwm_filepath` | full path/blob path of the item |
      | `fwm_filesizebytes` | item size |
      | `fwm_modifiedat` | item's **source** last-modified timestamp |
      | `fwm_observedat` | `utcNow()` |
      The synchronous plugin fires on this create — state + event are written (or the
      create fails loudly on an invalid transition).
4. **Failure behavior:** no try/catch — a failed run is the alert (matches the TS
   fail-fast + per-interface isolation contract). Configure flow failure notifications
   to the service account/owner; other interfaces recover on the next recurrence.

Behavior checklist to verify per deployed flow: see Task 5 of the code-migration plan
(pattern filter, no directories, vanished-file tolerance, empty listing = no-op, etc.).

## B. Missing-SLA sweep flow (exactly one)

**Name:** `FWM Sweep — missing SLA`

1. **Trigger — Recurrence:** every 15 minutes (deadline granularity is minutes; the
   sentinel row makes re-runs idempotent).
2. **List rows:** `fwm_interface` where `fwm_enabled eq true`.
3. **Apply to each → Perform an unbound action:** `fwm_CheckMissingSla` with
   `InterfaceId` = `fwm_interfaceid`. (One interface per call — keeps each plugin
   execution far below the 2-minute budget.)
4. Optional: sum `EventCount` outputs and post a Teams summary when > 0.

## C. Alert flow (one)

**Name:** `FWM Alert — stuck / missing SLA`

1. **Trigger — When a row is added (Dataverse):** table `fwm_fileevent`,
   filter `fwm_eventtype eq 100000003 or fwm_eventtype eq 100000004`
   (FILE_STUCK / FILE_MISSING_BY_SLA — values fixed in `d365/.../Schema.cs`).
2. **Get interface row** by `fwm_interfaceid` → read `alert owner`.
3. **Notify:** Teams chat/channel post or email to the owner with interface id,
   event type, file path (null for SLA misses), occurred-at.

## D. API monitoring additions

**Reporting (no flow needed if the integration calls directly):** integrations invoke
unbound action `fwm_ReportApiMessage` (`InterfaceId`, `MessageId`,
`Action` = `Received|Processed|Failed`, optional `CorrelationId`/`ErrorCode`).
For F&O-side processing, create per feed: **trigger** "When an action is performed"
(F&O business event) → **Perform unbound action** `fwm_ReportApiMessage`.

**API SLA sweep:** extend the sweep flow (or clone it): List rows `fwm_interface`
where `fwm_enabled eq true and fwm_interfacetype eq 100000001` → Apply to each →
unbound action `fwm_CheckApiSla` with `InterfaceId`. Same 15-min recurrence.

**API alert flow:** trigger on `fwm_apievent` create, filter
`fwm_eventtype eq 100000003 or fwm_eventtype eq 100000004 or fwm_eventtype eq 100000005`
(MSG_FAILED / MSG_TIMEOUT / FEED_MISSING_BY_SLA) → notify the interface's alert owner.

## Prerequisites recap

- Plugin assembly registered (sync PostOperation on `fwm_fileobservation` Create) and
  Custom API `fwm_CheckMissingSla` (String `InterfaceId` in, Integer `EventCount` out)
  bound to `CheckMissingSlaPlugin`.
- Tables + `fwm_filestatus` choice created with the exact values in `Schema.cs`
  (100000000–100000004) and the alternate key on `fwm_filestate`
  (`fwm_interfaceid`, `fwm_filepath`).
- Connection references created for each storage connector under the service account.
