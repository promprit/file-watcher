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
    await db.close();
  });

  it('should persist state to database on first observation', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-001.xlsx',
      size: 1024,
      mtime: new Date('2026-07-16T10:00:00Z'),
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
    expect(savedState?.fileSizeBytes).toBe(1024);
    expect(savedState?.firstDetectedAt).toEqual(now);
    expect(savedState?.statusChangedAt).toEqual(now);
    expect(savedState?.lastSeenAt).toEqual(now);
  });

  it('should load previous state on subsequent observation', async () => {
    const firstObservation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-002.xlsx',
      size: 2048,
      mtime: new Date('2026-07-16T11:00:00Z'),
    };

    const now1 = new Date('2026-07-16T11:00:00Z');
    const event1 = await processObservation(firstObservation, testConfig, stateRepo, now1);
    expect(event1?.eventType).toBe('FILE_DETECTED');

    // Second observation - same file, 35 seconds later (exceeds stability threshold of 30s)
    const secondObservation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/vendor-invoice-002.xlsx',
      size: 2048, // Same size (stable)
      mtime: new Date('2026-07-16T11:00:00Z'), // Same mtime (file hasn't changed)
    };

    const now2 = new Date('2026-07-16T11:00:35Z');
    const event2 = await processObservation(secondObservation, testConfig, stateRepo, now2);

    expect(event2?.eventType).toBe('FILE_STABLE');

    // Verify state loaded correctly and transitioned
    const finalState = await stateRepo.get('SA-034', '/inbound/vendor-invoice-002.xlsx');
    expect(finalState?.currentStatus).toBe('FILE_STABLE');
    expect(finalState?.previousStatus).toBe('FILE_DETECTED');
    expect(finalState?.firstDetectedAt).toEqual(now1); // Preserved from first observation
    expect(finalState?.statusChangedAt).toEqual(now2); // Updated on transition
  });

  it('should enforce valid state transitions', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/test-transitions.xlsx',
      size: 512,
      mtime: new Date('2026-07-16T12:00:00Z'),
    };

    const now = new Date('2026-07-16T12:00:00Z');

    // First: FILE_DETECTED
    const event1 = await processObservation(observation, testConfig, stateRepo, now);
    expect(event1?.eventType).toBe('FILE_DETECTED');

    // Verify transition to FILE_STABLE works (same file, unchanged, observed 35s later)
    const now2 = new Date('2026-07-16T12:00:35Z');
    const event2 = await processObservation(observation, testConfig, stateRepo, now2);
    expect(event2?.eventType).toBe('FILE_STABLE');

    // Verify final state has correct transition
    const state = await stateRepo.get('SA-034', '/inbound/test-transitions.xlsx');
    expect(state?.currentStatus).toBe('FILE_STABLE');
    expect(state?.previousStatus).toBe('FILE_DETECTED');
  });

  it('should upsert state without creating duplicate rows', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/upsert-test.xlsx',
      size: 1024,
      mtime: new Date('2026-07-16T13:00:00Z'),
    };

    const now1 = new Date('2026-07-16T13:00:00Z');
    await processObservation(observation, testConfig, stateRepo, now1);

    // Process same file again (after stability threshold)
    const now2 = new Date('2026-07-16T13:00:35Z');
    await processObservation(observation, testConfig, stateRepo, now2);

    // Verify only one row exists
    const allStates = await stateRepo.findByInterface('SA-034');
    const matchingStates = allStates.filter((s) => s.filePath === '/inbound/upsert-test.xlsx');

    expect(matchingStates).toHaveLength(1);
    expect(matchingStates[0].currentStatus).toBe('FILE_STABLE');
  });

  it('should query database for missing SLA check', async () => {
    // Set time to after SLA deadline (18:00 UTC)
    const now = new Date('2026-07-16T18:30:00Z');

    // No files arrived today - should trigger FILE_MISSING_BY_SLA
    const events = await checkMissingSla(testConfig, stateRepo, now);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('FILE_MISSING_BY_SLA');
    expect(events[0].interfaceId).toBe('SA-034');

    // Verify sentinel state persisted to database
    const sentinelState = await stateRepo.get('SA-034', '__sla_window__');
    expect(sentinelState).not.toBeNull();
    expect(sentinelState?.currentStatus).toBe('FILE_MISSING_BY_SLA');
    expect(sentinelState?.fileName).toBe('__sla_window__');
    expect(sentinelState?.fileSizeBytes).toBe(0);
  });

  it('should reuse batch ID across state transitions for same file', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/batch-id-test.xlsx',
      size: 1024,
      mtime: new Date('2026-07-16T14:00:00Z'),
    };

    const now1 = new Date('2026-07-16T14:00:00Z');
    const event1 = await processObservation(observation, testConfig, stateRepo, now1);
    const batchId1 = event1?.batchId;

    // Transition to FILE_STABLE
    const now2 = new Date('2026-07-16T14:00:35Z');
    const event2 = await processObservation(observation, testConfig, stateRepo, now2);
    const batchId2 = event2?.batchId;

    // Batch ID should be reused
    expect(batchId2).toBe(batchId1);

    // Verify in database
    const state = await stateRepo.get('SA-034', '/inbound/batch-id-test.xlsx');
    expect(state?.batchId).toBe(batchId1);
  });

  it('should persist all timestamps correctly', async () => {
    const observation: FileObservation = {
      interfaceId: 'SA-034',
      path: '/inbound/timestamp-test.xlsx',
      size: 2048,
      mtime: new Date('2026-07-16T15:00:00Z'),
    };

    const firstDetectedTime = new Date('2026-07-16T15:00:00Z');
    await processObservation(observation, testConfig, stateRepo, firstDetectedTime);

    // Update after 35 seconds
    const stableTime = new Date('2026-07-16T15:00:35Z');
    await processObservation(observation, testConfig, stateRepo, stableTime);

    // Verify timestamps from database
    const state = await stateRepo.get('SA-034', '/inbound/timestamp-test.xlsx');

    expect(state?.firstDetectedAt).toEqual(firstDetectedTime); // Never changes
    expect(state?.statusChangedAt).toEqual(stableTime); // Updates on transition
    expect(state?.lastSeenAt).toEqual(stableTime); // Updates on each observation
  });
});
