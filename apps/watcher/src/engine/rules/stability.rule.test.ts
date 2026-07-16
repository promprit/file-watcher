import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig, WatcherState } from '@packages/contracts';
import { stabilityRule } from './stability.rule';

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
    fileName: 'foo.csv',
    fileSizeBytes: 100,
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
    const state = makeState({ fileSizeBytes: 100 });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:01:00Z'))).toBeNull();
  });

  it('returns null when size unchanged but under the stability window', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ fileSizeBytes: 100, statusChangedAt: new Date('2026-07-15T08:00:00Z') });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:00:10Z'))).toBeNull();
  });

  it('fires FILE_STABLE when size unchanged and stability window elapsed', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/foo.csv',
      size: 100,
      mtime: new Date('2026-07-15T08:00:00Z'),
    };
    const state = makeState({ fileSizeBytes: 100, statusChangedAt: new Date('2026-07-15T08:00:00Z') });
    expect(stabilityRule(observation, state, config, new Date('2026-07-15T08:00:30Z'))).toEqual({
      status: 'FILE_STABLE',
    });
  });
});
