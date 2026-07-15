import { FileStatus } from './file-status';

/**
 * WatcherState represents the persistent state of a file being monitored by the Watcher.
 * This is the core data model that the database layer manages and queries.
 *
 * Each file monitored by an interface has exactly one WatcherState record that
 * tracks its lifecycle from detection through processing or terminal states.
 */
export interface WatcherState {
  /**
   * Unique identifier of the interface that is monitoring this file.
   * Links to InterfaceConfig.interfaceId.
   */
  interfaceId: string;

  /**
   * The full file path as reported by the source system.
   * Together with interfaceId, forms the unique composite key for this record.
   */
  filePath: string;

  /**
   * The current lifecycle status of the file.
   * Updated by the Watcher Engine as file state transitions occur.
   */
  currentStatus: FileStatus;

  /**
   * The previous status of the file.
   * Null if this is the first observation of the file.
   * Used for status transition history and debugging.
   */
  previousStatus: FileStatus | null;

  /**
   * Batch identifier that groups file detections together.
   * All files detected in the same polling cycle share the same batchId.
   * Used for correlation and replay debugging.
   */
  batchId: string;

  /**
   * Timestamp when the file was first detected by any monitoring interface.
   * Never changes after initial creation.
   */
  firstDetectedAt: Date;

  /**
   * Timestamp when the current status was assigned.
   * Updated whenever currentStatus changes.
   */
  statusChangedAt: Date;

  /**
   * Timestamp when the file was last observed by the source system.
   * Updated on every observation, used to detect stuck files.
   */
  lastSeenAt: Date;

  /**
   * The name of the file (without path).
   * Extracted from filePath for convenience and querying.
   */
  fileName: string;

  /**
   * The size of the file in bytes at the last observation.
   * Used to determine stability (file size stopped changing).
   */
  fileSizeBytes: number;
}
