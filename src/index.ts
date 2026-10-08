import express, { type NextFunction, type Request, type Response } from 'express';
import type {} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { installOAuth, oauthChallenge } from './oauth.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp-server.js';

const config = loadConfig();
const app = express();
// Exactly one reverse proxy: the host Nginx.
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

function sanitizeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (!value || typeof value !== 'object') return value;

  const redactedKeys = new Set([
    'authorization',
    'token',
    'access_token',
    'refresh_token',
    'client_secret',
    'api_key',
    'apikey',
    'password',
    'secret'
  ]);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      redactedKeys.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeLogValue(item)
    ])
  );
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const body = req.body as Record<string, unknown> | undefined;
  const params = body && typeof body.params === 'object' && body.params
    ? body.params as Record<string, unknown>
    : undefined;

  const logEntry = {
    event: 'http_request',
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    sessionId: req.header('mcp-session-id') ?? null,
    userAgent: req.header('user-agent') ?? null,
    jsonrpcMethod: typeof body?.method === 'string' ? body.method : null,
    tool: typeof params?.name === 'string' ? params.name : null,
    arguments: params?.arguments === undefined ? undefined : sanitizeLogValue(params.arguments)
  };

  console.log(JSON.stringify(logEntry));

  res.on('finish', () => {
    console.log(JSON.stringify({
      event: 'http_response',
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      sessionId: req.header('mcp-session-id') ?? null
    }));
  });

  next();
});

const oauth = installOAuth(app);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'trendyol-marketplace-mcp' }));

async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (!config.mcpApiToken && !oauth) return next();
  if (config.mcpApiToken && req.header('authorization') === `Bearer ${config.mcpApiToken}`) return next();
  if (oauth) {
    const token = req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (token) {
      try {
        req.auth = await oauth.verifyAccessToken(token);
        return next();
      } catch { /* Return OAuth discovery challenge for invalid tokens. */ }
    }
    res.set('WWW-Authenticate', oauthChallenge(oauth));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}
app.use('/mcp', authenticate);

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.header('mcp-session-id');
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; },
      });

      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const server = createMcpServer(config);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid MCP session ID' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const id = req.header('mcp-session-id');
  if (!id || !transports[id]) return res.status(400).send('Invalid or missing MCP session ID');
  await transports[id].handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const id = req.header('mcp-session-id');
  if (!id || !transports[id]) return res.status(400).send('Invalid or missing MCP session ID');
  await transports[id].handleRequest(req, res);
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Trendyol MCP listening on :${config.port}`);
});
