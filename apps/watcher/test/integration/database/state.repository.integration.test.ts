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
