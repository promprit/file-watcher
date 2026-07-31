# Model-Driven App + Security Roles + Housekeeping — Build Spec

> Maker-portal build spec (P5 of the D365-native plan). Everything here is clicking, not
> coding — this doc removes the thinking so the app can be assembled in one sitting
> (~half a day). Prereq: `provision.py` has run; flows exist per the
> [flow runbook](2026-07-17-flow-runbook.md).

## 1. App: `File Watcher Monitoring`

Model-driven app in solution `FileWatcherMonitoring`. Sitemap:

| Area | Group | Pages |
|---|---|---|
| Monitoring | Live | File States (view), File Events (view), Dashboard |
| Monitoring | Intake | File Observations (view — debugging only) |
| Setup | Configuration | Interfaces, Connections |

## 2. Views

**FWM File States — "Active problems" (default):**
- Filter: `Current Status` in (FILE_STUCK) — plus a second view "Missing SLA today":
  `Current Status = FILE_MISSING_BY_SLA` and `Status Changed At = today`.
- Columns: Interface Id, File Name, Current Status, Previous Status, Status Changed At,
  First Detected At, File Size (bytes), Batch Id.
- Sort: Status Changed At desc.
- "All states" view: same columns, no filter.

**FWM File Events — "Today" (default):**
- Columns: Occurred At, Event Type, Interface Id, File Path, Batch Id.
- Sort: Occurred At desc. Second view "By batch": same columns grouped/searchable by
  Batch Id — the per-file lifecycle story.

**FWM Interfaces — "Enabled" (default):** Interface Id, Name, Inbound Path, File Pattern,
Poll Interval, Stability Check, Stuck Threshold, SLA Deadline, Enabled.

**FWM File Observations — "Recent":** Observed At desc, columns Interface Id, File Path,
Size, Modified At. (Debugging window into the intake queue.)

## 3. Forms

**Interface main form** — two columns:
- General: Interface Id, Name, Enabled, Connection (text ref), Inbound Path, File Pattern
- Rules: Poll Interval (s), Stability Check (s), Duplicate Check Enabled,
  Stuck Threshold (s), SLA Deadline (HH:mm UTC) — add form-level tooltip: "UTC, not local"
- Alerting: Alert Owner

**Connection main form:** Connection Ref, Storage Type, Endpoint, Enabled + a read-only
info text: "Credentials are never stored here — they live in the Power Automate
connection reference for this source."

**File State form (read-only for all fields):** all columns; timeline section listing
related File Events by Batch Id if a subgrid is wanted (relate via Batch Id view filter).

## 4. Dashboard: `FWM Operations`

Four tiles (charts over views):
1. Stuck files (count, view "Active problems")
2. Missing SLA today (count)
3. Duplicates today (File Events, `Event Type = FILE_DUPLICATE`, `Occurred At = today`)
4. Events by type — last 7 days (bar chart on File Events)

## 5. Security roles

| Privilege | FWM Integration Admin | FWM Integration Operator |
|---|---|---|
| fwm_interface / fwm_connection | Create/Read/Write/Delete (org) | Read (org) |
| fwm_filestate | Read (org) + **Delete (org)** — delete IS the guarded "reset file state" action | Read (org) |
| fwm_fileobservation | Read/Delete (org) | Read (org) |
| fwm_fileevent | Read (org) — nobody gets Write/Delete: audit trail | Read (org) |
| Custom API fwm_CheckMissingSla (execute) | Yes | No |

Notes:
- **Reset file state = delete the `fwm_filestate` row.** Next observation re-detects the
  file fresh (new batch id). Admin-only by role; surfaces in the app as the standard
  Delete button on the File State view — no custom code needed.
- The flow-owner service account needs Admin + the flows' connection references.
- Nobody edits `fwm_fileevent` — append-only by security design, not just convention.

## 6. Housekeeping

- **Bulk-delete job** (Settings → Data management → Bulk deletion): `fwm_fileobservation`
  where Created On older than 7 days; recurring daily. Observations are processing
  triggers, not history — `fwm_fileevent` keeps the story.
- Optional retention decision for `fwm_fileevent` (client policy; default keep forever).

## 7. ALM snapshot

After app + flows exist: add app, sitemap, flows, tables, security roles to solution
`FileWatcherMonitoring`; export unmanaged (dev) + managed (test/prod). Dataverse then owns
the canonical solution artifact — this repo keeps the sources (plugin DLL, provisioning
script) and the specs.
