import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { InterfaceConfigRepository } from '../../../src/database/repositories/interface-config.repository';
import { DatabaseClient } from '../../../src/database/client';
import interfaceConfigsFixture from '../../fixtures/interface-configs.json';

describe('InterfaceConfigRepository Integration', () => {
  let repository: InterfaceConfigRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = DatabaseClient.getInstance();
    repository = new InterfaceConfigRepository();
    await db.query('TRUNCATE TABLE watcher_schema.interface_config CASCADE');

    // Insert fixture data
    for (const config of interfaceConfigsFixture) {
      await db.query(
        `INSERT INTO watcher_schema.interface_config (
          interface_id, interface_name, source_system, target_system,
          connection_ref, inbound_path, file_pattern, poll_interval_seconds,
          readiness_rule, stability_check_seconds, duplicate_check_enabled,
          stuck_threshold_minutes, expected_schedule, sla_threshold_minutes,
          alert_owner, enabled_flag
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          config.interfaceId,
          config.interfaceName,
          config.sourceSystem,
          config.targetSystem,
          config.connectionRef,
          config.inboundPath,
          config.filePattern,
          config.pollIntervalSeconds,
          config.readinessRule,
          config.stabilityCheckSeconds,
          config.duplicateCheckEnabled,
          config.stuckThresholdMinutes,
          config.expectedSchedule,
          config.slaThresholdMinutes,
          config.alertOwner,
          config.enabledFlag,
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
    expect(results[0].interfaceId).toBe('SA-034');
  });

  it('should find config by id', async () => {
    const result = await repository.findById('SA-034');
    expect(result).not.toBeNull();
    expect(result?.interfaceName).toBe('Vendor Invoice Posting');
  });

  it('should find configs by connection ref', async () => {
    const results = await repository.findByConnectionRef('sftp-agdoc-prod');
    expect(results).toHaveLength(1);
    expect(results[0].interfaceId).toBe('SA-034');
  });
});
