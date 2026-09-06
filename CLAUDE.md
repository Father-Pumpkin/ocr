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
  - `analysis-service.ts` — the web app's sentiment facade: the **style** vocabulary (bag-of-words vs LLM, merging the lexicon catalogue with what's been loaded), style→method materialization, an in-memory **run registry** the client polls, **batch** submission + tracking, per-run **ceilings**, and **prewarming** (run every loaded dictionary over the whole library)
  - `lexicon-catalogue.ts` — the five expected Spanish dictionaries (AFINN, SO-CAL/SFU, JAEN/iSOL, Linguakit, SBU) with source, licence and exact published layout, plus `seedLexiconsFromDisk()` which imports anything dropped in `lexicons/` on startup. No dictionary data is bundled — only knowledge about them. Three presets are `formatVerified` (checked against the real file); see `lexicons/README.md` for the download commands and the traps
  - `analysis-export.ts` — the download: `pages.csv` (long format, one row per page×dimension×method), `summary.csv` (one row per group), or `analysis.json`
  - `google-drive.ts` — OAuth2 for Drive access *and* "Sign in with Google" login
- **`src/http/`** — Express backend: `server.ts` (app factory), `start.ts` (Node entry), `session.ts` (cookie sessions + `roleForEmail`), `middleware/require-auth.ts` (`requireAuth` / `requireMember`), `routes/` (`auth`, `login`, `books`, `library`, `analysis`)
- **`src/tools/`** — one file per transcription/read MCP tool (`list_books`, `transcribe_books`, `batch_transcribe`, `get_transcription`); the dimension and sentiment tools are defined inline in `index.ts`
- **`app/`** — React + Vite + Tailwind v4 SPA (React Router): `pages/` (Library, BookDetail, PageEditor, Analysis), `components/` (TagSelect, SplitDialog, LexiconUpload, AuthGate, DriveStatus, ui, icons), `lib/` (api, theme, `session` — the role context). Built to `app/dist/` (gitignored).

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

### Sentiment analysis in the web app (`/analysis`)

The same engine, driven by a three-step form instead of MCP tools. The screen's
vocabulary is **style** (how to measure) × **dimension** (what to measure) ×
**scope** (what to run it on), then a download.

Two style families:

- **Bag of words** — a dictionary, matched word by word and averaged. Local,
  instant, free, reproducible. The picker lists the lexicons this project expects
  (AFINN, SO-CAL/SFU, JAEN/iSOL, Linguakit, Stony Brook) whether or not they've been
  loaded, so it doubles as a checklist. **No dictionary data is bundled** — each
  carries its own licence. Two ways to load one:
  - **Drop it in `lexicons/`** (see that folder's README, which has copy-paste
    download commands for the three that are freely available). The backend imports
    on startup, idempotently: a *folder* = one lexicon combining its files, which is
    how SO-CAL's four parts of speech or iSOL's two polarity lists become a single
    instrument — and the folder name is what matches the preset, since published
    filenames rarely name the dictionary. A `<file>.mapping.json` sidecar overrides
    anything inferred. `POST /api/analysis/lexicons/seed` re-scans.
  - **Upload a dictionary** in the UI — reads the file in the browser, POSTs it to
    `/api/analysis/lexicons/preview` to discover its shape, and pre-fills the
    mapping from the matched catalogue preset.
  Either way, importing registers the `lex-<name>` method, so the style is
  immediately runnable. Everything defaults into a shared **`polarity`** dimension,
  which is what makes "AFINN vs SO-CAL vs Claude" a single comparable chart.
  **Pre-compute the whole library** runs every loaded dictionary over every book —
  local and free, so there's no reason not to have the results waiting.
- **LLM** — Claude scores each page against the dimension's description, or a custom
  rubric saved as a named, reusable method.

Scope is books (empty = all transcribed) × page range × tags. `scorePages` gained
`tags`, `onProgress` and two mode-aware ceilings for this.

**Standard vs batch.** `/api/analysis/estimate` sizes a run before it starts and
recommends a mode: at or below `BATCH_RECOMMEND_THRESHOLD` (100 page–dimension
pairs) a **standard** run, above it a **batch**. The recommendation is only that —
the UI offers both and the override sticks. Lexicon methods are always standard;
the Batch API has nothing to offer something that runs locally in milliseconds.

- **Standard** scores inline and is **polled** (`POST /api/analysis/runs`, then
  `GET /api/analysis/runs/:id`) — a held-open request would time out behind a proxy.
  The registry is in memory (progress only); scores land in `page_sentiment`, so a
  lost run costs nothing but the progress bar. Capped by `MAX_LLM_CALLS_PER_RUN`
  (default 500) because someone is waiting on it.
- **Batch** submits to the Anthropic Batch API — about half the price, about an
  hour — and is tracked in `batch_jobs` (`kind='sentiment'`), so it survives closing
  the tab or restarting the server. `GET /api/analysis/batches` lists them and the
  HTTP server polls in-flight batches every 5 minutes, so results land without
  anyone pressing anything; `POST /api/analysis/batches/:id/check` forces it. Capped
  by `MAX_BATCH_ITEMS_PER_RUN` (default 20,000) because nobody is waiting.

Over-cap runs are refused with the numbers rather than half-spent, and a standard
run over its cap is told batch is the way out.

Already-scored (page, dimension, method) triples are skipped unless "re-score" is
ticked, which is what makes repeat runs cheap and the results panel re-readable
without re-scoring. A lexicon page with no dictionary hits stores no score — it has
no reading, and inventing a neutral 0.5 would be worse — so prewarming re-attempts
those pages each time. That's free.

### Lexicon file formats

`lexicon-import.ts` detects rather than assumes, because the real dictionaries
disagree with each other on every axis. All of this was found by reading the
published files, and each case is a silent-failure mode if guessed wrong:

- **Delimiter** — tried in order (tab, comma, semicolon, pipe, whitespace) and
  chosen by which splits ≥90% of sampled rows into the same ≥2 columns. AFINN-es
  is comma, Linguakit tab, SO-CAL's `google_translated` build *space* — all under
  `.txt`/`.csv`/`.tsv` names, so the extension settles nothing. A single-space
  delimiter splits on any whitespace run, since those files carry trailing spaces.
- **Header row** — detected, not assumed: a first row whose value cell is numeric
  (SO-CAL) or repeats a label seen further down (Linguakit) is data. Headerless
  files get synthetic `term` / `value` columns. Guessing wrong eats a term *and*
  names every column after it.
- **Labelled values** — Linguakit's values are the words `POSITIVE`/`NEGATIVE`.
  Without a `labelValues` map every row parses as NaN and the import silently
  yields nothing, so `previewLexicon` reports `labelColumns` and the UI demands a
  mapping before it will submit.
- **Word lists** — no value column at all (iSOL, SBU); polarity comes from the
  filename and both halves import under one lexicon name via `appendToExisting`.
- **Native scale** — inferred from a scan of the *whole* file, not the preview
  rows. Everything normalizes against it, so reading −2..1 off the first few rows
  of a −5..5 dictionary would skew every score in the corpus, silently.
- **Character encoding** — UTF-8 is tried strictly and falls back to Latin-1.
  iSOL is ISO-8859-1, and decoding it as UTF-8 turns every accented term into
  U+FFFD. Both the seeder and the browser upload do this (`decodeLexiconBytes`
  and `readAsText`); `File.text()` and `readFileSync(..., 'utf8')` are the traps.
- **BOM / CRLF** — stripped.

Presets are hints, not assertions: `planImport` checks that a preset's columns are
actually present and falls back to detection when they aren't, keeping only what
the preset knows about the *dictionary* (native scale, label meanings) rather than
about the file. The same lexicon does circulate in different layouts — AFINN as
comma-with-header from one mirror, tab-and-headerless from another.

`uploadLexicon` deletes the lexicon row it created if parsing then fails, so a bad
import can't strand an empty lexicon that shows up as a broken style.

### Access tiers

Two tiers, enforced server-side per route and mirrored in the UI:

- **guest** — any verified Google account. Reads everything: library,
  transcriptions, page scans, OCR history, and the pre-computed sentiment scores
  including exports. Writes nothing, spends nothing.
- **member** — an address in `ALLOWED_EMAILS`. Everything else: page edits,
  scoring runs, dimensions, lexicons, Drive.

Points worth not re-deriving:

- **The role is never in the session token.** `roleForEmail()` resolves it from
  the allowlist on each request. Cookies last 7 days, so a cached role would keep
  a removed account privileged for a week. Verified by an access test that
  promotes and demotes the *same* token.
- **`login.ts` no longer rejects anyone.** Any verified email gets a session; the
  allowlist decides capability, not entry. Access control lives in
  `middleware/require-auth`, per route.
- **Mount middleware inside the router, not at the mount point.**
  `app.use('/api', requireMember, authRouter)` applies `requireMember` to *every*
  `/api` request, because Express treats the path as a prefix for the whole
  chain — that locked guests out of the public reads. The Drive routes gate
  themselves individually instead.
- **Guests never trigger a render.** `GET /pages/:n/image` routes them through
  `getCachedPageImage`, which returns null on a miss rather than downloading the
  PDF from Drive and rasterizing every page.
- The UI (`app/lib/session.tsx`, `useIsMember()`) only *hides* controls. It is a
  courtesy, never the boundary; components still handle a 403, since a role can
  change between page load and click.

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
