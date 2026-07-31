import { DatabaseClient } from '../client';
import type { InterfaceConfig } from '@packages/contracts';

export class InterfaceConfigRepository {
  private db = DatabaseClient.getInstance();

  async findAll(enabledOnly: boolean = false): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql);
  }

  async findById(interfaceId: string): Promise<InterfaceConfig | null> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      WHERE interface_id = $1
    `;
    return this.db.queryOne<InterfaceConfig>(sql, [interfaceId]);
  }

  async findByConnectionRef(connectionRef: string): Promise<InterfaceConfig[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        interface_name as "interfaceName",
        source_system as "sourceSystem",
        target_system as "targetSystem",
        connection_ref as "connectionRef",
        inbound_path as "inboundPath",
        file_pattern as "filePattern",
        poll_interval_seconds as "pollIntervalSeconds",
        readiness_rule as "readinessRule",
        stability_check_seconds as "stabilityCheckSeconds",
        duplicate_check_enabled as "duplicateCheckEnabled",
        stuck_threshold_minutes as "stuckThresholdMinutes",
        expected_schedule as "expectedSchedule",
        sla_threshold_minutes as "slaThresholdMinutes",
        alert_owner as "alertOwner",
        enabled_flag as "enabledFlag"
      FROM watcher_schema.interface_config
      WHERE connection_ref = $1
      ORDER BY interface_id
    `;
    return this.db.query<InterfaceConfig>(sql, [connectionRef]);
  }
}
