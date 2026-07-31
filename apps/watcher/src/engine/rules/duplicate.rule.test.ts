import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig, WatcherState } from '@packages/contracts';
import { duplicateRule } from './duplicate.rule';

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
    fileName: 'foo.csv',
    fileSizeBytes: 100,
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
