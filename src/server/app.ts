import path from 'node:path';
import express from 'express';
import { createApiRouter, type ApiDeps } from './api.js';
import type { Logger } from './logger.js';
import { securityHeaders } from './security.js';

export interface AppOptions {
  /** A built web interface (web/dist). When set, it is served at / and unknown pages fall back to it. */
  staticDir?: string;
  /** One line per request: method, path, status, time. Never a body or a query value. */
  logger?: Logger;
  /** Trust the X-Forwarded-For header, for a server behind a proxy, so limits count real clients. */
  trustProxy?: boolean;
  /** Send Strict-Transport-Security. Only for a server reached over HTTPS. */
  hsts?: boolean;
}

/** Logs when each request finishes, with what is safe to know about it. */
function requestLogger(logger: Logger): express.RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/ready') return;
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      // The full path, without the query: values in a query string are not for the log.
      const fullPath = req.originalUrl.split('?')[0] ?? req.path;
      const fields = { method: req.method, path: fullPath, status: res.statusCode, ms };
      if (res.statusCode >= 500) logger.error(fields, 'request failed');
      else if (res.statusCode >= 400) logger.warn(fields, 'request refused');
      else logger.info(fields, 'request');
    });
    next();
  };
}

/**
 * Builds the HTTP app. Without dependencies it only answers the health check; with them it also
 * serves the generate API under /api. With a static folder it serves the web interface too.
 */
export function createApp(api?: ApiDeps, options: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', true);

  app.use(securityHeaders({ hsts: options.hsts ?? false }));
  if (options.logger) app.use(requestLogger(options.logger));

  // Alive: the process answers. Used by a container or a load balancer to restart a stuck server.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Ready: the things it needs (the database) answer. Used to decide whether to send traffic.
  app.get('/ready', async (_req, res) => {
    try {
      await api?.ready?.();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
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
