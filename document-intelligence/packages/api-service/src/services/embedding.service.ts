import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.LITELLM_BASE_URL ?? 'http://localhost:4000/v1',
      apiKey: process.env.LITELLM_API_KEY ?? 'sk-ikubicki',
    });
  }
  return client;
}

// nomic-embed-text requires task-specific prefixes for asymmetric retrieval
const TASK_PREFIX: Record<string, string> = {
  query:    'search_query: ',
  document: 'search_document: ',
};

export async function generateEmbedding(text: string, mode: 'query' | 'document' = 'query'): Promise<number[]> {
  const model = process.env.LITELLM_EMBED_MODEL ?? 'embedding';
  const input = TASK_PREFIX[mode] + text;

  const response = await getClient().embeddings.create({
    model,
    input: [input],          // LM Studio returns zeros for string input; array input works correctly
    encoding_format: 'float', // prevent SDK from defaulting to base64 (LM Studio ignores it and returns float[], causing SDK to decode incorrectly → all zeros)
  });
/*
  console.log({
    model,
    input: [input],
    response: JSON.stringify(response, null, 2)
  });
  */

  const embedding = response.data[0]?.embedding;

  if (!embedding) {
    throw new Error('LM Studio returned no embedding data');
  }

  return embedding;
}
