# Watcher Engine Implementation Plan

> **⚠️ HISTORICAL (2026-07-17):** this plan was executed against the TypeScript reference implementation. The production architecture has since pivoted to a D365-native build — see [2026-07-17-d365-native-implementation.md](2026-07-17-d365-native-implementation.md) and the [D365-native design spec](../specs/2026-07-17-d365-native-architecture-design.md). The code this plan produced is now part of the frozen executable reference spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Common Watcher Engine — the component that turns a `FileObservation` into a `FileEvent` by deciding file lifecycle state — plus its `packages/contracts` dependency, per the approved design spec.

**Architecture:** Ordered rule pipeline (`duplicate` → `stuck-file` → `stability`) with a separate sweep entry point for `missing-sla` (which reacts to absence, not an observation). State is snapshot-only, held behind a `StateRepository` interface with an in-memory implementation. Fail-fast error handling throughout — no retry/catch inside the engine.

**Tech Stack:** TypeScript (strict), npm workspaces + TS project references, Vitest.

**Source spec:** [`docs/superpowers/specs/2026-07-15-watcher-engine-design.md`](../specs/2026-07-15-watcher-engine-design.md)

## Global Constraints

- Node >=18, TypeScript strict mode (matches existing root `tsconfig.json`).
- npm workspaces + TypeScript project references for cross-package imports (per `docs/monorepo-architecture.md` "Development" section) — no package needs to be prebuilt for another to import it during dev/test.
- Vitest is the test framework for this and all future work in this repo.
- Engine processes observations sequentially per interface — no internal concurrency.
- Fail-fast: any error inside `processObservation` or `checkMissingSla` throws immediately, no partial state save, no internal catch/retry.
- One `batch_id` per file lifecycle — generated once at `FILE_DETECTED`, reused for every later event on that file. Never shared across files.
- `WatcherState` is a current-snapshot table (`currentStatus`/`previousStatus` only) — no history log. Durable audit trail is Gateway's `event_outbox`, out of scope here.
- Rule pipeline order: `duplicate` → `stuck-file` → `stability`. `missing-sla` is a separate sweep function, not in this pipeline.
- Duplicate detection basis: file path + prior terminal status only. No content checksum (adapters return metadata only in MVP).
- The valid state-transition table below is the single source of truth for `state-transition.policy.ts` — it's an allow-list; anything not listed is invalid.

| From | To | Allowed |
|---|---|---|
| (none) | `FILE_DETECTED` | yes |
| (none) | `FILE_MISSING_BY_SLA` | yes |
| `FILE_DETECTED` | `FILE_STABLE` | yes |
| `FILE_DETECTED` | `FILE_STUCK` | yes |
| `FILE_STABLE` | `FILE_DUPLICATE` | yes |
| `FILE_STUCK` | `FILE_STABLE` | yes |
| everything else | — | no |

## Refinements made during planning (beyond the spec)

The spec intentionally left some implementation details open. These choices were made now, not during brainstorming — flagging them so you know they're plan-level decisions, not spec-approved ones:

1. **`Rule` signature takes `now: Date`.** The spec's one-liner `(observation, state, config) => RuleOutcome | null` omitted time, but `stuck-file` and `stability` are time-dependent and need deterministic `now` for testing. Added as a fourth parameter.
2. **`interface-matcher.ts` throws, doesn't return boolean.** The spec's file-layout table said `matchesInterface(observation, config): boolean` but its flow description said "throws if mismatched" — a real contradiction. Resolved in favor of the more detailed flow description; the function is `assertInterfaceMatch(observation, config): void`, named to make the throwing behavior obvious.
3. **`StateRepository` gains `findByInterface(interfaceId): Promise<WatcherState[]>`**, beyond the spec's "(get/save)" mention. `checkMissingSla` needs to know whether *any* file arrived for an interface — SLA is interface-level, not file-level, and `get()` is keyed by a specific file path that doesn't exist for a missing file. This is consistent with the architecture doc calling the State Repository's job "CRUD operations."
4. **`FileEvent.filePath` is `string | null`.** A `FILE_MISSING_BY_SLA` event has no real file — `filePath` is `null` for that event type only.
5. **Missing-SLA idempotency via a sentinel state row** (`filePath: "__sla_window__"`). Without persisting *something*, every scheduler cycle after the deadline would re-emit `FILE_MISSING_BY_SLA` for the same day. Reusing the same `StateRepository`/transition-policy machinery for this (rather than inventing separate dedup logic) keeps one mechanism instead of two.
6. **`processObservation` treats a same-status outcome as a no-op**, returning `null` instead of calling `assertValidTransition`. Without this, a file sitting in `FILE_STUCK` across multiple polls would throw `InvalidStateTransitionError` on every subsequent poll, since `FILE_STUCK → FILE_STUCK` isn't (and shouldn't be) in the valid-transition table. Matches the architecture doc's "emit event only for meaningful state changes."

---

### Task 1: Workspace + tooling bootstrap

**Files:**
- Modify: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: npm workspaces resolving `apps/*` and `packages/*`; `vitest.config.ts` used by every later task's test commands; `tsconfig.base.json` extended by every package's `tsconfig.json`.

This task has no application logic to TDD — it's tooling config. Steps verify each piece works before moving on.

- [ ] **Step 1: Add workspaces field and test script to root `package.json`**

Edit `package.json`, add `"workspaces"` and update `"scripts"`:

```json
{
  "name": "integration-engine",
  "version": "0.1.0",
  "description": "File Watcher Service for D365 Integration Monitoring",
  "main": "dist/index.js",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "keywords": ["d365", "integration", "file-watcher"],
  "author": "Napas Jutha <napasjutha@gmail.com>",
  "license": "UNLICENSED",
  "dependencies": {
    "pg": "^8.11.0",
    "redis": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.10.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0",
    "vite-tsconfig-paths": "^4.3.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Install new devDependencies**

Run: `npm install`
Expected: installs `vitest` and `vite-tsconfig-paths` at root, no errors.

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 5: Verify the test runner wires up with zero tests**

Run: `npm test`
Expected: exits 0, reports no test files found (allowed by `passWithNoTests: true`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts
git commit -m "chore: add npm workspaces and vitest"
```

---

### Task 2: Contracts — core types

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/events/file-status.ts`
- Create: `packages/contracts/src/observations/file-observation.ts`
- Create: `packages/contracts/src/events/file-event.ts`
- Create: `packages/contracts/src/config/interface-config.ts`
- Create: `packages/contracts/src/config/connection-config.ts`

**Interfaces:**
- Produces: `FileStatus` (union type), `FileObservation`, `FileEvent`, `InterfaceConfig`, `ConnectionConfig` — consumed by every later task.

These are plain type/interface declarations with no runtime behavior, so there's nothing to RED/GREEN — correctness is verified by the TypeScript compiler, not a Vitest assertion. Each step's "test" is a type-check.

- [ ] **Step 1: Scaffold the package**

`packages/contracts/package.json`:
```json
{
  "name": "@integration-engine/contracts",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  }
}
```

`packages/contracts/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Write `file-status.ts`**

```ts
export type FileStatus =
  | 'FILE_DETECTED'
  | 'FILE_STABLE'
  | 'FILE_DUPLICATE'
  | 'FILE_STUCK'
  | 'FILE_MISSING_BY_SLA';
```

- [ ] **Step 3: Write `file-observation.ts`**

```ts
export interface FileObservation {
  interfaceId: string;
  path: string;
  size: number;
  mtime: Date;
}
```

- [ ] **Step 4: Write `file-event.ts`**

```ts
import { FileStatus } from './file-status';

export interface FileEvent {
  eventId: string;
  eventType: FileStatus;
  batchId: string;
  interfaceId: string;
  filePath: string | null;
  occurredAt: Date;
}
```

`filePath` is nullable because `FILE_MISSING_BY_SLA` events (Task 14) have no real file.

- [ ] **Step 5: Write `interface-config.ts`**

```ts
export interface InterfaceConfig {
  interfaceId: string;
  connectionRef: string;
  inboundPath: string;
  filePattern: string;
  pollIntervalSeconds: number;
  stabilityCheckSeconds: number;
  stuckThresholdSeconds: number;
  slaDeadline: string;
}
```

`slaDeadline` is a `"HH:mm"` 24-hour local-time cutoff (e.g. `"09:00"`).

- [ ] **Step 6: Write `connection-config.ts`**

```ts
export interface ConnectionConfig {
  connectionRef: string;
  storageType: 'SFTP' | 'BLOB' | 'SHAREPOINT' | 'FOLDER';
  host?: string;
  port?: number;
  credentialRef: string;
}
```

- [ ] **Step 7: Install workspace link and type-check**

Run: `npm install`
Expected: `node_modules/@integration-engine/contracts` symlinked to `packages/contracts`.

Run: `npx tsc --noEmit -p packages/contracts/tsconfig.json`
Expected: exits 0, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/src
git commit -m "feat(contracts): add core types (FileStatus, FileObservation, FileEvent, InterfaceConfig, ConnectionConfig)"
```

---

### Task 3: Contracts — error classes and barrel export

**Files:**
- Create: `packages/contracts/src/errors/error-codes.ts`
- Create: `packages/contracts/src/errors/error-codes.test.ts`
- Create: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `FileStatus` from Task 2.
- Produces: `InvalidStateTransitionError`, `InterfaceMismatchError`, and the package's public barrel export (everything downstream imports from `@integration-engine/contracts`, not deep paths).

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/errors/error-codes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError, InterfaceMismatchError } from './error-codes';

describe('InvalidStateTransitionError', () => {
  it('includes from and to statuses in the message', () => {
    const err = new InvalidStateTransitionError('FILE_STABLE', 'FILE_DETECTED');
    expect(err.name).toBe('InvalidStateTransitionError');
    expect(err.from).toBe('FILE_STABLE');
    expect(err.to).toBe('FILE_DETECTED');
    expect(err.message).toContain('FILE_STABLE');
    expect(err.message).toContain('FILE_DETECTED');
  });

  it('renders (none) when from is null', () => {
    const err = new InvalidStateTransitionError(null, 'FILE_STABLE');
    expect(err.message).toContain('(none)');
  });
});

describe('InterfaceMismatchError', () => {
  it('includes the file path and interface id in the message', () => {
    const err = new InterfaceMismatchError('/inbound/foo.csv', 'SA-034');
    expect(err.name).toBe('InterfaceMismatchError');
    expect(err.filePath).toBe('/inbound/foo.csv');
    expect(err.interfaceId).toBe('SA-034');
    expect(err.message).toContain('/inbound/foo.csv');
    expect(err.message).toContain('SA-034');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/errors/error-codes.test.ts`
Expected: FAIL — `error-codes.ts` doesn't exist yet, import error.

- [ ] **Step 3: Write minimal implementation**

`packages/contracts/src/errors/error-codes.ts`:
```ts
import { FileStatus } from '../events/file-status';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: FileStatus | null,
    public readonly to: FileStatus
  ) {
    super(`Invalid state transition: ${from ?? '(none)'} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class InterfaceMismatchError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly interfaceId: string
  ) {
    super(`File path ${filePath} does not match interface ${interfaceId}`);
    this.name = 'InterfaceMismatchError';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/errors/error-codes.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the barrel export**

`packages/contracts/src/index.ts`:
```ts
export * from './events/file-status';
export * from './events/file-event';
export * from './observations/file-observation';
export * from './config/interface-config';
export * from './config/connection-config';
export * from './errors/error-codes';
```

- [ ] **Step 6: Build the package**

Run: `npm run build -w @integration-engine/contracts`
Expected: exits 0, `packages/contracts/dist/` created with compiled `.js`/`.d.ts` files.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(contracts): add error classes and public barrel export"
```

---

### Task 4: Scaffold `apps/watcher` package

**Files:**
- Create: `apps/watcher/package.json`
- Create: `apps/watcher/tsconfig.json`
- Create: `apps/watcher/src/engine/sanity.test.ts` (temporary — deleted in Task 15's cleanup is unnecessary, this stays as a real smoke test)

**Interfaces:**
- Consumes: `@integration-engine/contracts` (Task 2/3).
- Produces: a working `apps/watcher` workspace member with a verified path alias to contracts source (no prebuild required).

- [ ] **Step 1: Scaffold the package**

`apps/watcher/package.json`:
```json
{
  "name": "@integration-engine/watcher",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@integration-engine/contracts": "*"
  }
}
```

`apps/watcher/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@integration-engine/contracts": ["../../packages/contracts/src/index.ts"],
      "@integration-engine/testing": ["../../packages/testing/src/index.ts"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"],
  "references": [
    { "path": "../../packages/contracts" }
  ]
}
```

The `paths` mapping points straight at contracts' TypeScript source, not its `dist/` — Vitest (via `vite-tsconfig-paths`, wired in Task 1) resolves and transpiles it on the fly, so contracts never needs rebuilding while iterating on the watcher engine.

- [ ] **Step 2: Write a smoke test proving the path alias works**

`apps/watcher/src/engine/sanity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileStatus } from '@integration-engine/contracts';

describe('workspace wiring', () => {
  it('resolves @integration-engine/contracts via path alias', () => {
    const status: FileStatus = 'FILE_DETECTED';
    expect(status).toBe('FILE_DETECTED');
  });
});
```

- [ ] **Step 3: Install and run**

Run: `npm install`
Expected: `node_modules/@integration-engine/watcher` symlinked.

Run: `npx vitest run apps/watcher/src/engine/sanity.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 4: Commit**

```bash
git add apps/watcher/package.json apps/watcher/tsconfig.json apps/watcher/src/engine/sanity.test.ts
git commit -m "chore(watcher): scaffold package and verify contracts path alias"
```

---

### Task 5: `packages/testing` — FakeClock

**Files:**
- Create: `packages/testing/package.json`
- Create: `packages/testing/tsconfig.json`
- Create: `packages/testing/src/fake-clock.ts`
- Create: `packages/testing/src/fake-clock.test.ts`
- Create: `packages/testing/src/index.ts`
- Modify: `apps/watcher/tsconfig.json` — already has the `@integration-engine/testing` path from Task 4.

**Interfaces:**
- Produces: `FakeClock` class with `now(): Date`, `setNow(date: Date): void`, `advanceSeconds(seconds: number): void` — used by every rule test from Task 10 onward.

- [ ] **Step 1: Scaffold the package**

`packages/testing/package.json`:
```json
{
  "name": "@integration-engine/testing",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  }
}
```

`packages/testing/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/testing/src/fake-clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock';

describe('FakeClock', () => {
  it('returns the date it was constructed with', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-07-15T09:00:00Z'));
  });

  it('setNow overrides the current time', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    clock.setNow(new Date('2026-07-16T00:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-07-16T00:00:00Z'));
  });

  it('advanceSeconds moves the clock forward', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    clock.advanceSeconds(90);
    expect(clock.now()).toEqual(new Date('2026-07-15T09:01:30Z'));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/testing/src/fake-clock.test.ts`
Expected: FAIL — `fake-clock.ts` doesn't exist yet.

- [ ] **Step 4: Write minimal implementation**

`packages/testing/src/fake-clock.ts`:
```ts
export class FakeClock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }

  setNow(date: Date): void {
    this.current = date;
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/testing/src/fake-clock.test.ts`
Expected: PASS, 3 tests.

Note: `duplicateRule`/`stuckFileRule`/`stabilityRule`/`processObservation`/`checkMissingSla` (Tasks 10–14) all take an explicit `now: Date` parameter rather than depending on a clock abstraction — plain `Date` literals in their tests already give full determinism, so none of them consume `FakeClock` directly in this plan. It's built here because the spec calls for it and `packages/testing` is in scope; it's available for the future scheduler/orchestrator work (out of scope here), which will likely run on a real interval and need to fake the passage of time across ticks in a way a static `Date` literal can't express.

- [ ] **Step 6: Write the barrel export**

`packages/testing/src/index.ts`:
```ts
export * from './fake-clock';
```

- [ ] **Step 7: Install and commit**

Run: `npm install`

```bash
git add packages/testing
git commit -m "feat(testing): add FakeClock"
```

---

### Task 6: Engine state — `WatcherState`, `StateRepository`, `InMemoryStateRepository`

**Files:**
- Create: `apps/watcher/src/engine/state/state-repository.ts`
- Create: `apps/watcher/src/engine/state/in-memory-state-repository.ts`
- Create: `apps/watcher/src/engine/state/in-memory-state-repository.test.ts`

**Interfaces:**
- Consumes: `FileStatus` from `@integration-engine/contracts`.
- Produces: `WatcherState` interface, `StateRepository` interface (`get`, `save`, `findByInterface`), `InMemoryStateRepository` class — consumed by every rule and by `watcher-engine.ts`/`missing-sla-sweep.ts`.

- [ ] **Step 1: Write the failing test**

`apps/watcher/src/engine/state/in-memory-state-repository.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InMemoryStateRepository } from './in-memory-state-repository';
import type { WatcherState } from './state-repository';

function makeState(overrides: Partial<WatcherState> = {}): WatcherState {
  return {
    interfaceId: 'SA-034',
    filePath: '/inbound/foo.csv',
    currentStatus: 'FILE_DETECTED',
    previousStatus: null,
    batchId: 'batch-1',
    firstDetectedAt: new Date('2026-07-15T09:00:00Z'),
    statusChangedAt: new Date('2026-07-15T09:00:00Z'),
    lastSeenAt: new Date('2026-07-15T09:00:00Z'),
    lastKnownSize: 100,
    ...overrides,
  };
}

describe('InMemoryStateRepository', () => {
  it('returns null for an unknown (interfaceId, filePath)', async () => {
    const repo = new InMemoryStateRepository();
    expect(await repo.get('SA-034', '/inbound/foo.csv')).toBeNull();
  });

  it('returns a saved state by (interfaceId, filePath)', async () => {
    const repo = new InMemoryStateRepository();
    const state = makeState();
    await repo.save(state);
    expect(await repo.get('SA-034', '/inbound/foo.csv')).toEqual(state);
  });

  it('does not confuse the same file path across different interfaces', async () => {
    const repo = new InMemoryStateRepository();
    await repo.save(makeState({ interfaceId: 'SA-034' }));
    expect(await repo.get('SA-999', '/inbound/foo.csv')).toBeNull();
  });

  it('findByInterface returns all states for that interface only', async () => {
    const repo = new InMemoryStateRepository();
    await repo.save(makeState({ interfaceId: 'SA-034', filePath: '/inbound/a.csv' }));
    await repo.save(makeState({ interfaceId: 'SA-034', filePath: '/inbound/b.csv' }));
    await repo.save(makeState({ interfaceId: 'SA-999', filePath: '/inbound/c.csv' }));

    const results = await repo.findByInterface('SA-034');
    expect(results).toHaveLength(2);
    expect(results.map((s) => s.filePath).sort()).toEqual(['/inbound/a.csv', '/inbound/b.csv']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/state/in-memory-state-repository.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the `StateRepository` interface and `WatcherState` type**

`apps/watcher/src/engine/state/state-repository.ts`:
```ts
import type { FileStatus } from '@integration-engine/contracts';

export interface WatcherState {
  interfaceId: string;
  filePath: string;
  currentStatus: FileStatus;
  previousStatus: FileStatus | null;
  batchId: string;
  firstDetectedAt: Date;
  statusChangedAt: Date;
  lastSeenAt: Date;
  lastKnownSize: number;
}

export interface StateRepository {
  get(interfaceId: string, filePath: string): Promise<WatcherState | null>;
  save(state: WatcherState): Promise<void>;
  findByInterface(interfaceId: string): Promise<WatcherState[]>;
}
```

- [ ] **Step 4: Write the in-memory implementation**

`apps/watcher/src/engine/state/in-memory-state-repository.ts`:
```ts
import type { StateRepository, WatcherState } from './state-repository';

export class InMemoryStateRepository implements StateRepository {
  private readonly store = new Map<string, WatcherState>();

  private key(interfaceId: string, filePath: string): string {
    return `${interfaceId}::${filePath}`;
  }

  async get(interfaceId: string, filePath: string): Promise<WatcherState | null> {
    return this.store.get(this.key(interfaceId, filePath)) ?? null;
  }

  async save(state: WatcherState): Promise<void> {
    this.store.set(this.key(state.interfaceId, state.filePath), state);
  }

  async findByInterface(interfaceId: string): Promise<WatcherState[]> {
    return Array.from(this.store.values()).filter((s) => s.interfaceId === interfaceId);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/state/in-memory-state-repository.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/engine/state
git commit -m "feat(watcher): add StateRepository interface and in-memory implementation"
```

---

### Task 7: `state-transition.policy.ts`

**Files:**
- Create: `apps/watcher/src/engine/state-transition.policy.ts`
- Create: `apps/watcher/src/engine/state-transition.policy.test.ts`

**Interfaces:**
- Consumes: `FileStatus`, `InvalidStateTransitionError` from `@integration-engine/contracts`.
- Produces: `assertValidTransition(from: FileStatus | null, to: FileStatus): void` — used by `watcher-engine.ts` (Task 13) and `missing-sla-sweep.ts` (Task 14).

- [ ] **Step 1: Write the failing test**

`apps/watcher/src/engine/state-transition.policy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '@integration-engine/contracts';
import { assertValidTransition } from './state-transition.policy';

describe('assertValidTransition', () => {
  const validCases: Array<[string | null, string]> = [
    [null, 'FILE_DETECTED'],
    [null, 'FILE_MISSING_BY_SLA'],
    ['FILE_DETECTED', 'FILE_STABLE'],
    ['FILE_DETECTED', 'FILE_STUCK'],
    ['FILE_STABLE', 'FILE_DUPLICATE'],
    ['FILE_STUCK', 'FILE_STABLE'],
  ];

  it.each(validCases)('allows %s -> %s', (from, to) => {
    expect(() =>
      assertValidTransition(from as any, to as any)
    ).not.toThrow();
  });

  const invalidCases: Array<[string | null, string]> = [
    ['FILE_STABLE', 'FILE_DETECTED'],
    ['FILE_DUPLICATE', 'FILE_STABLE'],
    ['FILE_STUCK', 'FILE_DUPLICATE'],
    ['FILE_DETECTED', 'FILE_MISSING_BY_SLA'],
    [null, 'FILE_STABLE'],
  ];

  it.each(invalidCases)('rejects %s -> %s', (from, to) => {
    expect(() => assertValidTransition(from as any, to as any)).toThrow(
      InvalidStateTransitionError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/state-transition.policy.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/state-transition.policy.ts`:
```ts
import type { FileStatus } from '@integration-engine/contracts';
import { InvalidStateTransitionError } from '@integration-engine/contracts';

const NONE = '(none)';

const VALID_TRANSITIONS: Record<string, FileStatus[]> = {
  [NONE]: ['FILE_DETECTED', 'FILE_MISSING_BY_SLA'],
  FILE_DETECTED: ['FILE_STABLE', 'FILE_STUCK'],
  FILE_STABLE: ['FILE_DUPLICATE'],
  FILE_STUCK: ['FILE_STABLE'],
  FILE_DUPLICATE: [],
  FILE_MISSING_BY_SLA: [],
};

export function assertValidTransition(from: FileStatus | null, to: FileStatus): void {
  const key = from ?? NONE;
  const allowed = VALID_TRANSITIONS[key] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/state-transition.policy.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/state-transition.policy.ts apps/watcher/src/engine/state-transition.policy.test.ts
git commit -m "feat(watcher): add state transition policy"
```

---

### Task 8: `batch-id.generator.ts` and `event-builder.ts`

**Files:**
- Create: `apps/watcher/src/engine/batch-id.generator.ts`
- Create: `apps/watcher/src/engine/batch-id.generator.test.ts`
- Create: `apps/watcher/src/engine/event-builder.ts`
- Create: `apps/watcher/src/engine/event-builder.test.ts`

**Interfaces:**
- Consumes: `FileObservation`, `FileEvent`, `FileStatus` from `@integration-engine/contracts`.
- Produces: `generateBatchId(): string`, `buildFileEvent(observation, status, batchId, now): FileEvent` — both used by `watcher-engine.ts` (Task 13).

- [ ] **Step 1: Write the failing test for batch-id generator**

`apps/watcher/src/engine/batch-id.generator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generateBatchId } from './batch-id.generator';

describe('generateBatchId', () => {
  it('returns a non-empty string', () => {
    expect(generateBatchId().length).toBeGreaterThan(0);
  });

  it('returns a different id on each call', () => {
    expect(generateBatchId()).not.toBe(generateBatchId());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/batch-id.generator.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/batch-id.generator.ts`:
```ts
import { randomUUID } from 'node:crypto';

export function generateBatchId(): string {
  return randomUUID();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/batch-id.generator.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing test for event builder**

`apps/watcher/src/engine/event-builder.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation } from '@integration-engine/contracts';
import { buildFileEvent } from './event-builder';

describe('buildFileEvent', () => {
  const observation: FileObservation = {
    interfaceId: 'SA-034',
    path: '/inbound/foo.csv',
    size: 100,
    mtime: new Date('2026-07-15T09:00:00Z'),
  };
  const now = new Date('2026-07-15T09:05:00Z');

  it('builds a FileEvent from the observation, status, and batchId', () => {
    const event = buildFileEvent(observation, 'FILE_STABLE', 'batch-1', now);
    expect(event.eventType).toBe('FILE_STABLE');
    expect(event.batchId).toBe('batch-1');
    expect(event.interfaceId).toBe('SA-034');
    expect(event.filePath).toBe('/inbound/foo.csv');
    expect(event.occurredAt).toEqual(now);
    expect(event.eventId.length).toBeGreaterThan(0);
  });

  it('generates a fresh eventId each call', () => {
    const first = buildFileEvent(observation, 'FILE_STABLE', 'batch-1', now);
    const second = buildFileEvent(observation, 'FILE_STABLE', 'batch-1', now);
    expect(first.eventId).not.toBe(second.eventId);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/event-builder.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Write minimal implementation**

`apps/watcher/src/engine/event-builder.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { FileEvent, FileObservation, FileStatus } from '@integration-engine/contracts';

export function buildFileEvent(
  observation: FileObservation,
  status: FileStatus,
  batchId: string,
  now: Date
): FileEvent {
  return {
    eventId: randomUUID(),
    eventType: status,
    batchId,
    interfaceId: observation.interfaceId,
    filePath: observation.path,
    occurredAt: now,
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/event-builder.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/watcher/src/engine/batch-id.generator.ts apps/watcher/src/engine/batch-id.generator.test.ts apps/watcher/src/engine/event-builder.ts apps/watcher/src/engine/event-builder.test.ts
git commit -m "feat(watcher): add batch id generator and event builder"
```

---

### Task 9: `interface-matcher.ts`

**Files:**
- Create: `apps/watcher/src/engine/interface-matcher.ts`
- Create: `apps/watcher/src/engine/interface-matcher.test.ts`

**Interfaces:**
- Consumes: `FileObservation`, `InterfaceConfig`, `InterfaceMismatchError` from `@integration-engine/contracts`.
- Produces: `assertInterfaceMatch(observation, config): void` — used by `watcher-engine.ts` (Task 13). See "Refinements" note #2 above for why this throws instead of returning a boolean.

- [ ] **Step 1: Write the failing test**

`apps/watcher/src/engine/interface-matcher.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import { InterfaceMismatchError } from '@integration-engine/contracts';
import { assertInterfaceMatch } from './interface-matcher';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/ag-doc/vendor-invoice/inbound/',
  filePattern: 'VendorInvoice_*.xlsx',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

describe('assertInterfaceMatch', () => {
  it('does not throw when observation.interfaceId matches config.interfaceId', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/VendorInvoice_1.xlsx',
      size: 100,
      mtime: new Date(),
    };
    expect(() => assertInterfaceMatch(observation, config)).not.toThrow();
  });

  it('throws InterfaceMismatchError when interfaceId differs', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-999',
      path: '/inbound/VendorInvoice_1.xlsx',
      size: 100,
      mtime: new Date(),
    };
    expect(() => assertInterfaceMatch(observation, config)).toThrow(InterfaceMismatchError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/interface-matcher.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/interface-matcher.ts`:
```ts
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import { InterfaceMismatchError } from '@integration-engine/contracts';

export function assertInterfaceMatch(observation: FileObservation, config: InterfaceConfig): void {
  if (observation.interfaceId !== config.interfaceId) {
    throw new InterfaceMismatchError(observation.path, config.interfaceId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/interface-matcher.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/interface-matcher.ts apps/watcher/src/engine/interface-matcher.test.ts
git commit -m "feat(watcher): add interface matcher guard"
```

---

### Task 10: Rule type and `duplicate.rule.ts`

**Files:**
- Create: `apps/watcher/src/engine/rules/rule.ts`
- Create: `apps/watcher/src/engine/rules/duplicate.rule.ts`
- Create: `apps/watcher/src/engine/rules/duplicate.rule.test.ts`

**Interfaces:**
- Consumes: `FileObservation`, `InterfaceConfig`, `FileStatus` from contracts; `WatcherState` from Task 6.
- Produces: `Rule` type, `RuleOutcome` type, `TERMINAL_STATUSES` constant, `duplicateRule: Rule` — `Rule` and `TERMINAL_STATUSES` are reused by Tasks 11–12; `duplicateRule` is one of three entries in the pipeline array built in Task 13.

- [ ] **Step 1: Write the shared rule type (no test — type-only, verified by compilation in later steps)**

`apps/watcher/src/engine/rules/rule.ts`:
```ts
import type { FileObservation, FileStatus, InterfaceConfig } from '@integration-engine/contracts';
import type { WatcherState } from '../state/state-repository';

export interface RuleOutcome {
  status: FileStatus;
}

export type Rule = (
  observation: FileObservation,
  state: WatcherState | null,
  config: InterfaceConfig,
  now: Date
) => RuleOutcome | null;

export const TERMINAL_STATUSES: FileStatus[] = ['FILE_STABLE', 'FILE_DUPLICATE'];
```

- [ ] **Step 2: Write the failing test for duplicate.rule.ts**

`apps/watcher/src/engine/rules/duplicate.rule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import type { WatcherState } from '../state/state-repository';
import { duplicateRule } from './duplicate.rule';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

const observation: FileObservation = {
  interfaceId: 'SA-034',
  path: '/inbound/foo.csv',
  size: 100,
  mtime: new Date('2026-07-15T09:00:00Z'),
};

const now = new Date('2026-07-15T10:00:00Z');

function makeState(overrides: Partial<WatcherState> = {}): WatcherState {
  return {
    interfaceId: 'SA-034',
    filePath: '/inbound/foo.csv',
    currentStatus: 'FILE_STABLE',
    previousStatus: 'FILE_DETECTED',
    batchId: 'batch-1',
    firstDetectedAt: new Date('2026-07-15T08:00:00Z'),
    statusChangedAt: new Date('2026-07-15T08:31:00Z'),
    lastSeenAt: new Date('2026-07-15T08:31:00Z'),
    lastKnownSize: 100,
    ...overrides,
  };
}

describe('duplicateRule', () => {
  it('returns null when there is no prior state', () => {
    expect(duplicateRule(observation, null, config, now)).toBeNull();
  });

  it('fires FILE_DUPLICATE when prior status is FILE_STABLE', () => {
    const result = duplicateRule(observation, makeState({ currentStatus: 'FILE_STABLE' }), config, now);
    expect(result).toEqual({ status: 'FILE_DUPLICATE' });
  });

  it('fires FILE_DUPLICATE when prior status is FILE_DUPLICATE', () => {
    const result = duplicateRule(observation, makeState({ currentStatus: 'FILE_DUPLICATE' }), config, now);
    expect(result).toEqual({ status: 'FILE_DUPLICATE' });
  });

  it('returns null when prior status is non-terminal (FILE_DETECTED)', () => {
    const result = duplicateRule(observation, makeState({ currentStatus: 'FILE_DETECTED' }), config, now);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/rules/duplicate.rule.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Write minimal implementation**

`apps/watcher/src/engine/rules/duplicate.rule.ts`:
```ts
import { TERMINAL_STATUSES, type Rule } from './rule';

export const duplicateRule: Rule = (observation, state, _config, _now) => {
  if (!state) return null;
  if (!TERMINAL_STATUSES.includes(state.currentStatus)) return null;
  if (state.filePath !== observation.path) return null;
  return { status: 'FILE_DUPLICATE' };
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/rules/duplicate.rule.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/engine/rules/rule.ts apps/watcher/src/engine/rules/duplicate.rule.ts apps/watcher/src/engine/rules/duplicate.rule.test.ts
git commit -m "feat(watcher): add rule pipeline type and duplicate rule"
```

---

### Task 11: `stuck-file.rule.ts`

**Files:**
- Create: `apps/watcher/src/engine/rules/stuck-file.rule.ts`
- Create: `apps/watcher/src/engine/rules/stuck-file.rule.test.ts`

**Interfaces:**
- Consumes: `Rule`, `TERMINAL_STATUSES` from Task 10; `FakeClock` from Task 5 (used in tests only, rule itself takes plain `Date`).
- Produces: `stuckFileRule: Rule` — second entry in the pipeline array (Task 13).

- [ ] **Step 1: Write the failing test**

`apps/watcher/src/engine/rules/stuck-file.rule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import type { WatcherState } from '../state/state-repository';
import { stuckFileRule } from './stuck-file.rule';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

const observation: FileObservation = {
  interfaceId: 'SA-034',
  path: '/inbound/foo.csv',
  size: 100,
  mtime: new Date('2026-07-15T08:00:00Z'),
};

function makeState(overrides: Partial<WatcherState> = {}): WatcherState {
  return {
    interfaceId: 'SA-034',
    filePath: '/inbound/foo.csv',
    currentStatus: 'FILE_DETECTED',
    previousStatus: null,
    batchId: 'batch-1',
    firstDetectedAt: new Date('2026-07-15T08:00:00Z'),
    statusChangedAt: new Date('2026-07-15T08:00:00Z'),
    lastSeenAt: new Date('2026-07-15T08:00:00Z'),
    lastKnownSize: 100,
    ...overrides,
  };
}

describe('stuckFileRule', () => {
  it('returns null when there is no prior state', () => {
    expect(stuckFileRule(observation, null, config, new Date('2026-07-15T10:00:00Z'))).toBeNull();
  });

  it('returns null when elapsed time is under the threshold', () => {
    const now = new Date('2026-07-15T08:30:00Z');
    expect(stuckFileRule(observation, makeState(), config, now)).toBeNull();
  });

  it('fires FILE_STUCK when elapsed time meets the threshold and status is non-terminal', () => {
    const now = new Date('2026-07-15T09:00:00Z');
    expect(stuckFileRule(observation, makeState(), config, now)).toEqual({ status: 'FILE_STUCK' });
  });

  it('returns null when status is already terminal (FILE_STABLE)', () => {
    const now = new Date('2026-07-15T09:00:00Z');
    const state = makeState({ currentStatus: 'FILE_STABLE' });
    expect(stuckFileRule(observation, state, config, now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/rules/stuck-file.rule.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/rules/stuck-file.rule.ts`:
```ts
import { TERMINAL_STATUSES, type Rule } from './rule';

export const stuckFileRule: Rule = (_observation, state, config, now) => {
  if (!state) return null;
  if (TERMINAL_STATUSES.includes(state.currentStatus)) return null;
  const elapsedSeconds = (now.getTime() - state.firstDetectedAt.getTime()) / 1000;
  if (elapsedSeconds < config.stuckThresholdSeconds) return null;
  return { status: 'FILE_STUCK' };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/rules/stuck-file.rule.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/rules/stuck-file.rule.ts apps/watcher/src/engine/rules/stuck-file.rule.test.ts
git commit -m "feat(watcher): add stuck-file rule"
```

---

### Task 12: `stability.rule.ts`

**Files:**
- Create: `apps/watcher/src/engine/rules/stability.rule.ts`
- Create: `apps/watcher/src/engine/rules/stability.rule.test.ts`

**Interfaces:**
- Consumes: `Rule` from Task 10.
- Produces: `stabilityRule: Rule` — third entry in the pipeline array (Task 13).

- [ ] **Step 1: Write the failing test**

`apps/watcher/src/engine/rules/stability.rule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import type { WatcherState } from '../state/state-repository';
import { stabilityRule } from './stability.rule';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

function makeState(overrides: Partial<WatcherState> = {}): WatcherState {
  return {
    interfaceId: 'SA-034',
    filePath: '/inbound/foo.csv',
    currentStatus: 'FILE_DETECTED',
    previousStatus: null,
    batchId: 'batch-1',
    firstDetectedAt: new Date('2026-07-15T08:00:00Z'),
    statusChangedAt: new Date('2026-07-15T08:00:00Z'),
    lastSeenAt: new Date('2026-07-15T08:00:00Z'),
    lastKnownSize: 100,
    ...overrides,
  };
}

describe('stabilityRule', () => {
  it('returns null when there is no prior state', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    expect(stabilityRule(observation, null, config, new Date('2026-07-15T08:01:00Z'))).toBeNull();
  });

  it('returns null when status is not FILE_DETECTED', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ currentStatus: 'FILE_STUCK' });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:01:00Z'))).toBeNull();
  });

  it('returns null when size changed since last seen', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 200,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ lastKnownSize: 100 });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:01:00Z'))).toBeNull();
  });

  it('returns null when size unchanged but under the stability window', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ lastKnownSize: 100, statusChangedAt: new Date('2026-07-15T08:00:00Z') });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:00:10Z'))).toBeNull();
  });

  it('fires FILE_STABLE when size unchanged and stability window elapsed', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ lastKnownSize: 100, statusChangedAt: new Date('2026-07-15T08:00:00Z') });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:00:30Z'))).toEqual({
      status: 'FILE_STABLE',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/rules/stability.rule.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/rules/stability.rule.ts`:
```ts
import type { Rule } from './rule';

export const stabilityRule: Rule = (observation, state, config, now) => {
  if (!state) return null;
  if (state.currentStatus !== 'FILE_DETECTED') return null;
  if (state.lastKnownSize !== observation.size) return null;
  const elapsedSeconds = (now.getTime() - state.statusChangedAt.getTime()) / 1000;
  if (elapsedSeconds < config.stabilityCheckSeconds) return null;
  return { status: 'FILE_STABLE' };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/rules/stability.rule.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/rules/stability.rule.ts apps/watcher/src/engine/rules/stability.rule.test.ts
git commit -m "feat(watcher): add stability rule"
```

---

### Task 13: `watcher-engine.ts` — `processObservation`

**Files:**
- Create: `apps/watcher/src/engine/watcher-engine.ts`
- Create: `apps/watcher/src/engine/watcher-engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–12 — `StateRepository`/`InMemoryStateRepository`, `assertValidTransition`, `generateBatchId`, `buildFileEvent`, `assertInterfaceMatch`, `duplicateRule`, `stuckFileRule`, `stabilityRule`.
- Produces: `processObservation(observation, interfaceConfig, stateRepo, now?): Promise<FileEvent | null>` — the engine's main entry point.

- [ ] **Step 1: Write the failing tests**

`apps/watcher/src/engine/watcher-engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@integration-engine/contracts';
import { InterfaceMismatchError } from '@integration-engine/contracts';
import { InMemoryStateRepository } from './state/in-memory-state-repository';
import { processObservation } from './watcher-engine';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

function observationAt(now: Date, size = 100): FileObservation {
  return { interfaceId: 'SA-034', path: '/inbound/foo.csv', size, mtime: now };
}

describe('processObservation', () => {
  it('emits FILE_DETECTED for a brand-new file and persists state', async () => {
    const repo = new InMemoryStateRepository();
    const now = new Date('2026-07-15T08:00:00Z');

    const event = await processObservation(observationAt(now), config, repo, now);

    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('FILE_DETECTED');
    expect(event!.filePath).toBe('/inbound/foo.csv');

    const state = await repo.get('SA-034', '/inbound/foo.csv');
    expect(state!.currentStatus).toBe('FILE_DETECTED');
    expect(state!.batchId).toBe(event!.batchId);
  });

  it('emits FILE_STABLE once the stability window elapses with unchanged size', async () => {
    const repo = new InMemoryStateRepository();
    const t0 = new Date('2026-07-15T08:00:00Z');
    await processObservation(observationAt(t0), config, repo, t0);

    const t1 = new Date('2026-07-15T08:00:30Z');
    const event = await processObservation(observationAt(t1), config, repo, t1);

    expect(event!.eventType).toBe('FILE_STABLE');
    const state = await repo.get('SA-034', '/inbound/foo.csv');
    expect(state!.currentStatus).toBe('FILE_STABLE');
    expect(state!.previousStatus).toBe('FILE_DETECTED');
  });

  it('reuses the same batchId across the file lifecycle', async () => {
    const repo = new InMemoryStateRepository();
    const t0 = new Date('2026-07-15T08:00:00Z');
    const first = await processObservation(observationAt(t0), config, repo, t0);

    const t1 = new Date('2026-07-15T08:00:30Z');
    const second = await processObservation(observationAt(t1), config, repo, t1);

    expect(second!.batchId).toBe(first!.batchId);
  });

  it('returns null when re-observed with no meaningful change (still detecting, size unchanged, window not elapsed)', async () => {
    const repo = new InMemoryStateRepository();
    const t0 = new Date('2026-07-15T08:00:00Z');
    await processObservation(observationAt(t0), config, repo, t0);

    const t1 = new Date('2026-07-15T08:00:05Z');
    const event = await processObservation(observationAt(t1), config, repo, t1);

    expect(event).toBeNull();
  });

  it('emits FILE_DUPLICATE when a stable file is observed again', async () => {
    const repo = new InMemoryStateRepository();
    const t0 = new Date('2026-07-15T08:00:00Z');
    await processObservation(observationAt(t0), config, repo, t0);
    const t1 = new Date('2026-07-15T08:00:30Z');
    await processObservation(observationAt(t1), config, repo, t1);

    const t2 = new Date('2026-07-15T09:00:00Z');
    const event = await processObservation(observationAt(t2), config, repo, t2);

    expect(event!.eventType).toBe('FILE_DUPLICATE');
  });

  it('returns null (no-op) when a stuck file is re-observed with the same status, instead of throwing', async () => {
    const repo = new InMemoryStateRepository();
    const t0 = new Date('2026-07-15T08:00:00Z');
    await processObservation(observationAt(t0), config, repo, t0);

    const t1 = new Date('2026-07-15T09:00:00Z');
    const stuckEvent = await processObservation(observationAt(t1), config, repo, t1);
    expect(stuckEvent!.eventType).toBe('FILE_STUCK');

    const t2 = new Date('2026-07-15T09:05:00Z');
    const repeatEvent = await processObservation(observationAt(t2), config, repo, t2);
    expect(repeatEvent).toBeNull();
  });

  it('throws InterfaceMismatchError when observation.interfaceId does not match config', async () => {
    const repo = new InMemoryStateRepository();
    const now = new Date('2026-07-15T08:00:00Z');
    const mismatched = { ...observationAt(now), interfaceId: 'SA-999' };

    await expect(processObservation(mismatched, config, repo, now)).rejects.toThrow(
      InterfaceMismatchError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/watcher-engine.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/watcher-engine.ts`:
```ts
import type { FileEvent, FileObservation, FileStatus, InterfaceConfig } from '@integration-engine/contracts';
import { assertInterfaceMatch } from './interface-matcher';
import type { StateRepository, WatcherState } from './state/state-repository';
import { assertValidTransition } from './state-transition.policy';
import { generateBatchId } from './batch-id.generator';
import { buildFileEvent } from './event-builder';
import type { Rule } from './rules/rule';
import { duplicateRule } from './rules/duplicate.rule';
import { stuckFileRule } from './rules/stuck-file.rule';
import { stabilityRule } from './rules/stability.rule';

const PIPELINE: Rule[] = [duplicateRule, stuckFileRule, stabilityRule];

export async function processObservation(
  observation: FileObservation,
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,
  now: Date = new Date()
): Promise<FileEvent | null> {
  assertInterfaceMatch(observation, interfaceConfig);

  const existingState = await stateRepo.get(observation.interfaceId, observation.path);

  let proposedStatus: FileStatus | null = null;
  for (const rule of PIPELINE) {
    const outcome = rule(observation, existingState, interfaceConfig, now);
    if (outcome) {
      proposedStatus = outcome.status;
      break;
    }
  }

  if (!proposedStatus) {
    if (existingState) {
      return null;
    }
    proposedStatus = 'FILE_DETECTED';
  }

  const currentStatus = existingState ? existingState.currentStatus : null;

  if (proposedStatus === currentStatus) {
    return null;
  }

  assertValidTransition(currentStatus, proposedStatus);

  const batchId = existingState ? existingState.batchId : generateBatchId();

  const newState: WatcherState = {
    interfaceId: observation.interfaceId,
    filePath: observation.path,
    currentStatus: proposedStatus,
    previousStatus: currentStatus,
    batchId,
    firstDetectedAt: existingState ? existingState.firstDetectedAt : now,
    statusChangedAt: now,
    lastSeenAt: now,
    lastKnownSize: observation.size,
  };

  await stateRepo.save(newState);

  return buildFileEvent(observation, proposedStatus, batchId, now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/watcher-engine.test.ts`
Expected: PASS, 7 tests.

Note: there's no test here that drives `processObservation` into `assertValidTransition`'s throwing branch. Tracing the pipeline shows it's unreachable via legitimate rule output — every rule's own guard condition already matches the valid-transition table one-for-one (`duplicateRule` only fires from a terminal status, matching `FILE_STABLE → FILE_DUPLICATE`; `stuckFileRule` and `stabilityRule` only fire from `FILE_DETECTED`, matching the two transitions allowed out of it). The throwing behavior itself is already covered directly in Task 7's `state-transition.policy.test.ts`. `assertValidTransition`'s call here is a defensive invariant check, not a reachable branch — worth knowing if a future rule change ever needs to violate it deliberately.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/watcher-engine.ts apps/watcher/src/engine/watcher-engine.test.ts
git commit -m "feat(watcher): add processObservation engine entry point"
```

---

### Task 14: `missing-sla-sweep.ts` — `checkMissingSla`

**Files:**
- Create: `apps/watcher/src/engine/missing-sla-sweep.ts`
- Create: `apps/watcher/src/engine/missing-sla-sweep.test.ts`

**Interfaces:**
- Consumes: `StateRepository`/`WatcherState` from Task 6, `assertValidTransition` from Task 7, `generateBatchId` from Task 8.
- Produces: `checkMissingSla(interfaceConfig, stateRepo, now): Promise<FileEvent[]>` — the second engine entry point, called once per interface per scheduler cycle (caller out of scope).

`slaDeadline` is `"HH:mm"` local time. The sweep uses a sentinel state row (`filePath: '__sla_window__'`) to remember "already reported today," per Refinement #5 above.

- [ ] **Step 1: Write the failing tests**

`apps/watcher/src/engine/missing-sla-sweep.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { InterfaceConfig } from '@integration-engine/contracts';
import { InMemoryStateRepository } from './state/in-memory-state-repository';
import { checkMissingSla } from './missing-sla-sweep';
import { processObservation } from './watcher-engine';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  stabilityCheckSeconds: 30,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

describe('checkMissingSla', () => {
  it('returns no events before the deadline has passed', async () => {
    const repo = new InMemoryStateRepository();
    const before = new Date('2026-07-15T08:59:00Z');
    expect(await checkMissingSla(config, repo, before)).toEqual([]);
  });

  it('returns no events after the deadline if a file arrived today', async () => {
    const repo = new InMemoryStateRepository();
    const arrival = new Date('2026-07-15T07:00:00Z');
    await processObservation(
      { interfaceId: 'SA-034', path: '/inbound/foo.csv', size: 100, mtime: arrival },
      config,
      repo,
      arrival
    );

    const afterDeadline = new Date('2026-07-15T09:30:00Z');
    expect(await checkMissingSla(config, repo, afterDeadline)).toEqual([]);
  });

  it('emits FILE_MISSING_BY_SLA after the deadline if nothing arrived today', async () => {
    const repo = new InMemoryStateRepository();
    const afterDeadline = new Date('2026-07-15T09:30:00Z');

    const events = await checkMissingSla(config, repo, afterDeadline);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('FILE_MISSING_BY_SLA');
    expect(events[0].filePath).toBeNull();
    expect(events[0].interfaceId).toBe('SA-034');
  });

  it('does not re-emit for the same day on a second sweep', async () => {
    const repo = new InMemoryStateRepository();
    const firstSweep = new Date('2026-07-15T09:30:00Z');
    const first = await checkMissingSla(config, repo, firstSweep);
    expect(first).toHaveLength(1);

    const secondSweep = new Date('2026-07-15T10:00:00Z');
    const second = await checkMissingSla(config, repo, secondSweep);
    expect(second).toEqual([]);
  });

  it('emits again on a later day if still nothing has arrived', async () => {
    const repo = new InMemoryStateRepository();
    const day1 = new Date('2026-07-15T09:30:00Z');
    await checkMissingSla(config, repo, day1);

    const day2 = new Date('2026-07-16T09:30:00Z');
    const events = await checkMissingSla(config, repo, day2);
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/engine/missing-sla-sweep.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`apps/watcher/src/engine/missing-sla-sweep.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { FileEvent, InterfaceConfig } from '@integration-engine/contracts';
import type { StateRepository, WatcherState } from './state/state-repository';
import { assertValidTransition } from './state-transition.policy';
import { generateBatchId } from './batch-id.generator';

const SLA_SENTINEL_PATH = '__sla_window__';

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function todaysDeadline(slaDeadline: string, now: Date): Date {
  const [hours, minutes] = slaDeadline.split(':').map(Number);
  const deadline = new Date(now);
  deadline.setUTCHours(hours, minutes, 0, 0);
  return deadline;
}

export async function checkMissingSla(
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,
  now: Date
): Promise<FileEvent[]> {
  const deadline = todaysDeadline(interfaceConfig.slaDeadline, now);
  if (now < deadline) {
    return [];
  }

  const states = await stateRepo.findByInterface(interfaceConfig.interfaceId);
  const arrivedToday = states.some(
    (s) => s.filePath !== SLA_SENTINEL_PATH && isSameLocalDay(s.firstDetectedAt, now)
  );
  if (arrivedToday) {
    return [];
  }

  const existingSentinel = await stateRepo.get(interfaceConfig.interfaceId, SLA_SENTINEL_PATH);
  if (
    existingSentinel &&
    existingSentinel.currentStatus === 'FILE_MISSING_BY_SLA' &&
    isSameLocalDay(existingSentinel.statusChangedAt, now)
  ) {
    return [];
  }

  const currentSentinelStatus = existingSentinel ? existingSentinel.currentStatus : null;
  assertValidTransition(currentSentinelStatus, 'FILE_MISSING_BY_SLA');

  const batchId = generateBatchId();
  const newState: WatcherState = {
    interfaceId: interfaceConfig.interfaceId,
    filePath: SLA_SENTINEL_PATH,
    currentStatus: 'FILE_MISSING_BY_SLA',
    previousStatus: currentSentinelStatus,
    batchId,
    firstDetectedAt: now,
    statusChangedAt: now,
    lastSeenAt: now,
    lastKnownSize: 0,
  };
  await stateRepo.save(newState);

  const event: FileEvent = {
    eventId: randomUUID(),
    eventType: 'FILE_MISSING_BY_SLA',
    batchId,
    interfaceId: interfaceConfig.interfaceId,
    filePath: null,
    occurredAt: now,
  };

  return [event];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/engine/missing-sla-sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/watcher/src/engine/missing-sla-sweep.ts apps/watcher/src/engine/missing-sla-sweep.test.ts
git commit -m "feat(watcher): add missing-sla sweep entry point"
```

---

### Task 15: Full workspace verification

**Files:** none created — verification only.

- [ ] **Step 1: Type-check every workspace package**

Run: `npx tsc --build packages/contracts packages/testing apps/watcher`
Expected: exits 0, no errors. (First run creates `.tsbuildinfo` files — do not commit those; confirm `.gitignore` covers `*.tsbuildinfo` and add it if missing.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all test files across `packages/` and `apps/watcher/` pass — 13 test files, 53 tests total (Tasks 3, 5–14 combined).

- [ ] **Step 3: Confirm root legacy app still builds (untouched by this work)**

Run: `npm run build && npm start`
Expected: same output as before this plan — `Integration Engine initialized`, `Build verification successful`, exit 0.

- [ ] **Step 4: Add `*.tsbuildinfo` to `.gitignore` if Step 1 created any and it's not already ignored**

Check: `git status --short | grep tsbuildinfo`
If any appear, add to `.gitignore`:
```
*.tsbuildinfo
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(watcher): verify full workspace build and test suite"
```
