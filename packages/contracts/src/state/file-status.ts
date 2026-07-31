/**
 * FileStatus represents the lifecycle status of a file in the Watcher system.
 * These states are determined by the Watcher Engine based on file observations
 * and configured monitoring rules.
 */
export type FileStatus =
  | 'FILE_DETECTED'        // File has been newly detected by the source system
  | 'FILE_STABLE'          // File has reached stability threshold and is ready for processing
  | 'FILE_DUPLICATE'       // File is a duplicate of a previously processed file
  | 'FILE_STUCK'           // File has not changed within the stuck threshold
  | 'FILE_MISSING_BY_SLA'; // File has not arrived within the SLA threshold
