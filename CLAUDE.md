# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build   # Compile TypeScript (src/ → dist/)
npm run dev     # Run directly with tsx (no build needed)
npm start       # Run compiled dist/index.js
```

No test or lint scripts are configured.

## Architecture

This is a TypeScript MCP server that transcribes Spanish children's books from Google Drive using Claude's vision API. It runs as a stdio transport server integrated with Claude Desktop.

**Pipeline**: Google Drive PDF → pdfjs-dist renders pages to PNG → Claude Haiku OCR → SQLite storage → MCP tools expose results.

### Module responsibilities

- **`src/index.ts`** — MCP server entry point. Initializes DB/dirs, registers 5 tools with Zod schemas, exposes 1 HTML resource, connects via StdioServerTransport.
- **`src/database.ts`** — better-sqlite3 in WAL mode. 3 tables: `books`, `pages` (1 row per PDF page), `batch_jobs`. All queries are synchronous.
- **`src/google-drive.ts`** — OAuth2 with auto-refresh. First run opens browser on port 3000 for OAuth callback. Stores token at `credentials/oauth-token.json`.
- **`src/pdf-processor.ts`** — Renders each PDF page to base64 PNG using pdfjs-dist + node-canvas at 2x scale. Each PDF page is a 2-page physical spread photo.
- **`src/ocr.ts`** — Two modes: single-request (`transcribePage`) and Anthropic Batch API (`createOcrBatch`/`checkAndProcessBatch`). Batch custom IDs use format `book-{bookId}-page-{pageNumber}`.
- **`src/tools/`** — One file per MCP tool.

### MCP tools

| Tool | Description |
|------|-------------|
| `list_books` | Lists Drive PDFs correlated with DB transcription status |
| `transcribe_books(book_names[], use_batch?, overwrite?)` | Full pipeline: download → render → OCR → store |
| `check_batch(batch_id)` | Polls Anthropic batch, streams results into DB |
| `get_transcription(book_name, page_start?, page_end?, include_illustrations?)` | Retrieves stored text |
| `update_page(book_name, page_number, transcription)` | Manual edit, sets `is_edited=true` |

### OCR conventions

- Illustration-only pages stored as `[ILLUSTRATION]` with `has_illustration=true`
- Text inside illustrations (signs, chalkboards) is NOT transcribed — enforced by system prompt in `src/ocr.ts`
- Line breaks preserved as-is
- Model: `claude-haiku-4-5-20251001` (cost-optimized)

### TypeScript config

ESM-only (`"module": "NodeNext"`), strict mode enabled, targets ES2022. Use `.js` extensions in import paths (NodeNext resolution requires this even for `.ts` source files).

## Environment

Copy `.env.example` to `.env`. Required variables:

```
ANTHROPIC_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
GOOGLE_DRIVE_FOLDER_ID
DATABASE_PATH=./data/books.db
CREDENTIALS_PATH=./credentials
```

`data/` and `credentials/` are gitignored and created automatically on first run.
