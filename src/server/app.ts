import express from 'express';

/** Builds the HTTP app. Feature routes are added here by later issues. */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
