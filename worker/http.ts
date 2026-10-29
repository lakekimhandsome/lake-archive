import type { Fetch } from './types';

export async function limitedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('response-too-large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response-too-large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export class ApiError extends Error {
  constructor(readonly status: number) { super(`api-http-${status}`); }
}

// The timeout covers the response body as well as the initial headers.
export async function apiJson<T>(url: string, headers: Record<string, string>, request: Fetch = fetch, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await request(url, { ...init, headers, redirect: 'manual', signal: controller.signal });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after') ?? '1');
        await response.body?.cancel();
        if (!Number.isFinite(retry) || retry > 5) throw new ApiError(response.status);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, retry) * 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status); }
      return JSON.parse(await limitedText(response, 4 * 1024 * 1024)) as T;
    } finally { clearTimeout(timeout); }
  }
  throw new Error('api-retries-exhausted');
}
