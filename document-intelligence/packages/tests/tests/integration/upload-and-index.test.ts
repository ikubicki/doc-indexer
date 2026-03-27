/**
 * Integration test: upload test.01.pdf and wait for the indexer to process it.
 *
 * Prerequisites: all three services must be running (./bin/start.sh).
 *
 * Run:
 *   npm test -w packages/tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE        = process.env.API_BASE ?? 'http://localhost:3002';
const FIXTURE_PATH    = fileURLToPath(
  new URL('../../../../../tests/fixtures/test.01.pdf', import.meta.url),
);
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS  = 300_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function uploadFile(filePath: string): Promise<{ documentId: string; status: string }> {
  const fileBuffer = await readFile(filePath);
  const filename   = path.basename(filePath);

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), filename);

  const res = await fetch(`${API_BASE}/documents/upload`, {
    method: 'POST',
    body: form,
  });

  assert.equal(res.status, 202, `Expected 202 from upload, got ${res.status}`);
  return res.json() as Promise<{ documentId: string; status: string }>;
}

async function pollUntilIndexed(documentId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res  = await fetch(`${API_BASE}/documents`);
    const body = await res.json() as { documents: Array<Record<string, unknown>> };

    const doc = body.documents.find((d) => d['documentId'] === documentId);

    if (doc && typeof doc['contentSummary'] === 'string' && doc['contentSummary'].length > 0) {
      return doc;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Document ${documentId} was not indexed within ${POLL_TIMEOUT_MS / 1000}s`);
}

async function search(query: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${API_BASE}/documents/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query, topK: 5 }),
  });

  assert.equal(res.status, 200, `Expected 200 from search, got ${res.status}`);
  const body = await res.json() as { results: Array<Record<string, unknown>> };
  return body.results;
}

// ── Shared state (set by upload test, reused by later tests) ─────────────────

let sharedDocumentId: string | undefined;

// ── Tests ─────────────────────────────────────────────────────────────────────

test('API health check', async () => {
  const res  = await fetch(`${API_BASE}/health`);
  const body = await res.json() as Record<string, string>;

  assert.equal(res.status, 200);
  assert.equal(body['status'], 'ok');
});

test('upload test.01.pdf returns 202 queued', async () => {
  const result = await uploadFile(FIXTURE_PATH);

  assert.ok(result.documentId, 'documentId should be present');
  assert.equal(result.status, 'queued');

  sharedDocumentId = result.documentId;
  console.log(`  → documentId: ${result.documentId}`);
});

test('test.01.pdf is indexed with a content summary within 300s', async (t) => {
  assert.ok(sharedDocumentId, 'sharedDocumentId must be set by the upload test');

  t.diagnostic(`Waiting for indexer to process ${sharedDocumentId}…`);
  const doc = await pollUntilIndexed(sharedDocumentId!);

  const summary = doc['contentSummary'] as string;
  assert.ok(summary.length > 20, `Content summary too short: "${summary}"`);

  console.log(`  → summary (first 120 chars): ${summary.slice(0, 120)}`);
});

test('search returns at least one result after indexing', async () => {
  assert.ok(sharedDocumentId, 'sharedDocumentId must be set — run upload test first');

  const results = await search('document content summary');

  assert.ok(results.length > 0, 'Expected at least one search result');
  assert.ok(
    results.some((r) => typeof r['score'] === 'number' && (r['score'] as number) > 0),
    'Expected at least one result with a positive score',
  );

  console.log(`  → ${results.length} result(s), top score: ${results[0]?.['score']}`);
});
