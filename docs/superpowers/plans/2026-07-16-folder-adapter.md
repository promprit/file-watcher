# Folder Adapter Implementation Plan

> **⚠️ HISTORICAL (2026-07-17):** this plan was executed against the TypeScript reference implementation. The production architecture has since pivoted to a D365-native build — see [2026-07-17-d365-native-implementation.md](2026-07-17-d365-native-implementation.md) and the [D365-native design spec](../specs/2026-07-17-d365-native-architecture-design.md). The code this plan produced is now part of the frozen executable reference spec.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the common `Adapter` contract and its first implementation, `folder.adapter.ts` — the Watcher's simplest file-source adapter, needing no `ConnectionManager`/`SecretProvider`.

**Architecture:** `adapter.ts` defines `ConnectionContext`, `InterfaceScope`, the `Adapter` interface, and a shared `AdapterError`. `folder/folder.adapter.ts` implements `Adapter` for local/network folders: list a directory, filter by regex, stat each match, return `FileObservation[]`. No state, no secrets, no lifecycle decisions — those stay in the already-built Watcher Engine.

**Tech Stack:** TypeScript (strict), Vitest, Node's `fs.promises`/`path`/`os` (no new dependencies).

**Source spec:** [`docs/superpowers/specs/2026-07-16-folder-adapter-design.md`](../specs/2026-07-16-folder-adapter-design.md)

## Global Constraints

- TypeScript strict mode, Vitest test framework (matches the rest of `apps/watcher`).
- `Adapter.observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]>` — `FileObservation` imported from `@packages/contracts` (already exported from its barrel).
- `ConnectionContext.endpoint` + `InterfaceScope.inboundPath` are joined via `path.join()` to get the real directory — this is the one piece of resolution logic worth testing directly.
- No comparison against prior state, no secrets, no batch IDs, no lifecycle decisions inside the adapter — it returns every currently-matching file, every call, and lets the Watcher Engine (already built) decide what's meaningful.
- Directory entries that aren't regular files (subdirectories) are excluded — no recursive traversal in this MVP.
- Real `fs` errors on the initial directory listing propagate as `AdapterError` (not swallowed, not retried inside the adapter).
- A file that disappears between `readdir` and `stat` (a real race under active polling) is skipped, not treated as an error — the rest of the scan continues.
- Testing uses the real filesystem (temp directories via `fs.mkdtempSync`), not mocks — except for the one deletion-race case, which needs a `stat` mock since a true race can't be reliably reproduced by timing alone.

---

### Task 1: Adapter contract (`adapter.ts`)

**Files:**
- Create: `apps/watcher/src/adapters/adapter.ts`
- Create: `apps/watcher/src/adapters/adapter.test.ts`

**Interfaces:**
- Consumes: `FileObservation` from `@packages/contracts`.
- Produces: `ConnectionContext`, `InterfaceScope`, `Adapter` interface, `AdapterError` class — all imported by Task 2's `folder.adapter.ts`.

`ConnectionContext`/`InterfaceScope`/`Adapter` are type-only declarations with no runtime behavior — verified by compilation, not a Vitest assertion. `AdapterError` has real behavior (message construction) and gets a TDD cycle.

- [ ] **Step 1: Write the failing test for `AdapterError`**

`apps/watcher/src/adapters/adapter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AdapterError } from './adapter';

describe('AdapterError', () => {
  it('includes connectionRef, interfaceId, and the cause message', () => {
    const cause = new Error('ENOENT: no such file or directory');
    const err = new AdapterError('folder-conn-1', 'SA-034', cause);

    expect(err.name).toBe('AdapterError');
    expect(err.connectionRef).toBe('folder-conn-1');
    expect(err.interfaceId).toBe('SA-034');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('folder-conn-1');
    expect(err.message).toContain('SA-034');
    expect(err.message).toContain('ENOENT');
  });

  it('stringifies a non-Error cause', () => {
    const err = new AdapterError('folder-conn-1', 'SA-034', 'plain string cause');
    expect(err.message).toContain('plain string cause');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/adapters/adapter.test.ts`
Expected: FAIL — `adapter.ts` doesn't exist.

- [ ] **Step 3: Write the implementation**

`apps/watcher/src/adapters/adapter.ts`:
```ts
import type { FileObservation } from '@packages/contracts';

export interface ConnectionContext {
  connectionRef: string;
  storageType: string;
  endpoint: string;
}

export interface InterfaceScope {
  interfaceId: string;
  inboundPath: string;
  filePattern: string;
}

export interface Adapter {
  observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]>;
}

export class AdapterError extends Error {
  constructor(
    public readonly connectionRef: string,
    public readonly interfaceId: string,
    public readonly cause: unknown
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Adapter error for interface ${interfaceId} (connection ${connectionRef}): ${causeMessage}`
    );
    this.name = 'AdapterError';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/adapters/adapter.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/watcher/tsconfig.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/adapters/adapter.ts apps/watcher/src/adapters/adapter.test.ts
git commit -m "feat(watcher): add Adapter contract and AdapterError"
```

---

### Task 2: Folder adapter implementation

**Files:**
- Create: `apps/watcher/src/adapters/folder/folder.adapter.ts`
- Create: `apps/watcher/src/adapters/folder/folder.adapter.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `ConnectionContext`, `InterfaceScope`, `AdapterError` from `../adapter` (Task 1). `FileObservation` from `@packages/contracts`.
- Produces: `folderAdapter: Adapter` — the concrete implementation; this is the deliverable of this plan.

- [ ] **Step 1: Write the failing tests**

`apps/watcher/src/adapters/folder/folder.adapter.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AdapterError, type ConnectionContext, type InterfaceScope } from '../adapter';
import { folderAdapter } from './folder.adapter';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-adapter-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeScope(overrides: Partial<InterfaceScope> = {}): InterfaceScope {
  return {
    interfaceId: 'SA-034',
    inboundPath: '.',
    filePattern: '.*\\.csv$',
    ...overrides,
  };
}

function makeContext(endpoint: string): ConnectionContext {
  return {
    connectionRef: 'folder-conn-1',
    storageType: 'FOLDER',
    endpoint,
  };
}

describe('folderAdapter.observe', () => {
  it('returns only files matching the pattern, ignoring non-matching names', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'ignore me');

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'invoice_1.csv'));
  });

  it('ignores subdirectories even if the name matches the pattern', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    fs.mkdirSync(path.join(tempDir, 'archive.csv'));

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'invoice_1.csv'));
  });

  it('returns correct size, mtime, path, and interfaceId', async () => {
    const filePath = path.join(tempDir, 'invoice_1.csv');
    fs.writeFileSync(filePath, '12345');
    const stats = fs.statSync(filePath);

    const result = await folderAdapter.observe(
      makeContext(tempDir),
      makeScope({ interfaceId: 'SA-099' })
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      interfaceId: 'SA-099',
      path: filePath,
      size: 5,
      mtime: stats.mtime,
    });
  });

  it('resolves inboundPath as a subdirectory under endpoint', async () => {
    const subDir = path.join(tempDir, 'inbound');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'invoice_1.csv'), 'a');

    const result = await folderAdapter.observe(
      makeContext(tempDir),
      makeScope({ inboundPath: 'inbound' })
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(subDir, 'invoice_1.csv'));
  });

  it('throws AdapterError when the directory does not exist', async () => {
    await expect(
      folderAdapter.observe(makeContext(path.join(tempDir, 'does-not-exist')), makeScope())
    ).rejects.toThrow(AdapterError);
  });

  it('skips a file that no longer exists by the time stat is called, instead of throwing', async () => {
    fs.writeFileSync(path.join(tempDir, 'ghost.csv'), 'a');
    fs.writeFileSync(path.join(tempDir, 'real.csv'), 'b');

    const realStat = fsPromises.stat.bind(fsPromises);
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (p: any, ...rest: any[]) => {
      if (String(p).endsWith('ghost.csv')) {
        const err = new Error('ENOENT: no such file or directory, stat') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return realStat(p, ...rest);
    });

    const result = await folderAdapter.observe(makeContext(tempDir), makeScope());

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(path.join(tempDir, 'real.csv'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/watcher/src/adapters/folder/folder.adapter.test.ts`
Expected: FAIL — `folder.adapter.ts` doesn't exist.

- [ ] **Step 3: Write the implementation**

`apps/watcher/src/adapters/folder/folder.adapter.ts`:
```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileObservation } from '@packages/contracts';
import { AdapterError, type Adapter, type ConnectionContext, type InterfaceScope } from '../adapter';

export const folderAdapter: Adapter = {
  async observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]> {
    const resolvedPath = path.join(context.endpoint, scope.inboundPath);

    let entries: string[];
    try {
      entries = await fs.readdir(resolvedPath);
    } catch (cause) {
      throw new AdapterError(context.connectionRef, scope.interfaceId, cause);
    }

    const pattern = new RegExp(scope.filePattern);
    const matches = entries.filter((name) => pattern.test(name));

    const observations: FileObservation[] = [];
    for (const name of matches) {
      const fullPath = path.join(resolvedPath, name);

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw new AdapterError(context.connectionRef, scope.interfaceId, cause);
      }

      if (!stats.isFile()) {
        continue;
      }

      observations.push({
        interfaceId: scope.interfaceId,
        path: fullPath,
        size: stats.size,
        mtime: stats.mtime,
      });
    }

    return observations;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/watcher/src/adapters/folder/folder.adapter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/watcher/tsconfig.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src/adapters/folder
git commit -m "feat(watcher): add folder adapter"
```

---

### Task 3: Full workspace verification

**Files:** none created — verification only.

- [ ] **Step 1: Run the full fast suite**

Run: `npm test`
Expected: all pass, including the 2 new test files from Tasks 1-2 (8 new tests: 2 + 6).

- [ ] **Step 2: Type-check every workspace package**

Run: `npx tsc --build packages/contracts packages/testing apps/watcher`
Expected: exits 0.

- [ ] **Step 3: Confirm the root legacy app and DB-layer unit tests are unaffected**

Run: `npm run build && npm start`
Expected: `Integration Engine initialized`, `Build verification successful`, exit 0.

- [ ] **Step 4: Commit (only if Step 1-2 needed a fix; otherwise nothing to commit)**
