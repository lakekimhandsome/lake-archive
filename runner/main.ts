import { remoteD1 } from './d1';
import { runnerFetch } from './transport';
import { acquireSync, sync } from '../worker/sync';
import type { Env } from '../worker/types';

async function main() {
  const githubToken = process.env.DISCOVERY_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error('missing-runner-configuration');
  for (const key of ['CF_ACCOUNT_ID', 'CF_DATABASE_ID', 'CF_ZONE_ID', 'CF_API_TOKEN']) {
    if (!process.env[key]) throw new Error('missing-runner-configuration');
  }
  const DB = remoteD1(process.env.CF_ACCOUNT_ID!, process.env.CF_DATABASE_ID!, process.env.CF_API_TOKEN!);
  const env = { ...process.env, DB, GITHUB_TOKEN: githubToken, GITHUB_OWNER: process.env.DISCOVERY_GITHUB_TOKEN ? '' : process.env.GITHUB_OWNER } as unknown as Env;
  const id = process.env.SYNC_ID || await acquireSync(env);
  if (!id) { console.log('Sync skipped: active job or cooldown.'); return; }
  if (process.env.SYNC_ID) {
    const lock = await DB.prepare('SELECT owner,expires_at FROM sync_lock WHERE id=1').first<{ owner: string; expires_at: number }>();
    if (!lock || lock.owner !== id || lock.expires_at < Date.now()) throw new Error('expired-sync-request');
  }
  await sync(env, id, runnerFetch);
  const result = await DB.prepare('SELECT status,discovered,checked FROM sync_runs WHERE id=?').bind(id)
    .first<{ status: string; discovered: number; checked: number }>();
  // Public logs contain status only; counts and private discovery details stay in D1.
  console.log(`Archive sync: ${result?.status ?? 'unknown'}`);
  if (!result || result.status !== 'success') process.exitCode = 1;
}
main().catch(() => { console.error('Archive sync failed. Check private configuration and administrator run history.'); process.exitCode = 1; });
