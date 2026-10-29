import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../worker/types';
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
