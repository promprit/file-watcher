import { describe, expect, it } from 'vitest';
import type { InterfaceConfig } from '@packages/contracts';
import { InMemoryStateRepository } from './state/in-memory-state-repository';
import { checkMissingSla } from './missing-sla-sweep';
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
