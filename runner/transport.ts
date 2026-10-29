import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { publicIP, siteURL } from '../worker/safety';
import type { Fetch } from '../worker/types';

export function pinnedOptions(url: URL, addresses: string[]): RequestOptions {
  if (!siteURL(url.href) || !addresses.length || addresses.some(address => !publicIP(address))) throw new Error('blocked-address');
  return {
    protocol: 'https:', hostname: addresses[0], port: 443,
    path: url.pathname + url.search,
    // Connect to the checked IP, while authenticating the original hostname with TLS SNI.
    servername: url.hostname, rejectUnauthorized: true, agent: false, method: 'GET',
    headers: { Host: url.hostname, 'User-Agent': 'Lake-Archive/1.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
  };
}

export const runnerFetch: Fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (['api.cloudflare.com', 'api.github.com', 'cloudflare-dns.com'].includes(url.hostname) && url.protocol === 'https:' && !url.username && !url.password && !url.port) return fetch(input, init);
  if (!siteURL(url.href)) throw new Error('blocked-host');
  init?.signal?.throwIfAborted();
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  init?.signal?.throwIfAborted();
  const options = pinnedOptions(url, answers.map(answer => answer.address));
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest({ ...options, signal: init?.signal ?? undefined }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = response.statusCode ?? 502;
      if ([204, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); return; }
      let body: Readable = response;
      const encoding = headers.get('content-encoding');
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
      if (encoding && encoding !== 'identity' && !decoder) { response.destroy(); reject(new Error('unsupported-encoding')); return; }
      if (decoder) {
        pipeline(response, decoder, () => {});
        body = decoder;
        headers.delete('content-length'); headers.delete('content-encoding');
      }
      resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
};
