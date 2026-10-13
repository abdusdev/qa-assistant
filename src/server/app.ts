import express from 'express';
import { createApiRouter, type ApiDeps } from './api.js';

/**
 * Builds the HTTP app. Without dependencies it only answers the health check; with them it also
 * serves the generate API under /api.
 */
export function createApp(api?: ApiDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (api) app.use('/api', createApiRouter(api));

  return app;
}
