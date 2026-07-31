import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseClient } from '../../../src/database/client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('Migrations', () => {
  let db: DatabaseClient;

  beforeAll(() => {
    db = DatabaseClient.getInstance();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should create watcher_schema', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'watcher_schema') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create interface_config table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'interface_config') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create connection_config table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'connection_config') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should create watcher_state table', async () => {
    const result = await db.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'watcher_schema' AND table_name = 'watcher_state') as exists`
    );
    expect(result?.exists).toBe(true);
  });

  it('should have unique constraint on interface_id + file_path', async () => {
    const result = await db.queryOne<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'watcher_schema'
       AND table_name = 'watcher_state'
       AND constraint_type = 'UNIQUE'
       AND constraint_name = 'unique_interface_file'`
    );
    expect(result?.constraint_name).toBe('unique_interface_file');
  });
});
