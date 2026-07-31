import { DatabaseClient } from '../client';
import type { StateRepository, WatcherState } from '@packages/contracts';

export class PostgresStateRepository implements StateRepository {
  private db = DatabaseClient.getInstance();

  private mapRowToState(row: any): WatcherState {
    return {
      ...row,
      fileSizeBytes: typeof row.fileSizeBytes === 'string' ? parseInt(row.fileSizeBytes, 10) : row.fileSizeBytes,
    };
  }

  async get(interfaceId: string, filePath: string): Promise<WatcherState | null> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        batch_id as "batchId",
        file_path as "filePath",
        file_name as "fileName",
        file_size_bytes as "fileSizeBytes",
        previous_status as "previousStatus",
        current_status as "currentStatus",
        status_changed_at as "statusChangedAt",
        first_detected_at as "firstDetectedAt",
        last_seen_at as "lastSeenAt"
      FROM watcher_schema.watcher_state
      WHERE interface_id = $1 AND file_path = $2
    `;
    const row = await this.db.queryOne<WatcherState>(sql, [interfaceId, filePath]);
    return row ? this.mapRowToState(row) : null;
  }

  async save(state: WatcherState): Promise<void> {
    const sql = `
      INSERT INTO watcher_schema.watcher_state (
        interface_id, batch_id, file_path, file_name, file_size_bytes,
        previous_status, current_status, status_changed_at,
        first_detected_at, last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (interface_id, file_path)
      DO UPDATE SET
        batch_id = EXCLUDED.batch_id,
        file_name = EXCLUDED.file_name,
        file_size_bytes = EXCLUDED.file_size_bytes,
        previous_status = EXCLUDED.previous_status,
        current_status = EXCLUDED.current_status,
        status_changed_at = EXCLUDED.status_changed_at,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW()
    `;
    await this.db.query(sql, [
      state.interfaceId,
      state.batchId,
      state.filePath,
      state.fileName,
      state.fileSizeBytes,
      state.previousStatus,
      state.currentStatus,
      state.statusChangedAt,
      state.firstDetectedAt,
      state.lastSeenAt,
    ]);
  }

  async findByInterface(interfaceId: string): Promise<WatcherState[]> {
    const sql = `
      SELECT
        interface_id as "interfaceId",
        batch_id as "batchId",
        file_path as "filePath",
        file_name as "fileName",
        file_size_bytes as "fileSizeBytes",
        previous_status as "previousStatus",
        current_status as "currentStatus",
        status_changed_at as "statusChangedAt",
        first_detected_at as "firstDetectedAt",
        last_seen_at as "lastSeenAt"
      FROM watcher_schema.watcher_state
      WHERE interface_id = $1
      ORDER BY status_changed_at DESC
    `;
    const rows = await this.db.query<WatcherState>(sql, [interfaceId]);
    return rows.map((row) => this.mapRowToState(row));
  }
}
