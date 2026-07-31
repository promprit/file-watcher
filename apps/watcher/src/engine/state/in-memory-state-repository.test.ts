import { describe, expect, it } from 'vitest';
import { InMemoryStateRepository } from './in-memory-state-repository';
import type { WatcherState } from '@packages/contracts';

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
    fileName: 'foo.csv',
    fileSizeBytes: 100,
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
