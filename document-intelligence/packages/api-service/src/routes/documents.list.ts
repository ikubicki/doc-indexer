import { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import { getChromaCollection } from '../chroma/chroma.client.js';

function parseTags(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',');
  return [];
}

export const listRoute: FastifyPluginAsync = async (app) => {
  app.get('/', async (_request, reply) => {
    const collection = getChromaCollection();
    const result = await collection.get({ include: ['metadatas'] as any });

    const documents = (result.ids ?? []).map((id, i) => ({
      documentId: (result.metadatas?.[i] as any)?.documentId ?? id,
      filename:   (result.metadatas?.[i] as any)?.filename ?? '',
      mimeType:   (result.metadatas?.[i] as any)?.mimeType ?? null,
      uploadedAt: (result.metadatas?.[i] as any)?.uploadedAt ?? null,
      contentSummary: (result.metadatas?.[i] as any)?.contentSummary ?? null,
      tags: parseTags((result.metadatas?.[i] as any)?.tags),
    }));

    return reply.send({ documents, total: documents.length });
  });

  // ── Serve raw file for thumbnails / previews ────────────────────────────
  app.get('/:documentId/file', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const collection = getChromaCollection();
    const result = await collection.get({ ids: [documentId], include: ['metadatas'] as any });

    const meta = result.metadatas?.[0] as Record<string, unknown> | undefined;
    if (!meta?.path) {
      return reply.status(404).send({ error: 'Document not found' });
    }

    const filePath = meta.path as string;
    const mimeType = (meta.mimeType as string) || 'application/octet-stream';

    try {
      const stream = fs.createReadStream(filePath);
      return reply
        .type(mimeType)
        .header('Cache-Control', 'public, max-age=86400')
        .send(stream);
    } catch {
      return reply.status(404).send({ error: 'File not found on disk' });
    }
  });

  app.delete('/', async (_request, reply) => {
    const collection = getChromaCollection();
    const result = await collection.get();
    const ids = result.ids ?? [];

    if (ids.length > 0) {
      await collection.delete({ ids });
    }

    return reply.send({ deleted: ids.length });
  });
};
