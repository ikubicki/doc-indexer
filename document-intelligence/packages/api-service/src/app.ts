import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { uploadRoute } from './routes/documents.upload.js';
import { searchRoute } from './routes/documents.search.js';
import { listRoute } from './routes/documents.list.js';
import { initKafkaProducer, disconnectKafkaProducer } from './services/kafka.producer.js';
import { initChromaClient } from './chroma/chroma.client.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MB
    },
  });

  // Initialise dependencies on startup
  app.addHook('onReady', async () => {
    await initKafkaProducer();
    await initChromaClient();
    app.log.info('[api-service] Dependencies initialised');
  });

  app.addHook('onClose', async () => {
    await disconnectKafkaProducer();
  });

  // Routes
  await app.register(uploadRoute, { prefix: '/documents' });
  await app.register(searchRoute, { prefix: '/documents' });
  await app.register(listRoute,   { prefix: '/documents' });

  app.get('/health', async () => ({ status: 'ok', service: 'api-service' }));

  return app;
}
