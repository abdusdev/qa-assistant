import { ConfigError, loadConfig } from '../config/env.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  createApp().listen(config.port, () => {
    console.log(`qa-assistant listening on port ${config.port} (${config.env})`);
  });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
