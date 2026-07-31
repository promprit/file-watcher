# D365-Native Implementation Plan (Dataverse + Power Platform + F&O)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Note:** most tasks in this plan execute in the client's D365 environment (maker portal, Visual Studio, PAC CLI), not in this repo — only Task 2's parity artifacts live here.

**Goal:** Rebuild the file-watcher system as one Power Platform solution (`FileWatcherMonitoring`) inside the client's D365 F&O environment and its linked Dataverse: Dataverse tables, a C# plugin port of the Watcher Engine, Power Automate polling flows as adapters, and a model-driven monitoring app.

**Architecture:** Scheduled flows list file metadata via native connectors and write `fwm_fileobservation` rows; a synchronous plugin on observation-create runs the ported engine (duplicate → stuck → stability, transition allow-list), updating `fwm_filestate` and inserting `fwm_fileevent` in one transaction. A scheduled sweep flow calls `fwm_CheckMissingSla`. No Gateway, no outbox, no Azure resources.

**Tech Stack:** Dataverse (tables, choices, alternate keys, Custom APIs), C# plugin (.NET, Dataverse SDK), FakeXrmEasy for unit tests, Power Automate cloud flows, model-driven Power App, PAC CLI for ALM.

**Source spec:** [`docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md`](../specs/2026-07-17-d365-native-architecture-design.md) — the mapping table, data model, and normative transition matrix live there; this plan does not restate them.

**Hard constraint (from spec):** client provisions nothing beyond the D365 environment + Power Apps. The only tolerated client-side footprint is the free on-premises data gateway, and only if network-folder sources are in scope.

## Global Constraints

- The TypeScript engine in `apps/watcher/src/engine/` and its vitest suite are the **executable reference spec**. The C# port must produce identical decisions for every parity-matrix case. TS code is frozen: fixes only when the port surfaces a spec ambiguity (fix TS + spec together, then port).
- Rule pipeline order duplicate → stuck-file → stability, first non-null wins; missing-SLA is an absence-driven sweep outside the pipeline with the `__sla_window__` sentinel-row idempotency convention.
- State transitions enforced by allow-list (spec's matrix); anything unlisted is invalid.
- Flows observe metadata only — no moves, deletes, renames, content reads. All lifecycle decisions live in the plugin.
- No secrets in any Dataverse table; connector credentials live in Power Automate connection references only.
- Publisher prefix `fwm_` is a placeholder until the P0 prefix decision; substitute 1:1 everywhere if the client mandates another.

---

### Task 0: Prerequisites (P0 — client + dev setup, blocking)

- [ ] **Environment:** confirm D365 F&O environment with linked Dataverse and Power Apps is available; obtain system-customizer access for the build account.
- [ ] **Licensing:** confirm with the client's CSP how the autonomous polling flows are licensed — target: one Power Automate Premium seat (~$15/mo) on a service account owning all flows; fallback: Power Automate Process license. Confirm monitoring-app users are covered (D365 in-context rights vs Power Apps Premium / pay-as-you-go).
- [ ] **Service account:** provision the flow-owner service account and its connector credentials (SFTP, Blob, SharePoint as applicable).
- [ ] **Prefix decision:** confirm publisher + prefix (`fwm_` default) against the client's existing solutions.
- [ ] **Dev tooling:** Visual Studio + Dataverse plugin SDK + PAC CLI installed; ALM path agreed (solution export to the client's repo/pipeline — this repo does not hold the solution).
- [ ] **Verify:** service account can create a connection for each in-scope connector type in the maker portal.

### Task 1: Solution, tables, and app (P1)

**Dataverse artifacts (schemas in the spec's Data model section):**
- [ ] Solution `FileWatcherMonitoring` + publisher.
- [ ] Choice sets: `fwm_filestatus`, `fwm_storagetype`, `fwm_authenticationtype`, `fwm_readinessrule`.
- [ ] Tables: `fwm_interface`, `fwm_connection`, `fwm_filestate` (alternate key on interface + file path), `fwm_fileobservation`, `fwm_fileevent` (alternate key on `fwm_eventid`).
- [ ] Bulk-delete job for `fwm_fileobservation` rows older than N days (intake is transient).
- [ ] Model-driven app `File Watcher Monitoring`: setup forms for interface/connection, views for state and events.
- [ ] Security roles `FWM Integration Admin`, `FWM Integration Operator`.
- [ ] Seed dev config from `apps/watcher/test/fixtures/interface-configs.json` equivalents (manual entry or dataflow — small data set).
- [ ] **Exit:** an interface + connection pair is enterable end-to-end in the app by an Admin-role user.

### Task 2: Engine port + parity tests (P2)

**Parity artifacts in THIS repo:**
- [x] Create `docs/superpowers/specs/parity/engine-test-parity.md`: one row per vitest case → planned FakeXrmEasy test method name (36 behavioral cases; done 2026-07-17). Module-level port detail lives in [`2026-07-17-ts-to-d365-code-migration.md`](2026-07-17-ts-to-d365-code-migration.md).
- [x] Export shared JSON test vectors (inputs → expected outcome) so both harnesses consume one source of truth — `engine-test-vectors.json`, generated by executing the reference engine (`npm run parity:vectors -w @apps/watcher`). The C# engine core + vector-driven xunit suite are pre-built at `d365/` (compile + first run happen in the client env).

**C# artifacts (client environment):**
- [ ] Classes 1:1 with TS modules per the spec's mapping table: `WatcherEngine`, `MissingSlaSweep`, `DuplicateRule`, `StuckFileRule`, `StabilityRule`, `StateTransitionPolicy`, `BatchIdGenerator`, `EventBuilder`, `InterfaceMatcher`, plus injected `IClock`.
- [ ] Plugin registration: synchronous, on `fwm_fileobservation` Create; state upsert (via alternate key) + `fwm_fileevent` insert inside the plugin transaction; throw `InvalidPluginExecutionException` on invalid transition (fail-fast).
- [ ] Custom APIs `fwm_ProcessObservation`, `fwm_CheckMissingSla` (sweep pages per interface — 2-minute plugin limit).
- [ ] FakeXrmEasy test project mirroring the parity matrix.
- [ ] **Exit:** every parity-matrix row green in the C# suite; matrix checked into this repo with the C# method names filled in.

### Task 3: First adapter flow — MVP (P3)

- [ ] Watch flow for the first real source (SFTP via SFTP-SSH connector, or Blob if that lands first): recurrence per `fwm_pollintervalseconds` (1-min floor), concurrency = 1, list files, filter per interface (`fwm_inboundpath` + `fwm_filepattern`), create `fwm_fileobservation` rows (path, name, size, modified time — nothing else).
- [ ] Flow owned by the P0 service account; connector credentials via connection reference only.
- [ ] **Exit (E2E in dev):** dropping a file in the watched location produces `FILE_DETECTED`, then `FILE_STABLE` after the stability window, visible as `fwm_filestate` + two `fwm_fileevent` rows.

### Task 4: Remaining adapters + sweep (P4)

- [ ] Watch flows for remaining in-scope sources: Azure Blob Storage connector, SharePoint connector, File System connector (+ on-premises data gateway install runbook for the client).
- [ ] Missing-SLA sweep flow: scheduled, calls `fwm_CheckMissingSla` per enabled interface; verify sentinel-row idempotency (no repeat events after the deadline passes).
- [ ] Duplicate-file and stuck-file scenarios exercised E2E per source type.
- [ ] **Exit:** all in-scope source types monitored in dev; sweep emits exactly one `FILE_MISSING_BY_SLA` per missed window.

### Task 5: Monitoring polish (P5)

- [ ] Dashboards: stuck files, missing SLA today, duplicates today, disabled interfaces.
- [ ] Alert flow on `fwm_fileevent` create → Teams/email to `fwm_alertowner` for `FILE_STUCK` / `FILE_MISSING_BY_SLA`.
- [ ] Guarded "reset file state" action restricted to the Admin role.
- [ ] (Optional) Forward events into an F&O data entity via the Fin & Ops Apps connector, if the client wants an F&O-side copy.
- [ ] **Exit:** operator can run the whole lifecycle (configure → monitor → get alerted → reset) without maker-portal access.

## Verification (whole plan)

1. Parity: C# suite green against every row of `engine-test-parity.md`; TS suite still green in this repo (`npm test`).
2. E2E per source type in dev: detect → stable; duplicate re-drop → `FILE_DUPLICATE`; growing file past threshold → `FILE_STUCK`; missed window → single `FILE_MISSING_BY_SLA`.
3. Zero-provisioning audit: solution imports into a bare D365 environment + the service-account licenses; nothing else required (data gateway only if network folders in scope).
4. Security: no credential data in any `fwm_*` table; Operator role cannot edit setup tables.
