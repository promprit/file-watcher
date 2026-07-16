/**
 * InterfaceConfig defines the configuration for a file monitoring interface.
 * This includes the source system connection, file patterns, monitoring rules,
 * and SLA thresholds.
 *
 * Minimal version for database layer use - contains only configuration data,
 * no validation logic or implementation details.
 */
export interface InterfaceConfig {
  /**
   * Unique identifier for this monitoring interface.
   * Used as the primary key in the interfaces table.
   * Referenced by WatcherState.interfaceId.
   */
  interfaceId: string;

  /**
   * Human-readable name for this interface.
   * Used in logs and dashboards.
   */
  interfaceName: string;

  /**
   * Name of the source system that supplies the files.
   * Examples: 'SFTP_SERVER', 'AZURE_BLOB', 'SHAREPOINT', 'LOCAL_FOLDER'
   */
  sourceSystem: string;

  /**
   * Name of the target system that will consume the files.
   * Examples: 'D365', 'ERP_SYSTEM', 'DW', 'QUEUE'
   */
  targetSystem: string;

  /**
   * Reference to the ConnectionConfig used to connect to the source system.
   * Links to ConnectionConfig.connectionRef.
   */
  connectionRef: string;

  /**
   * The inbound directory path on the source system where files are expected.
   * Example: '/inbound/sales_orders/' or 's3://my-bucket/uploads/'
   */
  inboundPath: string;

  /**
   * Regex pattern to match file names to monitor.
   * Only files matching this pattern will be tracked.
   * Example: '.*\.csv$' or 'SO_[0-9]{8}\.txt'
   */
  filePattern: string;

  /**
   * How often to poll the source system for new files, in seconds.
   * Example: 60 means poll every minute.
   */
  pollIntervalSeconds: number;

  /**
   * Rule for determining when a file is ready to process.
   * Values depend on the Watcher Engine's rule engine.
   * Example: 'STABLE_BY_SIZE_AND_MTIME' or 'IMMEDIATE'
   */
  readinessRule: string;

  /**
   * Seconds that a file's size must remain unchanged to be considered stable.
   * Example: 30 means file hasn't changed in 30 seconds.
   */
  stabilityCheckSeconds: number;

  /**
   * Whether to enable duplicate detection for this interface.
   * If true, the Watcher Engine will check if this file matches a previously processed file.
   */
  duplicateCheckEnabled: boolean;

  /**
   * Threshold in minutes after which a file is marked FILE_STUCK if not updated.
   * Null if stuck detection is disabled for this interface.
   * Example: 120 means stuck after 2 hours of no change.
   */
  stuckThresholdMinutes: number | null;

  /**
   * Expected schedule pattern for file arrival.
   * Used by SLA detection to flag late arrivals.
   * Example: 'DAILY_08:00_UTC' or 'WEEKLY_FRIDAY_17:00_EST'
   * Null if no schedule-based SLA is configured.
   */
  expectedSchedule: string | null;

  /**
   * Threshold in minutes after the expected time to mark a file FILE_MISSING_BY_SLA.
   * Null if SLA checking is disabled.
   * Example: 60 means SLA breach if file hasn't arrived 60 minutes past expected time.
   */
  slaThresholdMinutes: number | null;

  /**
   * Email or identifier of the person responsible for this interface.
   * Used in alert notifications.
   * Null if no alert owner is configured.
   */
  alertOwner: string | null;

  /**
   * Whether this interface is currently enabled for monitoring.
   * If false, the Watcher will skip this interface during polling cycles.
   */
  enabledFlag: boolean;

  /**
   * Threshold in seconds after which a file is marked FILE_STUCK if not
   * updated. Engine-specific field (MVP model) — coexists with
   * stuckThresholdMinutes above, which is DB-schema-shaped and not yet
   * consumed by any rule. Always active (unlike stuckThresholdMinutes,
   * which is nullable/disable-able).
   */
  stuckThresholdSeconds: number;

  /**
   * Expected daily arrival deadline in "HH:mm" 24-hour UTC. Engine-specific
   * field (MVP model) — coexists with expectedSchedule/slaThresholdMinutes
   * above, which is a more expressive but not-yet-implemented schedule
   * format. Not local time — see missing-sla-sweep.ts.
   */
  slaDeadline: string;
}
