import pg from "pg";
import type { QueryResultRow } from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10
});

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const result = await pool.query<T>(text, values);
  return result;
}
