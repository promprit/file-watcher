# Completion Master Plan — Full Integration Monitoring inside D365

**Date:** 2026-07-22
**Goal:** a complete integration-monitoring system — **file-based AND API-based** — running
entirely within D365 / Power Platform, all data in Dataverse, zero external servers.
This plan is the build contract: hand it to the tech team with the access request in
Phase 0, then execute phases in order. Every phase has an exit test.

**Related:** [expert-briefing.md](../../expert-briefing.md) (present this),
[design spec](../specs/2026-07-17-d365-native-architecture-design.md),
[flow runbook](2026-07-17-flow-runbook.md), [app build spec](2026-07-22-model-driven-app-and-security.md).

---

## Current state (so the plan starts honest)

| Capability | Status |
|---|---|
| File monitoring — engine, tables, plugins, Custom API | ✅ Code-complete, 142 tests green, signed DLL |
| File monitoring — provisioning + smoke automation | ✅ `provision.py` (dry-run/seed) + `smoke.py` |
| File monitoring — flows, app, roles | 📋 Specs written, needs environment (clicking only) |
| API-based integration monitoring | ✅ **Code-complete 2026-07-22** (spec: [2026-07-22-api-entrypoint-monitoring-design.md](../specs/2026-07-22-api-entrypoint-monitoring-design.md); 26 tests green; provision.py extended) — Phase 4c deployment pending env |
| Environment access | ❌ **The blocker — Phase 0** |

---

## Phase 0 — Environment access (tech team, ~1 day of their time)

The complete, itemized ask:

- [ ] **Dataverse environment URL** linked to the F&O environment
      (PPAC → Environments → the F&O env → Environment URL, `https://….crm.dynamics.com`).
      If an older LCS-deployed env has none: enable **Power Platform Integration** in LCS
      (free, ~1 hour). Acceptable fallback: any Power Platform env with a Dataverse DB.
- [ ] **System Customizer** security role for the builder — sandbox/dev environment first.
      (F&O admin roles do not include this; it is a Power Platform role.)
- [ ] **Service account** to own flows + **1 × Power Automate Premium** seat (~$15/mo) —
      the only net-new license. SFTP-SSH/Blob/File System connectors are premium.
- [ ] **Source credentials** for the first watched feed (e.g. SFTP host + account) —
      stored only in a Power Automate connection reference, never in tables.
- [ ] (Only if on-prem network folders in scope) approval for the free
      **on-premises data gateway** install.
- [ ] Named contact for environment issues + agreement on sandbox → test → prod path.

**Explicitly not requested:** Azure subscription, VMs, storage accounts, Key Vault,
F&O code deployment, firewall changes.

**Exit test:** builder logs into `make.powerapps.com`, sees the environment, can open
Tables. `az account get-access-token --resource <env-url>` returns a token.

## Phase 1 — Provision + prove (½ day)

- [ ] `provision.py --dry-run` output reviewed (optionally with tech team — it prints
      every request before anything runs).
- [ ] `dotnet build d365/FileWatcherMonitoring.Dataverse -c Release` (swap in an
      org-controlled `.snk` first if the client mandates key policy).
- [ ] `provision.py --url … --dll … --seed` → 5 tables, choice, alternate keys, plugin,
      step, Custom API, sample config. Idempotent; re-run safe.
- [ ] **Exit test:** `smoke.py --url …` exits 0 (observation → FILE_DETECTED →
      FILE_STABLE, same batch id, in the real environment).

## Phase 2 — File monitoring go-live in sandbox (1–2 days)

- [ ] Watch flow per connection (SFTP first) per the [flow runbook](2026-07-17-flow-runbook.md);
      concurrency 1; owned by the service account.
- [ ] SLA sweep flow (15-min recurrence → `fwm_CheckMissingSla` per enabled interface).
- [ ] Alert flow (FILE_STUCK / FILE_MISSING_BY_SLA → Teams/email to alert owner).
- [ ] Real config seeded (true interfaces, real paths/patterns/deadlines with feed owners).
- [ ] **Exit tests (all four failure modes, live):** drop file → detect→stable; re-drop →
      duplicate; grow a file past threshold → stuck alert received; let a deadline pass →
      exactly one missing-SLA alert, none on sweep re-run.

## Phase 3 — Operations UX (½–1 day)

- [ ] Model-driven app, views, forms, dashboard per the
      [app build spec](2026-07-22-model-driven-app-and-security.md).
- [ ] Security roles `FWM Integration Admin` / `FWM Integration Operator`; event table
      write-locked for all.
- [ ] Bulk-delete job: observations older than 7 days.
- [ ] **Exit test:** an operator (not the builder) configures a new interface via the app
      form only, and it gets watched on the next poll; admin resets a file state and the
      file re-detects with a new batch id.

## Phase 4 — API-based integration monitoring (the extension; ~1 week total)

Files fail silently; that's why they came first. Async/fire-and-forget API feeds also
fail silently (message never processed, feed goes quiet) — this phase covers them with
the **same skeleton**: intake table → sync plugin engine → state + append-only event →
alert flow → app. All inside Dataverse.

### 4a. Design spec (env-free, ~1 session) — decisions to lock with the client

- [ ] **Message lifecycle statuses** (new global choice `fwm_apistatus`), proposed:
      `MSG_RECEIVED` → `MSG_PROCESSED` (terminal ok) / `MSG_FAILED` (terminal error) /
      `MSG_TIMEOUT` (received, not processed within threshold); plus feed-level
      `FEED_MISSING_BY_SLA` (no messages by deadline — the heartbeat, reusing the
      sentinel-row pattern verbatim). Allow-list transition table like the file engine.
- [ ] **Tables:** `fwm_apimessage` (intake+state: interface, message id [alternate key],
      correlation id, received/processed timestamps, error code) and `fwm_apievent`
      (append-only audit). `fwm_interface` gains a `fwm_interfacetype` choice (File/Api)
      + per-API thresholds (`processing timeout`, `heartbeat deadline`).
- [ ] **Reporting contract — who writes the intake rows** (pick per integration):
      1. The integration itself POSTs to the Dataverse API (best: sub-second, transactional);
      2. an **F&O business event** → Power Automate → intake row (for F&O-side processing);
      3. a scheduled flow polling the integration's own log table.
      All three are Power-Platform-only. No new infrastructure in any case.
- [ ] Rules: `DuplicateMessageRule` (message id re-seen), `TimeoutRule`
      (received ∧ now − receivedAt ≥ threshold ∧ not processed), heartbeat sweep
      (`fwm_CheckApiHeartbeat` Custom API mirroring the SLA sweep).

### 4b. Build (env-free, ~2 sessions)

- [ ] C# rule classes + `ApiMessageProcessor` in the same plugin project/pattern;
      plugin on `fwm_apimessage` Create + Update(processed/error fields).
- [ ] Tests in the existing harnesses: fake-`IOrganizationService` suite for the new
      processor; transition-policy tests for the new allow-list.
- [ ] `provision.py` extended (new tables/choice/keys/steps/Custom API) + drift-guard
      tests updated; `smoke.py` gains an API-path scenario.
- [ ] Simulator gains a `--api` mode (posts fake messages, shows timeout/heartbeat live).

### 4c. Deploy + go-live (env, ~1 day)

- [ ] Re-run `provision.py` (idempotent — only new pieces created); smoke passes.
- [ ] Wire the first real API feed via its chosen reporting contract; heartbeat sweep
      flow; alerts extended to `MSG_FAILED` / `MSG_TIMEOUT` / `FEED_MISSING_BY_SLA`.
- [ ] App: API dashboard tiles (failed today, timed out, silent feeds).
- [ ] **Exit tests:** processed message closes cleanly; a message left unprocessed past
      the threshold alerts; a feed kept silent past its heartbeat deadline alerts exactly
      once per day.

## Phase 5 — Production hardening (2–3 days, calendar-gated by client ALM)

- [ ] Snapshot everything (tables, plugin, flows, app, roles) into solution
      `FileWatcherMonitoring`; export **managed** to test, then prod.
- [ ] Prod service-account connections re-pointed at prod sources; prod seed config.
- [ ] Alert routing reviewed with feed owners; runbook for operators (reset, re-enable,
      reading a batch timeline).
- [ ] Retention decisions recorded (events keep-forever default; observation purge 7d).
- [ ] Handover session with the junior + ops team using [expert-briefing.md](../../expert-briefing.md).

---

## Timeline summary (working effort, given access)

| Phase | Effort | Dependency |
|---|---|---|
| 0 Access | tech team, ~1 day | — |
| 1 Provision + prove | ½ day | 0 |
| 2 File go-live (sandbox) | 1–2 days | 1 |
| 3 Operations UX | ½–1 day | 1 |
| 4 API monitoring | ~1 week (4a/4b start **now**, env-free) | 4c needs 1 |
| 5 Production | 2–3 days | 2+3 (files) / +4 (full) |

**File monitoring live in sandbox: within ~3 working days of credentials.**
**Full system (files + API) in production: ~2–3 weeks calendar, mostly waiting on
client-side ALM and API reporting-contract decisions.**

## Risks

1. **Access delay** — the only hard blocker; everything in 4a/4b proceeds without it.
2. **API reporting contract** — needs a decision per integration (who writes intake rows);
   schedule that conversation in Phase 0, not Phase 4.
3. **Licensing interpretation** — confirm the service-account Premium seat with the CSP
   during Phase 0.
4. **Prod signing policy** — if the client mandates their own strong-name key, swap
   before the Phase 5 build.
