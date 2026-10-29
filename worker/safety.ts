import ipaddr from 'ipaddr.js';
import { apiJson } from './http';
import type { Fetch } from './types';

export const ZONE = 'lakekim.com';
export function hostname(value: string): string | null {
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !(name === ZONE || name.endsWith(`.${ZONE}`))) return null;
  return name.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? name : null;
}
export function siteURL(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hostname(url.hostname) ? url : null;
  } catch { return null; }
}
export function publicIP(value: string): boolean {
  try { return ipaddr.parse(value).range() === 'unicast'; } catch { return false; }
}

// shortcut: DNS preflight cannot pin fetch IPs; use a pinned egress proxy if DNS writers are untrusted.
// Fail closed if either DNS family fails or any answer points into a private/special network.
export async function assertPublicDNS(host: string, request: Fetch = fetch): Promise<void> {
  if (!hostname(host)) throw new Error('blocked-host');
  const results = await Promise.all(['A', 'AAAA'].map(type =>
    apiJson<{ Status: number; Answer?: { type: number; data: string }[] }>(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { Accept: 'application/dns-json' }, request)));
  if (results.some(result => result.Status !== 0)) throw new Error('dns-unavailable');
  const addresses = results.flatMap(result => result.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28);
  if (!addresses.length || addresses.some(answer => !publicIP(answer.data))) throw new Error('blocked-address');
}
