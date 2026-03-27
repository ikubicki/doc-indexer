import { FastifyPluginAsync } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs/promises';
import { saveFile } from '../services/storage.service.js';
import { publishDocumentUploaded } from '../services/kafka.producer.js';

export const uploadRoute: FastifyPluginAsync = async (app) => {
  app.post('/upload', async (request, reply) => {
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    const allowedMimeTypes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
    ];

    if (!allowedMimeTypes.includes(data.mimetype)) {
      return reply.status(415).send({
        error: `Unsupported file type: ${data.mimetype}`,
        supported: allowedMimeTypes,
      });
    }

    const documentId = uuidv4();
    const ext = path.extname(data.filename);
    const safeFilename = `${documentId}${ext}`;

    const filePath = await saveFile(data.file, safeFilename);

    await publishDocumentUploaded({
      documentId,
      filename: data.filename,
      mimeType: data.mimetype,
      path: filePath,
      sizeBytes: (await fs.stat(filePath)).size,
    });

    app.log.info({ documentId, filename: data.filename }, 'Document uploaded and queued');

    return reply.status(202).send({
      documentId,
      filename: data.filename,
      path: filePath,
      status: 'queued',
    });
  });
};
