import OpenAI from 'openai';
import { extractText, extractImageBase64 } from './file.parser.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
    });
  }
  return client;
}

const LLM_MAX_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 10_000; // 10 s — give LM Studio time to reload the model

async function llmRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = (err as { error?: string }).error ?? (err as Error).message ?? '';
      const isRetryable = /model unloaded|model not loaded|503|502/i.test(String(msg));
      if (!isRetryable || attempt >= LLM_MAX_RETRIES) throw err;
      console.warn(`[indexer-service] LLM call failed (attempt ${attempt}/${LLM_MAX_RETRIES}): ${msg} — retrying in ${LLM_RETRY_DELAY_MS / 1000}s…`);
      await new Promise(r => setTimeout(r, LLM_RETRY_DELAY_MS));
    }
  }
}

const VISUAL_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
]);

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// ── Per-type analysis prompts ─────────────────────────────────────────────────

const TAG_INSTRUCTION =
  '\n\nAt the very end of your response, on a new line, output exactly: ' +
  'TAGS: tag1, tag2, tag3 (up to 5 short lowercase tags describing the media type, ' +
  'document category, and key content topics — e.g. "pdf, cv, software-engineer, java, wroclaw").';

const PROMPT_IMAGE =
  'Describe what you see in this image in detail. ' +
  'Identify the type of content (e.g. screenshot, photograph, diagram, infographic, artwork, UI mockup). ' +
  'List the main visual elements, any visible text, labels, names, dates, or numbers. ' +
  'Be thorough but concise.' + TAG_INSTRUCTION;

const PROMPT_PDF_VISUAL =
  'This is a rendered page from a PDF document. ' +
  'Identify the document type (e.g. invoice, contract, CV/resume, report, letter, form). ' +
  'Summarise its content: main topics, key facts, important entities such as names, dates, amounts, or organisations. ' +
  'Be thorough but concise.' + TAG_INSTRUCTION;

const PROMPT_PDF_TEXT_FALLBACK =
  'You received the extracted text of a PDF document. ' +
  'Identify the document type (e.g. invoice, contract, CV/resume, report, letter, form). ' +
  'Summarise its content: main topics, key facts, important entities such as names, dates, amounts, or organisations. ' +
  'Be thorough but concise.' + TAG_INSTRUCTION;

const PROMPT_TEXT =
  'Analyse the following text content. ' +
  'Identify what kind of material it is (e.g. article, notes, source code, configuration, correspondence, CV/resume, report). ' +
  'Summarise the content: main topics, key facts, and important entities such as names, dates, or amounts. ' +
  'Be thorough but concise.' + TAG_INSTRUCTION;

export interface AnalysisResult {
  summary: string;
  tags: string[];
}

/**
 * Parse the TAGS: line from the end of an LLM response.
 * Returns { summary (without the TAGS line), tags (up to 5, lowercase, trimmed) }.
 */
function parseTagsFromResponse(raw: string): AnalysisResult {
  const tagMatch = raw.match(/\n?TAGS:\s*(.+)$/im);
  if (!tagMatch) {
    return { summary: raw.trim(), tags: [] };
  }
  const summary = raw.slice(0, tagMatch.index).trim();
  const tags = tagMatch[1]
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/[^a-z0-9ąćęłńóśźżäöüß\-]/g, ''))
    .filter(t => t.length > 0)
    .slice(0, 5);
  return { summary, tags };
}

export async function analyseDocument(filePath: string, mimeType: string): Promise<AnalysisResult> {
  if (VISUAL_MIME_TYPES.has(mimeType)) {
    return analyseVisualDocument(filePath, mimeType);
  }

  if (TEXT_MIME_TYPES.has(mimeType)) {
    return analyseTextDocument(filePath);
  }

  throw new Error(`Unsupported MIME type for analysis: ${mimeType}`);
}

async function analyseVisualDocument(filePath: string, mimeType: string): Promise<AnalysisResult> {
  const { base64, usedFallbackText } = await extractImageBase64(filePath, mimeType);

  // PDF rendering fell back to text extraction — route to text model instead
  if (usedFallbackText) {
    const model = process.env.LM_STUDIO_TEXT_MODEL ?? 'gpt-oss-20b';
    const text = Buffer.from(base64, 'base64').toString('utf-8');
    const truncated = text.slice(0, 32_000);

    const response = await llmRetry(() => getClient().chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a document analysis assistant.',
        },
        {
          role: 'user',
          content: `${PROMPT_PDF_TEXT_FALLBACK}\n\n---\n\n${truncated}`,
        },
      ],
      max_tokens: 1024,
    }));

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('LM Studio returned empty response for text document analysis (PDF fallback)');
    }
    return parseTagsFromResponse(content);
  }

  // Normal vision path
  const model = process.env.LM_STUDIO_VISION_MODEL ?? 'qwen3-vl-8b';
  const imageMediaType = mimeType === 'application/pdf' ? 'image/png' : mimeType as 'image/png' | 'image/jpeg';
  const visionPrompt = mimeType === 'application/pdf' ? PROMPT_PDF_VISUAL : PROMPT_IMAGE;

  const response = await llmRetry(() => getClient().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${imageMediaType};base64,${base64}`,
            },
          },
          {
            type: 'text',
            text: visionPrompt,
          },
        ],
      },
    ],
    max_tokens: 1024,
  }));

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('LM Studio returned empty response for visual document analysis');
  }

  return parseTagsFromResponse(content);
}

async function analyseTextDocument(filePath: string): Promise<AnalysisResult> {
  const model = process.env.LM_STUDIO_TEXT_MODEL ?? 'gpt-oss-20b';
  const text = await extractText(filePath);

  // Truncate to avoid context window overflow (~8k tokens ≈ 32k chars)
  const truncated = text.slice(0, 32_000);

  const response = await llmRetry(() => getClient().chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a document analysis assistant.',
      },
      {
        role: 'user',
        content: `${PROMPT_TEXT}\n\n---\n\n${truncated}`,
      },
    ],
    max_tokens: 1024,
  }));

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('LM Studio returned empty response for text document analysis');
  }

  return parseTagsFromResponse(content);
}
