import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { cfList, discover } from '../worker/discovery';
import { configHosts, matchRepository, repositories } from '../worker/github';
import { apiJson, limitedText } from '../worker/http';
import { metadata, probe } from '../worker/probe';
import { hostname, publicIP, siteURL } from '../worker/safety';
import { acquireSync, sync } from '../worker/sync';
import type { Candidate, Env, Fetch, Site } from '../worker/types';

const testEnv: Env = { ...env, CF_ACCOUNT_ID: 'test-account', CF_ZONE_ID: 'test-zone', CF_API_TOKEN: 'secret-cf', GITHUB_TOKEN: 'secret-github', ADMIN_TOKEN: 'x'.repeat(40), DISPATCH_TOKEN: 'dispatch-secret', SYNC_REPOSITORY: 'test/archive', SYNC_REF: 'main' };
const candidate = (host = 'example.lakekim.com'): Candidate => ({ hostname: host, sources: new Set(['dns:A']), deployments: new Set(), unsafe: false });
const json = (value: unknown, status = 200) => Response.json(value, { status });
let records: { name: string; type: string; content: string }[];
let repoPrivate: boolean;
let githubFailure: boolean;
let pagesFailure: boolean;
let online: boolean;
let calls: string[];

const request: Fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  calls.push(url.href);
  if (url.hostname === 'api.cloudflare.com') {
    if (pagesFailure && url.pathname.includes('/pages/')) return json({}, 403);
    const result = url.pathname.endsWith('/dns_records') ? records : [];
    return json({ success: true, result, result_info: { total_pages: 1 } });
  }
  if (url.hostname === 'api.github.com') {
    if (githubFailure) return json({}, 403);
    if (url.pathname === '/user/repos') return json([
      { full_name: 'lake/public', private: repoPrivate, homepage: 'https://example.lakekim.com/', default_branch: 'main' },
      { full_name: 'lake/secret-internal-project', private: true, homepage: 'https://internal.lakekim.com', default_branch: 'main' },
    ]);
    if (url.pathname.endsWith('/contents/')) return json([]);
    throw new Error(`unexpected-github-path: ${url.pathname}`);
  }
  if (url.hostname === 'cloudflare-dns.com') return json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
  expect(init?.redirect).toBe('manual');
  expect(new Headers(init?.headers).get('authorization')).toBeNull();
  return new Response(online ? '<title>Example &amp; Archive</title><meta name="description" content="A website">' : 'offline', {
    status: online ? 200 : 503, headers: { 'Content-Type': 'text/html' },
  });
};

async function run() { await sync(testEnv, crypto.randomUUID(), request); }
async function api(path = '/api/sites', options?: RequestInit) {
  return worker.fetch(new Request(`https://archive.lakekim.com${path}`, options), testEnv, createExecutionContext());
}
async function getSite(host = 'example.lakekim.com') { return env.DB.prepare('SELECT * FROM sites WHERE hostname=?').bind(host).first<Site>(); }

beforeEach(async () => {
  await env.DB.batch(['DELETE FROM sites', 'DELETE FROM sync_runs', 'DELETE FROM sync_lock'].map(sql => env.DB.prepare(sql)));
  records = [{ name: 'example.lakekim.com', type: 'A', content: '93.184.216.34' }];
  calls = []; repoPrivate = false; githubFailure = false; pagesFailure = false; online = true;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('scope and SSRF', () => {
  it('normalizes exact suffixes and rejects wildcards, malformed labels and external domains', () => {
    expect(hostname('EXAMPLE.LAKEKIM.COM.')).toBe('example.lakekim.com');
    for (const host of ['*.lakekim.com', 'lakekim.com.evil.test', 'evillakekim.com', '-x.lakekim.com', 'x..lakekim.com', '127.0.0.1', 'x/y.lakekim.com']) expect(hostname(host)).toBeNull();
    for (const url of ['http://x.lakekim.com', 'https://x.lakekim.com:8080', 'https://secret@x.lakekim.com', 'https://evil.test']) expect(siteURL(url)).toBeNull();
  });
  it('blocks private, mapped, special IPv4/IPv6 addresses', () => {
    for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) expect(publicIP(ip), ip).toBe(false);
    expect(publicIP('93.184.216.34')).toBe(true);
    expect(publicIP('2606:4700:4700::1111')).toBe(true);
  });
  it('does not request a private DNS address or external redirect target', async () => {
    const mock = vi.fn<Fetch>(async input => {
      const url = String(input);
      if (url.includes('dns-query')) return json({ Status: 0, Answer: [{ type: 1, data: '10.0.0.1' }] });
      throw new Error('must not access origin');
    });
    expect((await probe(candidate(), mock)).status).toBe('blocked');
    expect(mock).toHaveBeenCalledTimes(2);
    const redirects: Fetch = async input => String(input).includes('dns-query') ? json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) : new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
    expect((await probe(candidate(), redirects)).status).toBe('blocked');
  });
  it('checks redirect destination DNS and bounds redirect loops', async () => {
    let targetRequested = false;
    const redirects: Fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') return json({ Status: 0, Answer: [{ type: 1, data: url.searchParams.get('name') === 'private.lakekim.com' ? '192.168.0.1' : '93.184.216.34' }] });
      if (url.hostname === 'private.lakekim.com') targetRequested = true;
      return new Response(null, { status: 302, headers: { Location: 'https://private.lakekim.com' } });
    };
    expect((await probe(candidate(), redirects)).status).toBe('blocked');
    expect(targetRequested).toBe(false);
    expect((await probe({ ...candidate(), unsafe: true }, request)).status).toBe('blocked');
    expect(calls).toHaveLength(0);
  });
  it('limits streamed bodies, not just the Content-Length header', async () => {
    await expect(limitedText(new Response('12345'), 4)).rejects.toThrow('response-too-large');
    const large: Fetch = async input => String(input).includes('dns-query') ? json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) : new Response('x'.repeat(513 * 1024), { headers: { 'content-type': 'text/html' } });
    expect((await probe(candidate(), large)).status).toBe('blocked');
  });
});

describe('discovery and matching', () => {
  it('paginates Cloudflare results and merges record types without wildcard hosts', async () => {
    let page = 0;
    const pages: Fetch = async () => json({ success: true, result: [{ page: ++page }], result_info: { total_pages: 2 } });
    expect(await cfList('/test', testEnv, pages)).toEqual([{ page: 1 }, { page: 2 }]);
    records.push({ ...records[0], type: 'AAAA', content: '2606:4700:4700::1111' }, { ...records[0], name: '*.lakekim.com' }, { ...records[0], name: 'evil.test' });
    const result = await discover(testEnv, request);
    expect(result.sites.size).toBe(1);
    expect([...result.sites.get('example.lakekim.com')!.sources]).toEqual(['dns:A', 'dns:AAAA']);
  });
  it('merges Workers and Pages custom domains and records GitHub integration', async () => {
    const deployments: Fetch = async input => {
      const path = new URL(String(input)).pathname;
      const result = path.endsWith('dns_records') ? records : path.endsWith('/routes') ? [{ pattern: 'https://example.lakekim.com/*', script: 'worker' }, { pattern: '*.lakekim.com/*', script: 'wild' }] : path.endsWith('/domains') ? [{ hostname: 'example.lakekim.com' }] : [{ name: 'pages', domains: ['example.lakekim.com', 'pages.lakekim.com', 'other.test'], source: { type: 'github', config: { owner: 'lake', repo_name: 'public' } } }];
      return json({ success: true, result, result_info: { total_pages: 1 } });
    };
    const found = await discover(testEnv, deployments);
    expect(found.sites.size).toBe(2);
    expect(found.sites.get('example.lakekim.com')!.sources.size).toBe(4);
    expect(found.sites.get('pages.lakekim.com')!.deployments.has('lake/public')).toBe(true);
  });
  it('recognizes managed Worker placeholder DNS only with a confirmed Custom Domain', async () => {
    const managed: Fetch = async input => {
      const path = new URL(String(input)).pathname;
      const result = path.endsWith('dns_records') ? [{ name: 'archive.lakekim.com', type: 'AAAA', content: '100::', proxied: true, meta: { read_only: true, origin_worker_id: 'worker-id' } }] : path.endsWith('/domains') ? [{ hostname: 'archive.lakekim.com' }] : [];
      return json({ success: true, result, result_info: { total_pages: 1 } });
    };
    expect((await discover(testEnv, managed)).sites.get('archive.lakekim.com')!.unsafe).toBe(false);
    const unconfirmed: Fetch = (input, init) => String(input).includes('/workers/domains') ? Promise.resolve(json({}, 403)) : managed(input, init);
    expect((await discover(testEnv, unconfirmed)).sites.get('archive.lakekim.com')!.unsafe).toBe(true);
  });
  it('uses only explicit config fields and exact CNAME, including JSONC and TOML', () => {
    expect(configHosts('CNAME', 'example.lakekim.com\n')).toEqual(['example.lakekim.com']);
    expect(configHosts('wrangler.jsonc', '// comment\n{"routes":[{"pattern":"example.lakekim.com/*"}],"name":"ignored.lakekim.com"}')).toEqual(['example.lakekim.com']);
    expect(configHosts('wrangler.toml', 'name="ignored.lakekim.com"\n[[routes]]\npattern="example.lakekim.com"')).toEqual(['example.lakekim.com']);
    expect(configHosts('vercel.json', '{"alias":["app.lakekim.com","outside.test"]}')).toEqual(['app.lakekim.com']);
  });
  it('does not guess by repository name, expose private matches, or choose conflicting repositories', async () => {
    const github = await repositories(testEnv, request);
    expect(matchRepository(candidate(), github.matches, github.publicRepos).repository).toBe('https://github.com/lake/public');
    expect(matchRepository(candidate('internal.lakekim.com'), github.matches, github.publicRepos).repository).toBeNull();
    expect(matchRepository(candidate('public.lakekim.com'), github.matches, github.publicRepos).repository).toBeNull();
    const site = candidate(); site.deployments.add('lake/other');
    expect(matchRepository(site, github.matches, new Set(['lake/other'])).repository).toBeNull();
    expect(calls.some(value => value.includes('secret-internal-project'))).toBe(false);
  });
  it('paginates GitHub repositories and reads CNAME evidence through the authenticated contents API', async () => {
    let pages = 0;
    const github: Fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-github');
      if (url.pathname === '/user/repos') {
        pages++;
        return json(url.searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, n) => ({ full_name: `lake/private-${n}`, private: true, homepage: null }))
          : [{ full_name: 'lake/public', private: false, homepage: null }]);
      }
      if (url.pathname.endsWith('/contents/')) return json([{ name: 'CNAME', type: 'file' }]);
      return json({ content: btoa('example.lakekim.com'), encoding: 'base64', size: 19 });
    };
    const result = await repositories(testEnv, github);
    expect(pages).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.matches.get('example.lakekim.com')?.[0].kind).toBe('CNAME');
    expect(() => configHosts('wrangler.json', '{"route":"example.lakekim.com"')).toThrow('invalid-deployment-config');
  });
  it('collects decoded metadata and discards external image links', async () => {
    const result = await metadata('<title>A &amp; B</title><meta property="og:description" content="A &amp; B"><link rel="shortcut icon" href="/icon.png"><meta property="og:image" content="https://evil.test/image">', 'https://example.lakekim.com');
    expect(result.title).toBe('A & B');
    expect(result.description).toBe('A & B');
    expect(result.favicon).toBe('https://example.lakekim.com/icon.png');
    expect(result.image).toBeUndefined();
  });
});

describe('D1 sync and API', () => {
  it('automatically adds a new subdomain, is idempotent, and retains removed/offline records', async () => {
    await run();
    const first = (await getSite())!;
    expect(first.current_status).toBe('online');
    expect(first.repository_url).toBe('https://github.com/lake/public');
    expect(first.auto_public).toBe(1);
    await run();
    expect((await getSite())!.first_seen_at).toBe(first.first_seen_at);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{ n: number }>())!.n).toBe(1);
    const lastSeen = (await getSite())!.last_seen_at;
    records = []; online = false;
    await run();
    const retained = (await getSite())!;
    expect(retained.last_online_at).not.toBeNull();
    expect(retained.last_seen_at).toBe(lastSeen);
    expect(retained.current_status).toBe('offline');
    expect(retained.archived).toBe(1);
    expect((await (await api()).json<{ sites: Site[] }>()).sites).toHaveLength(1);
    records = [{ name: 'new.lakekim.com', type: 'CNAME', content: 'example.pages.dev' }]; online = true;
    await run();
    expect(await getSite('new.lakekim.com')).not.toBeNull();
  });
  it('preserves history and matching on GitHub outage; hides unverified repository URLs', async () => {
    await run();
    const first = (await getSite())!;
    githubFailure = true; pagesFailure = true;
    await run();
    const next = (await getSite())!;
    expect(next.repository_url).toBe(first.repository_url);
    expect(next.matching_evidence).toBe(first.matching_evidence);
    expect(next.first_seen_at).toBe(first.first_seen_at);
    expect(next.archived).toBe(0);
    expect((await (await api()).json<{ sites: Site[] }>()).sites[0].repository_url).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status='partial'").first()).toEqual({ n: 1 });
  });
  it('does not expose internal hosts, private repository evidence, admin fields, or raw errors', async () => {
    records.push({ name: 'internal.lakekim.com', type: 'A', content: '93.184.216.34' });
    await run();
    const text = await (await api()).text();
    expect(text).toContain('example.lakekim.com');
    for (const secret of ['internal.lakekim.com','secret-internal-project','matching_evidence','discovery_sources','visibility','secret-cf','secret-github']) expect(text).not.toContain(secret);
    expect((await api('/api/admin/sites')).status).toBe(401);
    expect((await api('/api/admin/sync', { method: 'POST' })).status).toBe(401);
    expect((await api('/api/sync', { method: 'POST' })).status).toBe(404);
    repoPrivate = true; await run();
    expect((await getSite())!.repository_url).toBeNull();
    expect((await (await api()).text())).not.toContain('github.com');
  });
  it('clears a conflicting match even if another discovery source fails', async () => {
    await run();
    pagesFailure = true;
    const conflicting: Fetch = (input, init) => String(input).includes('/user/repos?') ? Promise.resolve(json([
      { full_name: 'lake/public', private: false, homepage: 'https://example.lakekim.com' },
      { full_name: 'lake/other', private: false, homepage: 'https://example.lakekim.com' },
    ])) : request(input, init);
    await sync(testEnv, crypto.randomUUID(), conflicting);
    expect((await getSite())!.repository_url).toBeNull();
    expect(JSON.parse((await getSite())!.matching_evidence)).toHaveLength(2);
  });
  it('allows an authenticated visibility override and never resets it during sync', async () => {
    await run();
    expect((await api('/api/admin/sites', { method: 'PATCH', headers: { Authorization: `Bearer ${testEnv.ADMIN_TOKEN}` }, body: JSON.stringify({ hostname: 'example.lakekim.com', visibility: 'private' }) })).status).toBe(200);
    await run();
    expect((await (await api()).json<{ sites: Site[] }>()).sites).toHaveLength(0);
    expect((await getSite())!.visibility).toBe('private');
  });
  it('discovers itself normally and only fetches its root, with no synchronization recursion', async () => {
    records = [{ name: 'archive.lakekim.com', type: 'A', content: '93.184.216.34' }];
    await run(); await run();
    expect(await getSite('archive.lakekim.com')).not.toBeNull();
    expect(calls.filter(value => value.startsWith('https://archive.lakekim.com'))).toEqual(['https://archive.lakekim.com/', 'https://archive.lakekim.com/']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{ n: number }>())!.n).toBe(1);
  });
  it('dispatches the hourly job without probing sites and shares the manual cooldown', async () => {
    const dispatch = vi.fn<Fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.github.com/repos/test/archive/actions/workflows/sync.yml/dispatches');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer dispatch-secret');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', dispatch);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '0 * * * *' }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await getSite()).toBeNull();
    const run = await env.DB.prepare('SELECT id,status FROM sync_runs').first<{ id: string; status: string }>();
    expect(run!.status).toBe('running');
    // The runner takes over the same run ID rather than inserting a duplicate history row.
    await sync(testEnv, run!.id, request);
    expect((await getSite())!.current_status).toBe('online');
    expect((await api('/api/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${testEnv.ADMIN_TOKEN}` } })).status).toBe(429);
  });
  it('records dispatch failure without exposing tokens or changing existing records', async () => {
    await run();
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response(null, { status: 403 })));
    const response = await api('/api/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${testEnv.ADMIN_TOKEN}` } });
    expect(response.status).toBe(503);
    expect(await getSite()).not.toBeNull();
    expect(await env.DB.prepare("SELECT errors FROM sync_runs WHERE status='failed'").first()).toEqual({ errors: '["dispatch:github-403"]' });
  });
  it('uses an atomic lock and keeps a cooldown after finishing', async () => {
    const ids = await Promise.all([acquireSync(testEnv), acquireSync(testEnv)]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    await sync(testEnv, ids.find(Boolean)!, request);
    expect(await acquireSync(testEnv)).toBeNull();
  });
  it('escapes search wildcard/SQL characters and filters statuses', async () => {
    await run();
    expect((await (await api('/api/sites?q=%25')).json<{ sites: Site[] }>()).sites).toHaveLength(0);
    expect((await (await api('/api/sites?status=offline')).json<{ sites: Site[] }>()).sites).toHaveLength(0);
    expect((await (await api('/api/sites?q=example&sort=first')).json<{ sites: Site[] }>()).sites).toHaveLength(1);
    expect((await api('/api/sites?sort=constructor')).status).toBe(200);
    expect((await api('/api/sites')).headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  });
  it('keeps status and timestamps without probing when DNS management is unavailable', async () => {
    await run();
    const first = (await getSite())!;
    const dnsFailure: Fetch = (input, init) => String(input).includes('/dns_records') ? Promise.resolve(json({}, 403)) : request(input, init);
    calls = [];
    await sync(testEnv, crypto.randomUUID(), dnsFailure);
    const next = (await getSite())!;
    expect(next.last_checked_at).toBe(first.last_checked_at);
    expect(next.last_online_at).toBe(first.last_online_at);
    expect(next.current_status).toBe(first.current_status);
    expect(calls.some(value => value.startsWith('https://example.lakekim.com'))).toBe(false);
  });
  it('records missing configuration as failure without deleting existing data', async () => {
    await run();
    await sync({ ...testEnv, CF_API_TOKEN: '' }, crypto.randomUUID(), request);
    expect(await getSite()).not.toBeNull();
    expect((await env.DB.prepare("SELECT errors FROM sync_runs WHERE status='failed'").first<{ errors: string }>())!.errors).toBe('["missing-configuration"]');
  });
});

it('retries transient API errors with a bound', async () => {
  let count = 0;
  const retry: Fetch = async () => ++count === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '0' } }) : json({ ok: true });
  expect(await apiJson('https://api.github.com/test', {}, retry)).toEqual({ ok: true });
  expect(count).toBe(2);
});
