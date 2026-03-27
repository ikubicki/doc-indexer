import 'dotenv/config';
import { buildApp } from './app.js';

const port = parseInt(process.env.API_PORT ?? '3000', 10);
const host = '0.0.0.0';

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info(`[api-service] ${signal} received — shutting down`);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

try {
  await app.listen({ port, host });
  console.log(`[api-service] Listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
