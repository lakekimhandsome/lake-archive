import { discover } from './discovery';
import { repositories, matchRepository } from './github';
import { probe } from './probe';
import type { Candidate, Env, Fetch, Site } from './types';

export { acquireSync } from './lock';

export async function sync(env: Env, id: string, request: Fetch = fetch): Promise<void> {
  const started = new Date().toISOString();
  const errors: string[] = [];
  let discovered = 0;
  let checked = 0;
  let calls = 0;
  const deadline = Date.now() + 10 * 60000;
  const budgetFetch: Fetch = (input, init) => {
    if (++calls > 2500 || Date.now() > deadline) throw new Error('sync-budget');
    return request(input, init);
  };
  try {
    await env.DB.prepare('INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at').bind(id, started, 'running').run();
    if (![env.CF_ACCOUNT_ID, env.CF_ZONE_ID, env.CF_API_TOKEN, env.GITHUB_TOKEN].every(Boolean)) throw new Error('missing-configuration');
    const discovery = await discover(env, budgetFetch);
    discovered = discovery.sites.size;
    errors.push(...discovery.errors);
    const old = await env.DB.prepare('SELECT * FROM sites').all<Site>();
    const previous = new Map(old.results.map(site => [site.hostname, site]));
    // Persist discoveries before slower GitHub calls so an exhausted budget cannot lose new hosts.
    const discoveries = [...discovery.sites.values()];
    for (let offset = 0; offset < discoveries.length; offset += 100) {
      await env.DB.batch(discoveries.slice(offset, offset + 100).map(site => {
        const existing = previous.get(site.hostname);
        const sources = JSON.stringify([...new Set([...(existing ? JSON.parse(existing.discovery_sources) as string[] : []), ...site.sources])].sort());
        return env.DB.prepare(`INSERT INTO sites (hostname,first_seen_at,last_seen_at,discovery_sources,dns_created_at) VALUES (?,?,?,?,?)
          ON CONFLICT(hostname) DO UPDATE SET last_seen_at=excluded.last_seen_at,discovery_sources=excluded.discovery_sources,dns_created_at=COALESCE(excluded.dns_created_at,sites.dns_created_at),archived=0`)
          .bind(site.hostname, started, started, sources, site.dnsCreatedAt ?? null);
      }));
    }
    let githubCalls = 0;
    const githubDeadline = Math.min(deadline - 60000, Date.now() + 4 * 60000);
    const githubFetch: Fetch = (input, init) => {
      if (++githubCalls > 1200 || Date.now() > githubDeadline) throw new Error('github-budget');
      return budgetFetch(input, init);
    };
    const github = await repositories(env, githubFetch);
    errors.push(...github.errors);
    // Recheck retained hosts even after DNS deletion; last_seen only changes for discoveries.
    const candidates = new Map(discovery.sites);
    for (const site of previous.values()) {
      if (!candidates.has(site.hostname)) candidates.set(site.hostname, {
        hostname: site.hostname, sources: new Set(), deployments: new Set(), unsafe: site.current_status === 'blocked',
      });
    }
    const pending = [...candidates.values()].sort((a, b) =>
      (previous.get(a.hostname)?.last_checked_at ?? '').localeCompare(previous.get(b.hostname)?.last_checked_at ?? ''));
    async function save(candidate: Candidate) {
      const existing = previous.get(candidate.hostname);
      const now = new Date().toISOString();
      const observed = discovery.sites.has(candidate.hostname);
      const canProbe = !discovery.errors.includes('discovery:dns');
      const result = canProbe ? await probe(candidate, budgetFetch) : { status: existing?.current_status ?? 'unknown' };
      const match = matchRepository(candidate, github.matches, github.publicRepos);
      const matchingComplete = github.complete && discovery.successfulSources === 4;
      const ambiguous = new Set(match.evidence.map(item => item.repository)).size > 1;
      const repository = matchingComplete || ambiguous ? match.repository : match.repository ?? existing?.repository_url ?? null;
      const evidence = matchingComplete || match.evidence.length ? JSON.stringify(match.evidence) : existing?.matching_evidence ?? '[]';
      const verified = repository && github.publicRepos.has(repository.replace('https://github.com/', '')) ? now : null;
      const repositoryCreatedAt = repository
        ? github.createdAt.get(repository.replace('https://github.com/', ''))
          ?? (repository === existing?.repository_url ? existing.repository_created_at : null)
        : null;
      // Publication is retained as history; only an explicit administrator override hides it.
      const autoPublic = Number(!!existing?.auto_public || observed);
      const sources = JSON.stringify([...new Set([...(existing ? JSON.parse(existing.discovery_sources) as string[] : []), ...candidate.sources])].sort());
      const archived = observed ? 0 : discovery.successfulSources === 4 ? 1 : existing?.archived ?? 0;
      await env.DB.prepare(`INSERT INTO sites (hostname,title,description,favicon_url,og_image_url,repository_url,repository_verified_at,repository_created_at,
        first_seen_at,last_seen_at,last_checked_at,last_online_at,current_status,discovery_sources,matching_evidence,archived,auto_public)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(hostname) DO UPDATE SET
        title=excluded.title,description=excluded.description,favicon_url=excluded.favicon_url,og_image_url=excluded.og_image_url,
        repository_url=excluded.repository_url,repository_verified_at=excluded.repository_verified_at,repository_created_at=excluded.repository_created_at,
        last_seen_at=excluded.last_seen_at,last_checked_at=excluded.last_checked_at,last_online_at=excluded.last_online_at,
        current_status=excluded.current_status,discovery_sources=excluded.discovery_sources,matching_evidence=excluded.matching_evidence,
        archived=excluded.archived,auto_public=excluded.auto_public`).bind(
        candidate.hostname, result.title ?? existing?.title ?? null, result.description ?? existing?.description ?? null,
        result.favicon ?? existing?.favicon_url ?? null, result.image ?? existing?.og_image_url ?? null,
        repository, verified, repositoryCreatedAt ?? null, existing?.first_seen_at ?? now, observed ? now : existing!.last_seen_at,
        canProbe ? now : existing?.last_checked_at ?? null, canProbe && result.status === 'online' ? now : existing?.last_online_at ?? null,
        result.status, sources, evidence, archived, autoPublic).run();
      if (canProbe) checked++;
    }
    // Each probe opens two DNS requests; three probes use at most six outbound connections.
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (pending.length) {
        if (Date.now() > deadline || calls > 2500) { errors.push('sync:budget'); break; }
        const candidate = pending.shift()!;
        try { await save(candidate); } catch { errors.push('sync:site-update'); }
      }
    }));
    if (!discovery.successfulSources) errors.push('sync:no-discovery-sources');
    await finish(errors.length ? 'partial' : 'success');
  } catch (error) {
    errors.push(error instanceof Error && error.message === 'missing-configuration' ? 'missing-configuration' : 'sync:failed');
    await finish('failed');
  } finally {
    await env.DB.prepare('UPDATE sync_lock SET expires_at=0 WHERE id=1 AND owner=?').bind(id).run();
  }
  async function finish(status: string) {
    await env.DB.prepare('UPDATE sync_runs SET finished_at=?,status=?,discovered=?,checked=?,errors=? WHERE id=?')
      .bind(new Date().toISOString(), status, discovered, checked, JSON.stringify([...new Set(errors)]), id).run();
    // Bound operational history, never site history.
    await env.DB.prepare("DELETE FROM sync_runs WHERE julianday(started_at) < julianday('now','-90 days')").run();
  }
}
