import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { remoteD1 } from '../runner/d1';
import { pinnedOptions, runnerFetch } from '../runner/transport';
import type { Fetch } from '../worker/types';

describe('runner boundary', () => {
  it('loads the built runner in Node before checking configuration', () => {
    const result = spawnSync(process.execPath, ['.wrangler/runner.mjs'], { env: {}, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Archive sync failed. Check private configuration and administrator run history.');
  });

  it('pins a public address while keeping the original TLS identity and HTTP Host', () => {
    const options = pinnedOptions(new URL('https://example.lakekim.com/path?q=1'), ['93.184.216.34']);
    expect(options.hostname).toBe('93.184.216.34');
    expect(options.servername).toBe('example.lakekim.com');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toMatchObject({ Host: 'example.lakekim.com' });
    expect(options.path).toBe('/path?q=1');
    for (const addresses of [[], ['10.0.0.1'], ['93.184.216.34','::1'], ['::ffff:192.168.1.1']]) {
      expect(() => pinnedOptions(new URL('https://example.lakekim.com'), addresses)).toThrow('blocked-address');
    }
    expect(() => pinnedOptions(new URL('https://external.test'), ['93.184.216.34'])).toThrow('blocked-address');
  });
  it('does not allow arbitrary hosts through the runner transport', async () => {
    await expect(runnerFetch('https://127.0.0.1/')).rejects.toThrow('blocked-host');
    await expect(runnerFetch('https://api.github.com.evil.test/')).rejects.toThrow('blocked-host');
    await expect(runnerFetch('http://api.github.com/')).rejects.toThrow('blocked-host');
  });
  it('sends parameterized D1 queries and batches to the fixed authenticated endpoint', async () => {
    const request = vi.fn<Fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      const batch = JSON.parse(String(init?.body)).batch;
      return Response.json({ success: true, result: batch.map(() => ({ success: true, results: [{ value: 1 }], meta: { changes: 1 } })) });
    });
    const db = remoteD1('account', 'database', 'secret', request);
    expect(await db.prepare('SELECT ? AS value').bind(1).first()).toEqual({ value: 1 });
    const result = await db.batch([db.prepare('SELECT ?').bind("'; DROP TABLE sites; --"), db.prepare('SELECT 2')]);
    expect(result).toHaveLength(2);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).batch[0].params).toEqual(["'; DROP TABLE sites; --"]);
  });
  it('rejects failed D1 operations without returning raw upstream errors', async () => {
    const request: Fetch = async () => Response.json({ success: false, errors: [{ message: 'internal secret sql' }], result: [] });
    await expect(remoteD1('a', 'd', 's', request).prepare('SELECT 1').run()).rejects.toThrow('d1-query-failed');
  });
});
