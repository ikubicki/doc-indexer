# Document Intelligence Platform

A document ingestion and semantic search platform built with TypeScript. Upload PDFs, images, and text files — the system analyses them with LLMs, generates embeddings, and lets you search by meaning rather than keywords.

## Architecture

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
  ┌─────────────┐                             │      LiteLLM        │
  │   ChromaDB  │◄────────────────────────────│  (LLM proxy API)    │
  │ (vector DB) │                             │  localhost:4000      │
  └─────────────┘                             └─────────────────────┘
```

Three services communicate via REST and Redpanda (Kafka-compatible):

| Service | Description |
|---------|-------------|
| **api-service** | Fastify HTTP server — accepts uploads, publishes Kafka events, serves search |
| **indexer-service** | Kafka consumer — analyses documents via LLM, stores embeddings in ChromaDB |
| **web-app** | React SPA — upload, search, and browse indexed documents |

## Prerequisites

| Dependency | Port | Notes |
|------------|------|-------|
| Node.js ≥ 20 | — | Required for all services |
| LiteLLM | `4000` | LLM proxy with vision, text, and embedding models configured |
| ChromaDB | `8000` | Vector database |
| Redpanda | `9092` | Kafka-compatible message broker |

### Start ChromaDB (Docker)

```bash
docker run -d --name chromadb \
  -p 8000:8000 \
  chromadb/chroma:latest
```

### Start Redpanda (Docker)

```bash
docker run -d --name redpanda \
  -p 9092:9092 -p 9644:9644 \
  docker.redpanda.com/redpandadata/redpanda:latest \
  redpanda start --overprovisioned --smp 1 --memory 1G \
  --reserve-memory 0M --node-id 0 --check=false
```

## Setup

```bash
git clone <repo-url>
cd document-intelligence
npm install
```

Copy and configure environment variables for each service:

```bash
cp .env.example packages/api-service/.env
cp .env.example packages/indexer-service/.env
```

Edit both `.env` files to match your LiteLLM setup (see [Environment Variables](#environment-variables) below).

## Running

```bash
cd document-intelligence

# Start all services in the foreground (with concurrently):
npm run dev

# Or start services individually (stops previous instance first):
npm run start:api
npm run start:indexer
npm run start:webapp

# Start all in background (writes to .logs/):
./bin/start.sh
./bin/stop.sh
./bin/restart.sh
```

### Follow logs (background mode)

```bash
tail -f .logs/api-service.log
tail -f .logs/indexer-service.log
tail -f .logs/web-app.log
```

### Service URLs

| Service | URL |
|---------|-----|
| Web App | http://localhost:5173 |
| API Service | http://localhost:3002 |
| Health check | http://localhost:3002/health |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents/upload` | Upload a document (multipart/form-data, max 100 MB) |
| `POST` | `/documents/search` | Semantic search by natural language query |
| `GET` | `/documents` | List all indexed documents |
| `DELETE` | `/documents` | Delete all documents from ChromaDB |
| `GET` | `/documents/:documentId/file` | Serve original uploaded file |
| `GET` | `/health` | Health check |

### Upload

```bash
curl -X POST http://localhost:3002/documents/upload \
  -F "file=@contract.pdf"
```

Response `202 Accepted`:
```json
{
  "documentId": "uuid-v4",
  "filename": "contract.pdf",
  "path": "/uploads/2026-03-25/uuid-contract.pdf",
  "status": "queued"
}
```

### Search

```bash
curl -X POST http://localhost:3002/documents/search \
  -H "Content-Type: application/json" \
  -d '{ "query": "real estate lease agreements", "topK": 5, "minScore": 0.65 }'
```

Response `200 OK`:
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

`minScore` defaults to `0.6`. Lower it to get more results, raise it for stricter matching.

## Supported File Formats

| Format | Analysis model | Method |
|--------|---------------|--------|
| PDF | Vision model | Page 1 rendered to PNG via `pdfjs-dist` + `canvas` |
| PNG, JPG | Vision model | File read → base64 → vision prompt |
| TXT, MD | Text model | UTF-8, truncated to 32 k chars |
| DOCX | Text model | Text extracted via `mammoth`, truncated to 32 k chars |

## Environment Variables

Copy `.env.example` into each service's directory and adjust:

```dotenv
# ── LiteLLM ───────────────────────────────────────────────
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_API_KEY=sk-yourkey
LITELLM_VISION_MODEL=qwen3-8b
LITELLM_TEXT_MODEL=gpt-oss-20b
LITELLM_EMBED_MODEL=embedding

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

## Testing

```bash
cd document-intelligence
npm test
```

Integration tests live in `packages/tests/tests/integration/`. They require all services and infrastructure running.

## Project Structure

```
document-intelligence/
├── bin/
│   ├── start.sh           # start all services in background
│   ├── stop.sh            # stop all services
│   └── restart.sh         # stop + start
├── packages/
│   ├── api-service/       # Fastify REST API
│   ├── indexer-service/   # Kafka consumer + LLM analysis
│   ├── web-app/           # React SPA
│   └── tests/             # Integration tests
├── .env.example
└── package.json           # monorepo root (npm workspaces)
```
