# File Watcher — Expert Briefing

The one document that makes you fluent in this system at three altitudes: **business**
(why it exists, what it saves), **functional** (what users see and do), **technical**
(how every layer works and why it's built that way). Written for presenting to a tech
team, defending the design, and requesting environment access.

Companion docs: [how-it-works.md](how-it-works.md) (walkthrough + diagram),
[design spec](superpowers/specs/2026-07-17-d365-native-architecture-design.md) (normative),
[deploy quickstart](../d365/deploy/README.md), [flow runbook](superpowers/plans/2026-07-17-flow-runbook.md),
[app build spec](superpowers/plans/2026-07-22-model-driven-app-and-security.md).

---

## Part 1 — Business

### 1.1 The problem

Integration files (vendor invoices, sales orders, price lists) arrive on SFTP servers,
Azure Blob containers, and SharePoint libraries, then feed D365 F&O. Failure modes today
are **silent**:

| Failure | What actually happens | Who notices, when |
|---|---|---|
| File never arrives | Upstream job died, nobody sent it | Business, days later, when numbers are wrong |
| File stuck mid-upload | Consumer reads a half-written file | Support, after a corrupted batch posts |
| File arrives twice | Batch posts twice | Finance, at reconciliation |
| File arrives late | SLA quietly missed | Nobody, until it compounds |

Cost of each incident: hours of support triage + rework + business trust. The watcher
converts all four from *silent* to *alerted-in-minutes with an audit trail*.

### 1.2 The value proposition

- **Detection in ≤1 poll interval** (1 minute floor) or **sub-second** for push-capable
  sources — vs. days.
- **Append-only audit trail per file**: every lifecycle step, one batch id, one timeline.
  Answers "what happened to Tuesday's invoice file?" in one lookup.
- **Ops self-service**: adding a new watched feed is a form in an app, not a deployment.
- **Zero infrastructure**: no servers, VMs, Azure resources, or F&O code changes. Runs
  entirely on Microsoft-hosted D365/Power Platform the client already licenses.

### 1.3 Total cost

| Item | Cost |
|---|---|
| Infrastructure | **$0** — no Azure subscription, nothing hosted |
| Net-new licensing | **~$15/mo** — one Power Automate Premium seat for the flow-owner service account (SFTP-SSH is a premium connector) |
| App users | $0 for D365-licensed users (in-context rights); Power Apps licensing only for non-D365 users |
| Ongoing ops | Config via app forms; no patching, no servers to babysit |
| Build remaining | ~1 hr flow clicking + ~half-day app clicking (specs written, zero decisions left) |

### 1.4 Why "inside D365" is the strategic choice

Every alternative (Node services, Logic Apps, Functions) creates a second operational
estate: deployment pipeline, monitoring, patching, security reviews, another bill.
This design's rule: **put logic where its data lives**. The data is Dataverse tables;
the logic is a Dataverse plugin; the watchers are Power Automate flows — one estate,
one security model, one admin center, already owned.

---

## Part 2 — Functional

### 2.1 The five statuses (business meaning)

| Status | Meaning | Business action |
|---|---|---|
| `FILE_DETECTED` | New file seen, may still be uploading | None — informational |
| `FILE_STABLE` | Size unchanged for the configured window — **safe to consume** | Downstream may process |
| `FILE_DUPLICATE` | Same file re-appeared after completion | Investigate double-send before it double-posts |
| `FILE_STUCK` | Still changing/incomplete past threshold | Alert owner: upload is wedged |
| `FILE_MISSING_BY_SLA` | Deadline passed, nothing arrived today | Alert owner: chase upstream **before** business impact |

Legal status transitions are a fixed allow-list (e.g. a stuck file may recover to
stable; a duplicate is terminal; a detected file can never become "missing"). Anything
not explicitly allowed is rejected — the system cannot record an impossible story.

### 2.2 Personas

- **Integration admin** — creates/edits watched feeds (interfaces) and sources
  (connections) via app forms; owns thresholds and SLA deadlines; can reset a file's
  state (guarded delete) so it re-detects fresh.
- **Operator** — watches dashboards (stuck now / missed SLA today / duplicates), reads
  per-file timelines, receives Teams/email alerts. Read-only on config.
- **Feed owner (business)** — receives alerts for their interface (`alert owner` field).

### 2.3 A day in the life

07:55 — SFTP watch flow polls; vendor file appears, growing → `FILE_DETECTED`.
07:57 — size stable 30s → `FILE_STABLE`. Downstream consumes.
08:00 — SLA sweep runs: file arrived today → silence (correct).
Next day 08:05 — sweep: nothing arrived, deadline 08:00 passed → `FILE_MISSING_BY_SLA`,
one Teams alert to the owner, exactly once (sentinel row prevents re-alert spam; fires
again only on the *next* missed day).

### 2.4 Configuring a new feed (no IT ticket)

App → Interfaces → New: id `SA-051`, connection `sftp-agdoc-prod`, path
`/ag-doc/sales-price/inbound/`, pattern `SalesPrice_.*\.csv$`, poll 60s, stability 30s,
stuck 3600s, SLA `07:00` (UTC — always UTC), owner `sc-team@client.com`, enabled. Done —
next poll cycle picks it up. If the source itself is new, admin also adds a connection
row + a cloned watch flow pointing at its connection reference.

---

## Part 3 — Technical

### 3.1 Component map

```
File sources ──(list metadata only)── Power Automate watch flows   [observe, zero logic]
                                            │ creates row
                                    fwm_fileobservation            [intake, transient]
                                            │ sync plugin, SAME TRANSACTION
                                    FileObservationCreatePlugin    [the engine]
                                       ├─ upsert fwm_filestate     [snapshot]
                                       └─ insert fwm_fileevent     [append-only audit]
Scheduled sweep flow ──(Custom API fwm_CheckMissingSla)── CheckMissingSlaPlugin
Alert flow ──(on fwm_fileevent create: STUCK/MISSING)── Teams/Email
Model-driven app ──(views/dashboards/forms over all tables)
```

Plus the API entry-point path (self-reporting, no polling):

```
API integrations / F&O business events ──(Custom API fwm_ReportApiMessage:
    Received | Processed | Failed)── ReportApiMessagePlugin
                                       ├─ upsert fwm_apimessage   [message = its own state]
                                       └─ insert fwm_apievent     [append-only audit]
Sweep flow ──(fwm_CheckApiSla)── timeouts + feed heartbeat (FEED_MISSING_BY_SLA)
```

Footprint: **7 tables, 4 plugins, 3 custom APIs, 3–4 flows, 1 app**. All inside the F&O
environment's linked Dataverse (`*.crm.dynamics.com` — F&O itself, `*.operations.dynamics.com`,
needs zero changes).

### 3.2 Data model essentials

- `fwm_interface` / `fwm_connection` — config. **No credential columns exist** —
  connector credentials live in Power Automate connection references only.
- `fwm_fileobservation` — intake trigger rows; purged by bulk-delete job (7 days).
- `fwm_filestate` — snapshot (current + previous status, batch id, timestamps), unique
  **alternate key on (interface id, file path)** → upsert semantics, race-proof.
  Key sized inside Dataverse's 900-byte index limit (50 + 380 chars × 2 bytes).
- `fwm_fileevent` — append-only; alternate key on event id; **no role has write/delete**
  — audit integrity enforced by security model, not convention.
- Status choice values pinned: FILE_DETECTED=100000000 … FILE_MISSING_BY_SLA=100000004,
  single source of truth in `Schema.cs`, machine-cross-checked by the deploy tests.

### 3.3 The engine (why a C# plugin)

Registered **synchronous, PostOperation, on Create of `fwm_fileobservation`** — meaning
it executes inside the database transaction of the intake insert:

1. Load interface config; assert observation belongs to it (mismatch → throw).
2. Load state by alternate key.
3. Rule pipeline, first non-null wins: **duplicate** (prior status terminal + same path)
   → **stuck** (non-terminal ∧ now − firstDetected ≥ threshold) → **stability**
   (FILE_DETECTED ∧ size unchanged ∧ window elapsed). No state + no rule = new file →
   `FILE_DETECTED`. Same status re-proposed = no-op, no event.
4. `StateTransitionPolicy.AssertValidTransition` — allow-list; violation throws
   `InvalidPluginExecutionException` → **entire transaction rolls back**, observation
   row included. Nothing half-written is representable.
5. Upsert state + insert event. Batch id generated only for brand-new files, reused for
   the file's whole lifecycle.

**The transaction argument (memorize):** the original design's Gateway service —
HTTP intake, outbox table, retry policy, dead-letter queue, delivery worker — existed
solely because the writer was outside D365 and the network could fail between "state
updated" and "event delivered". Inside the plugin pipeline, state + event share one
commit. The failure mode is structurally impossible, so ~40% of the planned system was
deleted by *relocating* logic, not cutting scope.

### 3.4 Absence detection (the sweep)

Missing files produce no observations — nothing for the pipeline to react to. So a
scheduled flow calls Custom API `fwm_CheckMissingSla` per enabled interface (one
interface per call — each execution far below the 2-minute plugin budget). Logic: past
today's UTC deadline ∧ no non-sentinel state first-detected today → write one
`FILE_MISSING_BY_SLA` event + a sentinel state row (`__sla_window__`). The sentinel's
"same UTC day" check makes re-runs idempotent; the allow-list explicitly permits
`FILE_MISSING_BY_SLA → FILE_MISSING_BY_SLA` so the next missed day fires again.

### 3.5 API entry points — covered (the second rule pack)

Both interface entry-point types are monitored on one engine:

1. **Files are watched** — they can't announce themselves, so flows poll and write
   observations. (And the observation intake is itself a real-time API: any push-capable
   source can `POST fwm_fileobservations` directly and skip polling — sub-second,
   transactional. `smoke.py` exercises exactly this path.)
2. **APIs self-report** — they already touch D365 when they run, so the integration (or
   an F&O business-event flow) calls Custom API **`fwm_ReportApiMessage`** with
   `Received` / `Processed` / `Failed`. Message state + audit event commit in one
   transaction. Statuses: `MSG_RECEIVED`, `MSG_PROCESSED`, `MSG_DUPLICATE`,
   `MSG_FAILED` (error code recorded), `MSG_TIMEOUT`. A sweep (**`fwm_CheckApiSla`**)
   adds what self-reporting can't: timeouts (received, never processed) and the feed
   heartbeat (`FEED_MISSING_BY_SLA` — feed silent past its deadline, sentinel-idempotent
   per UTC day). Late completion after a timeout is recordable — the allow-list permits
   `MSG_TIMEOUT → MSG_PROCESSED`.

One-liner: *files are watched because they can't speak; APIs report because they can.*
Spec: `docs/superpowers/specs/2026-07-22-api-entrypoint-monitoring-design.md`.
Out of scope on the API side: payload inspection, retry orchestration, and synchronous
CRUD calls that already fail loudly to their caller.

### 3.6 Correctness chain (how we prove the logic)

1. **Frozen reference:** the original TypeScript engine + 81 vitest tests is the
   executable spec. No new features allowed; ambiguities fix TS + spec together first.
2. **Generated vectors:** `npm run parity:vectors` *executes* the reference across 39
   scenarios and records ground-truth outcomes to JSON. Self-verifying — generation
   fails if execution ever disagrees with declared expectations.
3. **Parity suite:** 43 vector-driven xunit tests prove the C# engine decision-identical.
4. **Plugin + API layer:** 38 tests run the repositories, processors, API transition
   policy, report handling, and both sweeps against a fake `IOrganizationService`
   (alternate-key upsert emulated; unsupported SDK calls throw so new code paths fail
   loudly).
5. **Tooling guards:** 8 python tests regex-parse `Schema.cs` and diff it against the
   provisioning script — all three choice sets' values, every column, key byte budgets —
   plus a full dry-run execution.
6. **CI:** all of the above + vector-drift check on every push.
7. **In-environment:** `smoke.py` = automated acceptance (detect → stable, same batch)
   with exit-code verdict.

**170 automated checks total. The slide number: 81 + 43 + 38 + 8.**

### 3.7 Deployment story

```bash
python3 d365/deploy/provision.py --url https://ORG.crm.dynamics.com --dry-run   # review plan, no HTTP
dotnet build d365/FileWatcherMonitoring.Dataverse -c Release                    # signed self-contained DLL
python3 d365/deploy/provision.py --url ... --dll ... --seed seed.json           # ~5 min, idempotent
python3 d365/deploy/smoke.py --url ...                                          # automated verdict
```

Then flows (runbook, ~1 hr) and app (build spec, ~half day) in the maker portal;
snapshot everything into solution `FileWatcherMonitoring` for managed export to
test/prod. Local demo needs no environment at all:
`dotnet run --project d365/FileWatcherMonitoring.Simulator -- ./watched` — real folder,
production processor sources, live lifecycle output.

### 3.8 Security posture

- No secrets in any table (structurally — no such columns). Connection references hold
  credentials, Microsoft-managed.
- Plugin runs sandboxed (isolation mode 2), strong-named assembly.
- Roles: Admin (config CRUD + guarded state-reset via delete), Operator (read-only).
  Event table immutable to everyone.
- Watcher is read-only toward file sources — lists metadata, never touches content.
  It cannot corrupt a feed even if fully compromised.

### 3.9 Known limits (say them before they ask)

- Poll floor 1 minute (flow recurrence); sub-minute needs push-based intake.
- SLA deadlines are UTC only (documented; per-interface timezone is future work).
- Connector-side pattern filtering is simpler than full regex — complex patterns are
  enforced by convention at the flow level (engine-side matching stays exact).
- File path column capped at 380 chars in the state key (Dataverse 900-byte index
  limit); longer paths would need a hash-key variant.
- Flows themselves aren't unit-testable — mitigated by keeping them logic-free and by
  the documented per-flow behavior checklist.

---

## Part 4 — The ask (itemized, approvable line-by-line)

1. **Dataverse environment URL** linked to our F&O env (PPAC → Environments → F&O env →
   Environment URL, `https://….crm.dynamics.com`). Older LCS-deployed env without one:
   enable Power Platform Integration in LCS (free, ~1 hr). Fallback: any Power Platform
   env with Dataverse.
2. **System Customizer** role for me in that environment (sandbox first). F&O admin
   roles do not include this.
3. **Service account** owning the flows + **one Power Automate Premium seat** (~$15/mo).
4. **Source credentials** for the first feed (SFTP account) → entered into a connection
   reference, never stored by us.
5. (Only for on-prem folder sources) approval to install the free on-premises data
   gateway.

Explicitly **not** requested: Azure subscription, VMs, storage, Key Vault, F&O code
deployment, firewall changes, database servers.

## Part 5 — Q&A flashcards

- **Why not X++?** Logic lives where its data lives; data is Dataverse. X++ in the AOS
  would need an OData hop — reintroducing the external-writer failure mode we deleted.
- **Why not Logic Apps/Functions?** Same connectors, but requires an Azure estate.
  Constraint: zero footprint beyond D365 + Power Apps.
- **Why is there no retry queue?** Because there's no unreliable hop left to retry.
  One transaction covers intake + state + event.
- **Duplicate alerts on sweep re-run?** Impossible — sentinel row, same-UTC-day check,
  proven by tests and vectors.
- **Race between two observations of the same file?** Alternate-key upsert serializes on
  the key; each observation is its own pipeline; transition allow-list rejects any
  impossible interleaving.
- **What breaks if the plugin throws?** The whole transaction rolls back including the
  observation row; flow run shows failed step; other interfaces unaffected (each create
  is isolated). Fail-fast is the design, not an accident.
- **Vendor lock-in?** The engine's behavior is captured in a platform-neutral JSON
  vector file generated from a TypeScript reference — the logic is portable by
  construction; Dataverse specifics are one repository class + one thin wrapper.

## Part 6 — Numbers card

| | |
|---|---|
| Footprint | 7 tables · 4 plugins · 3 custom APIs · 3–4 flows · 1 app |
| Tests | **170** (81 reference + 43 parity + 38 plugin/API layer + 8 tooling), all in CI |
| Coverage | Both entry-point types: files (watched) + APIs (self-reporting) |
| Provisioning | ~5 min, one idempotent script, dry-run preview |
| Detection latency | ≤ poll interval (min 1 min); sub-second via direct API push |
| Net-new cost | ~$15/mo licensing; $0 infrastructure |
| Servers | 0 |

## Glossary

**Interface** — one watched feed (path + pattern + thresholds). **Connection** — one
file source hosting many interfaces. **Observation** — one sighting of one file.
**Batch id** — GUID minted at first detection, reused for that file's lifecycle; the
audit-trail thread. **Sentinel row** — pseudo state row (`__sla_window__`) that makes
the SLA sweep once-per-day idempotent. **Allow-list** — the fixed legal-transition
table; everything else throws. **Terminal status** — FILE_STABLE / FILE_DUPLICATE
(file's story complete unless it re-appears). **Alternate key** — Dataverse unique
index enabling race-safe upserts. **Connection reference** — Power Automate's
credential holder; the reason no secrets exist in tables.
