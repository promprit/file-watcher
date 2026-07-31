import { DatabaseClient } from '../client';
import type { ConnectionConfig } from '@packages/contracts';

export class ConnectionConfigRepository {
  private db = DatabaseClient.getInstance();

  async findByRef(connectionRef: string): Promise<ConnectionConfig | null> {
    const sql = `
      SELECT
        connection_ref as "connectionRef",
        storage_type as "storageType",
        environment,
        endpoint,
        port,
        username,
        authentication_type as "authenticationType",
        credential_ref as "credentialRef",
        timeout_seconds as "timeoutSeconds",
        enabled_flag as "enabledFlag",
        owner
      FROM watcher_schema.connection_config
      WHERE connection_ref = $1
    `;
    return this.db.queryOne<ConnectionConfig>(sql, [connectionRef]);
  }

  async findAll(enabledOnly: boolean = false): Promise<ConnectionConfig[]> {
    const sql = `
      SELECT
        connection_ref as "connectionRef",
        storage_type as "storageType",
        environment,
        endpoint,
        port,
        username,
        authentication_type as "authenticationType",
        credential_ref as "credentialRef",
        timeout_seconds as "timeoutSeconds",
        enabled_flag as "enabledFlag",
        owner
      FROM watcher_schema.connection_config
      ${enabledOnly ? 'WHERE enabled_flag = true' : ''}
      ORDER BY connection_ref
    `;
    return this.db.query<ConnectionConfig>(sql);
  }
}
