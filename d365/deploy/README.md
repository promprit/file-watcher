# Plug & play: deploy FileWatcherMonitoring to a D365 environment

Everything below runs against the client's environment; total hands-on time ≈ 30 min
plus flow creation. Prereqs: System Customizer/Admin in the target environment,
Python 3.8+, .NET 8 SDK, Azure CLI (for the token).

## 0. Find your Dataverse URL (F&O clients read this first)

`provision.py` targets **Dataverse**, not F&O itself. F&O and Dataverse are two
runtimes under one environment: F&O answers on `*.operations.dynamics.com` (no
custom-table API), Dataverse on `*.crm.dynamics.com` (tables, plugins, flows —
everything this solution is). "We only have F&O" almost always means the Dataverse
half exists but nobody has looked:

1. Open `admin.powerplatform.microsoft.com` → **Environments** → find the
   environment matching the F&O environment name → **Environment URL** =
   `https://something.crm.dynamics.com`. That's your `--url`.
2. F&O environments deployed via PPAC (2023+) have linked Dataverse **by default**.
3. Older LCS-deployed F&O: LCS → environment page → **Power Platform Integration**
   → if empty, click **Setup** (free, ~1 hour, no new infrastructure).
4. Fallback if linking is blocked: any Power Platform environment with a Dataverse
   database works (PPAC → New environment → Dataverse: yes). The watcher is
   self-contained; forward events to F&O later via the Fin & Ops connector if needed.

The person running the script needs the **System Customizer** security role in that
Dataverse environment — an F&O admin role does not grant it automatically.

## 1. Build the signed plugin DLL

```bash
dotnet build d365/FileWatcherMonitoring.Dataverse -c Release
# → d365/FileWatcherMonitoring.Dataverse/bin/Release/net462/FileWatcherMonitoring.Dataverse.dll
```

The checked-in `FileWatcherMonitoring.snk` is a **dev key** — swap in an
org-controlled key for production if the client has signing policies.

## 2. Provision the environment (idempotent — safe to re-run)

```bash
export DATAVERSE_TOKEN=$(az account get-access-token \
    --resource https://YOURORG.crm.dynamics.com --query accessToken -o tsv)

python3 d365/deploy/provision.py \
    --url https://YOURORG.crm.dynamics.com \
    --dll d365/FileWatcherMonitoring.Dataverse/bin/Release/net462/FileWatcherMonitoring.Dataverse.dll
```

Creates: `fwm_filestatus` global choice (values 100000000–100000004, matching
`Schema.cs`), the 7 tables with all columns, the alternate keys
(`fwm_filestate` interfaceid+filepath, `fwm_fileevent` eventid), the plugin
assembly + sync PostOperation step on `fwm_fileobservation` Create, and Custom API
`fwm_CheckMissingSla`. Existing pieces are skipped, so re-running after a partial
failure is fine. Use `--tables-only` to provision schema without the plugin.

Preview the full plan first with zero risk (no token, no HTTP):

```bash
python3 d365/deploy/provision.py --url https://x --dry-run --seed d365/deploy/seed.example.json
```

Add `--seed d365/deploy/seed.example.json` (copy + edit first) to the real run to load
sample `fwm_connection`/`fwm_interface` rows.

## 3. Smoke test (automated — proves the whole engine path)

```bash
python3 d365/deploy/smoke.py --url https://YOURORG.crm.dynamics.com [--cleanup]
```

Creates a `SMOKE-001` interface (5s stability), posts an observation, asserts
`fwm_filestate` = `FILE_DETECTED` + one event, waits past the window, re-observes,
asserts `FILE_STABLE` + second event with the **same batch id**. Exit 0 = the plugin,
tables, keys, and transaction semantics are all live. `--cleanup` removes its rows.

Tooling self-checks (run locally / in CI, no environment):
`python3 -m unittest discover -s d365/deploy/tests` — cross-checks provision.py against
`Schema.cs` (choice values, every column, alternate-key 900-byte budget) and executes a
full dry-run.

## 4. Flows, app, roles (maker portal — manual by design)

- Flows: follow [`docs/superpowers/plans/2026-07-17-flow-runbook.md`](../../docs/superpowers/plans/2026-07-17-flow-runbook.md)
  (watch flow per connection, SLA sweep calling `fwm_CheckMissingSla`, alert flow).
- Add the 7 tables + flows to a solution named `FileWatcherMonitoring` for ALM.
- Model-driven app over interface/connection/state/event tables; security roles
  (`FWM Integration Admin` maintain-setup, `FWM Integration Operator` monitor).
- Bulk-delete job for `fwm_fileobservation` rows older than 7 days.

## Why a script instead of a solution .zip?

A hand-authored solution zip can only be validated by importing it into a real
environment — any schema mistake fails the whole import with opaque errors. The
Web API script is idempotent, fails per-request with a readable message, and was
syntax/flow-tested in this repo. Once provisioned, snapshotting the tables into a
solution in the portal gives the client a proper ALM artifact exported by
Dataverse itself.
