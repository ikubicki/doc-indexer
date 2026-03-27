export interface UploadResponse {
  documentId: string;
  filename: string;
  path: string;
  status: string;
}

export interface SearchResult {
  documentId: string;
  filename: string;
  score: number | null;
  excerpt: string;
  metadata: {
    uploadedAt?: string;
    contentSummary?: string;
    tags?: string;
    [key: string]: unknown;
  };
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface DocumentListItem {
  documentId: string;
  filename: string;
  mimeType: string | null;
  uploadedAt: string | null;
  contentSummary: string | null;
  tags: string[];
}

export interface DocumentListResponse {
  documents: DocumentListItem[];
  total: number;
}

const BASE = '/documents';

export async function uploadDocument(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
  }

  return res.json() as Promise<UploadResponse>;
}

export async function searchDocuments(query: string, topK = 5, minScore = 0.6): Promise<SearchResponse> {
  const res = await fetch(`${BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, minScore }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Search failed (${res.status})`);
  }

  return res.json() as Promise<SearchResponse>;
}

export async function listDocuments(): Promise<DocumentListResponse> {
  const res = await fetch(BASE);

  if (!res.ok) {
    throw new Error(`Failed to fetch documents (${res.status})`);
  }

  return res.json() as Promise<DocumentListResponse>;
}

export async function deleteAllDocuments(): Promise<{ deleted: number }> {
  const res = await fetch(BASE, { method: 'DELETE' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Delete failed (${res.status})`);
  }

  return res.json() as Promise<{ deleted: number }>;
}
