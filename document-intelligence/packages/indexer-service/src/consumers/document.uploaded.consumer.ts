import { Kafka, EachMessagePayload } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { analyseDocument } from '../services/llm.service.js';
import { generateEmbedding } from '../services/embedding.service.js';
import { getChromaCollection, refreshChromaCollection } from '../chroma/chroma.client.js';

interface DocumentUploadedEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  payload: {
    documentId: string;
    filename: string;
    mimeType: string;
    path: string;
    sizeBytes: number;
  };
}

function createKafka(): Kafka {
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
  const clientId = process.env.KAFKA_CLIENT_ID ?? 'document-intelligence-indexer';
  return new Kafka({ clientId, brokers });
}

export async function startDocumentUploadedConsumer(): Promise<{ disconnect: () => Promise<void> }> {
  const kafka = createKafka();

  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_CONSUMER_GROUP_INDEXER ?? 'indexer-service-group',
    sessionTimeout: 60_000,      // LLM calls can take 30–60 s; keep session alive
    heartbeatInterval: 5_000,
  });

  const topic = process.env.KAFKA_TOPIC_DOCUMENT_UPLOADED ?? 'document.uploaded';

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });

  console.log(`[indexer-service] Subscribed to topic: ${topic}`);

  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload: EachMessagePayload) => {
      const { topic: tp, partition, message } = payload;
      const raw = message.value?.toString();
      if (!raw) {
        await consumer.commitOffsets([{ topic: tp, partition, offset: String(Number(message.offset) + 1) }]);
        return;
      }

      let event: DocumentUploadedEvent;
      try {
        event = JSON.parse(raw) as DocumentUploadedEvent;
      } catch {
        console.error('[indexer-service] Failed to parse event:', raw);
        await consumer.commitOffsets([{ topic: tp, partition, offset: String(Number(message.offset) + 1) }]);
        return;
      }

      // Commit offset immediately so the coordinator doesn't evict us during slow LLM processing
      await consumer.commitOffsets([{ topic: tp, partition, offset: String(Number(message.offset) + 1) }]);

      if (event.eventType !== 'document.uploaded') {
        console.log(`[indexer-service] Skipping unknown event type: ${event.eventType}`);
        return;
      }

      console.log(`[indexer-service] Event received: ${event.eventType} — ${event.payload?.filename} (${event.payload?.documentId}) offset=${message.offset}`);

      // Fire-and-forget: detach from eachMessage so the Kafka heartbeat loop
      // is not blocked by slow LLM / embedding calls.
      void processDocument(event).catch(err =>
        console.error('[indexer-service] Unhandled error in processDocument:', err),
      );
    },
  });

  return { disconnect: () => consumer.disconnect() };
}

async function processDocument(event: DocumentUploadedEvent): Promise<void> {
  const { documentId, filename, mimeType, path: filePath } = event.payload;

  console.log(`[indexer-service] Processing document: ${filename} (${documentId})`);

  try {
    // 1. Analyse document content with LLM
    const { summary: contentSummary, tags } = await analyseDocument(filePath, mimeType);
    console.log(`[indexer-service] Content summary generated for: ${filename} — tags: [${tags.join(', ')}]`);

    // 2. Generate embedding from filename + tags + summary so document-type signals
    //    from the filename (e.g. "CV_Jan_Kowalski.pdf") and tags are captured in the vector.
    const tagsLine = tags.length > 0 ? `\nTags: ${tags.join(', ')}` : '';
    const embeddingInput = `File: ${filename}${tagsLine}\n\n${contentSummary}`;
    const embedding = await generateEmbedding(embeddingInput);
    console.log(`[indexer-service] Embedding generated for: ${filename}`);

    // 3. Store in ChromaDB (retry once if collection was deleted/recreated externally)
    const upsertData = {
      ids: [documentId],
      embeddings: [embedding],
      documents: [contentSummary],
      metadatas: [
        {
          documentId,
          filename,
          mimeType,
          path: filePath,
          contentSummary,
          tags: tags.join(','),
          uploadedAt: event.timestamp,
          indexedAt: new Date().toISOString(),
        },
      ],
    };

    try {
      await getChromaCollection().upsert(upsertData);
    } catch (chromaErr: unknown) {
      const isNotFound = (chromaErr as { name?: string }).name === 'ChromaNotFoundError';
      if (!isNotFound) throw chromaErr;
      console.warn('[indexer-service] ChromaDB collection stale — refreshing and retrying...');
      const fresh = await refreshChromaCollection();
      await fresh.upsert(upsertData);
    }

    console.log(`[indexer-service] Document indexed successfully: ${filename} (${documentId})`);
  } catch (err) {
    console.error(`[indexer-service] Failed to index document ${documentId}:`, err);
    // In production: publish to dead-letter topic
  }
}
