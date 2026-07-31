# Watcher Scheduler Implementation Plan

> **⚠️ HISTORICAL (2026-07-17):** this plan was executed against the TypeScript reference implementation. The production architecture has since pivoted to a D365-native build — see [2026-07-17-d365-native-implementation.md](2026-07-17-d365-native-implementation.md) and the [D365-native design spec](../specs/2026-07-17-d365-native-architecture-design.md). The code this plan produced is now part of the frozen executable reference spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `runOnce()` — the Scheduler function that ties the Watcher Engine, the folder adapter, and `PostgresStateRepository` together into one working pass over enabled interfaces.

**Architecture:** One function, `runOnce(deps, sink, now?)`, doing a sequential loop over enabled `InterfaceConfig` rows: resolve `ConnectionConfig`, dispatch to the right adapter via a minimal registry, run observations through `processObservation`/`checkMissingSla`, hand events to a pluggable sink, catch and isolate any per-interface failure.

**Tech Stack:** TypeScript (strict), Vitest, real Postgres (integration test, same convention as the existing Engine+Postgres integration test).

**Source spec:** [`docs/superpowers/specs/2026-07-17-watcher-scheduler-design.md`](../specs/2026-07-17-watcher-scheduler-design.md)

## Prerequisites for running this plan's verification commands

A live Postgres with migrations applied, same as the existing Engine+Postgres integration test requires:
```bash
docker compose -f infrastructure/compose/docker-compose.yml up -d
cd apps/watcher && npm run migrate:up
```

## Global Constraints

- TypeScript strict mode, Vitest.
- `runOnce` processes enabled interfaces **sequentially** (a plain `for` loop), not concurrently.
- Every thrown error inside one interface's processing (bad `ConnectionConfig` lookup, unsupported storage type, `AdapterError`, `InvalidStateTransitionError`) is caught at that interface's boundary and downgraded to `{ status: 'error', error }` — it never aborts the rest of the pass. This is the "isolate failures per interface" requirement.
- `EngineDefaults` (`stuckThresholdSeconds`, `slaDeadline`) are merged onto **every** loaded `InterfaceConfig` **unconditionally** — `{ ...interfaceConfig, ...engineDefaults }` — not "only if missing." These two fields aren't real DB columns yet and aren't nullable on the type, so there's no way to detect "the DB provided a real value" today.
- `adapterRegistry` starts with exactly one entry: `{ FOLDER: folderAdapter }`.
- `sink: (event: FileEvent) => void` is the pluggable event callback — `runOnce` never POSTs anywhere itself (`gateway-client` doesn't exist yet).
- A real continuous per-interface timer loop, `ConnectionManager`/`SecretProvider`, and any adapter beyond folder are explicitly out of scope for this plan.
- Test file lives under `apps/watcher/test/integration/scheduler/` — matches the `apps/watcher/test/integration/**` exclude glob already in root `vitest.config.ts`, so it's automatically kept out of the fast `npm test` suite, and `apps/watcher/vitest.config.ts`'s `fileParallelism: false` (already set) means it won't race the existing Engine+Postgres integration test file.

---

### Task 1: `runOnce()` and its integration test

**Files:**
- Create: `apps/watcher/src/scheduler/scheduler.ts`
- Create: `apps/watcher/test/integration/scheduler/scheduler.integration.test.ts`

**Interfaces:**
- Consumes: `processObservation` (`apps/watcher/src/engine/watcher-engine.ts`), `checkMissingSla` (`apps/watcher/src/engine/missing-sla-sweep.ts`), `folderAdapter` (`apps/watcher/src/adapters/folder/folder.adapter.ts`), `Adapter`/`ConnectionContext`/`InterfaceScope` (`apps/watcher/src/adapters/adapter.ts`), `InterfaceConfigRepository`/`ConnectionConfigRepository`/`PostgresStateRepository` (`apps/watcher/src/database/repositories/*`), `DatabaseClient` (`apps/watcher/src/database/client.ts`), `ConnectionConfig`/`FileEvent`/`FileObservation`/`InterfaceConfig`/`StateRepository` from `@packages/contracts`.
- Produces: `runOnce(deps: SchedulerDeps, sink: (event: FileEvent) => void, now?: Date): Promise<InterfaceRunResult[]>`, `EngineDefaults`, `AdapterRegistry`, `InterfaceRunResult`, `SchedulerDeps` — this is the plan's sole deliverable.

Uses unique `interfaceId`/`connectionRef` prefixes (`SCHED-TEST-*`/`sched-test-*`) so this test's DB rows never collide with the existing Engine+Postgres integration test's `SA-034` fixture, even though both files share the same test database.

- [ ] **Step 1: Write the failing tests**

`apps/watcher/test/integration/scheduler/scheduler.integration.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseClient } from '../../../src/database/client';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { folderAdapter } from '../../../src/adapters/folder/folder.adapter';
import { runOnce, type EngineDefaults } from '../../../src/scheduler/scheduler';
import type { FileEvent } from '@packages/contracts';

const db = DatabaseClient.getInstance();
const interfaceConfigRepo = new InterfaceConfigRepository();
const connectionConfigRepo = new ConnectionConfigRepository();
const stateRepo = new PostgresStateRepository();

const engineDefaults: EngineDefaults = {
  stuckThresholdSeconds: 3600,
  slaDeadline: '00:00', // deliberately early UTC deadline so `now` in these tests is always "after"
};

const adapterRegistry = { FOLDER: folderAdapter };

let tempDir: string;

async function insertConnectionConfig(overrides: {
  connectionRef: string;
  storageType: string;
  endpoint: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO watcher_schema.connection_config (
      connection_ref, storage_type, environment, endpoint,
      authentication_type, timeout_seconds, enabled_flag
    ) VALUES ($1, $2, 'test', $3, 'NONE', 30, true)
    ON CONFLICT (connection_ref) DO UPDATE SET
      storage_type = EXCLUDED.storage_type,
      endpoint = EXCLUDED.endpoint`,
    [overrides.connectionRef, overrides.storageType, overrides.endpoint]
  );
}

async function insertInterfaceConfig(overrides: {
  interfaceId: string;
  connectionRef: string;
  inboundPath: string;
  filePattern?: string;
  enabledFlag?: boolean;
}): Promise<void> {
  await db.query(
    `INSERT INTO watcher_schema.interface_config (
      interface_id, interface_name, source_system, target_system,
      connection_ref, inbound_path, file_pattern, poll_interval_seconds,
      readiness_rule, stability_check_seconds, duplicate_check_enabled,
      enabled_flag
    ) VALUES ($1, $2, 'TEST', 'TEST', $3, $4, $5, 60, 'STABLE_SIZE', 30, true, $6)
    ON CONFLICT (interface_id) DO UPDATE SET
      connection_ref = EXCLUDED.connection_ref,
      inbound_path = EXCLUDED.inbound_path,
      file_pattern = EXCLUDED.file_pattern,
      enabled_flag = EXCLUDED.enabled_flag`,
    [
      overrides.interfaceId,
      `Scheduler Test ${overrides.interfaceId}`,
      overrides.connectionRef,
      overrides.inboundPath,
      overrides.filePattern ?? '.*\\.csv$',
      overrides.enabledFlag ?? true,
    ]
  );
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  await db.query("DELETE FROM watcher_schema.watcher_state WHERE interface_id LIKE 'SCHED-TEST-%'");
  await db.query("DELETE FROM watcher_schema.interface_config WHERE interface_id LIKE 'SCHED-TEST-%'");
  await db.query("DELETE FROM watcher_schema.connection_config WHERE connection_ref LIKE 'sched-test-%'");
});

afterAll(async () => {
  await db.close();
});

describe('Scheduler runOnce', () => {
  it('processes one enabled FOLDER interface and emits FILE_DETECTED', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-ok',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-OK',
      connectionRef: 'sched-test-conn-ok',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    const now = new Date('2026-07-17T05:00:00Z');
    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      now
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-OK');
    expect(result?.status).toBe('ok');
    expect(
      events.some((e) => e.eventType === 'FILE_DETECTED' && e.interfaceId === 'SCHED-TEST-OK')
    ).toBe(true);
  });

  it('skips a disabled interface entirely', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-disabled',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-DISABLED',
      connectionRef: 'sched-test-conn-disabled',
      inboundPath: '.',
      enabledFlag: false,
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    expect(results.find((r) => r.interfaceId === 'SCHED-TEST-DISABLED')).toBeUndefined();
  });

  it('records an error result when the ConnectionConfig is missing, without stopping other interfaces', async () => {
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-BADCONN',
      connectionRef: 'sched-test-conn-does-not-exist',
      inboundPath: '.',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-BADCONN');
    expect(result?.status).toBe('error');
  });

  it('records an error result for an unsupported storage type', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-sftp',
      storageType: 'SFTP',
      endpoint: 'sftp.example.com',
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-SFTP',
      connectionRef: 'sched-test-conn-sftp',
      inboundPath: '.',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-SFTP');
    expect(result?.status).toBe('error');
  });

  it('records an error result when the adapter throws (nonexistent inboundPath)', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-badpath',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-BADPATH',
      connectionRef: 'sched-test-conn-badpath',
      inboundPath: 'does-not-exist',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-BADPATH');
    expect(result?.status).toBe('error');
  });

  it('processes multiple interfaces independently: one fails, one succeeds', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-mixed-ok',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-MIXED-OK',
      connectionRef: 'sched-test-conn-mixed-ok',
      inboundPath: '.',
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-MIXED-BAD',
      connectionRef: 'sched-test-conn-mixed-does-not-exist',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      new Date('2026-07-17T05:00:00Z')
    );

    const okResult = results.find((r) => r.interfaceId === 'SCHED-TEST-MIXED-OK');
    const badResult = results.find((r) => r.interfaceId === 'SCHED-TEST-MIXED-BAD');
    expect(okResult?.status).toBe('ok');
    expect(badResult?.status).toBe('error');
    expect(events.some((e) => e.interfaceId === 'SCHED-TEST-MIXED-OK')).toBe(true);
  });

  it('emits FILE_MISSING_BY_SLA when no files arrive before the deadline', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-sla',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-SLA',
      connectionRef: 'sched-test-conn-sla',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    // engineDefaults.slaDeadline is '00:00' UTC; `now` below is well after that, same day, empty dir
    const now = new Date('2026-07-17T05:00:00Z');
    await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      now
    );

    expect(
      events.some(
        (e) => e.eventType === 'FILE_MISSING_BY_SLA' && e.interfaceId === 'SCHED-TEST-SLA'
      )
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/test/integration/scheduler/scheduler.integration.test.ts --config apps/watcher/vitest.config.ts`
Expected: FAIL — `apps/watcher/src/scheduler/scheduler.ts` doesn't exist.

- [ ] **Step 3: Write the implementation**

`apps/watcher/src/scheduler/scheduler.ts`:
```ts
import type {
  FileEvent,
  InterfaceConfig,
  StateRepository,
} from '@packages/contracts';
import type { Adapter, ConnectionContext, InterfaceScope } from '../adapters/adapter';
import { processObservation } from '../engine/watcher-engine';
import { checkMissingSla } from '../engine/missing-sla-sweep';
import { InterfaceConfigRepository } from '../database/repositories/interface-config.repository';
import { ConnectionConfigRepository } from '../database/repositories/connection-config.repository';

export interface EngineDefaults {
  stuckThresholdSeconds: number;
  slaDeadline: string;
}

export type AdapterRegistry = Record<string, Adapter>;

export interface InterfaceRunResult {
  interfaceId: string;
  status: 'ok' | 'error';
  eventCount: number;
  error?: unknown;
}

export interface SchedulerDeps {
  interfaceConfigRepo: InterfaceConfigRepository;
  connectionConfigRepo: ConnectionConfigRepository;
  stateRepo: StateRepository;
  adapterRegistry: AdapterRegistry;
  engineDefaults: EngineDefaults;
}

export async function runOnce(
  deps: SchedulerDeps,
  sink: (event: FileEvent) => void,
  now: Date = new Date()
): Promise<InterfaceRunResult[]> {
  const interfaces = await deps.interfaceConfigRepo.findAll(true);
  const results: InterfaceRunResult[] = [];

  for (const interfaceConfig of interfaces) {
    const fullConfig: InterfaceConfig = {
      ...interfaceConfig,
      ...deps.engineDefaults,
    };

    let eventCount = 0;
    try {
      const connectionConfig = await deps.connectionConfigRepo.findByRef(fullConfig.connectionRef);
      if (!connectionConfig) {
        throw new Error(`Connection config not found: ${fullConfig.connectionRef}`);
      }

      const adapter = deps.adapterRegistry[connectionConfig.storageType];
      if (!adapter) {
        throw new Error(`Unsupported storage type: ${connectionConfig.storageType}`);
      }

      const context: ConnectionContext = {
        connectionRef: connectionConfig.connectionRef,
        storageType: connectionConfig.storageType,
        endpoint: connectionConfig.endpoint,
      };
      const scope: InterfaceScope = {
        interfaceId: fullConfig.interfaceId,
        inboundPath: fullConfig.inboundPath,
        filePattern: fullConfig.filePattern,
      };

      const observations = await adapter.observe(context, scope);

      for (const observation of observations) {
        const event = await processObservation(observation, fullConfig, deps.stateRepo, now);
        if (event) {
          sink(event);
          eventCount += 1;
        }
      }

      const slaEvents = await checkMissingSla(fullConfig, deps.stateRepo, now);
      for (const event of slaEvents) {
        sink(event);
        eventCount += 1;
      }

      results.push({ interfaceId: fullConfig.interfaceId, status: 'ok', eventCount });
    } catch (error) {
      results.push({ interfaceId: fullConfig.interfaceId, status: 'error', eventCount, error });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/test/integration/scheduler/scheduler.integration.test.ts --config apps/watcher/vitest.config.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/watcher/tsconfig.json`
Expected: exits 0. (Note: `apps/watcher/tsconfig.json` excludes `test/`, so this only verifies `scheduler.ts` itself — the test file's correctness is verified by Step 4's actual run against a live database, not by this type-check.)

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/scheduler/scheduler.ts apps/watcher/test/integration/scheduler/scheduler.integration.test.ts
git commit -m "feat(watcher): add Scheduler runOnce, ties Engine + folder adapter + Postgres together"
```

---

### Task 2: Full workspace verification

**Files:** none created — verification only.

- [ ] **Step 1: Run the fast suite (unaffected by this plan — new test lives under the excluded integration path)**

Run: `npm test`
Expected: same 19 files / 81 tests as before this plan (this plan's new test file is in `apps/watcher/test/integration/scheduler/`, excluded from the fast suite by design).

- [ ] **Step 2: Type-check every workspace package**

Run: `npx tsc --build packages/contracts packages/testing apps/watcher`
Expected: exits 0.

- [ ] **Step 3: Confirm the root legacy app is unaffected**

Run: `npm run build && npm start`
Expected: `Integration Engine initialized`, `Build verification successful`, exit 0.

- [ ] **Step 4: Commit (only if Step 1-2 needed a fix; otherwise nothing to commit)**
