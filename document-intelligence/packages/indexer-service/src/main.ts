import 'dotenv/config';
import { startDocumentUploadedConsumer } from './consumers/document.uploaded.consumer.js';
import { initChromaClient } from './chroma/chroma.client.js';

console.log('[indexer-service] Starting…');

await initChromaClient();
const { disconnect } = await startDocumentUploadedConsumer();

console.log('[indexer-service] Running — waiting for events');

const shutdown = async (signal: string) => {
  console.log(`[indexer-service] ${signal} received — shutting down`);
  await disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
