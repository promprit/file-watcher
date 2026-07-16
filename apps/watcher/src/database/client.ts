import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export class DatabaseClient {
  private static instance: DatabaseClient;
  private pool: Pool;

  private constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  static getInstance(): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient();
    }
    return DatabaseClient.instance;
  }

  async query<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<T[]> {
    const result: QueryResult<T> = await this.pool.query(sql, params);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    DatabaseClient.instance = null as any;
  }
}
