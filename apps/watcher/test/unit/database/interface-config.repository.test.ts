import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { InterfaceConfig } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('InterfaceConfigRepository', () => {
  let repository: InterfaceConfigRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      queryOne: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new InterfaceConfigRepository();
  });

  describe('findAll', () => {
    it('should return all configs when enabledOnly is false', async () => {
      const mockConfigs: InterfaceConfig[] = [
        {
          interfaceId: 'SA-034',
          interfaceName: 'Vendor Invoice',
          sourceSystem: 'AG-DOC',
          targetSystem: 'D365',
          connectionRef: 'sftp-agdoc-prod',
          inboundPath: '/inbound',
          filePattern: '*.xlsx',
          pollIntervalSeconds: 60,
          readinessRule: 'STABLE_SIZE',
          stabilityCheckSeconds: 30,
          duplicateCheckEnabled: true,
          stuckThresholdMinutes: 60,
          expectedSchedule: null,
          slaThresholdMinutes: null,
          alertOwner: 'team@example.com',
          enabledFlag: true,
        },
      ];

      mockClient.query.mockResolvedValue(mockConfigs);

      const result = await repository.findAll(false);

      expect(result).toEqual(mockConfigs);
      expect(mockClient.query).toHaveBeenCalled();
      const callArg = mockClient.query.mock.calls[0][0];
      expect(callArg).not.toContain('WHERE enabled_flag');
    });

    it('should filter enabled configs when enabledOnly is true', async () => {
      mockClient.query.mockResolvedValue([]);

      await repository.findAll(true);

      expect(mockClient.query).toHaveBeenCalled();
      const callArg = mockClient.query.mock.calls[0][0];
      expect(callArg).toContain('WHERE enabled_flag = true');
    });
  });

  describe('findById', () => {
    it('should return config when found', async () => {
      const mockConfig: InterfaceConfig = {
        interfaceId: 'SA-034',
        interfaceName: 'Vendor Invoice',
        sourceSystem: 'AG-DOC',
        targetSystem: 'D365',
        connectionRef: 'sftp-agdoc-prod',
        inboundPath: '/inbound',
        filePattern: '*.xlsx',
        pollIntervalSeconds: 60,
        readinessRule: 'STABLE_SIZE',
        stabilityCheckSeconds: 30,
        duplicateCheckEnabled: true,
        stuckThresholdMinutes: 60,
        expectedSchedule: null,
        slaThresholdMinutes: null,
        alertOwner: 'team@example.com',
        enabledFlag: true,
      };

      mockClient.queryOne.mockResolvedValue(mockConfig);

      const result = await repository.findById('SA-034');

      expect(result).toEqual(mockConfig);
      expect(mockClient.queryOne).toHaveBeenCalled();
      const callArg = mockClient.queryOne.mock.calls[0][0];
      expect(callArg).toContain('WHERE interface_id = $1');
      expect(mockClient.queryOne).toHaveBeenCalledWith(
        expect.any(String),
        ['SA-034']
      );
    });

    it('should return null when not found', async () => {
      mockClient.queryOne.mockResolvedValue(null);

      const result = await repository.findById('SA-999');

      expect(result).toBeNull();
    });
  });

  describe('findByConnectionRef', () => {
    it('should return all configs for connection', async () => {
      const mockConfigs: InterfaceConfig[] = [
        {
          interfaceId: 'SA-034',
          interfaceName: 'Vendor Invoice',
          sourceSystem: 'AG-DOC',
          targetSystem: 'D365',
          connectionRef: 'sftp-agdoc-prod',
          inboundPath: '/inbound',
          filePattern: '*.xlsx',
          pollIntervalSeconds: 60,
          readinessRule: 'STABLE_SIZE',
          stabilityCheckSeconds: 30,
          duplicateCheckEnabled: true,
          stuckThresholdMinutes: 60,
          expectedSchedule: null,
          slaThresholdMinutes: null,
          alertOwner: 'team@example.com',
          enabledFlag: true,
        },
      ];

      mockClient.query.mockResolvedValue(mockConfigs);

      const result = await repository.findByConnectionRef('sftp-agdoc-prod');

      expect(result).toEqual(mockConfigs);
      expect(mockClient.query).toHaveBeenCalled();
      const callArg = mockClient.query.mock.calls[0][0];
      expect(callArg).toContain('WHERE connection_ref = $1');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        ['sftp-agdoc-prod']
      );
    });
  });
});
