import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import connectionConfigsFixture from '../../fixtures/connection-configs.json';

describe('ConnectionConfigRepository Integration', () => {
  let repository: ConnectionConfigRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    repository = new ConnectionConfigRepository();
    await db.query('TRUNCATE TABLE watcher_schema.connection_config CASCADE');

    // Insert fixture data
    for (const config of connectionConfigsFixture) {
      await db.query(
        `INSERT INTO watcher_schema.connection_config (
          connection_ref, storage_type, environment, endpoint, port,
          username, authentication_type, credential_ref, timeout_seconds,
          enabled_flag, owner
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          config.connectionRef,
          config.storageType,
          config.environment,
          config.endpoint,
          config.port,
          config.username,
          config.authenticationType,
          config.credentialRef,
          config.timeoutSeconds,
          config.enabledFlag,
          config.owner,
        ]
      );
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('should find all configs', async () => {
    const results = await repository.findAll();
    expect(results).toHaveLength(1);
    expect(results[0].connectionRef).toBe('sftp-agdoc-prod');
  });

  it('should find config by ref', async () => {
    const result = await repository.findByRef('sftp-agdoc-prod');
    expect(result).not.toBeNull();
    expect(result?.storageType).toBe('SFTP');
    expect(result?.endpoint).toBe('sftp.agdoc.com');
  });

  it('should return null when not found', async () => {
    const result = await repository.findByRef('nonexistent');
    expect(result).toBeNull();
  });
});
