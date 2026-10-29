import { acquireSync } from './lock';
import type { Env, Fetch } from './types';

export async function dispatchSync(env: Env, request: Fetch = fetch) {
  const id = await acquireSync(env);
  if (!id) return { status: 429, body: { error: 'Sync active or cooldown (10 minutes)' } };
  await env.DB.prepare('INSERT INTO sync_runs (id,started_at,status) VALUES (?,?,?)')
    .bind(id, new Date().toISOString(), 'running').run();
  let error = 'dispatch:missing-configuration';
  try {
    if (!env.DISPATCH_TOKEN || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(env.SYNC_REPOSITORY) || !env.SYNC_REF) throw new Error(error);
    const response = await request(`https://api.github.com/repos/${env.SYNC_REPOSITORY}/actions/workflows/sync.yml/dispatches`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'Lake-Archive', 'X-GitHub-Api-Version': '2026-03-10' },
      body: JSON.stringify({ ref: env.SYNC_REF, inputs: { sync_id: id } }),
    });
    await response.body?.cancel();
    if (!response.ok) { error = `dispatch:github-${response.status}`; throw new Error(error); }
    return { status: 202, body: { id, status: 'queued' } };
  } catch {
    await env.DB.batch([
      env.DB.prepare('UPDATE sync_runs SET finished_at=?,status=?,errors=? WHERE id=?')
        .bind(new Date().toISOString(), 'failed', JSON.stringify([error]), id),
      env.DB.prepare('UPDATE sync_lock SET expires_at=0 WHERE id=1 AND owner=?').bind(id),
    ]);
    return { status: 503, body: { error: 'Sync dispatch unavailable', id } };
  }
}
