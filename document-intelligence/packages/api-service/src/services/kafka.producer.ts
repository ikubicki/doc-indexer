import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';

let producer: Producer | null = null;

function createKafka(): Kafka {
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
  const clientId = process.env.KAFKA_CLIENT_ID ?? 'document-intelligence-api';

  return new Kafka({ clientId, brokers });
}

export async function initKafkaProducer(): Promise<void> {
  const kafka = createKafka();
  producer = kafka.producer();
  await producer.connect();
  console.log('[api-service] Kafka producer connected');
}

export async function disconnectKafkaProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
  }
}

export interface DocumentUploadedPayload {
  documentId: string;
  filename: string;
  mimeType: string;
  path: string;
  sizeBytes: number;
}

export async function publishDocumentUploaded(payload: DocumentUploadedPayload): Promise<void> {
  if (!producer) {
    throw new Error('Kafka producer is not initialised. Call initKafkaProducer() first.');
  }

  const topic = process.env.KAFKA_TOPIC_DOCUMENT_UPLOADED ?? 'document.uploaded';

  const message = {
    eventId: uuidv4(),
    eventType: 'document.uploaded',
    timestamp: new Date().toISOString(),
    payload,
  };

  await producer.send({
    topic,
    compression: CompressionTypes.None,
    messages: [
      {
        key: payload.documentId,
        value: JSON.stringify(message),
      },
    ],
  });
}
