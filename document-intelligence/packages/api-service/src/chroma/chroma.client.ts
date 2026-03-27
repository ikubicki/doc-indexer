import { ChromaClient, Collection } from 'chromadb';

let collection: Collection | null = null;

export async function initChromaClient(): Promise<void> {
  const host = process.env.CHROMA_HOST ?? 'localhost';
  const port = parseInt(process.env.CHROMA_PORT ?? '8000', 10);
  const collectionName = process.env.CHROMA_COLLECTION_NAME ?? 'documents';

  const client = new ChromaClient({ path: `http://${host}:${port}` });

  collection = await client.getOrCreateCollection({
    name: collectionName,
    metadata: { 'hnsw:space': 'cosine' },
  });

  console.log(`[api-service] ChromaDB connected — collection: "${collectionName}"`);
}

export function getChromaCollection(): Collection {
  if (!collection) {
    throw new Error('ChromaDB collection is not initialised. Call initChromaClient() first.');
  }
  return collection;
}
