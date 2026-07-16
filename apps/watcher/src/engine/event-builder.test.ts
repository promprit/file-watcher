import { describe, expect, it } from 'vitest';
import type { FileObservation } from '@packages/contracts';
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
