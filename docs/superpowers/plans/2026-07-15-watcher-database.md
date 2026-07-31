# Watcher Database Infrastructure Implementation Plan

> **⚠️ HISTORICAL (2026-07-17):** this plan was executed against the TypeScript reference implementation. The production architecture has since pivoted to a D365-native build — see [2026-07-17-d365-native-implementation.md](2026-07-17-d365-native-implementation.md) and the [D365-native design spec](../specs/2026-07-17-d365-native-architecture-design.md). The code this plan produced is now part of the frozen executable reference spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Watcher database infrastructure with migrations, connection pooling, and three repositories (StateRepository, InterfaceConfigRepository, ConnectionConfigRepository).

**Architecture:** Separate `watcher_schema` in Postgres, `node-pg-migrate` for raw SQL migrations, thin repository layer with parameterized queries, singleton connection pool.

**Tech Stack:** TypeScript (strict), node-pg-migrate, pg (PostgreSQL client), Vitest

**Source spec:** [`docs/superpowers/specs/2026-07-15-watcher-database-design.md`](../specs/2026-07-15-watcher-database-design.md)

## Global Constraints

- Node >=18, TypeScript strict mode
- Database: PostgreSQL 15+, `watcher_schema` for namespace isolation
- Migration tool: `node-pg-migrate` (raw SQL migrations)
- Repository pattern: thin wrappers around parameterized SQL (no ORM, no query builder)
- Error handling: fail-fast (throw on errors, no catch/retry)
- Testing: Vitest for unit tests, real Postgres for integration tests
- `DATABASE_URL` environment variable for connection string
- Depends on `packages/contracts` having `WatcherState`, `StateRepository`, `InterfaceConfig`, `ConnectionConfig` types (created by Watcher Engine Task 2)

---

## File Structure Overview

```
apps/watcher/
├── src/
│   ├── database/
│   │   ├── client.ts                    # Singleton connection pool
│   │   ├── migrations/
│   │   │   ├── 1721000001_create_watcher_schema.js
│   │   │   ├── 1721000002_create_interface_config_table.js
│   │   │   ├── 1721000003_create_connection_config_table.js
│   │   │   └── 1721000004_create_watcher_state_table.js
│   │   └── repositories/
│   │       ├── interface-config.repository.ts
│   │       ├── connection-config.repository.ts
│   │       └── state.repository.ts      # Implements StateRepository interface
│   └── config/
│       └── (repositories live in database/ for cohesion)
├── test/
│   ├── unit/
│   │   └── database/
│   │       ├── state.repository.test.ts
│   │       ├── interface-config.repository.test.ts
│   │       └── connection-config.repository.test.ts
│   ├── integration/
│   │   └── database/
│   │       ├── migrations.test.ts
│   │       ├── state.repository.integration.test.ts
│   │       ├── interface-config.repository.integration.test.ts
│   │       └── connection-config.repository.integration.test.ts
│   └── fixtures/
│       ├── interface-configs.json
│       ├── connection-configs.json
│       └── watcher-states.json
├── package.json
└── tsconfig.json
```

---

### Task 1: Migration Framework Setup

**Files:**
- Modify: `apps/watcher/package.json`
- Create: `apps/watcher/src/database/migrations/1721000001_create_watcher_schema.js`
- Create: `apps/watcher/.env.example`

**Interfaces:**
- Consumes: None
- Produces: `node-pg-migrate` installed, migration commands in package.json, first migration file

- [ ] **Step 1: Install node-pg-migrate**

Run:
```bash
cd apps/watcher
npm init -y
npm install pg
npm install --save-dev node-pg-migrate @types/node @types/pg typescript vitest
```

Expected: `package.json` created with dependencies

- [ ] **Step 2: Add migration scripts to package.json**

Edit `apps/watcher/package.json`, add scripts:

```json
{
  "name": "@apps/watcher",
  "version": "0.1.0",
  "scripts": {
    "migrate:up": "node-pg-migrate up --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:down": "node-pg-migrate down --database-url-var DATABASE_URL --migrations-dir src/database/migrations",
    "migrate:create": "node-pg-migrate create --migrations-dir src/database/migrations",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "node-pg-migrate": "^6.2.0",
    "@types/node": "^20.0.0",
    "@types/pg": "^8.10.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `apps/watcher/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Create .env.example**

Create `apps/watcher/.env.example`:

```
DATABASE_URL=postgres://user:password@localhost:5432/integration_db
```

- [ ] **Step 5: Create migrations directory**

Run:
```bash
mkdir -p apps/watcher/src/database/migrations
```

Expected: Directory created

- [ ] **Step 6: Create first migration (schema creation)**

Create `apps/watcher/src/database/migrations/1721000001_create_watcher_schema.js`:

```javascript
exports.up = (pgm) => {
  pgm.createSchema('watcher_schema', {
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropSchema('watcher_schema', {
    ifExists: true,
    cascade: true,
  });
};
```

- [ ] **Step 7: Test migration up**

Run:
```bash
cp apps/watcher/.env.example apps/watcher/.env
npm run migrate:up
```

Expected: Migration applies successfully, `watcher_schema` created

- [ ] **Step 8: Test migration down**

Run:
```bash
npm run migrate:down
```

Expected: Migration rolls back, `watcher_schema` dropped

- [ ] **Step 9: Reapply migration for next tasks**

Run:
```bash
npm run migrate:up
```

Expected: Schema recreated

- [ ] **Step 10: Commit migration framework**

Run:
```bash
git add apps/watcher/package.json apps/watcher/tsconfig.json apps/watcher/.env.example apps/watcher/src/database/migrations/
git commit -m "feat(watcher): add migration framework with node-pg-migrate

- Install node-pg-migrate and dependencies
- Add migration scripts to package.json
- Create first migration for watcher_schema
- Add .env.example for DATABASE_URL"
```

---

### Task 2: Database Schema Migrations

**Files:**
- Create: `apps/watcher/src/database/migrations/1721000002_create_interface_config_table.js`
- Create: `apps/watcher/src/database/migrations/1721000003_create_connection_config_table.js`
- Create: `apps/watcher/src/database/migrations/1721000004_create_watcher_state_table.js`

**Interfaces:**
- Consumes: `watcher_schema` from Task 1
- Produces: Three tables: `interface_config`, `connection_config`, `watcher_state` with indexes

- [ ] **Step 1: Create interface_config migration**

Create `apps/watcher/src/database/migrations/1721000002_create_interface_config_table.js`:

```javascript
exports.up = (pgm) => {
  pgm.createTable('watcher_schema.interface_config', {
    interface_id: { type: 'varchar(50)', primaryKey: true },
    interface_name: { type: 'varchar(255)', notNull: true },
    source_system: { type: 'varchar(100)', notNull: true },
    target_system: { type: 'varchar(100)', notNull: true },
    connection_ref: { type: 'varchar(100)', notNull: true },
    inbound_path: { type: 'text', notNull: true },
    file_pattern: { type: 'varchar(255)', notNull: true },
    poll_interval_seconds: { type: 'integer', notNull: true, default: 60 },
    readiness_rule: { type: 'varchar(50)', notNull: true, default: "'STABLE_SIZE'" },
    stability_check_seconds: { type: 'integer', notNull: true, default: 30 },
    duplicate_check_enabled: { type: 'boolean', notNull: true, default: true },
    stuck_threshold_minutes: { type: 'integer' },
    expected_schedule: { type: 'varchar(100)' },
    sla_threshold_minutes: { type: 'integer' },
    alert_owner: { type: 'varchar(255)' },
    enabled_flag: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('watcher_schema.interface_config', 'connection_ref', {
    name: 'idx_interface_config_connection_ref',
  });

  pgm.createIndex('watcher_schema.interface_config', 'enabled_flag', {
    name: 'idx_interface_config_enabled',
    where: 'enabled_flag = true',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('watcher_schema.interface_config', {
    ifExists: true,
  });
};
```

- [ ] **Step 2: Create connection_config migration**

Create `apps/watcher/src/database/migrations/1721000003_create_connection_config_table.js`:

```javascript
exports.up = (pgm) => {
  pgm.createTable('watcher_schema.connection_config', {
    connection_ref: { type: 'varchar(100)', primaryKey: true },
    storage_type: { type: 'varchar(50)', notNull: true },
    environment: { type: 'varchar(50)', notNull: true },
    endpoint: { type: 'varchar(500)', notNull: true },
    port: { type: 'integer' },
    username: { type: 'varchar(255)' },
    authentication_type: { type: 'varchar(50)', notNull: true },
    credential_ref: { type: 'varchar(255)' },
    timeout_seconds: { type: 'integer', notNull: true, default: 30 },
    enabled_flag: { type: 'boolean', notNull: true, default: true },
    owner: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('watcher_schema.connection_config', 'storage_type', {
    name: 'idx_connection_config_storage_type',
  });

  pgm.createIndex('watcher_schema.connection_config', 'enabled_flag', {
    name: 'idx_connection_config_enabled',
    where: 'enabled_flag = true',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('watcher_schema.connection_config', {
    ifExists: true,
  });
};
```

- [ ] **Step 3: Create watcher_state migration**

Create `apps/watcher/src/database/migrations/1721000004_create_watcher_state_table.js`:

```javascript
exports.up = (pgm) => {
  pgm.createTable('watcher_schema.watcher_state', {
    state_id: { type: 'bigserial', primaryKey: true },
    interface_id: { type: 'varchar(50)', notNull: true },
    batch_id: { type: 'varchar(100)', notNull: true, unique: true },
    file_path: { type: 'text', notNull: true },
    file_name: { type: 'varchar(500)', notNull: true },
    file_size_bytes: { type: 'bigint', notNull: true },
    previous_status: { type: 'varchar(50)' },
    current_status: { type: 'varchar(50)', notNull: true },
    status_changed_at: { type: 'timestamptz', notNull: true },
    first_detected_at: { type: 'timestamptz', notNull: true },
    last_seen_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('watcher_schema.watcher_state', 'unique_interface_file', {
    unique: ['interface_id', 'file_path'],
  });

  pgm.createIndex('watcher_schema.watcher_state', 'interface_id', {
    name: 'idx_watcher_state_interface',
  });

  pgm.createIndex('watcher_schema.watcher_state', 'current_status', {
    name: 'idx_watcher_state_status',
  });

  pgm.createIndex('watcher_schema.watcher_state', 'batch_id', {
    name: 'idx_watcher_state_batch',
  });

  pgm.createIndex('watcher_schema.watcher_state', 'status_changed_at', {
    name: 'idx_watcher_state_status_changed',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('watcher_schema.watcher_state', {
    ifExists: true,
  });
};
```

- [ ] **Step 4: Run migrations**

Run:
```bash
npm run migrate:up
```

Expected: All three table migrations apply successfully

- [ ] **Step 5: Verify tables created**

Run:
```bash
psql $DATABASE_URL -c "\dt watcher_schema.*"
```

Expected: Shows three tables: interface_config, connection_config, watcher_state

- [ ] **Step 6: Verify indexes created**

Run:
```bash
psql $DATABASE_URL -c "\di watcher_schema.*"
```

Expected: Shows all indexes

- [ ] **Step 7: Commit schema migrations**

Run:
```bash
git add apps/watcher/src/database/migrations/
git commit -m "feat(watcher): add database schema migrations

- Create interface_config table with indexes
- Create connection_config table with indexes
- Create watcher_state table with indexes and unique constraint
- All tables in watcher_schema namespace"
```

---

### Task 3: Database Client (Connection Pool)

**Files:**
- Create: `apps/watcher/src/database/client.ts`
- Create: `apps/watcher/test/unit/database/client.test.ts`

**Interfaces:**
- Consumes: `pg` package, `DATABASE_URL` environment variable
- Produces: `DatabaseClient` class with methods:
  - `static getInstance(): DatabaseClient`
  - `query<T>(sql: string, params?: any[]): Promise<T[]>`
  - `queryOne<T>(sql: string, params?: any[]): Promise<T | null>`
  - `transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>`
  - `close(): Promise<void>`

- [ ] **Step 1: Write failing test for getInstance**

Create `apps/watcher/test/unit/database/client.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseClient } from '../../../src/database/client';

describe('DatabaseClient', () => {
  let client: DatabaseClient;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it('should return singleton instance', () => {
    const instance1 = DatabaseClient.getInstance();
    const instance2 = DatabaseClient.getInstance();
    expect(instance1).toBe(instance2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- client.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/database/client'"

- [ ] **Step 3: Write minimal DatabaseClient implementation**

Create `apps/watcher/src/database/client.ts`:

```typescript
import { Pool, PoolClient, QueryResult } from 'pg';

export class DatabaseClient {
  private static instance: DatabaseClient;
  private pool: Pool;

  private constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  static getInstance(): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient();
    }
    return DatabaseClient.instance;
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const result: QueryResult<T> = await this.pool.query(sql, params);
    return result.rows;
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    DatabaseClient.instance = null as any;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- client.test.ts
```

Expected: PASS

- [ ] **Step 5: Add query tests**

Add to `apps/watcher/test/unit/database/client.test.ts`:

```typescript
import { vi } from 'vitest';

describe('DatabaseClient', () => {
  // ... existing test

  it('should execute query and return rows', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [{ id: 1 }, { id: 2 }],
      command: 'SELECT',
      rowCount: 2,
      oid: 0,
      fields: [],
    });

    const result = await client.query('SELECT * FROM test', []);

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM test', []);
  });

  it('should execute queryOne and return first row', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [{ id: 1 }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await client.queryOne('SELECT * FROM test WHERE id = $1', [1]);

    expect(result).toEqual({ id: 1 });
  });

  it('should execute queryOne and return null when no rows', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });

    const result = await client.queryOne('SELECT * FROM test WHERE id = $1', [999]);

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests**

Run:
```bash
npm test -- client.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit database client**

Run:
```bash
git add apps/watcher/src/database/client.ts apps/watcher/test/unit/database/
git commit -m "feat(watcher): add database client with connection pooling

- Implement singleton DatabaseClient with pg Pool
- Add query, queryOne, transaction, close methods
- Add unit tests with mocked pool"
```

---

### Task 4: StateRepository Implementation

**Files:**
- Create: `apps/watcher/src/database/repositories/state.repository.ts`
- Create: `apps/watcher/test/unit/database/state.repository.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient` from Task 3, `StateRepository`, `WatcherState` interfaces from `packages/contracts`
- Produces: `PostgresStateRepository` implementing:
  - `get(interfaceId: string, filePath: string): Promise<WatcherState | null>`
  - `save(state: WatcherState): Promise<void>`
  - `findByInterface(interfaceId: string): Promise<WatcherState[]>`

- [ ] **Step 1: Write failing test for get method**

Create `apps/watcher/test/unit/database/state.repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { WatcherState } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('PostgresStateRepository', () => {
  let repository: PostgresStateRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      queryOne: vi.fn(),
      query: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new PostgresStateRepository();
  });

  describe('get', () => {
    it('should return state when found', async () => {
      const mockState: WatcherState = {
        interfaceId: 'SA-034',
        batchId: 'SA-034-20260715-001',
        filePath: '/inbound/file.xlsx',
        fileName: 'file.xlsx',
        fileSizeBytes: 1024,
        previousStatus: null,
        currentStatus: 'FILE_DETECTED',
        statusChangedAt: new Date('2026-07-15T10:00:00Z'),
        firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
        lastSeenAt: new Date('2026-07-15T10:00:00Z'),
      };

      mockClient.queryOne.mockResolvedValue(mockState);

      const result = await repository.get('SA-034', '/inbound/file.xlsx');

      expect(result).toEqual(mockState);
      expect(mockClient.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM watcher_schema.watcher_state'),
        ['SA-034', '/inbound/file.xlsx']
      );
    });

    it('should return null when not found', async () => {
      mockClient.queryOne.mockResolvedValue(null);

      const result = await repository.get('SA-999', '/nonexistent');

      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- state.repository.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement StateRepository**

Create `apps/watcher/src/database/repositories/state.repository.ts`:

```typescript
import { DatabaseClient } from '../client';
import type { StateRepository, WatcherState } from '@packages/contracts';

export class PostgresStateRepository implements StateRepository {
  private db = DatabaseClient.getInstance();

  async get(interfaceId: string, filePath: string): Promise<WatcherState | null> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        batch_id as "batchId",
        file_path as "filePath",
        file_name as "fileName",
        file_size_bytes as "fileSizeBytes",
        previous_status as "previousStatus",
        current_status as "currentStatus",
        status_changed_at as "statusChangedAt",
        first_detected_at as "firstDetectedAt",
        last_seen_at as "lastSeenAt"
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
      state.lastSeenAt,
    ]);
  }

  async findByInterface(interfaceId: string): Promise<WatcherState[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        batch_id as "batchId",
        file_path as "filePath",
        file_name as "fileName",
        file_size_bytes as "fileSizeBytes",
        previous_status as "previousStatus",
        current_status as "currentStatus",
        status_changed_at as "statusChangedAt",
        first_detected_at as "firstDetectedAt",
        last_seen_at as "lastSeenAt"
      FROM watcher_schema.watcher_state
      WHERE interface_id = $1
      ORDER BY status_changed_at DESC
    `;
    return this.db.query<WatcherState>(sql, [interfaceId]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- state.repository.test.ts
```

Expected: PASS

- [ ] **Step 5: Add save and findByInterface tests**

Add to `apps/watcher/test/unit/database/state.repository.test.ts`:

```typescript
describe('save', () => {
  it('should insert new state', async () => {
    const state: WatcherState = {
      interfaceId: 'SA-034',
      batchId: 'SA-034-20260715-001',
      filePath: '/inbound/file.xlsx',
      fileName: 'file.xlsx',
      fileSizeBytes: 1024,
      previousStatus: null,
      currentStatus: 'FILE_DETECTED',
      statusChangedAt: new Date('2026-07-15T10:00:00Z'),
      firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
      lastSeenAt: new Date('2026-07-15T10:00:00Z'),
    };

    mockClient.query.mockResolvedValue([]);

    await repository.save(state);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO watcher_schema.watcher_state'),
      expect.arrayContaining([
        'SA-034',
        'SA-034-20260715-001',
        '/inbound/file.xlsx',
        'file.xlsx',
        1024,
        null,
        'FILE_DETECTED',
      ])
    );
  });
});

describe('findByInterface', () => {
  it('should return all states for interface', async () => {
    const mockStates: WatcherState[] = [
      {
        interfaceId: 'SA-034',
        batchId: 'SA-034-20260715-001',
        filePath: '/inbound/file1.xlsx',
        fileName: 'file1.xlsx',
        fileSizeBytes: 1024,
        previousStatus: null,
        currentStatus: 'FILE_STABLE',
        statusChangedAt: new Date('2026-07-15T10:00:00Z'),
        firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
        lastSeenAt: new Date('2026-07-15T10:00:00Z'),
      },
    ];

    mockClient.query.mockResolvedValue(mockStates);

    const result = await repository.findByInterface('SA-034');

    expect(result).toEqual(mockStates);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE interface_id = $1'),
      ['SA-034']
    );
  });

  it('should return empty array when no states found', async () => {
    mockClient.query.mockResolvedValue([]);

    const result = await repository.findByInterface('SA-999');

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 6: Run all tests**

Run:
```bash
npm test -- state.repository.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit StateRepository**

Run:
```bash
git add apps/watcher/src/database/repositories/state.repository.ts apps/watcher/test/unit/database/state.repository.test.ts
git commit -m "feat(watcher): implement PostgresStateRepository

- Implement get, save, findByInterface methods
- Use upsert pattern (INSERT ON CONFLICT DO UPDATE)
- Map snake_case DB columns to camelCase TypeScript
- Add unit tests with mocked DatabaseClient"
```

---

### Task 5: InterfaceConfigRepository Implementation

**Files:**
- Create: `apps/watcher/src/database/repositories/interface-config.repository.ts`
- Create: `apps/watcher/test/unit/database/interface-config.repository.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient` from Task 3, `InterfaceConfig` from `packages/contracts`
- Produces: `InterfaceConfigRepository` with:
  - `findAll(enabledOnly?: boolean): Promise<InterfaceConfig[]>`
  - `findById(interfaceId: string): Promise<InterfaceConfig | null>`
  - `findByConnectionRef(connectionRef: string): Promise<InterfaceConfig[]>`

- [ ] **Step 1: Write failing test**

Create `apps/watcher/test/unit/database/interface-config.repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { InterfaceConfig } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('InterfaceConfigRepository', () => {
  let repository: InterfaceConfigRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      queryOne: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new InterfaceConfigRepository();
  });

  describe('findAll', () => {
    it('should return all configs when enabledOnly is false', async () => {
      const mockConfigs: InterfaceConfig[] = [
        {
          interfaceId: 'SA-034',
          interfaceName: 'Vendor Invoice',
          sourceSystem: 'AG-DOC',
          targetSystem: 'D365',
          connectionRef: 'sftp-agdoc-prod',
          inboundPath: '/inbound',
          filePattern: '*.xlsx',
          pollIntervalSeconds: 60,
          readinessRule: 'STABLE_SIZE',
          stabilityCheckSeconds: 30,
          duplicateCheckEnabled: true,
          stuckThresholdMinutes: 60,
          expectedSchedule: null,
          slaThresholdMinutes: null,
          alertOwner: 'team@example.com',
          enabledFlag: true,
        },
      ];

      mockClient.query.mockResolvedValue(mockConfigs);

      const result = await repository.findAll(false);

      expect(result).toEqual(mockConfigs);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.not.stringContaining('WHERE enabled_flag'),
        undefined
      );
    });

    it('should filter enabled configs when enabledOnly is true', async () => {
      mockClient.query.mockResolvedValue([]);

      await repository.findAll(true);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE enabled_flag = true'),
        undefined
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- interface-config.repository.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement InterfaceConfigRepository**

Create `apps/watcher/src/database/repositories/interface-config.repository.ts`:

```typescript
import { DatabaseClient } from '../client';
import type { InterfaceConfig } from '@packages/contracts';

export class InterfaceConfigRepository {
  private db = DatabaseClient.getInstance();

  async findAll(enabledOnly: boolean = false): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql);
  }

  async findById(interfaceId: string): Promise<InterfaceConfig | null> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      WHERE interface_id = $1
    `;
    return this.db.queryOne<InterfaceConfig>(sql, [interfaceId]);
  }

  async findByConnectionRef(connectionRef: string): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      WHERE connection_ref = $1
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql, [connectionRef]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- interface-config.repository.test.ts
```

Expected: PASS

- [ ] **Step 5: Add tests for findById and findByConnectionRef**

Add to `apps/watcher/test/unit/database/interface-config.repository.test.ts`:

```typescript
describe('findById', () => {
  it('should return config when found', async () => {
    const mockConfig: InterfaceConfig = {
      interfaceId: 'SA-034',
      interfaceName: 'Vendor Invoice',
      sourceSystem: 'AG-DOC',
      targetSystem: 'D365',
      connectionRef: 'sftp-agdoc-prod',
      inboundPath: '/inbound',
      filePattern: '*.xlsx',
      pollIntervalSeconds: 60,
      readinessRule: 'STABLE_SIZE',
      stabilityCheckSeconds: 30,
      duplicateCheckEnabled: true,
      stuckThresholdMinutes: 60,
      expectedSchedule: null,
      slaThresholdMinutes: null,
      alertOwner: 'team@example.com',
      enabledFlag: true,
    };

    mockClient.queryOne.mockResolvedValue(mockConfig);

    const result = await repository.findById('SA-034');

    expect(result).toEqual(mockConfig);
    expect(mockClient.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('WHERE interface_id = $1'),
      ['SA-034']
    );
  });

  it('should return null when not found', async () => {
    mockClient.queryOne.mockResolvedValue(null);

    const result = await repository.findById('SA-999');

    expect(result).toBeNull();
  });
});

describe('findByConnectionRef', () => {
  it('should return all configs for connection', async () => {
    const mockConfigs: InterfaceConfig[] = [
      {
        interfaceId: 'SA-034',
        interfaceName: 'Vendor Invoice',
        sourceSystem: 'AG-DOC',
        targetSystem: 'D365',
        connectionRef: 'sftp-agdoc-prod',
        inboundPath: '/inbound',
        filePattern: '*.xlsx',
        pollIntervalSeconds: 60,
        readinessRule: 'STABLE_SIZE',
        stabilityCheckSeconds: 30,
        duplicateCheckEnabled: true,
        stuckThresholdMinutes: 60,
        expectedSchedule: null,
        slaThresholdMinutes: null,
        alertOwner: 'team@example.com',
        enabledFlag: true,
      },
    ];

    mockClient.query.mockResolvedValue(mockConfigs);

    const result = await repository.findByConnectionRef('sftp-agdoc-prod');

    expect(result).toEqual(mockConfigs);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE connection_ref = $1'),
      ['sftp-agdoc-prod']
    );
  });
});
```

- [ ] **Step 6: Run all tests**

Run:
```bash
npm test -- interface-config.repository.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit InterfaceConfigRepository**

Run:
```bash
git add apps/watcher/src/database/repositories/interface-config.repository.ts apps/watcher/test/unit/database/interface-config.repository.test.ts
git commit -m "feat(watcher): implement InterfaceConfigRepository

- Implement findAll, findById, findByConnectionRef methods
- Support enabledOnly filtering
- Map snake_case DB columns to camelCase TypeScript
- Add unit tests with mocked DatabaseClient"
```

---

### Task 6: ConnectionConfigRepository Implementation

**Files:**
- Create: `apps/watcher/src/database/repositories/connection-config.repository.ts`
- Create: `apps/watcher/test/unit/database/connection-config.repository.test.ts`

**Interfaces:**
- Consumes: `DatabaseClient` from Task 3, `ConnectionConfig` from `packages/contracts`
- Produces: `ConnectionConfigRepository` with:
  - `findByRef(connectionRef: string): Promise<ConnectionConfig | null>`
  - `findAll(enabledOnly?: boolean): Promise<ConnectionConfig[]>`

- [ ] **Step 1: Write failing test**

Create `apps/watcher/test/unit/database/connection-config.repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { ConnectionConfig } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('ConnectionConfigRepository', () => {
  let repository: ConnectionConfigRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      queryOne: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new ConnectionConfigRepository();
  });

  describe('findByRef', () => {
    it('should return config when found', async () => {
      const mockConfig: ConnectionConfig = {
        connectionRef: 'sftp-agdoc-prod',
        storageType: 'SFTP',
        environment: 'production',
        endpoint: 'sftp.agdoc.com',
        port: 22,
        username: 'integration_user',
        authenticationType: 'PRIVATE_KEY',
        credentialRef: 'sftp-agdoc-key',
        timeoutSeconds: 30,
        enabledFlag: true,
        owner: 'team@example.com',
      };

      mockClient.queryOne.mockResolvedValue(mockConfig);

      const result = await repository.findByRef('sftp-agdoc-prod');

      expect(result).toEqual(mockConfig);
      expect(mockClient.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('WHERE connection_ref = $1'),
        ['sftp-agdoc-prod']
      );
    });

    it('should return null when not found', async () => {
      mockClient.queryOne.mockResolvedValue(null);

      const result = await repository.findByRef('nonexistent');

      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- connection-config.repository.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement ConnectionConfigRepository**

Create `apps/watcher/src/database/repositories/connection-config.repository.ts`:

```typescript
import { DatabaseClient } from '../client';
import type { ConnectionConfig } from '@packages/contracts';

export class ConnectionConfigRepository {
  private db = DatabaseClient.getInstance();

  async findByRef(connectionRef: string): Promise<ConnectionConfig | null> {
    const sql = `
      SELECT
        connection_ref as "connectionRef",
        storage_type as "storageType",
        environment,
        endpoint,
        port,
        username,
        authentication_type as "authenticationType",
        credential_ref as "credentialRef",
        timeout_seconds as "timeoutSeconds",
        enabled_flag as "enabledFlag",
        owner
      FROM watcher_schema.connection_config
      WHERE connection_ref = $1
    `;
    return this.db.queryOne<ConnectionConfig>(sql, [connectionRef]);
  }

  async findAll(enabledOnly: boolean = false): Promise<ConnectionConfig[]> {
    const sql = `
      SELECT
        connection_ref as "connectionRef",
        storage_type as "storageType",
        environment,
        endpoint,
        port,
        username,
        authentication_type as "authenticationType",
        credential_ref as "credentialRef",
        timeout_seconds as "timeoutSeconds",
        enabled_flag as "enabledFlag",
        owner
      FROM watcher_schema.connection_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY connection_ref
    `;
    return this.db.query<ConnectionConfig>(sql);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- connection-config.repository.test.ts
```

Expected: PASS

- [ ] **Step 5: Add test for findAll**

Add to `apps/watcher/test/unit/database/connection-config.repository.test.ts`:

```typescript
describe('findAll', () => {
  it('should return all configs when enabledOnly is false', async () => {
    const mockConfigs: ConnectionConfig[] = [
      {
        connectionRef: 'sftp-agdoc-prod',
        storageType: 'SFTP',
        environment: 'production',
        endpoint: 'sftp.agdoc.com',
        port: 22,
        username: 'integration_user',
        authenticationType: 'PRIVATE_KEY',
        credentialRef: 'sftp-agdoc-key',
        timeoutSeconds: 30,
        enabledFlag: true,
        owner: 'team@example.com',
      },
    ];

    mockClient.query.mockResolvedValue(mockConfigs);

    const result = await repository.findAll(false);

    expect(result).toEqual(mockConfigs);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.not.stringContaining('WHERE enabled_flag'),
      undefined
    );
  });

  it('should filter enabled configs when enabledOnly is true', async () => {
    mockClient.query.mockResolvedValue([]);

    await repository.findAll(true);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE enabled_flag = true'),
      undefined
    );
  });
});
```

- [ ] **Step 6: Run all tests**

Run:
```bash
npm test -- connection-config.repository.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit ConnectionConfigRepository**

Run:
```bash
git add apps/watcher/src/database/repositories/connection-config.repository.ts apps/watcher/test/unit/database/connection-config.repository.test.ts
git commit -m "feat(watcher): implement ConnectionConfigRepository

- Implement findByRef, findAll methods
- Support enabledOnly filtering
- Map snake_case DB columns to camelCase TypeScript
- Add unit tests with mocked DatabaseClient"
```

---

### Task 7: Integration Tests

**Files:**
- Create: `apps/watcher/test/integration/database/migrations.test.ts`
- Create: `apps/watcher/test/integration/database/state.repository.integration.test.ts`
- Create: `apps/watcher/test/integration/database/interface-config.repository.integration.test.ts`
- Create: `apps/watcher/test/integration/database/connection-config.repository.integration.test.ts`
- Create: `apps/watcher/test/fixtures/interface-configs.json`
- Create: `apps/watcher/test/fixtures/connection-configs.json`
- Create: `apps/watcher/test/fixtures/watcher-states.json`

**Interfaces:**
- Consumes: Real Postgres database, all repositories from Tasks 4-6
- Produces: Integration tests validating end-to-end database operations

- [ ] **Step 1: Create test fixtures**

Create `apps/watcher/test/fixtures/interface-configs.json`:

```json
[
  {
    "interfaceId": "SA-034",
    "interfaceName": "Vendor Invoice Posting",
    "sourceSystem": "AG-DOC",
    "targetSystem": "D365",
    "connectionRef": "sftp-agdoc-prod",
    "inboundPath": "/ag-doc/vendor-invoice/inbound/",
    "filePattern": "VendorInvoice_*.xlsx",
    "pollIntervalSeconds": 60,
    "readinessRule": "STABLE_SIZE",
    "stabilityCheckSeconds": 30,
    "duplicateCheckEnabled": true,
    "stuckThresholdMinutes": 60,
    "expectedSchedule": null,
    "slaThresholdMinutes": null,
    "alertOwner": "integration-team@example.com",
    "enabledFlag": true
  }
]
```

Create `apps/watcher/test/fixtures/connection-configs.json`:

```json
[
  {
    "connectionRef": "sftp-agdoc-prod",
    "storageType": "SFTP",
    "environment": "production",
    "endpoint": "sftp.agdoc.com",
    "port": 22,
    "username": "integration_user",
    "authenticationType": "PRIVATE_KEY",
    "credentialRef": "sftp-agdoc-key",
    "timeoutSeconds": 30,
    "enabledFlag": true,
    "owner": "integration-team@example.com"
  }
]
```

Create `apps/watcher/test/fixtures/watcher-states.json`:

```json
[
  {
    "interfaceId": "SA-034",
    "batchId": "SA-034-20260715-100000-ABCD",
    "filePath": "/ag-doc/vendor-invoice/inbound/VendorInvoice_20260715.xlsx",
    "fileName": "VendorInvoice_20260715.xlsx",
    "fileSizeBytes": 258300,
    "previousStatus": null,
    "currentStatus": "FILE_DETECTED",
    "statusChangedAt": "2026-07-15T10:00:00Z",
    "firstDetectedAt": "2026-07-15T10:00:00Z",
    "lastSeenAt": "2026-07-15T10:00:00Z"
  }
]
```

- [ ] **Step 2: Create migration test**

Create `apps/watcher/test/integration/database/migrations.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseClient } from '../../../src/database/client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('Migrations', () => {
  let db: DatabaseClient;

  beforeAll(() => {
    db = DatabaseClient.getInstance();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should create watcher_schema', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'watcher_schema') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create interface_config table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'interface_config') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create connection_config table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'connection_config') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create watcher_state table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'watcher_state') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should have unique constraint on interface_id + file_path', async () => {
    const result = await db.queryOne<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'watcher_schema'
       AND table_name = 'watcher_state'
       AND constraint_type = 'UNIQUE'
       AND constraint_name = 'unique_interface_file'`
    );
    expect(result?.constraint_name).toBe('unique_interface_file');
  });
});
```

- [ ] **Step 3: Run migration test**

Run:
```bash
npm test -- migrations.test.ts
```

Expected: All tests PASS

- [ ] **Step 4: Create StateRepository integration test**

Create `apps/watcher/test/integration/database/state.repository.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { WatcherState } from '@packages/contracts';

describe('PostgresStateRepository Integration', () => {
  let repository: PostgresStateRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    repository = new PostgresStateRepository();
    // Clean up before each test
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
  });

  afterAll(async () => {
    await db.close();
  });

  it('should save and retrieve state', async () => {
    const state: WatcherState = {
      interfaceId: 'SA-034',
      batchId: 'SA-034-20260715-100000-TEST',
      filePath: '/inbound/test.xlsx',
      fileName: 'test.xlsx',
      fileSizeBytes: 1024,
      previousStatus: null,
      currentStatus: 'FILE_DETECTED',
      statusChangedAt: new Date('2026-07-15T10:00:00Z'),
      firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
      lastSeenAt: new Date('2026-07-15T10:00:00Z'),
    };

    await repository.save(state);

    const retrieved = await repository.get('SA-034', '/inbound/test.xlsx');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.interfaceId).toBe('SA-034');
    expect(retrieved?.batchId).toBe('SA-034-20260715-100000-TEST');
    expect(retrieved?.currentStatus).toBe('FILE_DETECTED');
  });

  it('should upsert on conflict', async () => {
    const state: WatcherState = {
      interfaceId: 'SA-034',
      batchId: 'SA-034-20260715-100000-TEST',
      filePath: '/inbound/test.xlsx',
      fileName: 'test.xlsx',
      fileSizeBytes: 1024,
      previousStatus: null,
      currentStatus: 'FILE_DETECTED',
      statusChangedAt: new Date('2026-07-15T10:00:00Z'),
      firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
      lastSeenAt: new Date('2026-07-15T10:00:00Z'),
    };

    await repository.save(state);

    // Update status
    const updatedState = {
      ...state,
      previousStatus: 'FILE_DETECTED',
      currentStatus: 'FILE_STABLE',
      statusChangedAt: new Date('2026-07-15T10:01:00Z'),
      lastSeenAt: new Date('2026-07-15T10:01:00Z'),
    };

    await repository.save(updatedState);

    const retrieved = await repository.get('SA-034', '/inbound/test.xlsx');

    expect(retrieved?.currentStatus).toBe('FILE_STABLE');
    expect(retrieved?.previousStatus).toBe('FILE_DETECTED');
  });

  it('should findByInterface return all states for interface', async () => {
    const state1: WatcherState = {
      interfaceId: 'SA-034',
      batchId: 'SA-034-20260715-100000-TEST1',
      filePath: '/inbound/test1.xlsx',
      fileName: 'test1.xlsx',
      fileSizeBytes: 1024,
      previousStatus: null,
      currentStatus: 'FILE_STABLE',
      statusChangedAt: new Date('2026-07-15T10:00:00Z'),
      firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
      lastSeenAt: new Date('2026-07-15T10:00:00Z'),
    };

    const state2: WatcherState = {
      interfaceId: 'SA-034',
      batchId: 'SA-034-20260715-100100-TEST2',
      filePath: '/inbound/test2.xlsx',
      fileName: 'test2.xlsx',
      fileSizeBytes: 2048,
      previousStatus: null,
      currentStatus: 'FILE_DETECTED',
      statusChangedAt: new Date('2026-07-15T10:01:00Z'),
      firstDetectedAt: new Date('2026-07-15T10:01:00Z'),
      lastSeenAt: new Date('2026-07-15T10:01:00Z'),
    };

    await repository.save(state1);
    await repository.save(state2);

    const results = await repository.findByInterface('SA-034');

    expect(results).toHaveLength(2);
    expect(results[0].filePath).toBe('/inbound/test2.xlsx'); // Most recent first
    expect(results[1].filePath).toBe('/inbound/test1.xlsx');
  });

  it('should return null when state not found', async () => {
    const result = await repository.get('SA-999', '/nonexistent');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 5: Run StateRepository integration test**

Run:
```bash
npm test -- state.repository.integration.test.ts
```

Expected: All tests PASS (requires DATABASE_URL set to test database)

- [ ] **Step 6: Create InterfaceConfigRepository integration test**

Create `apps/watcher/test/integration/database/interface-config.repository.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import interfaceConfigsFixture from '../../fixtures/interface-configs.json';

describe('InterfaceConfigRepository Integration', () => {
  let repository: InterfaceConfigRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    repository = new InterfaceConfigRepository();
    await db.query('TRUNCATE TABLE watcher_schema.interface_config CASCADE');

    // Insert fixture data
    for (const config of interfaceConfigsFixture) {
      await db.query(
        `INSERT INTO watcher_schema.interface_config (
          interface_id, interface_name, source_system, target_system,
          connection_ref, inbound_path, file_pattern, poll_interval_seconds,
          readiness_rule, stability_check_seconds, duplicate_check_enabled,
          stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
          alert_owner, enabled_flag
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          config.interfaceId,
          config.interfaceName,
          config.sourceSystem,
          config.targetSystem,
          config.connectionRef,
          config.inboundPath,
          config.filePattern,
          config.pollIntervalSeconds,
          config.readinessRule,
          config.stabilityCheckSeconds,
          config.duplicateCheckEnabled,
          config.stuckThresholdMinutes,
          config.expectedSchedule,
          config.slaThresholdMinutes,
          config.alertOwner,
          config.enabledFlag,
        ]
      );
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('should find all configs', async () => {
    const results = await repository.findAll();
    expect(results).toHaveLength(1);
    expect(results[0].interfaceId).toBe('SA-034');
  });

  it('should find config by id', async () => {
    const result = await repository.findById('SA-034');
    expect(result).not.toBeNull();
    expect(result?.interfaceName).toBe('Vendor Invoice Posting');
  });

  it('should find configs by connection ref', async () => {
    const results = await repository.findByConnectionRef('sftp-agdoc-prod');
    expect(results).toHaveLength(1);
    expect(results[0].interfaceId).toBe('SA-034');
  });
});
```

- [ ] **Step 7: Run InterfaceConfigRepository integration test**

Run:
```bash
npm test -- interface-config.repository.integration.test.ts
```

Expected: All tests PASS

- [ ] **Step 8: Create ConnectionConfigRepository integration test**

Create `apps/watcher/test/integration/database/connection-config.repository.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import connectionConfigsFixture from '../../fixtures/connection-configs.json';

describe('ConnectionConfigRepository Integration', () => {
  let repository: ConnectionConfigRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    repository = new ConnectionConfigRepository();
    await db.query('TRUNCATE TABLE watcher_schema.connection_config CASCADE');

    // Insert fixture data
    for (const config of connectionConfigsFixture) {
      await db.query(
        `INSERT INTO watcher_schema.connection_config (
          connection_ref, storage_type, environment, endpoint, port,
          username, authentication_type, credential_ref, timeout_seconds,
          enabled_flag, owner
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          config.connectionRef,
          config.storageType,
          config.environment,
          config.endpoint,
          config.port,
          config.username,
          config.authenticationType,
          config.credentialRef,
          config.timeoutSeconds,
          config.enabledFlag,
          config.owner,
        ]
      );
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('should find all configs', async () => {
    const results = await repository.findAll();
    expect(results).toHaveLength(1);
    expect(results[0].connectionRef).toBe('sftp-agdoc-prod');
  });

  it('should find config by ref', async () => {
    const result = await repository.findByRef('sftp-agdoc-prod');
    expect(result).not.toBeNull();
    expect(result?.storageType).toBe('SFTP');
    expect(result?.endpoint).toBe('sftp.agdoc.com');
  });

  it('should return null when not found', async () => {
    const result = await repository.findByRef('nonexistent');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 9: Run ConnectionConfigRepository integration test**

Run:
```bash
npm test -- connection-config.repository.integration.test.ts
```

Expected: All tests PASS

- [ ] **Step 10: Run all tests**

Run:
```bash
npm test
```

Expected: All unit and integration tests PASS

- [ ] **Step 11: Commit integration tests**

Run:
```bash
git add apps/watcher/test/integration/ apps/watcher/test/fixtures/
git commit -m "test(watcher): add integration tests for database layer

- Add migration verification tests
- Add StateRepository integration tests (CRUD, upsert)
- Add InterfaceConfigRepository integration tests
- Add ConnectionConfigRepository integration tests
- Add test fixtures for configs and states
- All tests use real Postgres database"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✓ Migration framework (Task 1)
- ✓ Schema migrations (Task 2)
- ✓ Database client (Task 3)
- ✓ StateRepository (Task 4)
- ✓ InterfaceConfigRepository (Task 5)
- ✓ ConnectionConfigRepository (Task 6)
- ✓ Integration tests (Task 7)
- ✓ Test fixtures (Task 7)

**Placeholder scan:**
- No "TBD" or "TODO" found
- All code blocks complete
- All test commands specified
- All expected outputs documented

**Type consistency:**
- DatabaseClient methods consistent across tasks
- Repository interfaces match spec
- WatcherState, InterfaceConfig, ConnectionConfig types from contracts package
- camelCase used consistently for TypeScript

**Dependencies:**
- Requires `packages/contracts` types (created by Watcher Engine Task 2)
- All npm packages specified in Task 1
- DATABASE_URL environment variable required
- Test database needs to be separate from dev database

---

## Execution Notes

**Before starting:**
1. Ensure `packages/contracts` exists with required types (Watcher Engine Task 2 creates these)
2. Create test database: `createdb integration_db_test`
3. Set `DATABASE_URL=postgres://user:password@localhost:5432/integration_db` in `apps/watcher/.env`

**During implementation:**
- Run migrations after Task 2
- Unit tests use mocked DatabaseClient
- Integration tests use real Postgres
- Clean test database between tests (TRUNCATE tables)

**After completion:**
- Watcher Engine can swap in-memory StateRepository for PostgresStateRepository
- Scheduler can load interfaces via InterfaceConfigRepository
- Connection Manager can load connections via ConnectionConfigRepository
