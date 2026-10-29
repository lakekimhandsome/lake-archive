import { Parser } from 'htmlparser2';
import { decodeHTML } from 'entities';
import { limitedText } from './http';
import { assertPublicDNS, siteURL } from './safety';
import type { Candidate, Fetch, Site } from './types';

export interface Probe {
  status: Site['current_status'];
  title?: string;
  description?: string;
  favicon?: string;
  image?: string;
}
const clean = (text: string, length: number) => decodeHTML(text).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, length);

export async function metadata(html: string, url: string): Promise<Omit<Probe, 'status'>> {
  let title = '';
  const meta: Record<string, string> = {};
  let favicon: string | undefined;
  let inTitle = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'title') inTitle = true;
      if (name === 'meta') {
        const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
        if (['description', 'og:title', 'og:description', 'og:image'].includes(key) && attrs.content && !meta[key]) meta[key] = attrs.content;
      }
      if (name === 'link' && !favicon && (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('icon')) {
        favicon = siteURL(decodeHTML(attrs.href ?? ''), url)?.href;
      }
    },
    ontext(text) { if (inTitle) title += text; },
    onclosetag(name) { if (name === 'title') inTitle = false; },
  }, { decodeEntities: false });
  parser.end(html);
  return {
    title: clean(meta['og:title'] || title, 300) || undefined,
    description: clean(meta['og:description'] || meta.description || '', 1000) || undefined,
    favicon: favicon ?? new URL('/favicon.ico', url).href,
    image: meta['og:image'] ? siteURL(decodeHTML(meta['og:image']), url)?.href : undefined,
  };
}

export async function probe(site: Candidate, request: Fetch = fetch): Promise<Probe> {
  if (site.unsafe) return { status: 'blocked' };
  let url = new URL(`https://${site.hostname}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const scopedFetch: Fetch = (input, init) => request(input, { ...init, signal: controller.signal });
    for (let redirects = 0; redirects <= 4; redirects++) {
      await assertPublicDNS(url.hostname, scopedFetch);
      const response = await scopedFetch(url.href, {
        redirect: 'manual', headers: { 'User-Agent': 'Lake-Archive/1.0', Accept: 'text/html,application/xhtml+xml' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location && siteURL(location, url.href);
        if (!next) return { status: 'blocked' };
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); return { status: 'offline' }; }
      if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return { status: 'online' };
      }
      const html = await limitedText(response, 512 * 1024);
      return { status: 'online', ...await metadata(html, url.href) };
    }
    return { status: 'blocked' };
  } catch (error) {
    if (error instanceof Error && error.message === 'sync-budget') throw error;
    return { status: error instanceof Error && /blocked-|response-too-large/.test(error.message) ? 'blocked' : 'offline' };
  } finally { clearTimeout(timer); }
}
