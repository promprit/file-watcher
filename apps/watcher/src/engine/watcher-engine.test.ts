import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';
import { InterfaceMismatchError } from '@packages/contracts';
import { InMemoryStateRepository } from './state/in-memory-state-repository';
import { processObservation } from './watcher-engine';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  interfaceName: 'Test Interface',
  sourceSystem: 'SFTP_SERVER',
  targetSystem: 'D365',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/inbound/',
  filePattern: '*.csv',
  pollIntervalSeconds: 60,
  readinessRule: 'STABLE_BY_SIZE_AND_MTIME',
  stabilityCheckSeconds: 30,
  duplicateCheckEnabled: true,
  stuckThresholdMinutes: 60,
  expectedSchedule: null,
  slaThresholdMinutes: null,
  alertOwner: null,
  enabledFlag: true,
  stuckThresholdSeconds: 3600,
  slaDeadline: '09:00',
};

function observationAt(now: Date, size = 100): FileObservation {
  return { interfaceId: 'SA-034', path: '/inbound/foo.csv', size, mtime: now };
}

describe('processObservation', () => {
  it('emits FILE_DETECTED for a brand-new file and persists state with fileName derived from the path', async () => {
    const repo = new InMemoryStateRepository();
    const now = new Date('2026-07-15T08:00:00Z');

    const event = await processObservation(observationAt(now), config, repo, now);

    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('FILE_DETECTED');
    expect(event!.filePath).toBe('/inbound/foo.csv');

    const state = await repo.get('SA-034', '/inbound/foo.csv');
    expect(state!.currentStatus).toBe('FILE_DETECTED');
    expect(state!.batchId).toBe(event!.batchId);
    expect(state!.fileName).toBe('foo.csv');
    expect(state!.fileSizeBytes).toBe(100);
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
