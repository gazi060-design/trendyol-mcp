export type StoreConfig = {
  alias: string;
  name?: string;
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  userAgent: string;
};

export type AppConfig = {
  env: 'production' | 'stage';
  baseUrl: string;
  port: number;
  mcpApiToken?: string;
  stores: Record<string, StoreConfig>;
};

type RawStore = {
  name?: string;
  sellerId?: string | number;
  apiKey?: string;
  apiSecret?: string;
  userAgent?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseStores(): Record<string, StoreConfig> {
  const raw = required('TRENDYOL_STORES_JSON');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TRENDYOL_STORES_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRENDYOL_STORES_JSON must be a JSON object keyed by store alias');
  }

  const stores: Record<string, StoreConfig> = {};

  for (const [rawAlias, value] of Object.entries(parsed as Record<string, RawStore>)) {
    const alias = rawAlias.trim().toLowerCase();
    if (!alias) throw new Error('Store alias cannot be empty');
    if (!value || typeof value !== 'object') throw new Error(`Invalid store config for: ${rawAlias}`);

    const sellerId = String(value.sellerId ?? '').trim();
    const apiKey = String(value.apiKey ?? '').trim();
    const apiSecret = String(value.apiSecret ?? '').trim();

    if (!sellerId || !apiKey || !apiSecret) {
      throw new Error(`Store ${rawAlias} requires sellerId, apiKey and apiSecret`);
    }

    if (stores[alias]) throw new Error(`Duplicate store alias: ${alias}`);

    stores[alias] = {
      alias,
      name: value.name?.trim() || undefined,
      sellerId,
      apiKey,
      apiSecret,
      userAgent: value.userAgent?.trim() || `${sellerId}-SelfIntegration`,
    };
  }

  if (Object.keys(stores).length === 0) {
    throw new Error('TRENDYOL_STORES_JSON must contain at least one store');
  }

  return stores;
}

export function getStore(config: AppConfig, alias: string): StoreConfig {
  const normalized = alias.trim().toLowerCase();
  const store = config.stores[normalized];
  if (!store) {
    throw new Error(`Unknown Trendyol store: ${alias}. Available aliases: ${Object.keys(config.stores).join(', ')}`);
  }
  return store;
}

export function loadConfig(): AppConfig {
  const env = (process.env.TRENDYOL_ENV ?? 'production').toLowerCase() === 'stage' ? 'stage' : 'production';

  return {
    env,
    baseUrl: env === 'stage' ? 'https://stageapigw.trendyol.com' : 'https://apigw.trendyol.com',
    port: Number(process.env.MCP_PORT ?? 3000),
    mcpApiToken: process.env.MCP_API_TOKEN?.trim() || undefined,
    stores: parseStores(),
  };
}
