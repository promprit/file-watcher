import { describe, expect, it } from 'vitest';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';
import { InterfaceMismatchError } from '@packages/contracts';
import { assertInterfaceMatch } from './interface-matcher';

const config: InterfaceConfig = {
  interfaceId: 'SA-034',
  interfaceName: 'Test Interface',
  sourceSystem: 'SFTP_SERVER',
  targetSystem: 'D365',
  connectionRef: 'sftp-agdoc-prod',
  inboundPath: '/ag-doc/vendor-invoice/inbound/',
  filePattern: 'VendorInvoice_*.xlsx',
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

describe('assertInterfaceMatch', () => {
  it('does not throw when observation.interfaceId matches config.interfaceId', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/VendorInvoice_1.xlsx',
      size: 100,
      mtime: new Date(),
    };
    expect(() => assertInterfaceMatch(observation, config)).not.toThrow();
  });

  it('throws InterfaceMismatchError when interfaceId differs', () => {
    const observation: FileObservation = {
      interfaceId: 'SA-999',
      path: '/inbound/VendorInvoice_1.xlsx',
      size: 100,
      mtime: new Date(),
    };
    expect(() => assertInterfaceMatch(observation, config)).toThrow(InterfaceMismatchError);
  });
});
