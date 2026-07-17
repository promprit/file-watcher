# File Watcher — D365-native Integration Monitoring

File monitoring for D365 Finance & Operations integrations, built **entirely inside D365**:
Dataverse tables (the database), a C# plugin (the logic), Power Automate flows (the file
watchers), and a model-driven Power App (config + monitoring UI). **Zero servers** — nothing
hosted outside the client's D365 environment and Power Platform.

It watches file sources (SFTP / Azure Blob / SharePoint / on-prem folders), tracks each
file's lifecycle (`FILE_DETECTED`, `FILE_STABLE`, `FILE_DUPLICATE`, `FILE_STUCK`,
`FILE_MISSING_BY_SLA`), and alerts owners when feeds are stuck or missed their SLA.

**Start here:**
- [How it works](docs/how-it-works.md) — plain-language runtime walkthrough
- [Design spec](docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md) — normative architecture
- [Deploy quickstart](d365/deploy/README.md) — plug & play into any Dataverse environment
- [Flow runbook](docs/superpowers/plans/2026-07-17-flow-runbook.md) — maker-portal steps

## Repo layout

| Path | What | Status |
|---|---|---|
| `d365/FileWatcherMonitoring.Plugins/` | C# engine core (rules, transition allow-list, sweep) | **Production source** — deployed as plugin |
| `d365/FileWatcherMonitoring.Dataverse/` | Plugin wrappers, `DataverseStateRepository`, Custom API | **Production source** — signed self-contained DLL |
| `d365/FileWatcherMonitoring.*.Tests/` | 43 parity tests + 12 plugin-layer tests | CI |
| `d365/deploy/provision.py` | One-shot idempotent environment provisioning (tables, choice, keys, plugin, Custom API) | CI-adjacent tooling |
| `apps/watcher/src/engine/` | **Frozen TypeScript reference engine** + 81 tests — the executable spec the C# port must match | Reference only, no new features |
| `apps/watcher/src/parity/` | Generates shared test vectors by executing the reference engine | Tooling |
| `docs/superpowers/` | Design specs + implementation plans (dated; superseded ones carry banners) | Docs |
| `packages/contracts/`, `apps/watcher/src/{adapters,scheduler,database}/` | Pre-pivot TS, kept for the reference suite | Reference only |
| `infrastructure/` | Local Postgres/Redis for the reference suite's integration tests only | Dev only |

## Verify everything (three suites)

```bash
npm install && npm test                                     # 81 TS reference tests
npm run parity:vectors -w @apps/watcher                     # regenerate shared vectors (idempotent)
dotnet test d365/FileWatcherMonitoring.Plugins.Tests        # 43 vector-driven parity tests
dotnet test d365/FileWatcherMonitoring.Dataverse.Tests      # 12 plugin-layer tests (fake IOrganizationService)
dotnet build d365/FileWatcherMonitoring.Dataverse -c Release # the deployable plugin DLL
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
