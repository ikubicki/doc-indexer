import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { generateEmbedding } from '../services/embedding.service.js';
import { getChromaCollection } from '../chroma/chroma.client.js';

const SearchBodySchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).default(5),
  // Minimum cosine similarity score (0–1). Results below this threshold are discarded.
  // Default 0.6 eliminates weakly related documents while keeping solid matches.
  minScore: z.number().min(0).max(1).default(0.6),
});

export const searchRoute: FastifyPluginAsync = async (app) => {
  app.post('/search', async (request, reply) => {
    const parsed = SearchBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const { query, topK, minScore } = parsed.data;

    const queryEmbedding = await generateEmbedding(query, 'query');
    const collection = getChromaCollection();

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      include: ['metadatas', 'distances', 'documents'] as any,
    });

    const hits = (results.ids[0] ?? [])
      .map((id, i) => ({
        documentId: (results.metadatas[0]?.[i] as any)?.documentId ?? id,
        filename:   (results.metadatas[0]?.[i] as any)?.filename ?? '',
        score:      results.distances ? 1 - (results.distances[0]?.[i] ?? 0) : null,
        distance:   results.distances?.[0]?.[i] ?? null,
        excerpt:    results.documents?.[0]?.[i] ?? '',
        metadata:   results.metadatas[0]?.[i] ?? {},
      }))
      .filter(hit => hit.score !== null && hit.score >= minScore);

    return reply.send({ results: hits });
  });
};
