# Folder Adapter — Design Spec

> **⚠️ SUPERSEDED (2026-07-17):** the architecture pivoted to a D365-native build (Dataverse + Power Platform); this component's production role is replaced per the [D365-native design spec](2026-07-17-d365-native-architecture-design.md). The TypeScript implementation described here remains in-repo as part of the frozen executable reference spec.

**Date:** 2026-07-16
**Status:** Approved (pending final spec review)
**Related:** [docs/monorepo-architecture.md](../../monorepo-architecture.md)

## Context

Next piece of Watcher work after the Engine/contracts reconciliation (merged
upstream as PR #2). Junior dev is wiring the Engine to `PostgresStateRepository`
(replacing `InMemoryStateRepository`) in parallel — this work has no
dependency on that and touches entirely different files.

Three next-step candidates were on the table: (1) Watcher Scheduler, (2)
Gateway DB infrastructure, (3) an adapter. Scheduler was ruled out for now —
it needs at least one real adapter to be end-to-end meaningful, and
`adapters/`, `connection/`, `secrets/`, `gateway-client/` are all still empty
`.gitkeep` stubs. This spec is that missing first adapter — folder, chosen
over SFTP because it needs no external service, no real credentials, and no
`ConnectionManager`/`SecretProvider` machinery to be useful.

## Scope

Build the common `Adapter` contract (`apps/watcher/src/adapters/adapter.ts`)
plus `folder/folder.adapter.ts`, the first implementation of it. Out of
scope: `ConnectionManager`, `SecretProvider`, `AdapterRegistry`,
`InterfaceScope`/`ConnectionContext` resolution from real
`InterfaceConfig`/`ConnectionConfig` rows (those wire in when the Scheduler
is built) — this spec produces a directly-callable, fully-tested adapter
function, not the plumbing that invokes it in production.

## Architecture

**File locations** (per `docs/monorepo-architecture.md`'s target tree —
Watcher-internal, not shared via `packages/contracts`, since Gateway never
touches adapters):
```
apps/watcher/src/adapters/
  adapter.ts              Adapter contract, ConnectionContext, InterfaceScope, AdapterError
  folder/
    folder.adapter.ts
    folder.adapter.test.ts
```

**Contract:**
```ts
export interface ConnectionContext {
  connectionRef: string;
  storageType: string;
  endpoint: string;       // for FOLDER: the root filesystem path
}

export interface InterfaceScope {
  interfaceId: string;
  inboundPath: string;    // subdirectory under endpoint to watch
  filePattern: string;    // regex, e.g. '.*\.csv$'
}

export interface Adapter {
  observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]>;
}
```

`ConnectionContext.endpoint` generalizes the "which system" concept (root
filesystem path for folder; a host for SFTP later). `InterfaceScope.inboundPath`
is "which directory on it." `folder.adapter.ts` resolves the real directory
via `path.join(context.endpoint, scope.inboundPath)`.

**Data flow:**
```
Filesystem
    │  fs.readdir / fs.stat
    ▼
folder.adapter.ts  ──emits──▶  FileObservation[]
                                     │
                                     ▼
                            Watcher Engine (processObservation)
                                     │
                                     ▼
                              StateRepository
```
The adapter's only output is `FileObservation[]` — everything past that
(lifecycle decisions, persistence) is the Engine's, already built and
reconciled. `Adapter` is a stable contract: SFTP/Blob/SharePoint implement
the same interface later without this one changing.

**`AdapterError`** — a single error class (in `adapter.ts`, shared across
future adapters) carrying `{ connectionRef, interfaceId, cause }`, thrown
when the underlying filesystem operation fails (directory missing, not
readable, etc.). Wraps the real Node error rather than swallowing it.

## `folder.adapter.ts` behavior

1. Resolve the real path: `path.join(context.endpoint, scope.inboundPath)`.
2. `fs.promises.readdir(resolvedPath)` — if this throws, catch and rethrow as
   `AdapterError` with context attached.
3. Filter entries by `new RegExp(scope.filePattern).test(name)`.
4. For each match, `fs.promises.stat(path.join(resolvedPath, name))` to get
   `size` and `mtime`. If `stat` throws `ENOENT` (file deleted between
   `readdir` and `stat` — a real race, not hypothetical), skip that entry
   and continue with the rest rather than failing the whole scan.
5. Return `FileObservation[]` — `{ interfaceId: scope.interfaceId, path: <full
   resolved file path>, size, mtime }` — for every currently-matching file,
   every call. No comparison against prior state, no filtering of "already
   seen" files — that's the Engine's job entirely, per the architecture
   doc's adapter boundary ("Do NOT: access state store, generate batch IDs,
   decide events, retrieve secrets").
6. Directory entries that aren't regular files (subdirectories) are skipped
   — `fs.promises.stat`'s `isFile()` check before including a match.

## Error handling

Real `fs` errors (`ENOENT`, `EACCES`, etc.) propagate as `AdapterError`,
not swallowed or retried inside the adapter. Per-interface failure
isolation across a polling cycle is the future Scheduler's responsibility,
not the adapter's — matches the original Watcher Engine design's precedent
of pushing that concern up to the orchestrator layer.

| Failure | Behavior | Rationale |
|---|---|---|
| `inboundPath` directory missing (`ENOENT` on `readdir`) | Throw `AdapterError` | Caller (future Scheduler) decides retry/alert policy |
| Directory not readable (`EACCES`) | Throw `AdapterError` | Same — not this layer's decision |
| File deleted between `readdir` and `stat` (`ENOENT` on `stat`) | Skip that file, continue with the rest | The file is gone — nothing to observe. A real race under active polling, not hypothetical; failing the whole scan over one vanished file would be wrong |
| Symlink (file or directory) | Follow it (`fs.promises.stat` already follows symlinks by default) | No special-casing for MVP — a symlinked file behaves like a real one. Symlink loops aren't traversed since the adapter doesn't recurse into subdirectories at all |
| Directory entry is a subdirectory | Skip (not a file) | Matches architecture doc: no recursive traversal in MVP |

## Testing

Real filesystem, not mocked — matches the original design's own testing
strategy ("Integration: Adapter connects to real SFTP/Blob/folder"; folder
is the one adapter where "real" costs nothing to set up).

- Create a real temp directory per test via `fs.mkdtempSync(path.join(os.tmpdir(), ...))`.
- Write real files into it (varying names/sizes) via `fs.writeFileSync`.
- Clean up (`fs.rmSync(..., { recursive: true })`) after each test.
- Cases: matches-only-pattern-matching-files, ignores non-matching names,
  ignores subdirectories, returns correct `size`/`mtime`/`path`/`interfaceId`,
  throws `AdapterError` when the directory doesn't exist, skips (doesn't
  throw for) a file removed after `readdir` but before `stat` — simulated by
  deleting the file in a hook between listing and the adapter's own `stat`
  call, or by asserting the skip logic directly against a mocked `stat`
  rejection for that one case (the rest of the suite uses the real
  filesystem per the strategy above).

## Out of scope (follow-up work)

- `ConnectionManager` (resolves `connectionRef` → `ConnectionConfig` →
  `ConnectionContext`, calling `SecretProvider` for real adapters)
- `SecretProvider` (env vars now, Key Vault later — not needed for folder)
- `AdapterRegistry` (maps `storageType` → adapter implementation)
- `InterfaceScope` construction from real `InterfaceConfig` DB rows
- SFTP/Blob/SharePoint adapters
- Watcher Scheduler/orchestrator (the eventual caller of this adapter)
