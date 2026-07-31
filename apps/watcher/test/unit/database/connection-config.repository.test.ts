import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { ConnectionConfig } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('ConnectionConfigRepository', () => {
  let repository: ConnectionConfigRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      queryOne: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new ConnectionConfigRepository();
  });

  describe('findByRef', () => {
    it('should return config when found', async () => {
      const mockConfig: ConnectionConfig = {
        connectionRef: 'sftp-agdoc-prod',
        storageType: 'SFTP',
        environment: 'production',
        endpoint: 'sftp.agdoc.com',
        port: 22,
        username: 'integration_user',
        authenticationType: 'PRIVATE_KEY',
        credentialRef: 'sftp-agdoc-key',
        timeoutSeconds: 30,
        enabledFlag: true,
        owner: 'team@example.com',
      };

      mockClient.queryOne.mockResolvedValue(mockConfig);

      const result = await repository.findByRef('sftp-agdoc-prod');

      expect(result).toEqual(mockConfig);
      expect(mockClient.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('WHERE connection_ref = $1'),
        ['sftp-agdoc-prod']
      );
    });

    it('should return null when not found', async () => {
      mockClient.queryOne.mockResolvedValue(null);

      const result = await repository.findByRef('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all configs when enabledOnly is false', async () => {
      const mockConfigs: ConnectionConfig[] = [
        {
          connectionRef: 'sftp-agdoc-prod',
          storageType: 'SFTP',
          environment: 'production',
          endpoint: 'sftp.agdoc.com',
          port: 22,
          username: 'integration_user',
          authenticationType: 'PRIVATE_KEY',
          credentialRef: 'sftp-agdoc-key',
          timeoutSeconds: 30,
          enabledFlag: true,
          owner: 'team@example.com',
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
});
