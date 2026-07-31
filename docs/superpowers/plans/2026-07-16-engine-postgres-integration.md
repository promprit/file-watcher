# Engine + PostgresStateRepository Integration — Implementation Plan

> **⚠️ HISTORICAL (2026-07-17):** this plan was executed against the TypeScript reference implementation. The production architecture has since pivoted to a D365-native build — see [2026-07-17-d365-native-implementation.md](2026-07-17-d365-native-implementation.md) and the [D365-native design spec](../specs/2026-07-17-d365-native-architecture-design.md). The code this plan produced is now part of the frozen executable reference spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Watcher Engine with PostgresStateRepository through integration tests and demo script.

**Architecture:** No Engine or Database code changes needed. Engine already uses StateRepository interface parameter. Integration tests verify Engine + Postgres work end-to-end. Demo script shows realistic usage with human-readable output.

**Tech Stack:** TypeScript, Vitest, node-postgres, PostgreSQL 15, ts-node

## Global Constraints

- Node.js ≥ 20.0.0 (from existing watcher package engines field)
- TypeScript 5.3+ (existing dependency)
- All database operations use DatabaseClient singleton (connection pooling)
- TRUNCATE watcher_state table before each test (isolation)
- Fail-fast design: throw errors immediately, no retry logic
- Reuse existing test fixtures from `test/fixtures/interface-configs.json`
- All tests use vitest framework (existing test runner)
- Demo uses ts-node for execution (already installed at root)

---

### Task 1: Integration Test Infrastructure

**Files:**
- Create: `apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts`

**Interfaces:**
- Consumes:
  - `processObservation(observation, config, stateRepo, now)` from `../../../src/engine/watcher-engine`
  - `PostgresStateRepository` from `../../../src/database/repositories/state.repository`
  - `DatabaseClient` from `../../../src/database/client`
  - `InterfaceConfig` type from `@packages/contracts`
- Produces:
  - Test suite `describe('Engine + PostgresStateRepository Integration')`
  - Helper function `seedInterfaceConfig(): Promise<InterfaceConfig>`

- [ ] **Step 1: Write test file skeleton with imports**

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { processObservation } from '../../../src/engine/watcher-engine';
import { checkMissingSla } from '../../../src/engine/missing-sla-sweep';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';
import interfaceConfigsFixture from '../../fixtures/interface-configs.json';

describe('Engine + PostgresStateRepository Integration', () => {
  let stateRepo: PostgresStateRepository;
  let configRepo: InterfaceConfigRepository;
  let db: DatabaseClient;
  let testConfig: InterfaceConfig;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    stateRepo = new PostgresStateRepository();
    configRepo = new InterfaceConfigRepository();

    // Clean state
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
    await db.query('TRUNCATE TABLE watcher_schema.interface_config CASCADE');

    // Seed interface config
    const fixtureConfig = interfaceConfigsFixture[0];
    await db.query(
      `INSERT INTO watcher_schema.interface_config (
        interface_id, interface_name, source_system, target_system,
        connection_ref, inbound_path, file_pattern, poll_interval_seconds,
        readiness_rule, stability_check_seconds, duplicate_check_enabled,
        stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
        alert_owner, enabled_flag
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        fixtureConfig.interfaceId,
        fixtureConfig.interfaceName,
        fixtureConfig.sourceSystem,
        fixtureConfig.targetSystem,
        fixtureConfig.connectionRef,
        fixtureConfig.inboundPath,
        fixtureConfig.filePattern,
        fixtureConfig.pollIntervalSeconds,
        fixtureConfig.readinessRule,
        fixtureConfig.stabilityCheckSeconds,
        fixtureConfig.duplicateCheckEnabled,
        fixtureConfig.stuckThresholdMinutes,
        fixtureConfig.expectedSchedule,
        fixtureConfig.slaThresholdMinutes,
        fixtureConfig.alertOwner,
        fixtureConfig.enabledFlag,
      ]
    );

    // Load config with engine fields
    const loadedConfig = await configRepo.findById(fixtureConfig.interfaceId);
    if (!loadedConfig) throw new Error('Failed to load test config');

    // Add engine-specific fields (MVP model) not in database schema yet
    testConfig = {
      ...loadedConfig,
      stuckThresholdSeconds: 3600, // 60 minutes = 3600 seconds
      slaDeadline: '18:00', // 6 PM UTC
    };
  });

  afterAll(async () => {
    await db.close();
  });

  // Tests will be added here
});
```

- [ ] **Step 2: Write first failing test (processObservation persists state)**

```typescript
  it('should persist state to database on first observation', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-001.xlsx',
      size: 1024,
      modified: new Date('2026-07-16T10:00:00Z'),
      observedAt: new Date('2026-07-16T10:00:00Z'),
    };

    const now = new Date('2026-07-16T10:00:00Z');

    const event = await processObservation(observation, testConfig, stateRepo, now);

    expect(event).not.toBeNull();
    expect(event?.eventType).toBe('FILE_DETECTED');

    // Verify state persisted to database
    const savedState = await stateRepo.get('SA-034', '/inbound/vendor-invoice-001.xlsx');

    expect(savedState).not.toBeNull();
    expect(savedState?.interfaceId).toBe('SA-034');
    expect(savedState?.filePath).toBe('/inbound/vendor-invoice-001.xlsx');
    expect(savedState?.currentStatus).toBe('FILE_DETECTED');
    expect(savedState?.previousStatus).toBeNull();
    expect(savedState?.fileName).toBe('vendor-invoice-001.xlsx');
    expect(savedState?.fileSizeBytes).toBe(1024);
    expect(savedState?.firstDetectedAt).toEqual(now);
    expect(savedState?.statusChangedAt).toEqual(now);
    expect(savedState?.lastSeenAt).toEqual(now);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/watcher && npm run test:integration -- engine-with-postgres`
Expected: FAIL with error (directory doesn't exist yet, need to create it first)

- [ ] **Step 4: Create test directory**

Run: `mkdir -p apps/watcher/test/integration/engine`

- [ ] **Step 5: Run test again to verify setup works**

Run: `cd apps/watcher && npm run test:integration -- engine-with-postgres`
Expected: PASS (all code already exists, just wiring together)

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts
git commit -m "test: add Engine + Postgres integration test infrastructure

- Create integration test file with setup/teardown hooks
- Add first test: processObservation persists state
- Reuse existing fixtures for interface config seeding
- TRUNCATE tables before each test for isolation"
```

---

### Task 2: Core Integration Tests

**Files:**
- Modify: `apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts`

**Interfaces:**
- Consumes: Test suite and helpers from Task 1
- Produces: Three additional integration tests (subsequent state load, transitions, upsert)

- [ ] **Step 1: Write test for subsequent observation loading previous state**

Add inside the `describe` block after the first test:

```typescript
  it('should load previous state on subsequent observation', async () => {
    const firstObservation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-002.xlsx',
      size: 2048,
      modified: new Date('2026-07-16T11:00:00Z'),
      observedAt: new Date('2026-07-16T11:00:00Z'),
    };

    const now1 = new Date('2026-07-16T11:00:00Z');
    const event1 = await processObservation(firstObservation, testConfig, stateRepo, now1);
    expect(event1?.eventType).toBe('FILE_DETECTED');

    // Second observation - same file, 35 seconds later (exceeds stability threshold of 30s)
    const secondObservation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-002.xlsx',
      size: 2048, // Same size (stable)
      modified: new Date('2026-07-16T11:00:00Z'), // Same modified time
      observedAt: new Date('2026-07-16T11:00:35Z'),
    };

    const now2 = new Date('2026-07-16T11:00:35Z');
    const event2 = await processObservation(secondObservation, testConfig, stateRepo, now2);

    expect(event2?.eventType).toBe('FILE_STABLE');

    // Verify state loaded correctly and transitioned
    const finalState = await stateRepo.get('SA-034', '/inbound/vendor-invoice-002.xlsx');
    expect(finalState?.currentStatus).toBe('FILE_STABLE');
    expect(finalState?.previousStatus).toBe('FILE_DETECTED');
    expect(finalState?.firstDetectedAt).toEqual(now1); // Preserved from first observation
    expect(finalState?.statusChangedAt).toEqual(now2); // Updated on transition
  });
```

- [ ] **Step 2: Write test for state transition enforcement**

```typescript
  it('should enforce valid state transitions', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/test-transitions.xlsx',
      size: 512,
      modified: new Date('2026-07-16T12:00:00Z'),
      observedAt: new Date('2026-07-16T12:00:00Z'),
    };

    const now = new Date('2026-07-16T12:00:00Z');

    // First: FILE_DETECTED
    const event1 = await processObservation(observation, testConfig, stateRepo, now);
    expect(event1?.eventType).toBe('FILE_DETECTED');

    // Verify transition to FILE_STABLE works
    const stableObservation = {
      ...observation,
      observedAt: new Date('2026-07-16T12:00:35Z'),
    };
    const now2 = new Date('2026-07-16T12:00:35Z');
    const event2 = await processObservation(stableObservation, testConfig, stateRepo, now2);
    expect(event2?.eventType).toBe('FILE_STABLE');

    // Verify final state has correct transition
    const state = await stateRepo.get('SA-034', '/inbound/test-transitions.xlsx');
    expect(state?.currentStatus).toBe('FILE_STABLE');
    expect(state?.previousStatus).toBe('FILE_DETECTED');
  });
```

- [ ] **Step 3: Write test for upsert preventing duplicates**

```typescript
  it('should upsert state without creating duplicate rows', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/upsert-test.xlsx',
      size: 1024,
      modified: new Date('2026-07-16T13:00:00Z'),
      observedAt: new Date('2026-07-16T13:00:00Z'),
    };

    const now1 = new Date('2026-07-16T13:00:00Z');
    await processObservation(observation, testConfig, stateRepo, now1);

    // Process same file again (after stability threshold)
    const now2 = new Date('2026-07-16T13:00:35Z');
    const stableObservation = {
      ...observation,
      observedAt: now2,
    };
    await processObservation(stableObservation, testConfig, stateRepo, now2);

    // Verify only one row exists
    const allStates = await stateRepo.findByInterface('SA-034');
    const matchingStates = allStates.filter((s) => s.filePath === '/inbound/upsert-test.xlsx');

    expect(matchingStates).toHaveLength(1);
    expect(matchingStates[0].currentStatus).toBe('FILE_STABLE');
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/watcher && npm run test:integration -- engine-with-postgres`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts
git commit -m "test: add core Engine + Postgres integration tests

- Test subsequent observations load previous state
- Test state transitions enforced (FILE_DETECTED -> FILE_STABLE)
- Test upsert prevents duplicate rows"
```

---

### Task 3: Additional Integration Tests

**Files:**
- Modify: `apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts`

**Interfaces:**
- Consumes: Test suite from Task 2
- Produces: Three more integration tests (checkMissingSla, batch ID, timestamps)

- [ ] **Step 1: Write test for checkMissingSla querying database**

Add inside the `describe` block:

```typescript
  it('should query database for missing SLA check', async () => {
    // Set time to after SLA deadline (18:00 UTC)
    const now = new Date('2026-07-16T18:30:00Z');

    // No files arrived today - should trigger FILE_MISSING_BY_SLA
    const events = await checkMissingSla(testConfig, stateRepo, now);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('FILE_MISSING_BY_SLA');
    expect(events[0].interfaceId).toBe('SA-034');

    // Verify sentinel state persisted to database
    const sentinelState = await stateRepo.get('SA-034', '__sla_window__');
    expect(sentinelState).not.toBeNull();
    expect(sentinelState?.currentStatus).toBe('FILE_MISSING_BY_SLA');
    expect(sentinelState?.fileName).toBe('__sla_window__');
    expect(sentinelState?.fileSizeBytes).toBe(0);
  });
```

- [ ] **Step 2: Write test for batch ID reuse across transitions**

```typescript
  it('should reuse batch ID across state transitions for same file', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/batch-id-test.xlsx',
      size: 1024,
      modified: new Date('2026-07-16T14:00:00Z'),
      observedAt: new Date('2026-07-16T14:00:00Z'),
    };

    const now1 = new Date('2026-07-16T14:00:00Z');
    const event1 = await processObservation(observation, testConfig, stateRepo, now1);
    const batchId1 = event1?.batchId;

    // Transition to FILE_STABLE
    const now2 = new Date('2026-07-16T14:00:35Z');
    const stableObservation = { ...observation, observedAt: now2 };
    const event2 = await processObservation(stableObservation, testConfig, stateRepo, now2);
    const batchId2 = event2?.batchId;

    // Batch ID should be reused
    expect(batchId2).toBe(batchId1);

    // Verify in database
    const state = await stateRepo.get('SA-034', '/inbound/batch-id-test.xlsx');
    expect(state?.batchId).toBe(batchId1);
  });
```

- [ ] **Step 3: Write test for timestamp persistence**

```typescript
  it('should persist all timestamps correctly', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/timestamp-test.xlsx',
      size: 2048,
      modified: new Date('2026-07-16T15:00:00Z'),
      observedAt: new Date('2026-07-16T15:00:00Z'),
    };

    const firstDetectedTime = new Date('2026-07-16T15:00:00Z');
    await processObservation(observation, testConfig, stateRepo, firstDetectedTime);

    // Update after 35 seconds
    const stableTime = new Date('2026-07-16T15:00:35Z');
    const stableObservation = { ...observation, observedAt: stableTime };
    await processObservation(stableObservation, testConfig, stateRepo, stableTime);

    // Verify timestamps from database
    const state = await stateRepo.get('SA-034', '/inbound/timestamp-test.xlsx');

    expect(state?.firstDetectedAt).toEqual(firstDetectedTime); // Never changes
    expect(state?.statusChangedAt).toEqual(stableTime); // Updates on transition
    expect(state?.lastSeenAt).toEqual(stableTime); // Updates on each observation
  });
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `cd apps/watcher && npm run test:integration -- engine-with-postgres`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts
git commit -m "test: add remaining Engine + Postgres integration tests

- Test checkMissingSla queries database correctly
- Test batch ID reused across transitions
- Test timestamps (firstDetectedAt, statusChangedAt, lastSeenAt) persist correctly

All 7 integration tests now passing"
```

---

### Task 4: Demo Script - Infrastructure & Scenario 1

**Files:**
- Create: `apps/watcher/src/demo/engine-demo.ts`

**Interfaces:**
- Consumes:
  - `processObservation` from `../engine/watcher-engine`
  - `checkMissingSla` from `../engine/missing-sla-sweep`
  - `PostgresStateRepository` from `../database/repositories/state.repository`
  - `InterfaceConfigRepository` from `../database/repositories/interface-config.repository`
  - `DatabaseClient` from `../database/client`
- Produces:
  - `async function runScenario1_DuplicateDetection(config, stateRepo, startTime): Promise<void>`
  - `async function main(): Promise<void>`

- [ ] **Step 1: Create demo directory and file with imports**

Run: `mkdir -p apps/watcher/src/demo`

Then create the file:

```typescript
import { processObservation } from '../engine/watcher-engine';
import { checkMissingSla } from '../engine/missing-sla-sweep';
import { PostgresStateRepository } from '../database/repositories/state.repository';
import { InterfaceConfigRepository } from '../database/repositories/interface-config.repository';
import { DatabaseClient } from '../database/client';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';

// Utility: simulate time passing
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Utility: format date for display
function formatTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

// Demo entry point - will be implemented in Task 5
async function main() {
  console.log('🚀 Engine + PostgresStateRepository Integration Demo\n');
  // TODO: Implementation in Task 5
}

main().catch((error) => {
  console.error('❌ Demo failed:', error.message);
  console.error('');
  console.error('Prerequisites:');
  console.error('  1. Database running: docker compose -f infrastructure/compose/docker-compose.yml up -d');
  console.error('  2. Migrations applied: cd apps/watcher && npm run migrate:up');
  console.error('  3. Interface config seeded (SA-034) - see test fixtures');
  process.exit(1);
});
```

- [ ] **Step 2: Write Scenario 1 - Duplicate Detection (Happy Path)**

Add before the `main()` function:

```typescript
async function runScenario1_DuplicateDetection(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 1: Duplicate Detection (Happy Path)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const filePath = '/inbound/vendor-invoice-001.xlsx';
  const fileSize = 1024;

  // Observation 1: First detection
  console.log(`[${formatTime(startTime)}] Processing observation 1: ${filePath} (${fileSize} bytes)`);

  const observation1: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    modified: startTime,
    observedAt: startTime,
  };

  const event1 = await processObservation(observation1, config, stateRepo, startTime);

  if (event1) {
    console.log(`  → Event: ${event1.eventType} (batch: ${event1.batchId})`);
    console.log(`  → State saved to database\n`);
  }

  // Simulate 35 seconds passing (exceeds stabilityCheckSeconds: 30)
  await sleep(100); // Actual sleep is short, but we advance the timestamp by 35s
  const time2 = new Date(startTime.getTime() + 35 * 1000);

  console.log(`[${formatTime(time2)}] Processing observation 2: ${filePath} (${fileSize} bytes, +35s)`);

  const observation2: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    modified: startTime, // Same modified time (file hasn't changed)
    observedAt: time2,
  };

  const event2 = await processObservation(observation2, config, stateRepo, time2);

  if (event2) {
    console.log(`  → Event: ${event2.eventType} (batch: ${event2.batchId})`);
    console.log(`  → State updated: FILE_DETECTED → FILE_STABLE\n`);
  }

  // Observation 3: Same file again (duplicate)
  await sleep(100);
  const time3 = new Date(time2.getTime() + 60 * 1000);

  console.log(`[${formatTime(time3)}] Processing observation 3: ${filePath} (${fileSize} bytes, same file)`);

  const observation3: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    modified: startTime,
    observedAt: time3,
  };

  const event3 = await processObservation(observation3, config, stateRepo, time3);

  if (event3) {
    console.log(`  → Event: ${event3.eventType} (batch: ${event3.batchId})`);
    console.log(`  → State updated: FILE_STABLE → FILE_DUPLICATE\n`);
  }

  // Show final state
  const finalState = await stateRepo.get(config.interfaceId, filePath);
  console.log('Final state in database:');
  console.log(`  Interface: ${finalState?.interfaceId}`);
  console.log(`  File: ${finalState?.filePath}`);
  console.log(`  Status: ${finalState?.currentStatus}`);
  console.log(`  Batch: ${finalState?.batchId}`);
  console.log(`  First detected: ${formatTime(finalState!.firstDetectedAt)}\n`);
}
```

- [ ] **Step 3: Implement minimal main() for testing Scenario 1**

Replace the `main()` function TODO with:

```typescript
async function main() {
  console.log('🚀 Engine + PostgresStateRepository Integration Demo\n');

  try {
    // Load interface config from database
    const configRepo = new InterfaceConfigRepository();
    const loadedConfig = await configRepo.findById('SA-034');

    if (!loadedConfig) {
      throw new Error('Interface config SA-034 not found. Run migrations and seed test data first.');
    }

    // Add engine-specific fields (MVP model)
    const config: InterfaceConfig = {
      ...loadedConfig,
      stuckThresholdSeconds: 3600, // 60 minutes
      slaDeadline: '18:00', // 6 PM UTC
    };

    // Create Postgres repository
    const stateRepo = new PostgresStateRepository();

    // Clean state for demo
    const db = DatabaseClient.getInstance();
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');

    const startTime = new Date('2026-07-16T10:00:00Z');

    // Run Scenario 1
    await runScenario1_DuplicateDetection(config, stateRepo, startTime);

    // Scenarios 2 & 3 will be added in Task 5

    // Close connection
    await DatabaseClient.getInstance().close();

    console.log('✅ Demo completed successfully\n');
  } catch (error) {
    // Re-throw to be caught by outer catch block
    throw error;
  }
}
```

- [ ] **Step 4: Test Scenario 1 works**

Run: `cd apps/watcher && npx ts-node src/demo/engine-demo.ts`
Expected: Output showing Scenario 1 with FILE_DETECTED → FILE_STABLE → FILE_DUPLICATE

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/demo/engine-demo.ts
git commit -m "feat: add demo script infrastructure and Scenario 1

- Create demo directory and file structure
- Add utility functions (sleep, formatTime)
- Implement Scenario 1: Duplicate Detection (Happy Path)
- Show FILE_DETECTED → FILE_STABLE → FILE_DUPLICATE flow
- Load config from database, clean state before demo"
```

---

### Task 5: Demo Script - Scenarios 2 & 3

**Files:**
- Modify: `apps/watcher/src/demo/engine-demo.ts`

**Interfaces:**
- Consumes: Scenario 1 and infrastructure from Task 4
- Produces:
  - `async function runScenario2_StuckFile(config, stateRepo, startTime): Promise<void>`
  - `async function runScenario3_MissingSLA(config, stateRepo, startTime): Promise<void>`
  - Complete `main()` orchestrating all 3 scenarios

- [ ] **Step 1: Write Scenario 2 - Stuck File**

Add after `runScenario1_DuplicateDetection`:

```typescript
async function runScenario2_StuckFile(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 2: Stuck File');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const filePath = '/inbound/stuck-file.xlsx';
  const fileSize = 2048;

  // Observation 1: First detection
  console.log(`[${formatTime(startTime)}] Processing observation 1: ${filePath} (${fileSize} bytes)`);

  const observation1: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    modified: startTime,
    observedAt: startTime,
  };

  const event1 = await processObservation(observation1, config, stateRepo, startTime);

  if (event1) {
    console.log(`  → Event: ${event1.eventType} (batch: ${event1.batchId})`);
    console.log(`  → State saved to database\n`);
  }

  // Simulate 90 minutes passing (exceeds stuckThresholdSeconds: 3600 = 60 minutes)
  await sleep(100);
  const time2 = new Date(startTime.getTime() + 90 * 60 * 1000);

  console.log(`[${formatTime(time2)}] Processing observation 2: ${filePath} (${fileSize} bytes, +90min)`);

  const observation2: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize, // Same size (no growth)
    modified: startTime, // Same modified time
    observedAt: time2,
  };

  const event2 = await processObservation(observation2, config, stateRepo, time2);

  if (event2) {
    console.log(`  → Event: ${event2.eventType} (batch: ${event2.batchId})`);
    console.log(`  → State updated: FILE_DETECTED → FILE_STUCK\n`);
  }

  // Show final state
  const finalState = await stateRepo.get(config.interfaceId, filePath);
  console.log('Final state in database:');
  console.log(`  Interface: ${finalState?.interfaceId}`);
  console.log(`  File: ${finalState?.filePath}`);
  console.log(`  Status: ${finalState?.currentStatus}`);
  console.log(`  Batch: ${finalState?.batchId}\n`);
}
```

- [ ] **Step 2: Write Scenario 3 - Missing by SLA**

Add after `runScenario2_StuckFile`:

```typescript
async function runScenario3_MissingSLA(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 3: Missing by SLA');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Time is after SLA deadline (18:00 UTC)
  const checkTime = new Date('2026-07-16T18:30:00Z');

  console.log(`[${formatTime(checkTime)}] Checking for missing files (SLA deadline: ${config.slaDeadline})`);

  // No files arrived today - should trigger FILE_MISSING_BY_SLA
  const events = await checkMissingSla(config, stateRepo, checkTime);

  if (events.length > 0) {
    console.log(`  → Event: ${events[0].eventType} (batch: ${events[0].batchId})`);
    console.log(`  → Expected file never arrived\n`);
  }

  // Show sentinel state
  const sentinelState = await stateRepo.get(config.interfaceId, '__sla_window__');
  console.log('Final state in database:');
  console.log(`  Interface: ${sentinelState?.interfaceId}`);
  console.log(`  File: ${sentinelState?.filePath} (sentinel)`);
  console.log(`  Status: ${sentinelState?.currentStatus}`);
  console.log(`  Batch: ${sentinelState?.batchId}\n`);
}
```

- [ ] **Step 3: Update main() to run all 3 scenarios**

Find the comment `// Scenarios 2 & 3 will be added in Task 5` and replace with:

```typescript
    // Run all 3 scenarios
    await runScenario1_DuplicateDetection(config, stateRepo, startTime);

    await runScenario2_StuckFile(config, stateRepo, new Date('2026-07-16T11:00:00Z'));

    // Clean state before Scenario 3 (SLA check expects no files today)
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
    await runScenario3_MissingSLA(config, stateRepo, new Date('2026-07-16T18:30:00Z'));
```

- [ ] **Step 4: Test all scenarios work**

Run: `cd apps/watcher && npx ts-node src/demo/engine-demo.ts`
Expected: Output showing all 3 scenarios with all 5 file states

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/demo/engine-demo.ts
git commit -m "feat: add Scenarios 2 & 3 to demo script

- Scenario 2: Stuck File (FILE_DETECTED → FILE_STUCK after 90 min)
- Scenario 3: Missing SLA (checkMissingSla → FILE_MISSING_BY_SLA)
- All 5 file states now demonstrated
- Clean state between Scenario 2 and 3"
```

---

### Task 6: Package Script & Verification

**Files:**
- Modify: `apps/watcher/package.json`

**Interfaces:**
- Consumes: All tests from Tasks 1-3, demo from Tasks 4-5
- Produces: Complete integration with npm script for demo

- [ ] **Step 1: Add demo script to package.json**

Modify the `scripts` section in `apps/watcher/package.json`:

```json
{
  "scripts": {
    "migrate:up": "node-pg-migrate up --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:down": "node-pg-migrate down --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:create": "node-pg-migrate create --migrations-dir src/database/migrations",
    "test:integration": "vitest run",
    "test:integration:watch": "vitest",
    "demo": "ts-node src/demo/engine-demo.ts"
  }
}
```

- [ ] **Step 2: Test demo script via npm**

Run: `cd apps/watcher && npm run demo`
Expected: Demo runs successfully, shows all 3 scenarios

- [ ] **Step 3: Run full integration test suite**

Run: `cd apps/watcher && npm run test:integration`
Expected: All 7 Engine + Postgres tests pass, plus existing database tests

- [ ] **Step 4: Verify prerequisites documented**

The demo script already includes error handling with clear prerequisite messages. Verify by running demo with database down:

Run: `docker compose -f infrastructure/compose/docker-compose.yml down && cd apps/watcher && npm run demo`
Expected: Clear error message listing prerequisites

Then start database again:
Run: `docker compose -f infrastructure/compose/docker-compose.yml up -d`

- [ ] **Step 5: Final commit**

```bash
git add apps/watcher/package.json
git commit -m "feat: add npm demo script for Engine + Postgres integration

- Add 'npm run demo' script to package.json
- Uses ts-node to execute engine-demo.ts
- All 7 integration tests passing
- Demo shows all 5 file states across 3 scenarios"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Integration tests (7 tests): processObservation persists state, subsequent calls load state, state transitions enforced, upsert prevents duplicates, checkMissingSla queries DB, batch ID reused, timestamps persisted
- ✅ Demo script (3 scenarios): Duplicate Detection, Stuck File, Missing SLA
- ✅ Package.json modification: demo script added
- ✅ No Engine/Database code changes (pure integration)
- ✅ Reuse existing fixtures
- ✅ TRUNCATE for test isolation
- ✅ Error handling with prerequisites in demo

**2. Placeholder scan:**
- ✅ No TBD/TODO in final code
- ✅ All test assertions have actual expected values
- ✅ All imports are exact paths
- ✅ All types are fully specified
- ✅ All SQL queries are complete
- ✅ All function signatures match across tasks

**3. Type consistency:**
- ✅ `InterfaceConfig` type consistent (includes engine fields stuckThresholdSeconds, slaDeadline)
- ✅ `FileObservation` interface matches: {interfaceId, path, size, modified, observedAt}
- ✅ `processObservation(observation, config, stateRepo, now)` signature consistent
- ✅ `checkMissingSla(config, stateRepo, now)` signature consistent
- ✅ `PostgresStateRepository` methods: get(interfaceId, filePath), save(state), findByInterface(interfaceId)
- ✅ Repository class names consistent: `PostgresStateRepository`, `InterfaceConfigRepository`
- ✅ Database client: `DatabaseClient.getInstance()` everywhere
- ✅ File paths consistent across all tasks
