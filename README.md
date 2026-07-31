# File Watcher — D365-native Integration Monitoring

File monitoring for D365 Finance & Operations integrations, built **entirely inside D365**:
Dataverse tables (the database), a C# plugin (the logic), Power Automate flows (the file
watchers), and a model-driven Power App (config + monitoring UI). **Zero servers** — nothing
hosted outside the client's D365 environment and Power Platform.

It monitors both interface entry-point types on one engine: **file sources**
(SFTP / Azure Blob / SharePoint / on-prem folders) are watched — lifecycle
`FILE_DETECTED → FILE_STABLE`, plus duplicate/stuck/missing-by-SLA detection — and
**API entry points** self-report via Custom API `fwm_ReportApiMessage`
(`MSG_RECEIVED/PROCESSED/FAILED/TIMEOUT` + feed heartbeat). Owners get alerted the
minute a feed is stuck, failed, or silent.

**Start here (in this order):**
- [How it works](docs/how-it-works.md) — plain-language runtime walkthrough + diagram
- [Expert briefing](docs/expert-briefing.md) — business, functional, and technical deep dive
- [Development guide](docs/development-guide.md) — commands, layout, invariants
- [Completion master plan](docs/superpowers/plans/2026-07-22-completion-master-plan.md) — the remaining work, phase by phase
- [Design spec](docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md) — normative architecture ([API extension](docs/superpowers/specs/2026-07-22-api-entrypoint-monitoring-design.md))
- [Deploy quickstart](d365/deploy/README.md) — plug & play into any Dataverse environment
- [Flow runbook](docs/superpowers/plans/2026-07-17-flow-runbook.md) — maker-portal steps

## Repo layout

| Path | What | Status |
|---|---|---|
| `d365/FileWatcherMonitoring.Plugins/` | C# engine core (rules, transition allow-list, sweep) | **Production source** — deployed as plugin |
| `d365/FileWatcherMonitoring.Dataverse/` | Plugin wrappers, `DataverseStateRepository`, Custom API | **Production source** — signed self-contained DLL |
| `d365/FileWatcherMonitoring.*.Tests/` | 43 parity tests + 38 plugin/API-layer tests | CI |
| `d365/deploy/` | `provision.py` (idempotent env provisioning: 3 choices, 7 tables, keys, plugin, 3 Custom APIs; `--dry-run`/`--seed`), `smoke.py` (automated acceptance), drift-guard tests | Tooling + CI |
| `d365/FileWatcherMonitoring.Simulator/` | Local live demo — watches a real folder through the production engine sources | Demo |
| `apps/watcher/src/engine/` | **Frozen TypeScript reference engine** + 81 tests — the executable spec the C# port must match | Reference only, no new features |
| `apps/watcher/src/parity/` | Generates shared test vectors by executing the reference engine | Tooling |
| `docs/superpowers/` | Design specs + implementation plans (dated; superseded ones carry banners) | Docs |
| `packages/contracts/`, `apps/watcher/src/{adapters,scheduler,database}/` | Pre-pivot TS, kept for the reference suite | Reference only |
| `infrastructure/` | Local Postgres/Redis for the reference suite's integration tests only | Dev only |

## Verify everything (four suites, 170 checks)

```bash
npm install && npm test                                     # 81 TS reference tests
npm run parity:vectors -w @apps/watcher                     # regenerate shared vectors (idempotent)
dotnet test d365/FileWatcherMonitoring.Plugins.Tests        # 43 vector-driven parity tests
dotnet test d365/FileWatcherMonitoring.Dataverse.Tests      # 38 plugin + API-layer tests (fake IOrganizationService)
python3 -m unittest discover -s d365/deploy/tests           # 8 provisioning drift guards
dotnet build d365/FileWatcherMonitoring.Dataverse -c Release # the deployable plugin DLL
dotnet run --project d365/FileWatcherMonitoring.Simulator -- ./watched   # live demo: drop a .csv, watch the lifecycle
```

CI (`.github/workflows/ci.yml`) runs all of the above plus a vector-drift check on every push.

## History

The system was originally designed as two external Node services (Watcher + Gateway) — that
design is preserved in [`docs/monorepo-architecture.md`](docs/monorepo-architecture.md)
(superseded 2026-07-17). The pivot rationale in one line: moving the logic inside Dataverse
puts the state update and event insert in one transaction, which makes the entire
Gateway/outbox/retry layer unnecessary.

Reference-suite integration tests (optional, need Docker):
`docker compose -f infrastructure/compose/docker-compose.yml up -d`, then
`npm run test:integration -w @apps/watcher` (needs `DATABASE_URL`, see `.env.example`).
