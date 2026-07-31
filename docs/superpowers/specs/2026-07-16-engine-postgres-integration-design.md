# Engine + PostgresStateRepository Integration — Design Spec

> **⚠️ SUPERSEDED (2026-07-17):** the architecture pivoted to a D365-native build (Dataverse + Power Platform); this component's production role is replaced per the [D365-native design spec](2026-07-17-d365-native-architecture-design.md). The TypeScript implementation described here remains in-repo as part of the frozen executable reference spec.

**Date:** 2026-07-16
**Status:** Approved
**Related:**
- [Watcher Engine Design](2026-07-15-watcher-engine-design.md)
- [Watcher Database Design](2026-07-15-watcher-database-design.md)
- [Monorepo Architecture](../monorepo-architecture.md)

## Context

Engine and Database layers built separately:
- **Engine** (PR#2): processObservation, checkMissingSla, rules, state transitions - tested with InMemoryStateRepository
- **Database** (your work): PostgresStateRepository, migrations, connection pooling - tested separately

**Gap:** Never tested together. Need to verify Engine works with real Postgres.

**Scope:** Integration tests + demo script showing Engine + Database working end-to-end.

**Out of scope:** Scheduler/orchestrator, adapters, Gateway integration (separate work).

## Architecture

### No Engine Changes Needed

Engine already designed for dependency injection:

```typescript
async function processObservation(
  observation: FileObservation,
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,  // ← Interface, not concrete type
  now: Date = new Date()
): Promise<FileEvent | null>
```

**Integration approach:**
- Engine stays interface-dependent (StateRepository)
- Tests/demo inject PostgresStateRepository
- No code changes to Engine or Database layers
- Pure integration work

### Integration Points

1. **processObservation()** → PostgresStateRepository.get/save
2. **checkMissingSla()** → PostgresStateRepository.findByInterface
3. **Config loading** → InterfaceConfigRepository.findById
4. **Connection pooling** → DatabaseClient singleton

All pieces exist, just need to wire together.

## Components

### Integration Tests

**Location:** `apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts`

**Test coverage:**
1. **processObservation persists state** - First observation creates state in database
2. **Subsequent calls load previous state** - Second observation finds existing state
3. **State transitions enforced** - FILE_DETECTED → FILE_STABLE transition works
4. **Upsert prevents duplicates** - Same file path doesn't create duplicate rows
5. **checkMissingSla queries database** - Missing file detection works with real DB
6. **Batch ID reused** - Same batchId across state transitions for same file
7. **Timestamps persisted** - firstDetectedAt, statusChangedAt, lastSeenAt stored correctly

**Test pattern:**
```typescript
beforeEach: async () => {
  // Truncate watcher_state
  await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
  // Seed interface_config (reuse existing fixtures)
  await seedFixtures();
}

afterAll: async () => {
  await DatabaseClient.getInstance().close();
}
```

**Fixtures:** Reuse existing `test/fixtures/interface-configs.json`, `connection-configs.json`

**Focus:** Integration behavior (state persistence, constraints, transactions), not re-testing Engine rules or Database CRUD.

### Demo Script

**Location:** `apps/watcher/src/demo/engine-demo.ts`

**Purpose:** Show realistic usage pattern for new users.

**Script structure:**
```typescript
async function main() {
  // 1. Load interface config from database
  const configRepo = new InterfaceConfigRepository();
  const config = await configRepo.findById('SA-034');

  // 2. Create Postgres repository
  const stateRepo = new PostgresStateRepository();

  // 3. Run 3 scenarios showing all 5 file states
  await runScenario1_DuplicateDetection(config, stateRepo);
  await runScenario2_StuckFile(config, stateRepo);
  await runScenario3_MissingSLA(config, stateRepo);

  // 4. Close connection
  await DatabaseClient.getInstance().close();
}
```

**Scenario 1: Duplicate Detection (Happy Path)**
```
Input: /inbound/vendor-invoice-001.xlsx
Flow:
  Observation 1 (1024 bytes) → FILE_DETECTED
  Wait 35 seconds (simulated)
  Observation 2 (1024 bytes, stable) → FILE_STABLE
  Observation 3 (same file again) → FILE_DUPLICATE

Output:
  Processing observation 1: /inbound/vendor-invoice-001.xlsx (1024 bytes)
    → Event: FILE_DETECTED (batch: SA-034-20260716-001)
    → State saved to database

  Processing observation 2: /inbound/vendor-invoice-001.xlsx (1024 bytes, +35s)
    → Event: FILE_STABLE (batch: SA-034-20260716-001)
    → State updated: FILE_DETECTED → FILE_STABLE

  Processing observation 3: /inbound/vendor-invoice-001.xlsx (1024 bytes)
    → Event: FILE_DUPLICATE (batch: SA-034-20260716-001)
    → State updated: FILE_STABLE → FILE_DUPLICATE

  Final state in database:
    Interface: SA-034
    File: /inbound/vendor-invoice-001.xlsx
    Status: FILE_DUPLICATE
    Batch: SA-034-20260716-001
    First detected: 2026-07-16T10:00:00Z
```

**Scenario 2: Stuck File**
```
Input: /inbound/stuck-file.xlsx
Flow:
  Observation 1 (2048 bytes) → FILE_DETECTED
  Wait 90 minutes (exceeds stuckThresholdMinutes: 60)
  Observation 2 (2048 bytes, no size change) → FILE_STUCK

Output:
  Processing observation 1: /inbound/stuck-file.xlsx (2048 bytes)
    → Event: FILE_DETECTED (batch: SA-034-20260716-002)
    → State saved to database

  Processing observation 2: /inbound/stuck-file.xlsx (2048 bytes, +90min)
    → Event: FILE_STUCK (batch: SA-034-20260716-002)
    → State updated: FILE_DETECTED → FILE_STUCK

  Final state in database:
    Interface: SA-034
    File: /inbound/stuck-file.xlsx
    Status: FILE_STUCK
    Batch: SA-034-20260716-002
```

**Scenario 3: Missing by SLA**
```
Input: No file (expected file never arrived)
Flow:
  checkMissingSla() called after slaDeadline
  No watcher_state rows exist for today's window
  → FILE_MISSING_BY_SLA

Output:
  Checking for missing files (SLA deadline: 2026-07-16T18:00:00Z)
    → Event: FILE_MISSING_BY_SLA (batch: SA-034-20260716-SLA)
    → Expected file never arrived

  Final state in database:
    Interface: SA-034
    File: __sla_window__ (sentinel)
    Status: FILE_MISSING_BY_SLA
    Batch: SA-034-20260716-SLA
```

**npm script:** Add to `apps/watcher/package.json`:
```json
{
  "scripts": {
    "demo": "ts-node src/demo/engine-demo.ts"
  }
}
```

**Prerequisites:**
- Database running (Docker Compose up)
- Migrations applied (`npm run migrate:up`)
- Test fixtures loaded (interface_config row for SA-034)

**Error handling:**
```typescript
try {
  await main();
} catch (error) {
  console.error('❌ Demo failed:', error.message);
  console.error('');
  console.error('Prerequisites:');
  console.error('  1. Database running: docker compose -f infrastructure/compose/docker-compose.yml up -d');
  console.error('  2. Migrations applied: cd apps/watcher && npm run migrate:up');
  console.error('  3. Test fixtures loaded: npm run seed-fixtures (if exists)');
  process.exit(1);
}
```

## Error Handling

**Fail-fast principle** - throw immediately when something goes wrong, don't try to recover.

**Integration layer:**
- Database connection errors → throw (let caller handle)
- State save failures → throw (transaction rollback in DatabaseClient)
- Invalid state transitions → throw InvalidStateTransitionError (already implemented)
- Missing interface config → throw with clear error message

**Demo script:**
- Catches top-level errors
- Shows clear error message with prerequisites
- Exits with non-zero code

**Integration tests:**
- Let errors bubble to test runner (fail test on error)
- No try/catch in tests (want failures to be loud)

**No retry logic** - matches Engine's fail-fast design. Caller (future Scheduler) decides retry strategy.

## Testing Strategy

### Existing Tests (Unchanged)

**Engine unit tests:**
- Use InMemoryStateRepository
- Fast, isolated, no database dependency
- Keep as-is (no modifications)

**Database repository unit tests:**
- Mock DatabaseClient
- Verify SQL correctness
- Keep as-is

**Database integration tests:**
- Use real Postgres
- Verify CRUD operations
- Keep as-is

### New Integration Tests

**Purpose:** Fill gap - verify Engine + Postgres work together

**What's being tested:**
- Engine's processObservation persists state to real database
- Subsequent calls load previous state correctly
- State transitions work with real constraints
- Upsert behavior (INSERT ON CONFLICT) works in practice
- checkMissingSla queries real database

**What's NOT re-tested:**
- Engine rule logic (already tested in Engine unit tests)
- SQL correctness (already tested in Database unit tests)
- Individual repository methods (already tested)

**Focus:** Integration points, real database constraints, end-to-end flow.

### Test Isolation

**Per-test setup:**
```typescript
beforeEach(async () => {
  const db = DatabaseClient.getInstance();
  await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
  // Seed interface_config, connection_config from fixtures
  await seedInterfaceConfig('SA-034');
});
```

**Cleanup:**
```typescript
afterAll(async () => {
  await DatabaseClient.getInstance().close();
});
```

**No test data leakage** - TRUNCATE ensures clean state between tests.

## File Structure

```
apps/watcher/
├── src/
│   ├── demo/
│   │   └── engine-demo.ts              # NEW: Demo script
│   ├── engine/
│   │   └── (existing, no changes)
│   └── database/
│       └── (existing, no changes)
├── test/
│   ├── integration/
│   │   ├── engine/
│   │   │   └── engine-with-postgres.integration.test.ts  # NEW
│   │   └── database/
│   │       └── (existing, no changes)
│   └── fixtures/
│       └── (existing, reused)
└── package.json                        # Modified: add "demo" script
```

## Deliverables

**Files to create:**
1. `apps/watcher/test/integration/engine/engine-with-postgres.integration.test.ts`
2. `apps/watcher/src/demo/engine-demo.ts`

**Files to modify:**
1. `apps/watcher/package.json` - Add `"demo": "ts-node src/demo/engine-demo.ts"` script

**Dependencies:**
- All already installed (ts-node, vitest, pg, node-pg-migrate)
- No new npm packages needed

**Test coverage:**
- 7 new integration tests
- Demo covers all 5 file states

## Out of Scope

**NOT included in this work:**
- Scheduler/orchestrator (production entry point)
- Adapter implementations (SFTP, Blob, SharePoint, Folder)
- Gateway integration (event sender)
- Config management UI
- Production deployment configuration
- Performance optimization
- Monitoring/observability instrumentation

**This work proves:** Engine + Database integration works. Foundation for building Scheduler next.

## Success Criteria

1. All integration tests pass with real Postgres
2. Demo script runs successfully, shows all 5 file states
3. State persists across processObservation calls
4. Database constraints enforced (unique constraint, foreign keys)
5. No Engine or Database code changes required
6. Existing tests continue to pass
