import { ChromaClient, Collection } from 'chromadb';

let chromaClient: ChromaClient | null = null;
let collection: Collection | null = null;
let savedCollectionName: string = 'documents';

export async function initChromaClient(): Promise<void> {
  const host = process.env.CHROMA_HOST ?? 'localhost';
  const port = parseInt(process.env.CHROMA_PORT ?? '8000', 10);
  savedCollectionName = process.env.CHROMA_COLLECTION_NAME ?? 'documents';

  chromaClient = new ChromaClient({ path: `http://${host}:${port}` });

  collection = await chromaClient.getOrCreateCollection({
    name: savedCollectionName,
    metadata: { 'hnsw:space': 'cosine' },
  });

  console.log(`[indexer-service] ChromaDB connected — collection: "${savedCollectionName}"`);
}

/** Re-creates the collection reference after an external delete. */
export async function refreshChromaCollection(): Promise<Collection> {
  if (!chromaClient) {
    throw new Error('ChromaDB client is not initialised. Call initChromaClient() first.');
  }
  collection = await chromaClient.getOrCreateCollection({
    name: savedCollectionName,
    metadata: { 'hnsw:space': 'cosine' },
  });
  console.log(`[indexer-service] ChromaDB collection refreshed: "${savedCollectionName}"`);
  return collection;
}

export function getChromaCollection(): Collection {
  if (!collection) {
    throw new Error('ChromaDB collection is not initialised. Call initChromaClient() first.');
  }
  return collection;
}
