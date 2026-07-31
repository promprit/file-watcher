# Watcher Database Infrastructure — Design Spec

> **⚠️ SUPERSEDED (2026-07-17):** the architecture pivoted to a D365-native build (Dataverse + Power Platform); this component's production role is replaced per the [D365-native design spec](2026-07-17-d365-native-architecture-design.md). The TypeScript implementation described here remains in-repo as part of the frozen executable reference spec.

**Date:** 2026-07-15
**Status:** Approved
**Related:** [docs/monorepo-architecture.md](../../monorepo-architecture.md), [docs/superpowers/specs/2026-07-15-watcher-engine-design.md](2026-07-15-watcher-engine-design.md)

## Context

Watcher Engine design spec defines `StateRepository` interface but uses in-memory fake implementation. Engine needs real Postgres-backed state persistence. Scheduler and Adapters need interface/connection configuration from database.

This spec covers:
- Watcher database schema (`watcher_schema`)
- Migration framework (`node-pg-migrate`)
- Database client (connection pooling)
- Repository implementations: `StateRepository`, `InterfaceConfigRepository`, `ConnectionConfigRepository`

Out of scope:
- Gateway database (separate spec)
- Secret Provider implementation (separate component)
- Scheduler/Adapter logic (use these repositories, don't define them)

## Architecture Decisions

### 1. Separate Schema

**Decision:** Use `watcher_schema` in Postgres, not public schema.

**Rationale:**
- Architecture doc: "Development: Same PostgreSQL server, separate schemas"
- Clean namespace isolation from Gateway
- Independent permission grants
- Easy to move to separate database in production
- Matches "Watcher and Gateway own separate DB schemas" principle

### 2. Raw SQL Migration Framework

**Decision:** `node-pg-migrate` with raw SQL files, not ORM.

**Rationale:**
- Project uses `pg` directly, no ORM
- Full control over DDL (indexes, constraints, schemas)
- Explicit migrations match project philosophy (Watcher Engine uses explicit interfaces)
- Lightweight (no code generation magic)
- SQL is SQL - easy to review
- Battle-tested

**Alternatives rejected:**
- TypeORM/Prisma: Heavy, adds ORM overhead, code generation, schema drift risk
- Custom runner: Lacks migration tracking/rollback

### 3. Thin Repository Layer

**Decision:** Repositories are thin wrappers around parameterized SQL queries.

**Rationale:**
- Simple, explicit SQL
- Minimal abstraction
- Easy to debug
- Fast
- Matches project style (engine uses interfaces, not classes/ORM)

**Alternatives rejected:**
- Query builder: More code, another abstraction layer, overkill for CRUD
- Domain models: Heavier objects, requires mapping, overkill for data-centric operations

### 4. Fail-Fast Error Handling

**Decision:** Repositories throw on errors, no catch/retry.

**Rationale:**
- Matches Watcher Engine design: "Fail-fast error handling throughout"
- Caller (Scheduler/Engine) decides retry logic
- Repository responsibility: data access, not resilience

## Database Schema

### Schema: `watcher_schema`

Three tables:
1. `interface_config` - what to watch (monitoring rules per interface)
2. `connection_config` - how to connect (reusable connection metadata)
3. `watcher_state` - file lifecycle operational state

### Table: interface_config

Stores per-interface monitoring configuration.

```sql
CREATE TABLE watcher_schema.interface_config (
  interface_id VARCHAR(50) PRIMARY KEY,
  interface_name VARCHAR(255) NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  target_system VARCHAR(100) NOT NULL,
  connection_ref VARCHAR(100) NOT NULL,
  inbound_path TEXT NOT NULL,
  file_pattern VARCHAR(255) NOT NULL,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  readiness_rule VARCHAR(50) NOT NULL DEFAULT 'STABLE_SIZE',
  stability_check_seconds INTEGER NOT NULL DEFAULT 30,
  duplicate_check_enabled BOOLEAN NOT NULL DEFAULT true,
  stuck_threshold_minutes INTEGER,
  expected_schedule VARCHAR(100),
  sla_threshold_minutes INTEGER,
  alert_owner VARCHAR(255),
  enabled_flag BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interface_config_connection_ref
  ON watcher_schema.interface_config(connection_ref);
CREATE INDEX idx_interface_config_enabled
  ON watcher_schema.interface_config(enabled_flag)
  WHERE enabled_flag = true;
```

**Key fields:**
- `interface_id` (PK) - unique identifier (e.g., "SA-034")
- `connection_ref` - references `connection_config.connection_ref` (logical FK, not enforced)
- `inbound_path` - folder/prefix to watch
- `file_pattern` - regex or glob pattern
- `poll_interval_seconds` - how often to check
- `readiness_rule` - STABLE_SIZE, DONE_MARKER, etc.
- `stability_check_seconds` - how long size must remain unchanged
- `stuck_threshold_minutes` - max time in active state before FILE_STUCK
- `expected_schedule` - cron expression or time window for SLA
- `sla_threshold_minutes` - grace period after expected time
- `enabled_flag` - soft delete/disable

**Indexes:**
- `connection_ref` - Scheduler loads interfaces by connection
- `enabled_flag` - Scheduler loads only enabled interfaces

**No foreign key constraint on `connection_ref`:** Allows loading configs independently, simpler migrations, avoids cascade complexity.

### Table: connection_config

Stores reusable connection metadata (non-secret).

```sql
CREATE TABLE watcher_schema.connection_config (
  connection_ref VARCHAR(100) PRIMARY KEY,
  storage_type VARCHAR(50) NOT NULL,
  environment VARCHAR(50) NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  port INTEGER,
  username VARCHAR(255),
  authentication_type VARCHAR(50) NOT NULL,
  credential_ref VARCHAR(255),
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  enabled_flag BOOLEAN NOT NULL DEFAULT true,
  owner VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connection_config_storage_type
  ON watcher_schema.connection_config(storage_type);
CREATE INDEX idx_connection_config_enabled
  ON watcher_schema.connection_config(enabled_flag)
  WHERE enabled_flag = true;
```

**Key fields:**
- `connection_ref` (PK) - unique identifier (e.g., "sftp-agdoc-prod")
- `storage_type` - SFTP, AZURE_BLOB, SHAREPOINT, NETWORK_FOLDER
- `endpoint` - host, URL, or base path
- `port` - TCP port (nullable for non-TCP connections)
- `username` - username if applicable (nullable)
- `authentication_type` - PASSWORD, PRIVATE_KEY, MANAGED_IDENTITY, etc.
- `credential_ref` - pointer to secret in Secret Provider (NOT the actual secret)
- `timeout_seconds` - connection/operation timeout

**Security principle:** `credential_ref` is a pointer/key, NOT the actual secret. Secret Provider resolves it at runtime.

Example:
```
connection_ref: "sftp-agdoc-prod"
endpoint: "sftp.agdoc.com"
port: 22
username: "integration_user"
authentication_type: "PRIVATE_KEY"
credential_ref: "sftp-agdoc-key"  ← points to secret backend
```

Secret Provider:
```
credential_ref: "sftp-agdoc-key"
  → Secret Backend (env vars / Key Vault)
  → Actual private key contents
```

**One connection, many interfaces:**
```
connection_ref: "sftp-agdoc-prod"
  → interface SA-023: /ag-doc/sales-order/inbound/
  → interface SA-034: /ag-doc/vendor-invoice/inbound/
  → interface SA-036: /ag-doc/sales-price/inbound/
```

### Table: watcher_state

Stores current file lifecycle state (snapshot, not history log).

```sql
CREATE TABLE watcher_schema.watcher_state (
  state_id BIGSERIAL PRIMARY KEY,
  interface_id VARCHAR(50) NOT NULL,
  batch_id VARCHAR(100) NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  file_name VARCHAR(500) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  previous_status VARCHAR(50),
  current_status VARCHAR(50) NOT NULL,
  status_changed_at TIMESTAMPTZ NOT NULL,
  first_detected_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(interface_id, file_path)
);

CREATE INDEX idx_watcher_state_interface
  ON watcher_schema.watcher_state(interface_id);
CREATE INDEX idx_watcher_state_status
  ON watcher_schema.watcher_state(current_status);
CREATE INDEX idx_watcher_state_batch
  ON watcher_schema.watcher_state(batch_id);
CREATE INDEX idx_watcher_state_status_changed
  ON watcher_schema.watcher_state(status_changed_at);
```

**Key fields:**
- `state_id` (PK) - surrogate key
- `interface_id` + `file_path` - natural key (unique constraint)
- `batch_id` - unique identifier for this file run (generated by engine)
- `file_path` - full path (adapter-specific format)
- `file_name` - filename only
- `file_size_bytes` - last observed size
- `previous_status` - previous state (for transition tracking)
- `current_status` - current state (FILE_DETECTED, FILE_STABLE, FILE_DUPLICATE, FILE_STUCK, FILE_MISSING_BY_SLA)
- `status_changed_at` - when current_status was set
- `first_detected_at` - when file first appeared
- `last_seen_at` - last observation time (updated every poll)

**Indexes:**
- `interface_id` - Engine queries by interface
- `current_status` - Stuck-file detection queries active states
- `batch_id` - Event correlation
- `status_changed_at` - Time-based queries (SLA, stuck detection)

**Snapshot semantics:**
- Stores current state only (`current_status`, `previous_status`)
- No history log of all transitions
- Durable audit trail is Gateway's `event_outbox` (every meaningful state change emits FileEvent sent downstream)
- Watcher-side history logging explicitly deferred

**Unique constraint on (interface_id, file_path):**
- Prevents duplicate state rows for same file
- Engine updates existing row on subsequent observations
- Upsert pattern: INSERT ON CONFLICT UPDATE

**Missing-SLA sentinel row:**
Watcher Engine plan uses sentinel row for SLA idempotency:
```
interface_id: "SA-034"
file_path: "__sla_window__"
current_status: "FILE_MISSING_BY_SLA"
```

Prevents re-emitting FILE_MISSING_BY_SLA every poll cycle after deadline.

## Migration Framework

### Tool: node-pg-migrate

**Why node-pg-migrate:**
- Lightweight, no ORM dependency
- Raw SQL migrations (full DDL control)
- Up/down in single file
- Transaction support (atomic migrations)
- Migration tracking table (`pgmigrations`)
- CLI + programmatic API

**Installation:**
```bash
npm install node-pg-migrate pg
npm install --save-dev @types/node
```

### Migration File Structure

**Location:** `apps/watcher/src/database/migrations/`

**Naming:** `{timestamp}_{description}.sql` (or `.js` for programmatic migrations)

**Order:**
```
001_create_watcher_schema.sql
002_create_interface_config_table.sql
003_create_connection_config_table.sql
004_create_watcher_state_table.sql
```

**Format (SQL):**
```sql
-- Up Migration
CREATE TABLE watcher_schema.example (...);

-- Down Migration
DROP TABLE watcher_schema.example;
```

**Format (JavaScript):**
```javascript
exports.up = (pgm) => {
  pgm.createTable('watcher_schema.example', { ... });
};

exports.down = (pgm) => {
  pgm.dropTable('watcher_schema.example');
};
```

### Migration Commands

**package.json scripts:**
```json
{
  "scripts": {
    "migrate:up": "node-pg-migrate up --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:down": "node-pg-migrate down --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:create": "node-pg-migrate create --migrations-dir src/database/migrations"
  }
}
```

**Usage:**
```bash
npm run migrate:up              # Apply pending migrations
npm run migrate:down            # Rollback last migration
npm run migrate:create add_field_to_config  # Create new migration
```

**Configuration:**
Reads `DATABASE_URL` environment variable:
```
DATABASE_URL=postgres://user:password@localhost:5432/integration_db
```

**Tracking:**
- Migrations recorded in `pgmigrations` table (public schema)
- Stores: migration name, applied timestamp
- Only applies pending migrations (not already in tracking table)

**Transaction semantics:**
- Each migration runs in transaction (COMMIT on success, ROLLBACK on error)
- Entire migration succeeds or fails atomically

### Migration 001: Create Schema

```sql
-- Up
CREATE SCHEMA IF NOT EXISTS watcher_schema;

-- Down
DROP SCHEMA IF EXISTS watcher_schema CASCADE;
```

### Migration 002: Interface Config Table

```sql
-- Up
CREATE TABLE watcher_schema.interface_config (
  interface_id VARCHAR(50) PRIMARY KEY,
  interface_name VARCHAR(255) NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  target_system VARCHAR(100) NOT NULL,
  connection_ref VARCHAR(100) NOT NULL,
  inbound_path TEXT NOT NULL,
  file_pattern VARCHAR(255) NOT NULL,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  readiness_rule VARCHAR(50) NOT NULL DEFAULT 'STABLE_SIZE',
  stability_check_seconds INTEGER NOT NULL DEFAULT 30,
  duplicate_check_enabled BOOLEAN NOT NULL DEFAULT true,
  stuck_threshold_minutes INTEGER,
  expected_schedule VARCHAR(100),
  sla_threshold_minutes INTEGER,
  alert_owner VARCHAR(255),
  enabled_flag BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interface_config_connection_ref
  ON watcher_schema.interface_config(connection_ref);
CREATE INDEX idx_interface_config_enabled
  ON watcher_schema.interface_config(enabled_flag)
  WHERE enabled_flag = true;

-- Down
DROP TABLE IF EXISTS watcher_schema.interface_config;
```

### Migration 003: Connection Config Table

```sql
-- Up
CREATE TABLE watcher_schema.connection_config (
  connection_ref VARCHAR(100) PRIMARY KEY,
  storage_type VARCHAR(50) NOT NULL,
  environment VARCHAR(50) NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  port INTEGER,
  username VARCHAR(255),
  authentication_type VARCHAR(50) NOT NULL,
  credential_ref VARCHAR(255),
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  enabled_flag BOOLEAN NOT NULL DEFAULT true,
  owner VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connection_config_storage_type
  ON watcher_schema.connection_config(storage_type);
CREATE INDEX idx_connection_config_enabled
  ON watcher_schema.connection_config(enabled_flag)
  WHERE enabled_flag = true;

-- Down
DROP TABLE IF EXISTS watcher_schema.connection_config;
```

### Migration 004: Watcher State Table

```sql
-- Up
CREATE TABLE watcher_schema.watcher_state (
  state_id BIGSERIAL PRIMARY KEY,
  interface_id VARCHAR(50) NOT NULL,
  batch_id VARCHAR(100) NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  file_name VARCHAR(500) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  previous_status VARCHAR(50),
  current_status VARCHAR(50) NOT NULL,
  status_changed_at TIMESTAMPTZ NOT NULL,
  first_detected_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(interface_id, file_path)
);

CREATE INDEX idx_watcher_state_interface
  ON watcher_schema.watcher_state(interface_id);
CREATE INDEX idx_watcher_state_status
  ON watcher_schema.watcher_state(current_status);
CREATE INDEX idx_watcher_state_batch
  ON watcher_schema.watcher_state(batch_id);
CREATE INDEX idx_watcher_state_status_changed
  ON watcher_schema.watcher_state(status_changed_at);

-- Down
DROP TABLE IF EXISTS watcher_schema.watcher_state;
```

## Database Client

### Singleton Pool Pattern

**File:** `apps/watcher/src/database/client.ts`

**Responsibilities:**
- Create connection pool on first use
- Expose query methods
- Provide transaction support
- Handle pool lifecycle (shutdown)

**Interface:**
```typescript
export class DatabaseClient {
  private static instance: DatabaseClient;
  private pool: Pool;

  private constructor();

  static getInstance(): DatabaseClient;

  async query<T>(sql: string, params?: any[]): Promise<T[]>;
  async queryOne<T>(sql: string, params?: any[]): Promise<T | null>;
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  async close(): Promise<void>;
}
```

**Pool configuration:**
```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,           // max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

**Error handling:**
- Throws on connection errors (no retry)
- Throws on query errors (no retry)
- Caller decides retry logic

**Transaction example:**
```typescript
await client.transaction(async (txClient) => {
  await txClient.query('UPDATE watcher_state SET status = $1', ['FILE_STABLE']);
  await txClient.query('INSERT INTO audit_log ...', [...]);
  // COMMIT on success, ROLLBACK on throw
});
```

## Repository Implementations

### Base Structure

All repositories:
- Use `DatabaseClient.getInstance()`
- Throw on errors (no catch/retry)
- Use parameterized queries ($1, $2, etc.)
- Return plain objects (no classes)

**Common pattern:**
```typescript
export class SomeRepository {
  private db = DatabaseClient.getInstance();

  async findById(id: string): Promise<SomeType | null> {
    const sql = 'SELECT * FROM watcher_schema.some_table WHERE id = $1';
    return this.db.queryOne<SomeType>(sql, [id]);
  }
}
```

### StateRepository

**File:** `apps/watcher/src/state/state-repository.ts`

**Implements:** Watcher Engine's `StateRepository` interface

```typescript
import { StateRepository, WatcherState } from '@packages/contracts';

export class PostgresStateRepository implements StateRepository {
  private db = DatabaseClient.getInstance();

  async get(interfaceId: string, filePath: string): Promise<WatcherState | null> {
    const sql = `
      SELECT state_id, interface_id, batch_id, file_path, file_name,
             file_size_bytes, previous_status, current_status,
             status_changed_at, first_detected_at, last_seen_at,
             created_at, updated_at
      FROM watcher_schema.watcher_state
      WHERE interface_id = $1 AND file_path = $2
    `;
    return this.db.queryOne<WatcherState>(sql, [interfaceId, filePath]);
  }

  async save(state: WatcherState): Promise<void> {
    const sql = `
      INSERT INTO watcher_schema.watcher_state (
        interface_id, batch_id, file_path, file_name, file_size_bytes,
        previous_status, current_status, status_changed_at,
        first_detected_at, last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (interface_id, file_path)
      DO UPDATE SET
        batch_id = EXCLUDED.batch_id,
        file_name = EXCLUDED.file_name,
        file_size_bytes = EXCLUDED.file_size_bytes,
        previous_status = EXCLUDED.previous_status,
        current_status = EXCLUDED.current_status,
        status_changed_at = EXCLUDED.status_changed_at,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW()
    `;
    await this.db.query(sql, [
      state.interfaceId,
      state.batchId,
      state.filePath,
      state.fileName,
      state.fileSizeBytes,
      state.previousStatus,
      state.currentStatus,
      state.statusChangedAt,
      state.firstDetectedAt,
      state.lastSeenAt
    ]);
  }

  async findByInterface(interfaceId: string): Promise<WatcherState[]> {
    const sql = `
      SELECT state_id, interface_id, batch_id, file_path, file_name,
             file_size_bytes, previous_status, current_status,
             status_changed_at, first_detected_at, last_seen_at,
             created_at, updated_at
      FROM watcher_schema.watcher_state
      WHERE interface_id = $1
      ORDER BY status_changed_at DESC
    `;
    return this.db.query<WatcherState>(sql, [interfaceId]);
  }
}
```

**Upsert pattern:** `INSERT ... ON CONFLICT ... DO UPDATE` handles both new files and updates atomically.

**Engine compatibility:** Implements exact interface from `packages/contracts`, drop-in replacement for in-memory fake.

### InterfaceConfigRepository

**File:** `apps/watcher/src/config/interface-config.repository.ts`

```typescript
import { InterfaceConfig } from '@packages/contracts';

export class InterfaceConfigRepository {
  private db = DatabaseClient.getInstance();

  async findAll(enabledOnly: boolean = false): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT interface_id, interface_name, source_system, target_system,
             connection_ref, inbound_path, file_pattern, poll_interval_seconds,
             readiness_rule, stability_check_seconds, duplicate_check_enabled,
             stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
             alert_owner, enabled_flag, created_at, updated_at
      FROM watcher_schema.interface_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql);
  }

  async findById(interfaceId: string): Promise<InterfaceConfig | null> {
    const sql = `
      SELECT interface_id, interface_name, source_system, target_system,
             connection_ref, inbound_path, file_pattern, poll_interval_seconds,
             readiness_rule, stability_check_seconds, duplicate_check_enabled,
             stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
             alert_owner, enabled_flag, created_at, updated_at
      FROM watcher_schema.interface_config
      WHERE interface_id = $1
    `;
    return this.db.queryOne<InterfaceConfig>(sql, [interfaceId]);
  }

  async findByConnectionRef(connectionRef: string): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT interface_id, interface_name, source_system, target_system,
             connection_ref, inbound_path, file_pattern, poll_interval_seconds,
             readiness_rule, stability_check_seconds, duplicate_check_enabled,
             stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
             alert_owner, enabled_flag, created_at, updated_at
      FROM watcher_schema.interface_config
      WHERE connection_ref = $1
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql, [connectionRef]);
  }
}
```

**Usage:** Scheduler loads enabled interfaces via `findAll(true)`, passes to Adapters.

### ConnectionConfigRepository

**File:** `apps/watcher/src/config/connection-config.repository.ts`

```typescript
import { ConnectionConfig } from '@packages/contracts';

export class ConnectionConfigRepository {
  private db = DatabaseClient.getInstance();

  async findByRef(connectionRef: string): Promise<ConnectionConfig | null> {
    const sql = `
      SELECT connection_ref, storage_type, environment, endpoint, port,
             username, authentication_type, credential_ref, timeout_seconds,
             enabled_flag, owner, created_at, updated_at
      FROM watcher_schema.connection_config
      WHERE connection_ref = $1
    `;
    return this.db.queryOne<ConnectionConfig>(sql, [connectionRef]);
  }

  async findAll(enabledOnly: boolean = false): Promise<ConnectionConfig[]> {
    const sql = `
      SELECT connection_ref, storage_type, environment, endpoint, port,
             username, authentication_type, credential_ref, timeout_seconds,
             enabled_flag, owner, created_at, updated_at
      FROM watcher_schema.connection_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY connection_ref
    `;
    return this.db.query<ConnectionConfig>(sql);
  }
}
```

**Usage:** Connection Manager loads connection by `connection_ref`, passes `credential_ref` to Secret Provider, builds runtime connection context.

## Testing Strategy

### Unit Tests

**Repository query logic (mocked pool):**
- `StateRepository.get()` returns correct row
- `StateRepository.save()` upserts correctly
- `InterfaceConfigRepository.findAll(enabledOnly=true)` filters correctly
- `ConnectionConfigRepository.findByRef()` parameterizes correctly
- Error handling (pool throws, repository re-throws)

**Mocking:**
```typescript
const mockPool = {
  query: vi.fn(),
};
DatabaseClient['pool'] = mockPool;
```

**Framework:** Vitest (matches Watcher Engine plan)

### Integration Tests

**Real Postgres (test database):**
- Migration up creates all tables
- Migration down drops all tables
- Repository CRUD round-trip (insert, read, update, delete)
- Unique constraint violations (duplicate interface_id, duplicate batch_id)
- Transaction rollback on error
- Concurrent access (pool exhaustion, connection reuse)
- Upsert conflict handling (`ON CONFLICT DO UPDATE`)

**Test database:**
```
DATABASE_URL=postgres://user:password@localhost:5432/integration_db_test
```

**Setup:**
```typescript
beforeAll(async () => {
  await runMigrations('up');
});

afterAll(async () => {
  await runMigrations('down');
  await DatabaseClient.getInstance().close();
});

beforeEach(async () => {
  await truncateAllTables();
});
```

**Fixtures:**
- `fixtures/interface-configs.json` - sample interface configs
- `fixtures/connection-configs.json` - sample connection configs
- `fixtures/watcher-states.json` - sample states (various statuses)

**Test coverage:**
- Happy path CRUD
- Edge cases (empty result, null values)
- Constraints (unique violations, not-null violations)
- Indexes (query plans use indexes)
- Transactions (commit on success, rollback on error)

## Dependencies

**npm packages:**
```json
{
  "dependencies": {
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "node-pg-migrate": "^6.2.0",
    "@types/pg": "^8.10.0",
    "vitest": "^1.0.0"
  }
}
```

**Type contracts:** Depends on `packages/contracts` having:
- `WatcherState` interface
- `StateRepository` interface
- `InterfaceConfig` interface
- `ConnectionConfig` interface

Watcher Engine implementation plan (Task 2) creates these contracts. This work starts after contracts exist.

## MVP Scope

**Include:**
- `watcher_schema` with 3 tables
- 4 migrations (schema + 3 tables)
- `DatabaseClient` singleton with pooling
- `StateRepository` (Postgres implementation of engine interface)
- `InterfaceConfigRepository`
- `ConnectionConfigRepository`
- Unit tests (mocked)
- Integration tests (real Postgres)

**Defer:**
- Gateway database (separate spec)
- Config UI (manual SQL inserts for MVP)
- Seed data scripts (test fixtures sufficient)
- Connection pooling tuning (use defaults)
- Read replicas
- Database monitoring/alerts

## Success Criteria

1. Migrations create `watcher_schema` and 3 tables
2. `StateRepository` implements engine interface
3. Repositories perform CRUD operations
4. Upsert handles conflicts correctly
5. Unit tests pass (mocked pool)
6. Integration tests pass (real Postgres)
7. No secrets in database tables
8. Watcher Engine can swap in-memory fake for Postgres implementation (drop-in replacement)

## Security Considerations

**Secrets:**
- `credential_ref` is a pointer, NOT actual secret
- Secret Provider resolves `credential_ref` at runtime
- No passwords, keys, tokens in database
- Connection string in `DATABASE_URL` environment variable (not code)

**Database permissions:**
- Watcher application user: CONNECT on database, USAGE on `watcher_schema`, SELECT/INSERT/UPDATE on tables
- Migration runner: CREATE on database, ALL on `watcher_schema`
- No DROP permissions in application runtime

**SQL injection:**
- All queries use parameterized placeholders ($1, $2, etc.)
- No string concatenation
- No dynamic table/column names

## Future Enhancements

**Performance:**
- Connection pool tuning based on load
- Read replicas for queries
- Partitioning `watcher_state` by time

**Observability:**
- Query performance logging
- Slow query alerts
- Connection pool metrics

**Operations:**
- Seed data scripts
- Backup/restore procedures
- Database monitoring dashboards

**Schema evolution:**
- Add columns without downtime (nullable first, backfill, NOT NULL later)
- Online index creation
- Blue/green migration strategy
