import { parse as parseJSONC, type ParseError } from 'jsonc-parser';
import { parse as parseTOML } from 'smol-toml';
import { ApiError, apiJson } from './http';
import { hostname, siteURL } from './safety';
import type { Candidate, Env, Evidence, Fetch } from './types';

interface Repo { full_name: string; private: boolean; homepage: string | null; default_branch: string; created_at?: string }
interface File { type: string; name: string }
interface Content { content: string; encoding: string; size: number }
const configFiles = new Set(['CNAME', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'vercel.json']);

export function configHosts(name: string, text: string): string[] {
  if (name === 'CNAME') return [hostname(text.trim())].filter((value): value is string => !!value);
  const errors: ParseError[] = [];
  const data = (name.endsWith('.toml') ? parseTOML(text) : parseJSONC(text, errors, { allowTrailingComma: true })) as Record<string, unknown>;
  if (errors.length) throw new Error('invalid-deployment-config');
  if (!data || typeof data !== 'object') return [];
  const values: unknown[] = [];
  const collect = (config: Record<string, unknown>) => {
    for (const key of ['route', 'routes', 'domains', 'alias']) {
      const value = config[key];
      values.push(...(Array.isArray(value) ? value : [value]));
    }
  };
  collect(data);
  if (data.env && typeof data.env === 'object') {
    Object.values(data.env).forEach(value => { if (value && typeof value === 'object') collect(value as Record<string, unknown>); });
  }
  return [...new Set(values.flatMap(value => {
    const literal = typeof value === 'string' ? value : value && typeof value === 'object' && 'pattern' in value ? value.pattern : null;
    if (typeof literal !== 'string') return [];
    const url = siteURL(literal.includes('://') ? literal : `https://${literal}`);
    return url ? [url.hostname] : [];
  }))];
}

export async function repositories(env: Env, request: Fetch = fetch) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'Lake-Archive', 'X-GitHub-Api-Version': '2026-03-10',
  };
  const repos: Repo[] = [];
  const matches = new Map<string, Evidence[]>();
  const publicRepos = new Set<string>();
  const createdAt = new Map<string, string>();
  const errors: string[] = [];
  function add(host: string, repository: string, kind: Evidence['kind']) {
    const evidence = matches.get(host) ?? [];
    evidence.push({ kind, repository, confidence: 'high' });
    matches.set(host, evidence);
  }
  const listPath = env.GITHUB_OWNER ? `/users/${encodeURIComponent(env.GITHUB_OWNER)}/repos?type=owner` : '/user/repos?affiliation=owner,collaborator,organization_member';
  try {
    for (let page = 1; page <= 100; page++) {
      const batch = await apiJson<Repo[]>(`https://api.github.com${listPath}&per_page=100&page=${page}`, headers, request);
      if (!Array.isArray(batch)) throw new Error('invalid-repos');
      repos.push(...batch);
      if (repos.length > 1000) throw new Error('repository-limit');
      if (batch.length < 100) break;
      if (page === 100) throw new Error('repository-page-limit');
    }
  } catch { return { matches, publicRepos, createdAt, complete: false, errors: ['github:list'] }; }
  for (const repo of repos) {
    if (repo.private) continue;
    const fullName = repo.full_name.toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(fullName)) continue;
    // The authenticated list explicitly reports visibility; private repos never supply evidence.
    publicRepos.add(fullName);
    if (repo.created_at && Number.isFinite(Date.parse(repo.created_at))) {
      createdAt.set(fullName, new Date(repo.created_at).toISOString());
    }
    const home = repo.homepage && siteURL(repo.homepage);
    if (home) add(home.hostname, fullName, 'homepage');
  }
  for (const repo of repos) {
    const fullName = repo.full_name.toLowerCase();
    if (!publicRepos.has(fullName)) continue;
    try {
      let root: File[];
      try { root = await apiJson<File[]>(`https://api.github.com/repos/${fullName}/contents/`, headers, request); }
      catch (error) {
        // GitHub returns 404 for empty public repositories; they have no deployment files to scan.
        if (error instanceof ApiError && error.status === 404) continue;
        throw error;
      }
      const paths = root.filter(file => file.type === 'file' && configFiles.has(file.name)).map(file => file.name);
      if (root.some(file => file.type === 'dir' && file.name === 'docs')) paths.push('docs/CNAME');
      for (const path of paths) {
        let data: Content;
        try { data = await apiJson<Content>(`https://api.github.com/repos/${fullName}/contents/${path}`, headers, request); }
        catch (error) {
          if (path === 'docs/CNAME' && error instanceof ApiError && error.status === 404) continue;
          throw error;
        }
        if (data.encoding !== 'base64' || data.size > 64000) continue;
        const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, '')), c => c.charCodeAt(0));
        const name = path.split('/').pop()!;
        for (const host of configHosts(name, new TextDecoder().decode(bytes))) add(host, fullName, name === 'CNAME' ? 'CNAME' : 'config');
      }
    } catch (error) {
      errors.push(error instanceof ApiError ? `github:contents-${error.status}` : 'github:invalid-config');
      if ((error instanceof ApiError && [403, 429].includes(error.status)) || (error instanceof Error && error.message === 'github-budget')) break;
    }
  }
  return { matches, publicRepos, createdAt, complete: errors.length === 0, errors: [...new Set(errors)] };
}

export function matchRepository(site: Candidate, matches: Map<string, Evidence[]>, publicRepos: Set<string>) {
  const evidence = [...(matches.get(site.hostname) ?? [])];
  for (const repository of site.deployments) {
    if (publicRepos.has(repository)) evidence.push({ kind: 'pages-github', repository, confidence: 'high' });
  }
  const names = new Set(evidence.map(item => item.repository));
  return { evidence, repository: names.size === 1 ? `https://github.com/${[...names][0]}` : null };
}
