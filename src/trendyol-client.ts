import type { AppConfig } from './config.js';

export class TrendyolClient {
  constructor(private readonly config: AppConfig) {}

  private headers(extra?: Record<string, string>) {
    const basic = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'User-Agent': this.config.userAgent,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try { data = JSON.parse(text); } catch { /* keep text */ }
    }
    if (!res.ok) throw new Error(`Trendyol API ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return data as T;
  }

  sellerPath(path: string): string {
    return path.replace('{sellerId}', encodeURIComponent(this.config.sellerId));
  }
}
