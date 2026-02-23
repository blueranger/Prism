import dotenv from 'dotenv';
import path from 'path';

// Load .env from the monorepo root (two levels up from apps/api)
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
// Also try local .env as fallback
dotenv.config();

import http from 'http';
import express from 'express';
import cors from 'cors';
import { API_PORT } from '@prism/shared';
import promptRouter from './routes/prompt';
import modelsRouter from './routes/models';
import handoffRouter from './routes/handoff';
import compareRouter from './routes/compare';
import synthesizeRouter from './routes/synthesize';
import sessionsRouter from './routes/sessions';
import agentsRouter from './routes/agents';
import decisionsRouter from './routes/decisions';
import classifyRouter from './routes/classify';
import connectorsRouter from './routes/connectors';
import commRouter from './routes/comm';
import webhooksRouter from './routes/webhooks';
import importRouter from './routes/import';
import searchRouter from './routes/search';
import knowledgeRouter from './routes/knowledge';

// Import agents to trigger self-registration
import './agents';

// Import ALL connector types — they register their classes with ConnectorRegistry at import time.
// Multi-account: both types can be active simultaneously.
import './connectors/outlook';
import './connectors/outlook-local';
import './connectors/line';

import { ConnectorRegistry } from './connectors/registry';
import { initPolling } from './services/connector-service';
import { initWebSocket } from './services/ws';
import { restoreSubscriptions } from './services/graph-subscriptions';

// Validate required API keys at startup
const requiredKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY'];
for (const key of requiredKeys) {
  if (process.env[key]) {
    console.log(`[env] ${key}: set (${process.env[key]!.slice(0, 8)}...)`);
  } else {
    console.warn(`[env] WARNING: ${key} is NOT set — requests to this provider will fail`);
  }
}

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.use('/api/prompt', promptRouter);
app.use('/api/models', modelsRouter);
app.use('/api/handoff', handoffRouter);
app.use('/api/compare', compareRouter);
app.use('/api/synthesize', synthesizeRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/decisions', decisionsRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/connectors', connectorsRouter);
app.use('/api/comm', commRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/import', importRouter);
app.use('/api/search', searchRouter);
app.use('/api/knowledge', knowledgeRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

server.listen(API_PORT, () => {
  console.log(`Prism API running on http://localhost:${API_PORT}`);

  // Initialize WebSocket server on the same HTTP server
  initWebSocket(server);

  // Restore all active connector instances from DB
  ConnectorRegistry.restoreFromDb();

  // Start polling for all active connectors (Outlook uses 5-min round-robin)
  initPolling();

  // Auto-start LINE monitor agent for any restored LINE connectors (30s polling)
  const lineConnectors = ConnectorRegistry.getByProvider('line');
  if (lineConnectors.length > 0) {
    // Lazy import to avoid circular deps
    import('./agents/line-monitor').then(({ startLineMonitoring }) => {
      for (const conn of lineConnectors) {
        console.log(`[startup] Auto-starting LINE monitor for ${conn.accountId}`);
        startLineMonitoring(conn.accountId);
      }
    });
  }

  // Restore any Graph webhook subscriptions from previous run
  restoreSubscriptions().catch((err: any) => {
    console.error('[startup] Failed to restore Graph subscriptions:', err.message);
  });
});
