import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp-server.js';

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'trendyol-marketplace-mcp' }));

function authenticate(req: Request, res: Response, next: NextFunction) {
  if (!config.mcpApiToken) return next();
  if (req.header('authorization') === `Bearer ${config.mcpApiToken}`) return next();
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
