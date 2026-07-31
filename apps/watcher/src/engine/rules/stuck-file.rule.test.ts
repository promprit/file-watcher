import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig, WatcherState } from '@packages/contracts';
import { stuckFileRule } from './stuck-file.rule';

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
    fileName: 'foo.csv',
    fileSizeBytes: 100,
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
