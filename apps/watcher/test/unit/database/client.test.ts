import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseClient } from '../../../src/database/client';

describe('DatabaseClient', () => {
  let client: DatabaseClient;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it('should return singleton instance', () => {
    const instance1 = DatabaseClient.getInstance();
    const instance2 = DatabaseClient.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should execute query and return rows', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [{ id: 1 }, { id: 2 }],
      command: 'SELECT',
      rowCount: 2,
      oid: 0,
      fields: [],
    });

    const result = await client.query('SELECT * FROM test', []);

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM test', []);
  });

  it('should execute queryOne and return first row', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [{ id: 1 }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await client.queryOne('SELECT * FROM test WHERE id = $1', [1]);

    expect(result).toEqual({ id: 1 });
  });

  it('should execute queryOne and return null when no rows', async () => {
    client = DatabaseClient.getInstance();
    const mockQuery = vi.spyOn(client['pool'], 'query').mockResolvedValue({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });

    const result = await client.queryOne('SELECT * FROM test WHERE id = $1', [999]);

    expect(result).toBeNull();
  });
});
