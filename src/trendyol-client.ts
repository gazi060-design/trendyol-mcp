import type { AppConfig, StoreConfig } from './config.js';

export class TrendyolClient {
  constructor(
    private readonly config: AppConfig,
    private readonly store: StoreConfig,
  ) {}

  private headers(extra?: Record<string, string>) {
    const basic = Buffer.from(`${this.store.apiKey}:${this.store.apiSecret}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'User-Agent': this.store.userAgent,
      Accept: 'application/json',
      ...extra,
    };
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: this.headers(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try { data = JSON.parse(text); } catch { /* keep text */ }
    }

    if (path.includes('/claims?')) {
      console.info(JSON.stringify({
        event: 'trendyol_claims_api_response',
        store: this.store.alias,
        status: res.status,
        ok: res.ok,
        responseBytes: Buffer.byteLength(text, 'utf8'),
        contentType: res.headers.get('content-type'),
        responseKind: !text.trim() ? 'empty_body' : Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
        claimCount: data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { content?: unknown }).content)
          ? (data as { content: unknown[] }).content.length : null,
      }));
      if (res.ok && (!text.trim() || !data || typeof data !== 'object' || Array.isArray(data) ||
          !Array.isArray((data as { content?: unknown }).content))) {
        throw new Error(`Unexpected Trendyol claims response [store=${this.store.alias}, status=${res.status}]: expected JSON object with content array`);
      }
    }

    if (!res.ok) {
      throw new Error(`Trendyol API ${res.status} [store=${this.store.alias}]: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }

    return data as T;
  }

  sellerPath(path: string): string {
    return path.replace('{sellerId}', encodeURIComponent(this.store.sellerId));
  }
}
