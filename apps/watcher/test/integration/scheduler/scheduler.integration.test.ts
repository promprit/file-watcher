import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseClient } from '../../../src/database/client';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { ConnectionConfigRepository } from '../../../src/database/repositories/connection-config.repository';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { folderAdapter } from '../../../src/adapters/folder/folder.adapter';
import { AdapterError } from '../../../src/adapters/adapter';
import { runOnce, type EngineDefaults } from '../../../src/scheduler/scheduler';
import type { FileEvent } from '@packages/contracts';

const db = DatabaseClient.getInstance();
const interfaceConfigRepo = new InterfaceConfigRepository();
const connectionConfigRepo = new ConnectionConfigRepository();
const stateRepo = new PostgresStateRepository();

const engineDefaults: EngineDefaults = {
  stuckThresholdSeconds: 3600,
  slaDeadline: '00:00', // deliberately early UTC deadline so `now` in these tests is always "after"
};

const adapterRegistry = { FOLDER: folderAdapter };

let tempDir: string;

async function insertConnectionConfig(overrides: {
  connectionRef: string;
  storageType: string;
  endpoint: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO watcher_schema.connection_config (
      connection_ref, storage_type, environment, endpoint,
      authentication_type, timeout_seconds, enabled_flag
    ) VALUES ($1, $2, 'test', $3, 'NONE', 30, true)
    ON CONFLICT (connection_ref) DO UPDATE SET
      storage_type = EXCLUDED.storage_type,
      endpoint = EXCLUDED.endpoint`,
    [overrides.connectionRef, overrides.storageType, overrides.endpoint]
  );
}

async function insertInterfaceConfig(overrides: {
  interfaceId: string;
  connectionRef: string;
  inboundPath: string;
  filePattern?: string;
  enabledFlag?: boolean;
}): Promise<void> {
  await db.query(
    `INSERT INTO watcher_schema.interface_config (
      interface_id, interface_name, source_system, target_system,
      connection_ref, inbound_path, file_pattern, poll_interval_seconds,
      readiness_rule, stability_check_seconds, duplicate_check_enabled,
      enabled_flag
    ) VALUES ($1, $2, 'TEST', 'TEST', $3, $4, $5, 60, 'STABLE_SIZE', 30, true, $6)
    ON CONFLICT (interface_id) DO UPDATE SET
      connection_ref = EXCLUDED.connection_ref,
      inbound_path = EXCLUDED.inbound_path,
      file_pattern = EXCLUDED.file_pattern,
      enabled_flag = EXCLUDED.enabled_flag`,
    [
      overrides.interfaceId,
      `Scheduler Test ${overrides.interfaceId}`,
      overrides.connectionRef,
      overrides.inboundPath,
      overrides.filePattern ?? '.*\\.csv$',
      overrides.enabledFlag ?? true,
    ]
  );
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  await db.query("DELETE FROM watcher_schema.watcher_state WHERE interface_id LIKE 'SCHED-TEST-%'");
  await db.query("DELETE FROM watcher_schema.interface_config WHERE interface_id LIKE 'SCHED-TEST-%'");
  await db.query("DELETE FROM watcher_schema.connection_config WHERE connection_ref LIKE 'sched-test-%'");
});

afterAll(async () => {
  await db.close();
});

describe('Scheduler runOnce', () => {
  it('processes one enabled FOLDER interface and emits FILE_DETECTED', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-ok',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-OK',
      connectionRef: 'sched-test-conn-ok',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    const now = new Date('2026-07-17T05:00:00Z');
    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      now
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-OK');
    expect(result?.status).toBe('ok');
    expect(
      events.some((e) => e.eventType === 'FILE_DETECTED' && e.interfaceId === 'SCHED-TEST-OK')
    ).toBe(true);
  });

  it('skips a disabled interface entirely', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-disabled',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-DISABLED',
      connectionRef: 'sched-test-conn-disabled',
      inboundPath: '.',
      enabledFlag: false,
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    expect(results.find((r) => r.interfaceId === 'SCHED-TEST-DISABLED')).toBeUndefined();
  });

  it('records an error result when the ConnectionConfig is missing, without stopping other interfaces', async () => {
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-BADCONN',
      connectionRef: 'sched-test-conn-does-not-exist',
      inboundPath: '.',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-BADCONN');
    expect(result?.status).toBe('error');
    expect(result?.error).toBeInstanceOf(Error);
    expect((result?.error as Error).message).toContain('sched-test-conn-does-not-exist');
  });

  it('records an error result for an unsupported storage type', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-sftp',
      storageType: 'SFTP',
      endpoint: 'sftp.example.com',
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-SFTP',
      connectionRef: 'sched-test-conn-sftp',
      inboundPath: '.',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-SFTP');
    expect(result?.status).toBe('error');
    expect(result?.error).toBeInstanceOf(Error);
    expect((result?.error as Error).message).toContain('SFTP');
  });

  it('records an error result when the adapter throws (nonexistent inboundPath)', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-badpath',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-BADPATH',
      connectionRef: 'sched-test-conn-badpath',
      inboundPath: 'does-not-exist',
    });

    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      () => {},
      new Date('2026-07-17T05:00:00Z')
    );

    const result = results.find((r) => r.interfaceId === 'SCHED-TEST-BADPATH');
    expect(result?.status).toBe('error');
    expect(result?.error).toBeInstanceOf(AdapterError);
  });

  it('processes multiple interfaces independently: one fails, one succeeds', async () => {
    fs.writeFileSync(path.join(tempDir, 'invoice_1.csv'), 'a,b,c');
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-mixed-ok',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-MIXED-OK',
      connectionRef: 'sched-test-conn-mixed-ok',
      inboundPath: '.',
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-MIXED-BAD',
      connectionRef: 'sched-test-conn-mixed-does-not-exist',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    const results = await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      new Date('2026-07-17T05:00:00Z')
    );

    const okResult = results.find((r) => r.interfaceId === 'SCHED-TEST-MIXED-OK');
    const badResult = results.find((r) => r.interfaceId === 'SCHED-TEST-MIXED-BAD');
    expect(okResult?.status).toBe('ok');
    expect(badResult?.status).toBe('error');
    expect((badResult?.error as Error).message).toContain('sched-test-conn-mixed-does-not-exist');
    expect(events.some((e) => e.interfaceId === 'SCHED-TEST-MIXED-OK')).toBe(true);
  });

  it('emits FILE_MISSING_BY_SLA when no files arrive before the deadline', async () => {
    await insertConnectionConfig({
      connectionRef: 'sched-test-conn-sla',
      storageType: 'FOLDER',
      endpoint: tempDir,
    });
    await insertInterfaceConfig({
      interfaceId: 'SCHED-TEST-SLA',
      connectionRef: 'sched-test-conn-sla',
      inboundPath: '.',
    });

    const events: FileEvent[] = [];
    // engineDefaults.slaDeadline is '00:00' UTC; `now` below is well after that, same day, empty dir
    const now = new Date('2026-07-17T05:00:00Z');
    await runOnce(
      { interfaceConfigRepo, connectionConfigRepo, stateRepo, adapterRegistry, engineDefaults },
      (event) => events.push(event),
      now
    );

    expect(
      events.some(
        (e) => e.eventType === 'FILE_MISSING_BY_SLA' && e.interfaceId === 'SCHED-TEST-SLA'
      )
    ).toBe(true);
  });
});
