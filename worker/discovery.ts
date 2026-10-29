import { apiJson } from './http';
import { hostname, publicIP } from './safety';
import type { Candidate, Env, Fetch } from './types';

interface CFList<T> { success: boolean; result: T[]; result_info?: { total_pages?: number; page?: number } }
export async function cfList<T>(path: string, env: Env, request: Fetch = fetch): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await apiJson<CFList<T>>(`https://api.cloudflare.com/client/v4${path}${separator}page=${page}&per_page=100`,
      { Authorization: `Bearer ${env.CF_API_TOKEN}` }, request);
    if (!data.success || !Array.isArray(data.result)) throw new Error('cloudflare-invalid-response');
    values.push(...data.result);
    if (values.length > 10000) throw new Error('cloudflare-record-limit');
    if (data.result_info?.total_pages !== undefined ? page >= data.result_info.total_pages : !data.result_info || data.result.length < 100) return values;
  }
  throw new Error('cloudflare-page-limit');
}
interface DNSRecord { name: string; type: string; content: string }
interface PagesProject { name: string; domains?: string[]; source?: { type: string; config: { owner: string; repo_name: string } } }

export async function discover(env: Env, request: Fetch = fetch) {
  const sites = new Map<string, Candidate>();
  const errors: string[] = [];
  let successfulSources = 0;
  function add(value: string, source: string, repo?: string, unsafe = false) {
    const host = hostname(value);
    if (!host) return;
    const site = sites.get(host) ?? { hostname: host, sources: new Set<string>(), deployments: new Set<string>(), unsafe: false };
    site.sources.add(source);
    if (repo) site.deployments.add(repo.toLowerCase());
    site.unsafe ||= unsafe;
    sites.set(host, site);
  }
  async function source(name: string, run: () => Promise<void>) {
    try { await run(); successfulSources++; } catch { errors.push(`discovery:${name}`); }
  }
  await source('dns', async () => {
    const records = await cfList<DNSRecord>(`/zones/${env.CF_ZONE_ID}/dns_records`, env, request);
    for (const record of records) {
      if (['A', 'AAAA', 'CNAME'].includes(record.type)) add(record.name, `dns:${record.type}`,
        undefined, record.type !== 'CNAME' && !publicIP(record.content));
    }
  });
  await source('worker-routes', async () => {
    const routes = await cfList<{ pattern: string; script: string | null }>(`/zones/${env.CF_ZONE_ID}/workers/routes`, env, request);
    for (const route of routes) {
      if (!route.script) continue;
      const host = route.pattern.replace(/^https?:\/\//, '').split('/')[0];
      add(host, 'worker-route');
    }
  });
  await source('worker-domains', async () => {
    const domains = await cfList<{ hostname: string }>(`/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, env, request);
    domains.forEach(domain => add(domain.hostname, 'worker-domain'));
  });
  await source('pages', async () => {
    const projects = await cfList<PagesProject>(`/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, env, request);
    for (const project of projects) {
      const sourceRepo = project.source?.type === 'github' ? `${project.source.config.owner}/${project.source.config.repo_name}` : undefined;
      for (const domain of project.domains ?? []) add(domain, 'pages-domain', sourceRepo);
    }
  });
  return { sites, errors, successfulSources };
}
