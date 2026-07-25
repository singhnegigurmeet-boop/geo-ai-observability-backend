import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow
} from "pg";

export interface DatabaseExecutor {
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<TRow>>;
}

export type TransactionPool = Pick<Pool, "connect">;

export async function inTransaction<T>(
  pool: TransactionPool,
  operation: (client: PoolClient) => Promise<T>
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
