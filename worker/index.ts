import { dispatchSync } from './dispatch';
import { hostname } from './safety';
import type { Env, Site } from './types';

const publicWhere = "(visibility='public' OR (visibility='auto' AND auto_public=1))";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(token), digest(env.ADMIN_TOKEN)]);
  return actual.reduce((diff, value, index) => diff | (value ^ expected[index]), 0) === 0;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/admin/')) {
    if (!await authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    if (url.pathname === '/api/admin/sync' && request.method === 'POST') {
      const result = await dispatchSync(env);
      return json(result.body, result.status);
    }
    if (url.pathname === '/api/admin/runs' && request.method === 'GET') {
      return json((await env.DB.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 30').all()).results);
    }
    if (url.pathname === '/api/admin/sites' && request.method === 'GET') {
      const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
      return json((await env.DB.prepare('SELECT * FROM sites ORDER BY hostname LIMIT 100 OFFSET ?').bind(Math.floor(offset)).all()).results);
    }
    if (url.pathname === '/api/admin/sites' && request.method === 'PATCH') {
      if (Number(request.headers.get('content-length')) > 2048) return json({ error: 'Body too large' }, 413);
      const { limitedText } = await import('./http');
      let body: { hostname?: string; visibility?: string };
      try { body = JSON.parse(await limitedText(new Response(request.body), 2048)); }
      catch { return json({ error: 'Invalid JSON' }, 400); }
      const host = typeof body?.hostname === 'string' && hostname(body.hostname);
      if (!host || !['auto', 'public', 'private'].includes(body.visibility ?? '')) return json({ error: 'Invalid hostname or visibility' }, 400);
      const result = await env.DB.prepare('UPDATE sites SET visibility=? WHERE hostname=?').bind(body.visibility, host).run();
      return result.meta.changes ? json({ hostname: host, visibility: body.visibility }) : json({ error: 'Not found' }, 404);
    }
    return json({ error: 'Not found' }, 404);
  }
  if (url.pathname === '/api/sites' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const state = url.searchParams.get('status');
    const sorts: Record<string, string> = { created: 'repository_created_at DESC', name: 'COALESCE(title,hostname) COLLATE NOCASE ASC', first: 'first_seen_at DESC', checked: 'last_checked_at DESC' };
    const requestedSort = url.searchParams.get('sort') ?? 'created';
    const sort = Object.hasOwn(sorts, requestedSort) ? sorts[requestedSort] : sorts.created;
    const offset = Math.floor(Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0)));
    const where = `${publicWhere} AND (hostname LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
      ${state === 'online' ? "AND current_status='online'" : state === 'offline' ? "AND current_status!='online'" : ''}`;
    const pattern = `%${q}%`;
    const [rows, counts, filtered, latest] = await env.DB.batch([
      env.DB.prepare(`SELECT hostname,title,description,favicon_url,repository_url,repository_verified_at,repository_created_at,first_seen_at,last_seen_at,
        last_checked_at,last_online_at,current_status,archived FROM sites WHERE ${where} ORDER BY ${sort},hostname LIMIT 60 OFFSET ?`).bind(pattern, pattern, offset),
      env.DB.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(current_status='online'),0) AS online FROM sites WHERE ${publicWhere}`),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM sites WHERE ${where}`).bind(pattern, pattern),
      env.DB.prepare("SELECT finished_at,status FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1"),
    ]);
    const sites = (rows.results as unknown as Site[]).map(site => {
      const { repository_verified_at, ...safe } = site;
      return { ...safe, repository_url: repository_verified_at && Date.now() - Date.parse(repository_verified_at) < 65 * 60000 ? site.repository_url : null };
    });
    return json({ sites, counts: counts.results[0], filtered: (filtered.results[0] as { count: number }).count, last_sync: latest.results[0] ?? null, page_size: 60 });
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let response: Response;
    try { response = await handle(request, env, ctx); }
    catch { response = json({ error: 'Service unavailable' }, 503); }
    const secure = new Response(response.body, response);
    secure.headers.set('X-Content-Type-Options', 'nosniff');
    secure.headers.set('Referrer-Policy', 'no-referrer');
    secure.headers.set('X-Frame-Options', 'DENY');
    secure.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    secure.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://lakekim.com https://*.lakekim.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return secure;
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchSync(env).then(result => {
      if (result.status >= 500) throw new Error('sync-dispatch-failed');
    }));
  },
} satisfies ExportedHandler<Env>;
