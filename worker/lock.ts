import type { Env } from './types';

export async function acquireSync(env: Env): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO sync_lock (id, owner, expires_at, next_allowed_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at, next_allowed_at=excluded.next_allowed_at
    WHERE sync_lock.expires_at < ? AND sync_lock.next_allowed_at < ?`).bind(id, now + 14 * 60000, now + 10 * 60000, now, now).run();
  return result.meta.changes ? id : null;
}

