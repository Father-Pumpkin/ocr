# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build        # Compile MCP server TypeScript (src/ → dist/)
npm run build:app    # Build the React web app (Vite → app/dist/)
npm run build:all    # Both (server, then app)

# Run
npm run dev          # MCP stdio server directly via tsx (for Claude Desktop)
npm run dev:server   # HTTP backend only (tsx src/http/start.ts)
npm run dev:app      # HTTP backend + Vite dev server together → http://localhost:5173
npm start            # Compiled MCP server (node dist/index.js)

# Test
npm test             # Smoke-test the PDF render pipeline (tsx --test scripts/test-render.ts)
```

No lint script. `scripts/` holds many one-off maintenance commands wired as npm scripts: `reauth`, `diagnose`, `retranscribe-all`, `process-batches`, `grade-all`, `title-case`, `reocr-suspects`, `migrate-images`. `typecheck:app` runs `tsc -p tsconfig.app.json` over the web app.

## Architecture

OCR pipeline for Spanish children's books. The same `src/core/` business logic backs **two** entry points:

- **MCP stdio server** (`src/index.ts`) — integrated with Claude Desktop; registers 17 tools. Its job is **sentiment analysis** (primary) and **bulk transcription/ingestion** (secondary); page/book *editing* lives in the web app, not here.
- **HTTP backend** (`src/http/start.ts`) — Express API consumed by the React web app in `app/` (the library + page editor).

**Pipeline**: Google Drive PDF → `render-pdf` rasterizes each page (pdfjs-dist + @napi-rs/canvas) → Claude OCR (`core/ocr.ts`) → SQLite/Postgres storage → exposed via MCP tools or REST.

### Layout

- **`src/index.ts`** — MCP entry. Redirects `console.log` to stderr (stdout is reserved for MCP JSON), initializes the DB adapter, registers tools, resumes in-progress batch jobs, connects `StdioServerTransport`.
- **`src/core/`** — shared logic used by both entry points:
  - `book-service.ts` — facade for non-MCP consumers (the HTTP routes)
  - `database.ts` / `database-adapter.ts` / `database-sqlite.ts` / `database-postgres.ts` — the adapter selects **Postgres** when `DB_HOST` or `DATABASE_URL` is set, otherwise **SQLite** (better-sqlite3). All DB access is **async** (`await getAdapter()`).
  - `ocr.ts` — single-request + Anthropic Batch API OCR **and sentiment scoring** (`scoreTranscription`, `createSentimentBatch` / `checkAndProcessSentimentBatch`). `DEFAULT_MODEL = 'claude-sonnet-4-6'`; `AVAILABLE_MODELS` = sonnet-4-6 / opus-4-6 / haiku-4-5. Holds the OCR + sentiment system prompts.
  - `render-pdf.ts` — renders a PDF page to an image. Each PDF page is a 2-page physical spread photo.
  - `blob-store.ts` / `image-service.ts` — page images in Cloudflare R2 when `R2_*` is configured (rendered at `IMAGE_RENDER_SCALE`), else base64-in-DB.
  - `image-split.ts` — splits a spread into two pages at the gutter
  - `quality.ts` — cheap Sonnet proofreader that grades pages and flags them for re-OCR (exports `mapLimit` / `isTextPage`, reused by sentiment)
  - `scoring.ts` — pluggable `Scorer` abstraction: `LlmScorer` (Claude prompt+model) and `LexiconScorer` (local dictionary lookup); shared tokenizer/normalizer
  - `lexicon-import.ts` — generic mapping-driven lexicon importer (any CSV/TSV/JSON dictionary → values normalized 0–1 in `lexicon_terms`)
  - `sentiment.ts` — method-aware hybrid scoring orchestration; lexicon methods run locally, LLM methods inline / Batch API; populates `page_sentiment`
  - `sentiment-analysis.ts` — `analyzeSentiment`: aggregates scores into chartable per-page series / grouped means (by page, book, tag, book×tag, or method)
  - `sentiment-chart.ts` — optional server-rendered PNG of a chart (reuses `@napi-rs/canvas`)
  - `google-drive.ts` — OAuth2 for Drive access *and* "Sign in with Google" login
- **`src/http/`** — Express backend: `server.ts` (app factory), `start.ts` (Node entry), `session.ts` (cookie sessions + email allowlist), `middleware/require-auth.ts`, `routes/` (`auth`, `login`, `books`, `library`)
- **`src/tools/`** — one file per transcription/read MCP tool (`list_books`, `transcribe_books`, `batch_transcribe`, `get_transcription`); the dimension and sentiment tools are defined inline in `index.ts`
- **`app/`** — React + Vite + Tailwind v4 SPA (React Router): `pages/` (Library, BookDetail, PageEditor), `components/` (TagSelect, SplitDialog, AuthGate, DriveStatus, ui, icons), `lib/` (api, theme). Built to `app/dist/` (gitignored).

### Database tables

`books`, `pages` (1 row per page — transcription, illustration flag, tags, edit history), `batch_jobs` (has a `kind`: `ocr` | `sentiment`), `dimensions` (researcher-defined constructs), `methods` (scoring instruments: an `llm` prompt+model or a `lexicon`), `lexicons` + `lexicon_terms` (imported dictionaries; term values normalized 0–1), `page_sentiment` (one score per **page + dimension + method** — `score` 0–1, rationale, model). Schema auto-migrates on startup (the `method_id` migration backfills existing scores to the built-in `claude-default` method).

### MCP tools (17)

- **Transcription / ingestion**: `list_books`, `transcribe_books`, `batch_transcribe`, `check_batch`, `get_transcription`
- **Sentiment**: `list_dimensions`, `create_dimension`, `update_dimension`, `delete_dimension`, `score_pages`, `chart_sentiment`, `list_tags`, `list_methods`, `create_method`, `delete_method`, `import_lexicon`
- **Auth**: `clear_auth`

`check_batch` routes by `batch_jobs.kind` to either the OCR or the sentiment-scoring processor. The page-editing tools (`update_page`, `tag_page`, `insert_page`, `delete_page`, `get_page_image`, `set_page_image`, `retranscribe_page`) were intentionally removed — that surface is the web app's job.

### Sentiment analysis workflow

A **dimension** is the construct measured (e.g. "fear"); a **method** is the instrument that measures it (a Claude prompt, or a lexicon). Scores are stored per **(page, dimension, method)**, so the same construct measured different ways can be compared.

1. Define dimensions with `create_dimension` — the `description` becomes the LLM scoring prompt.
2. *(Optional)* Add scoring methods — *how* to score. `create_method` saves a custom LLM rubric/model; `import_lexicon` + `create_method` (kind `lexicon`) registers **any** word→value dictionary (mapping-driven: term column, value column→dimension, native scale → normalized 0–1) to run locally. The built-in `claude-default` LLM method is used otherwise; `list_methods` lists them.
3. `score_pages { method }` scores text pages and caches them in `page_sentiment`. **Lexicon** methods run locally and instantly; **LLM** methods run inline (small scopes) or submit a Batch API job (`kind='sentiment'`, resolved by `check_batch`). Illustration/empty pages skipped; already-scored (page, dimension, method) skipped unless `overwrite`.
4. `chart_sentiment` returns aggregated data for any slice — a per-page **series** (narrative arc) or grouped **means** (bars) — sliced by `books` / `tags` / `dimensions` / `methods` / page range and bucketed via `group_by` (`page` | `book` | `tag` | `book_tag` | `method`). Scores are partitioned by method so instruments overlay. Claude renders the returned `structuredContent` as a chart artifact; `render_png: true` also returns a server-rendered PNG. The `coverage` field reports how many in-scope pages are scored. `list_tags` surfaces groupable tag values.

### OCR conventions

- Illustration-only spreads stored as `[ILLUSTRATION]` with `has_illustration=true`
- Text inside illustrations (signs, chalkboards) is NOT transcribed — enforced by the system prompt in `core/ocr.ts`
- Each image is a two-page spread: transcribe the entire left page, then the entire right page — never read across the gutter
- Capitalization and accents reproduced verbatim; line breaks preserved as-is

### TypeScript config

ESM-only (`"module": "NodeNext"`), strict, ES2022. Use `.js` extensions in import paths (NodeNext resolution requires this even for `.ts` source). The web app uses a separate `tsconfig.app.json` (bundler resolution).

## Environment

Copy `.env.example` to `.env`. Core requirements: `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_DRIVE_FOLDER_ID`. Optional blocks unlock larger features:

- **Postgres** (else SQLite): `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SSL`, or a single `DATABASE_URL`
- **Object storage** (else base64-in-DB): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `IMAGE_RENDER_SCALE`
- **Web-app login gate**: `AUTH_ENABLED` (auto-on when `NODE_ENV=production`), `BASE_URL`, `ALLOWED_EMAILS`, `SESSION_SECRET`; plus `GOOGLE_DRIVE_TOKEN` to enable Drive in hosted deploys

`data/` and `credentials/` are gitignored and created on first run. Deployment is via Docker/Render — see `DEPLOY.md`.
