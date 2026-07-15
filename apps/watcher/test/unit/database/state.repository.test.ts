import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { WatcherState } from '@packages/contracts';

vi.mock('../../../src/database/client');

describe('PostgresStateRepository', () => {
  let repository: PostgresStateRepository;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      queryOne: vi.fn(),
      query: vi.fn(),
    };
    vi.spyOn(DatabaseClient, 'getInstance').mockReturnValue(mockClient);
    repository = new PostgresStateRepository();
  });

  describe('get', () => {
    it('should return state when found', async () => {
      const mockState: WatcherState = {
        interfaceId: 'SA-034',
        batchId: 'SA-034-20260715-001',
        filePath: '/inbound/file.xlsx',
        fileName: 'file.xlsx',
        fileSizeBytes: 1024,
        previousStatus: null,
        currentStatus: 'FILE_DETECTED',
        statusChangedAt: new Date('2026-07-15T10:00:00Z'),
        firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
        lastSeenAt: new Date('2026-07-15T10:00:00Z'),
      };

      mockClient.queryOne.mockResolvedValue(mockState);

      const result = await repository.get('SA-034', '/inbound/file.xlsx');

      expect(result).toEqual(mockState);
      expect(mockClient.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM watcher_schema.watcher_state'),
        ['SA-034', '/inbound/file.xlsx']
      );
    });

    it('should return null when not found', async () => {
      mockClient.queryOne.mockResolvedValue(null);

      const result = await repository.get('SA-999', '/nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('save', () => {
    it('should insert new state', async () => {
      const state: WatcherState = {
        interfaceId: 'SA-034',
        batchId: 'SA-034-20260715-001',
        filePath: '/inbound/file.xlsx',
        fileName: 'file.xlsx',
        fileSizeBytes: 1024,
        previousStatus: null,
        currentStatus: 'FILE_DETECTED',
        statusChangedAt: new Date('2026-07-15T10:00:00Z'),
        firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
        lastSeenAt: new Date('2026-07-15T10:00:00Z'),
      };

      mockClient.query.mockResolvedValue([]);

      await repository.save(state);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO watcher_schema.watcher_state'),
        expect.arrayContaining([
          'SA-034',
          'SA-034-20260715-001',
          '/inbound/file.xlsx',
          'file.xlsx',
          1024,
          null,
          'FILE_DETECTED',
        ])
      );
    });
  });

  describe('findByInterface', () => {
    it('should return all states for interface', async () => {
      const mockStates: WatcherState[] = [
        {
          interfaceId: 'SA-034',
          batchId: 'SA-034-20260715-001',
          filePath: '/inbound/file1.xlsx',
          fileName: 'file1.xlsx',
          fileSizeBytes: 1024,
          previousStatus: null,
          currentStatus: 'FILE_STABLE',
          statusChangedAt: new Date('2026-07-15T10:00:00Z'),
          firstDetectedAt: new Date('2026-07-15T10:00:00Z'),
          lastSeenAt: new Date('2026-07-15T10:00:00Z'),
        },
      ];

      mockClient.query.mockResolvedValue(mockStates);

      const result = await repository.findByInterface('SA-034');

      expect(result).toEqual(mockStates);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE interface_id = $1'),
        ['SA-034']
      );
    });

    it('should return empty array when no states found', async () => {
      mockClient.query.mockResolvedValue([]);

      const result = await repository.findByInterface('SA-999');

      expect(result).toEqual([]);
    });
  });
});
