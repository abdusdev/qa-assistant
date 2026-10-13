import path from 'node:path';
import express from 'express';
import { createApiRouter, type ApiDeps } from './api.js';

export interface AppOptions {
  /** A built web interface (web/dist). When set, it is served at / and unknown pages fall back to it. */
  staticDir?: string;
}

/**
 * Builds the HTTP app. Without dependencies it only answers the health check; with them it also
 * serves the generate API under /api. With a static folder it serves the web interface too.
 */
export function createApp(api?: ApiDeps, options: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (api) app.use('/api', createApiRouter(api));

  if (options.staticDir) {
    const dir = path.resolve(options.staticDir);
    app.use(express.static(dir, { index: 'index.html' }));
    // The interface keeps its place in the address after #, so any other page is the interface.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || !req.accepts('html')) {
        next();
        return;
      }
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  return app;
}
