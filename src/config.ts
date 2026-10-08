export type AppConfig = {
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  env: 'production' | 'stage';
  baseUrl: string;
  userAgent: string;
  port: number;
  mcpApiToken?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): AppConfig {
  const env = (process.env.TRENDYOL_ENV ?? 'production').toLowerCase() === 'stage' ? 'stage' : 'production';
  const sellerId = required('TRENDYOL_SELLER_ID');

  return {
    sellerId,
    apiKey: required('TRENDYOL_API_KEY'),
    apiSecret: required('TRENDYOL_API_SECRET'),
    env,
    baseUrl: env === 'stage' ? 'https://stageapigw.trendyol.com' : 'https://apigw.trendyol.com',
    userAgent: process.env.TRENDYOL_USER_AGENT?.trim() || `${sellerId}-SelfIntegration`,
    port: Number(process.env.MCP_PORT ?? 3000),
    mcpApiToken: process.env.MCP_API_TOKEN?.trim() || undefined
  };
}
