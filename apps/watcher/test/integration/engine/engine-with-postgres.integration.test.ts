import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { processObservation } from '../../../src/engine/watcher-engine';
import { checkMissingSla } from '../../../src/engine/missing-sla-sweep';
import { PostgresStateRepository } from '../../../src/database/repositories/state.repository';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';
import interfaceConfigsFixture from '../../fixtures/interface-configs.json';

describe('Engine + PostgresStateRepository Integration', () => {
  let stateRepo: PostgresStateRepository;
  let configRepo: InterfaceConfigRepository;
  let db: DatabaseClient;
  let testConfig: InterfaceConfig;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    stateRepo = new PostgresStateRepository();
    configRepo = new InterfaceConfigRepository();

    // Clean state - only watcher_state, not interface_config (other tests may have seeded it)
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');

    // Seed or update interface config (upsert to handle parallel test runs)
    const fixtureConfig = interfaceConfigsFixture[0];
    await db.query(
      `INSERT INTO watcher_schema.interface_config (
        interface_id, interface_name, source_system, target_system,
        connection_ref, inbound_path, file_pattern, poll_interval_seconds,
        readiness_rule, stability_check_seconds, duplicate_check_enabled,
        stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
        alert_owner, enabled_flag
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (interface_id) DO UPDATE SET
        interface_name = EXCLUDED.interface_name,
        enabled_flag = EXCLUDED.enabled_flag`,
      [
        fixtureConfig.interfaceId,
        fixtureConfig.interfaceName,
        fixtureConfig.sourceSystem,
        fixtureConfig.targetSystem,
        fixtureConfig.connectionRef,
        fixtureConfig.inboundPath,
        fixtureConfig.filePattern,
        fixtureConfig.pollIntervalSeconds,
        fixtureConfig.readinessRule,
        fixtureConfig.stabilityCheckSeconds,
        fixtureConfig.duplicateCheckEnabled,
        fixtureConfig.stuckThresholdMinutes,
        fixtureConfig.expectedSchedule,
        fixtureConfig.slaThresholdMinutes,
        fixtureConfig.alertOwner,
        fixtureConfig.enabledFlag,
      ]
    );

    // Load config with engine fields
    const loadedConfig = await configRepo.findById(fixtureConfig.interfaceId);
    if (!loadedConfig) throw new Error('Failed to load test config');

    // Add engine-specific fields (MVP model) not in database schema yet
    testConfig = {
      ...loadedConfig,
      stuckThresholdSeconds: 3600, // 60 minutes = 3600 seconds
      slaDeadline: '18:00', // 6 PM UTC
    };
  });

  afterAll(async () => {
    // Don't close DB - other tests may still be using it (singleton + parallel execution)
  });

  it('should persist state to database on first observation', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-001.xlsx',
      size: 1024,
      modified: new Date('2026-07-16T10:00:00Z'),
      observedAt: new Date('2026-07-16T10:00:00Z'),
    };

    const now = new Date('2026-07-16T10:00:00Z');

    const event = await processObservation(observation, testConfig, stateRepo, now);

    expect(event).not.toBeNull();
    expect(event?.eventType).toBe('FILE_DETECTED');

    // Verify state persisted to database
    const savedState = await stateRepo.get('SA-034', '/inbound/vendor-invoice-001.xlsx');

    expect(savedState).not.toBeNull();
    expect(savedState?.interfaceId).toBe('SA-034');
    expect(savedState?.filePath).toBe('/inbound/vendor-invoice-001.xlsx');
    expect(savedState?.currentStatus).toBe('FILE_DETECTED');
    expect(savedState?.previousStatus).toBeNull();
    expect(savedState?.fileName).toBe('vendor-invoice-001.xlsx');
    // PostgreSQL BIGINT is returned as string by pg driver
    expect(savedState?.fileSizeBytes).toBe('1024');
    expect(savedState?.firstDetectedAt).toEqual(now);
    expect(savedState?.statusChangedAt).toEqual(now);
    expect(savedState?.lastSeenAt).toEqual(now);
  });
});
