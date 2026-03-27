# Application Specification: Document Intelligence Platform

**Date:** March 27, 2026  
**Stack:** TypeScript, React (Vite), Fastify, LM Studio (local), ChromaDB, Redpanda (Kafka-compatible)

---

## 1. Architecture Overview

The application consists of three packages communicating via REST and Redpanda (Kafka):

```
                        ┌─────────────────────┐
                        │    Web App          │
                        │  (React + Vite)     │
                        │  localhost:5173      │
                        └────────┬────────────┘
                                 │ HTTP (proxy)
                                 ▼
┌─────────────────┐        Kafka Event        ┌──────────────────────┐
│   API Service   │ ─── document.uploaded ──► │  Indexer Service     │
│  (Fastify REST) │                           │  (Event Consumer)    │
│  localhost:3002 │                           └──────────┬───────────┘
└────────┬────────┘                                      │
         │                                               │ embeddings + metadata
         │ similarity search                             ▼
         ▼                                    ┌─────────────────────┐
  ┌─────────────┐                             │     LM Studio       │
  │   ChromaDB  │◄────────────────────────────│  (local LLM API)    │
  │ (vector DB) │                             │  localhost:1234      │
  └─────────────┘                             └─────────────────────┘
```

---

## 2. Services

### 2.1 API Service (`packages/api-service`)

HTTP service built with Fastify. Accepts file uploads, publishes Kafka events, and handles semantic search queries against ChromaDB.

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents/upload` | Upload a document (multipart/form-data) |
| `POST` | `/documents/search` | Semantic search based on a prompt |
| `GET`  | `/documents` | List all indexed documents |
| `DELETE` | `/documents` | Delete all indexed documents from ChromaDB |
| `GET`  | `/documents/:documentId/file` | Serve the original uploaded file (used for image thumbnails) |
| `GET`  | `/health` | Service health check |

#### `POST /documents/upload`

**Request:** `multipart/form-data`
- `file` — document file (PDF, TXT, DOCX, PNG, JPG) — max 100 MB

**Response `202 Accepted`:**
```json
{
  "documentId": "uuid-v4",
  "filename": "contract.pdf",
  "path": "/uploads/2026-03-25/uuid-contract.pdf",
  "status": "queued"
}
```

**Behaviour:**
1. Validates MIME type against the allowed list.
2. Saves the file to disk under `UPLOADS_DIR/<YYYY-MM-DD>/<uuid><ext>`.
3. Publishes a `document.uploaded` event to the Kafka topic with file metadata.
4. Returns `202 Accepted` — indexing happens asynchronously.

#### `POST /documents/search`

**Request:**
```json
{
  "query": "real estate lease agreements",
  "topK": 5,
  "minScore": 0.65
}
```

> `minScore` is optional (default `0.6`). Results with cosine similarity below this threshold are discarded. Lower the value to get more results; raise it for stricter matching.

**Response `200 OK`:**
```json
{
  "results": [
    {
      "documentId": "uuid-v4",
      "filename": "lease_agreement.pdf",
      "score": 0.92,
      "excerpt": "This lease agreement entered into on...",
      "metadata": {
        "uploadedAt": "2026-03-25T10:00:00Z",
        "contentSummary": "Residential lease agreement for an apartment..."
      }
    }
  ]
}
```

**Behaviour:**
1. Converts `query` to an embedding using `nomic-embed-text-v1.5`.
2. Performs a cosine similarity search in ChromaDB.
3. Filters out results below the `minScore` threshold.
4. Returns the `topK` most relevant documents.

#### `GET /documents`

Returns a flat list of all documents currently stored in ChromaDB (metadata only, no embeddings).

#### `DELETE /documents`

Deletes **all** documents from the ChromaDB collection. Returns `{ "deleted": <count> }`.

#### `GET /documents/:documentId/file`

Serves the original uploaded file from disk. Looks up the file `path` and `mimeType` from ChromaDB metadata. Sets `Cache-Control: public, max-age=86400`. Used by the Web App to render background-image gradients on image cards and full-screen image preview.

---

### 2.2 Indexer Service (`packages/indexer-service`)

Long-running Node.js process that consumes events from Kafka, analyses document content via LM Studio, generates embeddings, and stores them in ChromaDB.

#### Kafka Consumer Configuration

| Parameter | Value | Reason |
|-----------|-------|--------|
| `sessionTimeout` | `60 000 ms` | LLM calls can take 30–60 s; keep session alive |
| `heartbeatInterval` | `5 000 ms` | Regular heartbeats keep the session alive |
| `autoCommit` | `false` | Manual commit guarantees at-most-once processing |
| `fromBeginning` | `false` | Only new events are consumed |

Offset is committed **before** LLM processing begins. `processDocument()` runs as fire-and-forget (detached from `eachMessage`) so the Kafka heartbeat loop is never blocked by slow LLM calls.

#### Indexing Flow

```
Kafka Event (document.uploaded)
        │
        ▼
0. Commit Kafka offset immediately (before LLM call)
        │
        ▼
1. Read file from the path contained in the event
        │
        ▼
2. Dispatch to correct LLM based on MIME type:
   ├─ PDF / PNG / JPG  →  qwen3-vl-8b  (vision model)
   │    PDF: rendered to PNG via pdfjs-dist + canvas (first page)
   └─ TXT / MD / DOCX  →  gpt-oss-20b  (text model)
   Each file type uses a dedicated LLM prompt (see below).
        │
        ▼
3. Receive content summary (max 1 024 tokens) + up to 5 tags
   LLM response ends with: TAGS: tag1, tag2, tag3
   Tags describe media type, document category, and key topics.
        │
        ▼
4. Generate embedding from "File: <filename>\nTags: tag1, tag2\n\n<summary>"
   → prefix: "search_document: " (nomic-embed-text-v1.5, 768-dim)
   Including filename and tags ensures document-type signals
   (e.g. "CV_Jan.pdf", tags: cv, software-engineer) are captured in the vector.
        │
        ▼
5. Upsert into ChromaDB (with retry on stale collection reference):
   { embedding, document: summary, metadata: { documentId, filename,
     mimeType, path, contentSummary, tags, uploadedAt, indexedAt } }
   Tags stored as comma-separated string in metadata.
        │
        ▼
6. Log success  (on error: log + skip — dead-letter topic TBD)
```

#### Supported File Formats

| Format | Analysis Model | Method |
|--------|---------------|--------|
| PDF | `qwen3-vl-8b` | Render page 1 to PNG via `pdfjs-dist` + `canvas`, then vision |
| PNG, JPG | `qwen3-vl-8b` | Read file → base64 → vision |
| TXT, MD | `gpt-oss-20b` | Read as UTF-8, truncate to 32 k chars |
| DOCX | `gpt-oss-20b` | Extract text via `mammoth`, truncate to 32 k chars |

#### Per-Type LLM Prompts

Instead of a single generic analysis prompt, four dedicated prompts are used to get accurate summaries:

| Prompt | Used for | Key instruction |
|--------|----------|------------------|
| `PROMPT_IMAGE` | PNG, JPG | "Describe what you see in this image…" |
| `PROMPT_PDF_VISUAL` | PDF (vision path) | "This is a rendered page from a PDF document…" |
| `PROMPT_PDF_TEXT_FALLBACK` | PDF (text fallback) | "You received the extracted text of a PDF…" |
| `PROMPT_TEXT` | TXT, MD, DOCX | "Analyse the following text content…" |

All prompts instruct the LLM to first identify the document type before producing a summary. Each prompt ends with a `TAG_INSTRUCTION` that requests up to 5 short lowercase tags at the end of the response in format `TAGS: tag1, tag2, tag3`. Tags describe the media type (e.g. `pdf`, `image`), document category (e.g. `cv`, `invoice`, `contract`), and key content topics (e.g. `java`, `wroclaw`). Tags are parsed from the LLM response, stored in ChromaDB metadata, included in the embedding input, and displayed in the UI as coloured pills.

---

### 2.3 Web App (`packages/web-app`)

Single-page React application built with Vite. Communicates with the API Service through a Vite dev-proxy (no CORS issues in development).

#### Features

| Component | Description |
|-----------|-------------|
| **Upload Panel** | Drag-and-drop or click-to-browse file upload. Shows upload status (`queued` / error). Triggers document list refresh on success. |
| **Search Panel** | Free-text semantic search with configurable `topK` and `minScore` (default `0.6`). Displays results with filename, match percentage, excerpt, and tags. Image documents show a gradient background (0% → 20% opacity top-to-bottom) via `GET /documents/:id/file`. Clicking an image filename opens a full-screen preview overlay. Tags are embedded in the search vector, so queries like "CV Irek" naturally rank CV documents higher. |
| **Document List** | Card-based list of all indexed documents. Each card shows a monochrome file-type icon + filename, upload date, tags (coloured pills), and content summary preview. Image cards have a gradient background. Clicking an image filename opens a preview overlay. Includes manual refresh and a 🗑 Delete All button (with confirmation). |
| **Image Preview** | Full-screen overlay (`ImagePreview` component) with dark backdrop (85% opacity), centred image, filename caption, close button (✕) and Escape key support. |

#### Vite Dev Proxy

All requests to `/documents/*` are proxied to `http://localhost:3002`, so the React app does not need to know the API port explicitly.

---

## 3. LM Studio Models

LM Studio runs locally and exposes an OpenAI-compatible API at `http://localhost:1234/v1`.

| Model | Identifier in LM Studio | Purpose |
|-------|--------------------------|------|
| Qwen3 VL 8B | `qwen/qwen3-vl-8b` | Visual document analysis (PDFs, images) |
| GPT-OSS 20B | `openai/gpt-oss-20b` | Text document analysis |
| Nomic Embed | `text-embedding-nomic-embed-text-v1.5@q8_0` | Embedding generation for ChromaDB and search |

> **Important — asymmetric prefixes:** `nomic-embed-text-v1.5` requires task-specific prefixes:
> - documents indexed with prefix `search_document: `
> - search queries with prefix `search_query: `
>
> Without these prefixes vectors are orthogonal (cosine distance ≈ 1.0) and search returns 0% match for all results.

> **Important — OpenAI SDK v4 + LM Studio compatibility:** OpenAI SDK ≥ 4.x defaults to `encoding_format: "base64"` on every embeddings request and decodes the response internally. LM Studio **ignores** this parameter and always returns a `float[]`. The SDK then tries to base64-decode a numeric array → produces an all-zero vector (768× `0`). **Fix:** always pass `encoding_format: 'float'` explicitly:
> ```ts
> await openai.embeddings.create({ model, input: [...], encoding_format: 'float' });
> ```

---

## 4. Kafka Events

### Topic: `document.uploaded`

Published by **API Service** upon accepting a file.

```json
{
  "eventId": "uuid-v4",
  "eventType": "document.uploaded",
  "timestamp": "2026-03-25T10:00:00Z",
  "payload": {
    "documentId": "uuid-v4",
    "filename": "contract.pdf",
    "mimeType": "application/pdf",
    "path": "/uploads/2026-03-25/uuid-contract.pdf",
    "sizeBytes": 204800
  }
}
```

### Topic: `document.indexed` *(optional)*

Published by **Indexer Service** after successful indexing.

```json
{
  "eventId": "uuid-v4",
  "eventType": "document.indexed",
  "timestamp": "2026-03-25T10:00:45Z",
  "payload": {
    "documentId": "uuid-v4",
    "filename": "contract.pdf",
    "chromaCollectionId": "documents",
    "contentSummary": "Residential lease agreement for an apartment..."
  }
}
```

---

## 5. Project Structure

```
document-intelligence/
├── bin/
│   ├── start.sh           # start all services in background
│   ├── stop.sh            # gracefully stop all services
│   └── restart.sh         # stop + start
│
├── packages/
│   ├── api-service/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── documents.upload.ts
│   │   │   │   ├── documents.search.ts
│   │   │   │   └── documents.list.ts
│   │   │   ├── services/
│   │   │   │   ├── storage.service.ts       # file persistence to disk
│   │   │   │   ├── kafka.producer.ts        # event publishing
│   │   │   │   └── embedding.service.ts     # embeddings via LM Studio
│   │   │   ├── chroma/
│   │   │   │   └── chroma.client.ts         # ChromaDB client
│   │   │   ├── app.ts
│   │   │   └── main.ts
│   │   ├── .env
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── indexer-service/
│   │   ├── src/
│   │   │   ├── consumers/
│   │   │   │   └── document.uploaded.consumer.ts
│   │   │   ├── services/
│   │   │   │   ├── llm.service.ts           # LM Studio communication
│   │   │   │   ├── embedding.service.ts     # embeddings via LM Studio
│   │   │   │   └── file.parser.ts           # text/image extraction
│   │   │   ├── chroma/
│   │   │   │   └── chroma.client.ts
│   │   │   └── main.ts
│   │   ├── .env
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web-app/
│       ├── src/
│       │   ├── api/
│       │   │   └── client.ts                # typed fetch wrappers
│       │   ├── components/
│       │   │   ├── UploadPanel.tsx
│       │   │   ├── SearchPanel.tsx
│       │   │   └── DocumentList.tsx
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   └── index.css
│       ├── index.html
│       ├── vite.config.ts
│       ├── package.json
│       └── tsconfig.json
│
├── .env.example
├── .gitignore
└── package.json                             # monorepo root (npm workspaces)
```

---

## 6. Environment Configuration (`.env`)

Each service has its own `.env` file. Shared template (see `.env.example`):

```dotenv
# ── LM Studio ─────────────────────────────────────────────
LM_STUDIO_BASE_URL=http://localhost:1234/v1
LM_STUDIO_VISION_MODEL=qwen3-vl-8b
LM_STUDIO_TEXT_MODEL=gpt-oss-20b
LM_STUDIO_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5@q8_0

# ── ChromaDB ───────────────────────────────────────────────
CHROMA_HOST=localhost
CHROMA_PORT=8000
CHROMA_COLLECTION_NAME=documents

# ── Redpanda / Kafka ───────────────────────────────────────
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=document-intelligence
KAFKA_TOPIC_DOCUMENT_UPLOADED=document.uploaded
KAFKA_TOPIC_DOCUMENT_INDEXED=document.indexed
KAFKA_CONSUMER_GROUP_INDEXER=indexer-service-group

# ── API Service ────────────────────────────────────────────
API_PORT=3002
UPLOADS_DIR=/tmp/document-intelligence/uploads

# ── General ───────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=debug
```

---

## 7. Key Dependencies (npm)

### Backend (`api-service` / `indexer-service`)

| Package | Version | Purpose |
|---------|---------|---------|
| `fastify` | ^5 | HTTP server (API Service) |
| `@fastify/multipart` | ^9 | Multipart file upload |
| `openai` | ^4 | LM Studio client (OpenAI-compatible API) |
| `chromadb` | ^1 | ChromaDB client |
| `kafkajs` | ^2 | Kafka/Redpanda client |
| `pdfjs-dist` | ^4 | PDF rendering to image |
| `canvas` | ^3 | Node.js canvas for PDF → PNG rendering |
| `mammoth` | ^1 | DOCX parsing → text |
| `zod` | ^3 | Input validation |
| `uuid` | ^11 | UUID generation |
| `dotenv` | ^16 | `.env` loading |
| `typescript` | ^5 | Language |
| `tsx` | ^4 | Running TS in dev |

### Frontend (`web-app`)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18 | UI framework |
| `react-dom` | ^18 | DOM renderer |
| `vite` | ^6 | Build tool & dev server |
| `@vitejs/plugin-react` | ^4 | Vite React plugin |
| `typescript` | ^5 | Language |

---

## 8. Local Infrastructure Requirements

| Service | Port | Notes |
|---------|------|-------|
| LM Studio | `1234` | All 3 models loaded and running |
| ChromaDB | `8000` | `chroma run` or Docker |
| Redpanda | `9092` | Kafka-compatible broker |
| Redpanda Console | `8080` | Optional UI |
| API Service | `3002` | Started via `bin/start.sh` |
| Web App | `5173` | Vite dev server |

### Start Redpanda (Docker):
```bash
docker run -d --name redpanda \
  -p 9092:9092 -p 9644:9644 \
  docker.redpanda.com/redpandadata/redpanda:latest \
  redpanda start --overprovisioned --smp 1 --memory 1G \
  --reserve-memory 0M --node-id 0 --check=false
```

### Start ChromaDB (Docker):
```bash
docker run -d --name chromadb \
  -p 8000:8000 \
  chromadb/chroma:latest
```

---

## 9. Running the Application

### Start / Stop / Restart

```bash
cd document-intelligence

# Start individual services (foreground, with stop-before-start):
npm run start:api        # cd packages/api-service && npm run dev
npm run start:indexer     # cd packages/indexer-service && npm run dev
npm run start:webapp      # cd packages/web-app && npm run dev

# Stop individual services:
npm run stop:api          # kill port 3002
npm run stop:indexer      # pkill -f NODE_APP=indexer-service
npm run stop:webapp       # kill ports 5173-5176
npm run stop              # stop all

# Background (via bin scripts):
./bin/start.sh            # start all 3 services in background
./bin/stop.sh             # gracefully stop all services
./bin/restart.sh          # stop + start
```

> **Process management:** Indexer Service uses `NODE_APP=indexer-service` as env prefix in its `dev` script so that `pkill -f 'NODE_APP=indexer-service'` reliably kills all child processes (tsx spawns node workers without package path in cmdline).

### Follow logs

```bash
tail -f .logs/api-service.log
tail -f .logs/indexer-service.log
tail -f .logs/web-app.log
```

### URLs after startup

| Service | URL |
|---------|-----|
| Web App | http://localhost:5173 |
| API Service | http://localhost:3002 |
| Health check | http://localhost:3002/health |

---

## 10. End-to-End Scenario

```
1. Start infrastructure: Redpanda, ChromaDB, LM Studio
2. Run: ./bin/start.sh
3. Open: http://localhost:5173

4. User drops contract.pdf onto the Upload Panel
   → Web App: POST /documents/upload (multipart)
   → API Service: saves file, publishes `document.uploaded` event
   → API Service: responds 202 { documentId, status: "queued" }
   → Web App: shows "Queued for indexing", refreshes Document List

5. Indexer Service consumes event from `document.uploaded`
   → Reads file from path in the event
   → Sends first page image to qwen3-vl-8b with analysis prompt
   → Receives content summary
   → Generates embedding via nomic-embed-text-v1.5
   → Upserts into ChromaDB (embedding + metadata)

6. User types "contract termination conditions" in Search Panel
   → Web App: POST /documents/search { query, topK: 5, minScore: 0.65 }
   → API Service: generates query embedding (nomic-embed-text-v1.5)
   → API Service: performs cosine similarity search in ChromaDB
   → Filters results below minScore threshold
   → Returns topK results with score and excerpt
   → Web App: displays results with match percentage
```

---

## 11. Open Questions / Decisions to Make

| # | Topic | Options |
|---|-------|---------|
| 1 | API authorisation | None (dev), API Key, JWT |
| 2 | File storage | Local disk (current), MinIO |
| 3 | Document chunking | Whole document as single record (current) vs. splitting into chunks (better recall for long PDFs) |
| 4 | Retry logic for Indexer | On LM Studio failure — dead-letter topic? |
| 5 | Monitoring | None (dev), Prometheus + Grafana |
| 6 | Production deployment | Docker Compose, Kubernetes |

---

## 12. Troubleshooting

### All-zero embeddings (768× `0`)

**Symptom:** `generateEmbedding` returns a vector of 768 zeros; `prompt_tokens: 0` in the LM Studio response.

**Cause:** OpenAI SDK ≥ 4.x adds `encoding_format: "base64"` by default. LM Studio ignores this and returns `float[]`. The SDK then tries to base64-decode a numeric array → garbage → zeros.

**Fix:** pass `encoding_format: 'float'` explicitly in both `api-service` and `indexer-service` `embedding.service.ts`:
```ts
await openai.embeddings.create({ model, input: [...], encoding_format: 'float' });
```

### ChromaDB dimension mismatch (`expecting 192, got 768`)

**Symptom:** `InvalidArgumentError: Collection expecting embedding with dimension of 192, got 768`.

**Cause:** The collection was seeded with zeroed embeddings of wrong length (result of the bug above). ChromaDB locks the dimension on first insert.

**Fix:** Delete and recreate the collection (all data is lost — reindex documents):

```bash
curl -X DELETE \
  "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections/documents"
```

Then restart both services — `getOrCreateCollection` will recreate it with the correct 768 dimensions.

> **Note:** ChromaDB REST API v1 (`/api/v1/…`) is **deprecated**. Use `/api/v2/tenants/default_tenant/databases/default_database/…` for all operations.

### Zombie indexer processes (events consumed but not processed)

**Symptom:** Events are consumed from Kafka but indexer logs show nothing. Documents appear uploaded but never indexed. Multiple `tsx watch src/main.ts` processes visible in `ps aux`.

**Cause:** `npm run stop:indexer` failed to kill old processes because `tsx` spawns node workers with only `src/main.ts` in cmdline (no package path). Old zombie instances remain in the consumer group and steal events from the new instance.

**Fix:** The indexer `dev` script now uses `NODE_APP=indexer-service` prefix:
```json
"dev": "NODE_APP=indexer-service tsx watch src/main.ts"
```
This makes `pkill -9 -f 'NODE_APP=indexer-service'` reliable. If zombies already exist:
```bash
pkill -9 -f 'tsx.*src/main'  # nuclear option: kills ALL tsx watchers
```

### LM Studio “Model unloaded” errors

**Symptom:** `BadRequestError: 400 "Model unloaded."` during indexing.

**Cause:** LM Studio unloads models from GPU after inactivity timeout. The first request after unload fails.

**Fix:** `llm.service.ts` wraps all `chat.completions.create` calls with `llmRetry()` — automatic retry up to 3 attempts with 10 s delay between each. This gives LM Studio time to reload the model. The retry triggers on `"model unloaded"`, `"model not loaded"`, `502`, and `503` errors.

---

## 13. Integration Tests (`packages/tests`)

### Overview

Integration tests validate the full end-to-end pipeline: file upload → Kafka event → indexer processing → ChromaDB storage → semantic search.

The test runner is the built-in **`node:test`** module (Node.js ≥ 18), executed via **`tsx`** (no transpilation step required).

### Prerequisites

All services must be running before the tests are executed:

```bash
./bin/start.sh
# or
npm run start
```

Required infrastructure: ChromaDB (`:8000`), Redpanda/Kafka (`:9092`), LM Studio (`:1234`), api-service (`:3002`), indexer-service.

### Test Fixture

```
tests/fixtures/test.01.pdf   ← sample PDF used by the integration test suite
```

The path is resolved at runtime relative to the test file using `import.meta.url`.

### Test Cases

| # | Test | Description |
|---|------|-------------|
| 1 | API health check | `GET /health` → 200 `{ status: "ok" }` |
| 2 | Upload document | `POST /documents/upload` (multipart `test.01.pdf`) → 202 with `documentId`; stores `documentId` in shared state |
| 3 | Poll until indexed | `GET /documents` every 3 s, up to 300 s — reuses `documentId` from test 2, waits for `contentSummary` |
| 4 | Semantic search | `POST /documents/search` with a relevant query — reuses already-indexed document; at least one result |

> Tests 3 and 4 reuse the `documentId` from test 2 (shared module-level variable). Only one upload is performed — this ensures the 300 s indexer timeout is sufficient for the first and only file.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE` | `http://localhost:3002` | Override via env var to test against a different host |
| `POLL_INTERVAL_MS` | `3000` | Polling interval while waiting for indexer |
| `POLL_TIMEOUT_MS` | `300000` | Maximum wait time before test fails (5 minutes — LLM is slow) |

### Running Tests Manually

```bash
# from monorepo root
npm test

# or directly from the package
npm test -w packages/tests
```

### Automatic Execution on Build

The root `build` script is defined so that tests run automatically every time the agent builds the application:

```json
// package.json (root)
"scripts": {
  "build": "npm run build --workspaces --if-present",
  "test":  "npm test -w packages/tests"
}
```

An agent building the project should call both scripts in sequence:

```bash
npm run build && npm test
```

This ensures that every build is verified against the live infrastructure before being considered complete.
