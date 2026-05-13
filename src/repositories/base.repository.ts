import { query } from "../lib/postgres.js";

export abstract class BaseRepository<T extends Record<string, unknown> = Record<string, unknown>> {
  protected async executeQuery<U extends Record<string, unknown> = T>(
    sql: string,
    params: unknown[] = []
  ): Promise<U[]> {
    const result = await query<U>(sql, params);
    return result.rows;
  }

  protected async executeSingleQuery<U extends Record<string, unknown> = T>(
    sql: string,
    params: unknown[] = []
  ): Promise<U | null> {
    const result = await query<U>(sql, params);
    return result.rows[0] ?? null;
  }

  protected async executeSingleQueryOrThrow<U extends Record<string, unknown> = T>(
    sql: string,
    params: unknown[] = [],
    errorMessage: string
  ): Promise<U> {
    const result = await this.executeSingleQuery<U>(sql, params);
    if (!result) {
      throw new Error(errorMessage);
    }
    return result;
  }

  protected log(message: string, data?: unknown): void {
    const repoName = this.constructor.name;
    if (data) {
      console.log(`[${repoName}] ${message}`, data);
      return;
    }

    console.log(`[${repoName}] ${message}`);
  }
}
