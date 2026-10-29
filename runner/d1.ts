import { apiJson } from '../worker/http';
import type { Fetch } from '../worker/types';

interface Query { sql: string; params: unknown[] }
interface Result { success: boolean; results: Record<string, unknown>[]; meta: { changes: number } }

// Only the prepared-statement operations used by the shared sync engine cross this REST boundary.
export function remoteD1(account: string, database: string, token: string, request: Fetch = fetch): D1Database {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`;
  async function query(batch: Query[]) {
    const data = await apiJson<{ success: boolean; result: Result[] }>(endpoint,
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, request,
      { method: 'POST', body: JSON.stringify({ batch }) });
    if (!data.success || data.result.length !== batch.length || data.result.some(row => !row.success)) throw new Error('d1-query-failed');
    return data.result;
  }
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    async all() { return (await query([{ sql: this.sql, params: this.params }]))[0]; }
    async run() { return this.all(); }
    async first(column?: string) {
      const row = (await this.all()).results[0];
      return row ? column ? row[column] : row : null;
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: (statements: Statement[]) => query(statements.map(({ sql, params }) => ({ sql, params }))),
  } as unknown as D1Database;
}
