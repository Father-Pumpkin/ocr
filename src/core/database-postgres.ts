import postgres from 'postgres';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow, SentimentScoreDetail, MethodRow, LexiconRow, LexiconSummary, LexiconTermRow, OcrRunRow } from './database-adapter.js';

// Raw Postgres row types (dates come back as Date objects from the driver)
interface PgBookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  ocr_quality: string | null;
  ocr_quality_note: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgPageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  original_transcription: string | null;
  ocr_quality: string | null;
  ocr_quality_reason: string | null;
  has_illustration: boolean;
  is_edited: boolean;
  status: string;
  batch_custom_id: string | null;
  tags: unknown; // JSONB — comes back as parsed JS value
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgOcrRunRow {
  id: number;
  page_id: number;
  model: string | null;
  text: string;
  created_by: string | null;
  created_at: Date;
}

interface PgBatchJobRow {
  id: number;
  batch_id: string;
  book_ids: unknown; // JSONB — comes back as parsed JS value
  kind: string;
  status: string;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface PgDimensionRow {
  id: number;
  name: string;
  description: string;
  min_label: string;
  max_label: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgPageSentimentRow {
  id: number;
  page_id: number;
  dimension_id: number;
  method_id: number;
  score: number;
  rationale: string | null;
  model: string | null;
  created_by: string | null;
  created_at: Date;
}

interface PgMethodRow {
  id: number;
  name: string;
  kind: string;
  config: string;
  created_by: string | null;
  created_at: Date;
}

interface PgLexiconRow {
  id: number;
  name: string;
  scale_min: number;
  scale_max: number;
  note: string | null;
  created_at: Date;
}

function coerceBook(row: PgBookRow): BookRow {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function coercePage(row: PgPageRow): PageRow {
  return {
    ...row,
    tags: JSON.stringify(row.tags ?? []),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function coerceOcrRun(row: PgOcrRunRow): OcrRunRow {
  return { ...row, created_at: row.created_at.toISOString() };
}

function coerceBatchJob(row: PgBatchJobRow): BatchJobRow {
  return {
    ...row,
    book_ids: JSON.stringify(row.book_ids ?? []),
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

function coerceDimension(row: PgDimensionRow): DimensionRow {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function coercePageSentiment(row: PgPageSentimentRow): PageSentimentRow {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
  };
}

function coerceMethod(row: PgMethodRow): MethodRow {
  return { ...row, created_at: row.created_at.toISOString() };
}

function coerceLexicon(row: PgLexiconRow): LexiconRow {
  return { ...row, created_at: row.created_at.toISOString() };
}

export class PostgresAdapter implements DatabaseAdapter {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS books (
        id              SERIAL PRIMARY KEY,
        title           TEXT NOT NULL,
        drive_file_id   TEXT NOT NULL UNIQUE,
        drive_file_name TEXT NOT NULL,
        page_count      INTEGER,
        status          TEXT DEFAULT 'pending',
        ocr_quality     TEXT,
        ocr_quality_note TEXT,
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS pages (
        id               SERIAL PRIMARY KEY,
        book_id          INTEGER NOT NULL REFERENCES books(id),
        page_number      INTEGER NOT NULL,
        transcription    TEXT,
        original_transcription TEXT,
        ocr_quality      TEXT,
        ocr_quality_reason TEXT,
        has_illustration BOOLEAN DEFAULT FALSE,
        is_edited        BOOLEAN DEFAULT FALSE,
        status           TEXT DEFAULT 'pending',
        batch_custom_id  TEXT,
        tags             JSONB NOT NULL DEFAULT '[]',
        created_by       TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(book_id, page_number)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id           SERIAL PRIMARY KEY,
        batch_id     TEXT NOT NULL UNIQUE,
        book_ids     JSONB NOT NULL DEFAULT '[]',
        kind         TEXT NOT NULL DEFAULT 'ocr',
        status       TEXT DEFAULT 'in_progress',
        created_by   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS dimensions (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        min_label   TEXT NOT NULL DEFAULT 'Low',
        max_label   TEXT NOT NULL DEFAULT 'High',
        created_by  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS methods (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        kind       TEXT NOT NULL,
        config     TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS lexicons (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        scale_min  DOUBLE PRECISION NOT NULL DEFAULT 0,
        scale_max  DOUBLE PRECISION NOT NULL DEFAULT 1,
        note       TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS lexicon_terms (
        id           SERIAL PRIMARY KEY,
        lexicon_id   INTEGER NOT NULL REFERENCES lexicons(id) ON DELETE CASCADE,
        dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
        term         TEXT NOT NULL,
        value        DOUBLE PRECISION NOT NULL,
        UNIQUE(lexicon_id, dimension_id, term)
      )
    `;

    // method_id nullable + no inline unique here; the migration block below makes
    // it NOT NULL and installs the (page, dimension, method) unique — one path for
    // both fresh and existing DBs.
    await this.sql`
      CREATE TABLE IF NOT EXISTS page_sentiment (
        id           SERIAL PRIMARY KEY,
        page_id      INTEGER NOT NULL REFERENCES pages(id),
        dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
        method_id    INTEGER REFERENCES methods(id) ON DELETE CASCADE,
        score        FLOAT NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
        rationale    TEXT,
        model        TEXT,
        created_by   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS page_images (
        id          SERIAL PRIMARY KEY,
        book_id     INTEGER NOT NULL REFERENCES books(id),
        page_number INTEGER NOT NULL,
        image_data  TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(book_id, page_number)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS page_ocr_runs (
        id          SERIAL PRIMARY KEY,
        page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        model       TEXT,
        text        TEXT NOT NULL,
        created_by  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_page_ocr_runs_page ON page_ocr_runs (page_id, created_at)`;

    // Preserve the first OCR result for research. Additive migration for existing
    // DBs (the CREATE above is a no-op when the table already exists). Backfill
    // un-edited rows; edited rows keep NULL since their true original is gone.
    await this.sql`ALTER TABLE pages ADD COLUMN IF NOT EXISTS original_transcription TEXT`;
    await this.sql`UPDATE pages SET original_transcription = transcription WHERE original_transcription IS NULL AND is_edited = FALSE`;

    // OCR quality-check verdict columns (additive)
    await this.sql`ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_quality TEXT`;
    await this.sql`ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_quality_reason TEXT`;
    await this.sql`ALTER TABLE books ADD COLUMN IF NOT EXISTS ocr_quality TEXT`;
    await this.sql`ALTER TABLE books ADD COLUMN IF NOT EXISTS ocr_quality_note TEXT`;

    // Object-storage key for page images (R2)
    await this.sql`ALTER TABLE page_images ADD COLUMN IF NOT EXISTS object_key TEXT`;

    // Distinguish OCR batches from sentiment-scoring batches so resume routes correctly
    await this.sql`ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ocr'`;

    // Sentiment scoring methods: seed the default LLM method, make `method` a
    // first-class axis on page_sentiment (page+dimension+method), and migrate the
    // old 2-column unique. Idempotent and safe on both fresh and existing DBs.
    await this.sql`INSERT INTO methods (name, kind, config) VALUES ('claude-default', 'llm', '{}') ON CONFLICT (name) DO NOTHING`;
    await this.sql`ALTER TABLE page_sentiment ADD COLUMN IF NOT EXISTS method_id INTEGER REFERENCES methods(id) ON DELETE CASCADE`;
    await this.sql`UPDATE page_sentiment SET method_id = (SELECT id FROM methods WHERE name = 'claude-default') WHERE method_id IS NULL`;
    await this.sql`ALTER TABLE page_sentiment ALTER COLUMN method_id SET NOT NULL`;
    await this.sql`ALTER TABLE page_sentiment DROP CONSTRAINT IF EXISTS page_sentiment_page_id_dimension_id_key`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS page_sentiment_page_dim_method_key ON page_sentiment (page_id, dimension_id, method_id)`;

    // Seed OCR run history from the legacy single-original column so existing
    // pages still show their original in the new history view. Idempotent: only
    // inserts for pages that have an original but no run yet.
    await this.sql`
      INSERT INTO page_ocr_runs (page_id, model, text, created_at)
      SELECT id, NULL, original_transcription, created_at FROM pages p
      WHERE original_transcription IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM page_ocr_runs r WHERE r.page_id = p.id)
    `;
  }

  // ---- Book helpers ----

  async upsertBook(driveFileId: string, driveFileName: string, title: string): Promise<BookRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgBookRow[]>`
      INSERT INTO books (title, drive_file_id, drive_file_name, created_by)
      VALUES (${title}, ${driveFileId}, ${driveFileName}, ${createdBy})
      ON CONFLICT(drive_file_id) DO UPDATE SET
        drive_file_name = EXCLUDED.drive_file_name,
        updated_at = NOW()
      RETURNING *
    `;
    return coerceBook(rows[0]);
  }

  async setBookTitle(bookId: number, title: string): Promise<void> {
    await this.sql`UPDATE books SET title = ${title}, updated_at = NOW() WHERE id = ${bookId}`;
  }

  async getBookByDriveId(driveFileId: string): Promise<BookRow | undefined> {
    const rows = await this.sql<PgBookRow[]>`
      SELECT * FROM books WHERE drive_file_id = ${driveFileId}
    `;
    return rows.length > 0 ? coerceBook(rows[0]) : undefined;
  }

  async getBookByName(name: string): Promise<BookRow | undefined> {
    const rows = await this.sql<PgBookRow[]>`
      SELECT * FROM books WHERE drive_file_name = ${name} OR title = ${name} LIMIT 1
    `;
    return rows.length > 0 ? coerceBook(rows[0]) : undefined;
  }

  async getAllBooks(): Promise<BookRow[]> {
    const rows = await this.sql<PgBookRow[]>`
      SELECT * FROM books ORDER BY title
    `;
    return rows.map(coerceBook);
  }

  async updateBookStatus(bookId: number, status: string, pageCount?: number): Promise<void> {
    if (pageCount !== undefined) {
      await this.sql`
        UPDATE books SET status = ${status}, page_count = ${pageCount}, updated_at = NOW()
        WHERE id = ${bookId}
      `;
    } else {
      await this.sql`
        UPDATE books SET status = ${status}, updated_at = NOW()
        WHERE id = ${bookId}
      `;
    }
  }

  async setBookQuality(bookId: number, quality: string, note: string | null): Promise<void> {
    await this.sql`
      UPDATE books SET ocr_quality = ${quality}, ocr_quality_note = ${note} WHERE id = ${bookId}
    `;
  }

  // ---- Page helpers ----

  async upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void> {
    const hasIllustration = transcription.trim() === '[ILLUSTRATION]';
    const status = 'complete';
    const createdBy = process.env.APP_USER_ID ?? null;
    const batchId = batchCustomId ?? null;

    await this.sql`
      INSERT INTO pages (book_id, page_number, transcription, original_transcription, has_illustration, status, batch_custom_id, created_by, updated_at)
      VALUES (${bookId}, ${pageNumber}, ${transcription}, ${transcription}, ${hasIllustration}, ${status}, ${batchId}, ${createdBy}, NOW())
      ON CONFLICT(book_id, page_number) DO UPDATE SET
        transcription          = EXCLUDED.transcription,
        original_transcription = COALESCE(pages.original_transcription, EXCLUDED.transcription),
        ocr_quality            = NULL,
        ocr_quality_reason     = NULL,
        has_illustration       = EXCLUDED.has_illustration,
        status                 = EXCLUDED.status,
        batch_custom_id        = EXCLUDED.batch_custom_id,
        updated_at             = NOW()
      WHERE pages.is_edited = FALSE
    `;
  }

  async updatePageTranscription(bookId: number, pageNumber: number, transcription: string, markEdited = true): Promise<boolean> {
    const result = markEdited
      ? await this.sql`
          UPDATE pages
          SET transcription = ${transcription}, is_edited = TRUE,
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = NOW()
          WHERE book_id = ${bookId} AND page_number = ${pageNumber}
        `
      : await this.sql`
          UPDATE pages
          SET transcription = ${transcription}, is_edited = FALSE,
              original_transcription = COALESCE(original_transcription, ${transcription}),
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = NOW()
          WHERE book_id = ${bookId} AND page_number = ${pageNumber}
        `;
    return result.count > 0;
  }

  async getPages(bookId: number, pageStart?: number, pageEnd?: number): Promise<PageRow[]> {
    let rows: PgPageRow[];
    if (pageStart !== undefined && pageEnd !== undefined) {
      rows = await this.sql<PgPageRow[]>`
        SELECT * FROM pages
        WHERE book_id = ${bookId} AND page_number BETWEEN ${pageStart} AND ${pageEnd}
        ORDER BY page_number
      `;
    } else if (pageStart !== undefined) {
      rows = await this.sql<PgPageRow[]>`
        SELECT * FROM pages
        WHERE book_id = ${bookId} AND page_number >= ${pageStart}
        ORDER BY page_number
      `;
    } else {
      rows = await this.sql<PgPageRow[]>`
        SELECT * FROM pages WHERE book_id = ${bookId} ORDER BY page_number
      `;
    }
    return rows.map(coercePage);
  }

  async getPageByCustomId(batchCustomId: string): Promise<PageRow | undefined> {
    const rows = await this.sql<PgPageRow[]>`
      SELECT * FROM pages WHERE batch_custom_id = ${batchCustomId}
    `;
    return rows.length > 0 ? coercePage(rows[0]) : undefined;
  }

  async setPageTags(bookId: number, pageNumber: number, tags: string[]): Promise<boolean> {
    const result = await this.sql`
      UPDATE pages SET tags = ${this.sql.json(tags)}, updated_at = NOW()
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return result.count > 0;
  }

  async getAllTags(): Promise<string[]> {
    // tags is JSONB; expand each page's array to rows and dedupe.
    const rows = await this.sql<{ tag: string }[]>`
      SELECT DISTINCT t AS tag
      FROM pages, jsonb_array_elements_text(pages.tags) AS t
      WHERE jsonb_typeof(pages.tags) = 'array'
    `;
    return rows
      .map((r) => r.tag.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  async setPageQuality(bookId: number, pageNumber: number, quality: string, reason: string | null): Promise<boolean> {
    const result = await this.sql`
      UPDATE pages SET ocr_quality = ${quality}, ocr_quality_reason = ${reason}
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return result.count > 0;
  }

  async setPageIllustration(bookId: number, pageNumber: number, isIllustration: boolean): Promise<boolean> {
    const result = await this.sql`
      UPDATE pages SET has_illustration = ${isIllustration}, updated_at = NOW()
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return result.count > 0;
  }

  async hasExistingTranscription(bookId: number, pageNumber: number): Promise<boolean> {
    const rows = await this.sql<{ transcription: string | null }[]>`
      SELECT transcription FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return rows.length > 0 && rows[0].transcription != null && rows[0].transcription !== '';
  }

  // ---- Batch job helpers ----

  async createBatchJob(batchId: string, bookIds: number[], kind = 'ocr'): Promise<BatchJobRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgBatchJobRow[]>`
      INSERT INTO batch_jobs (batch_id, book_ids, kind, created_by)
      VALUES (${batchId}, ${this.sql.json(bookIds)}, ${kind}, ${createdBy})
      RETURNING *
    `;
    return coerceBatchJob(rows[0]);
  }

  async getBatchJob(batchId: string): Promise<BatchJobRow | undefined> {
    const rows = await this.sql<PgBatchJobRow[]>`
      SELECT * FROM batch_jobs WHERE batch_id = ${batchId}
    `;
    return rows.length > 0 ? coerceBatchJob(rows[0]) : undefined;
  }

  async updateBatchJobStatus(batchId: string, status: string): Promise<void> {
    await this.sql`
      UPDATE batch_jobs
      SET status = ${status},
          completed_at = CASE WHEN ${status} = 'complete' THEN NOW() ELSE completed_at END
      WHERE batch_id = ${batchId}
    `;
  }

  async getInProgressBatchJobs(): Promise<BatchJobRow[]> {
    const rows = await this.sql<PgBatchJobRow[]>`
      SELECT * FROM batch_jobs WHERE status = 'in_progress'
    `;
    return rows.map(coerceBatchJob);
  }

  // ---- Dimension helpers ----

  async getRecentBatchJobs(kind: string, limit: number): Promise<BatchJobRow[]> {
    const rows = await this.sql<PgBatchJobRow[]>`
      SELECT * FROM batch_jobs WHERE kind = ${kind}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(coerceBatchJob);
  }

  async createDimension(name: string, description: string, minLabel: string, maxLabel: string): Promise<DimensionRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgDimensionRow[]>`
      INSERT INTO dimensions (name, description, min_label, max_label, created_by)
      VALUES (${name}, ${description}, ${minLabel}, ${maxLabel}, ${createdBy})
      RETURNING *
    `;
    return coerceDimension(rows[0]);
  }

  async getDimensionByName(name: string): Promise<DimensionRow | undefined> {
    const rows = await this.sql<PgDimensionRow[]>`
      SELECT * FROM dimensions WHERE name = ${name}
    `;
    return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
  }

  async getAllDimensions(): Promise<DimensionRow[]> {
    const rows = await this.sql<PgDimensionRow[]>`
      SELECT * FROM dimensions ORDER BY name
    `;
    return rows.map(coerceDimension);
  }

  async updateDimension(id: number, fields: { description?: string; minLabel?: string; maxLabel?: string }): Promise<DimensionRow | undefined> {
    const setFields: Record<string, unknown> = { updated_at: new Date() };

    if (fields.description !== undefined) setFields['description'] = fields.description;
    if (fields.minLabel !== undefined) setFields['min_label'] = fields.minLabel;
    if (fields.maxLabel !== undefined) setFields['max_label'] = fields.maxLabel;

    // If only updated_at, nothing meaningful to update — just return current row
    if (Object.keys(setFields).length === 1) {
      const rows = await this.sql<PgDimensionRow[]>`SELECT * FROM dimensions WHERE id = ${id}`;
      return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
    }

    const rows = await this.sql<PgDimensionRow[]>`
      UPDATE dimensions
      SET ${this.sql(setFields)}
      WHERE id = ${id}
      RETURNING *
    `;
    return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
  }

  async deleteDimension(id: number): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM dimensions WHERE id = ${id}
    `;
    return result.count > 0;
  }

  // ---- Scoring method + lexicon helpers ----

  async createMethod(name: string, kind: string, config: string): Promise<MethodRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgMethodRow[]>`
      INSERT INTO methods (name, kind, config, created_by)
      VALUES (${name}, ${kind}, ${config}, ${createdBy})
      RETURNING *
    `;
    return coerceMethod(rows[0]);
  }

  async getMethodByName(name: string): Promise<MethodRow | undefined> {
    const rows = await this.sql<PgMethodRow[]>`SELECT * FROM methods WHERE name = ${name}`;
    return rows.length > 0 ? coerceMethod(rows[0]) : undefined;
  }

  async getAllMethods(): Promise<MethodRow[]> {
    const rows = await this.sql<PgMethodRow[]>`SELECT * FROM methods ORDER BY name`;
    return rows.map(coerceMethod);
  }

  async deleteMethod(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM methods WHERE id = ${id}`;
    return result.count > 0;
  }

  async createLexicon(name: string, scaleMin: number, scaleMax: number, note: string | null): Promise<LexiconRow> {
    const rows = await this.sql<PgLexiconRow[]>`
      INSERT INTO lexicons (name, scale_min, scale_max, note)
      VALUES (${name}, ${scaleMin}, ${scaleMax}, ${note})
      RETURNING *
    `;
    return coerceLexicon(rows[0]);
  }

  async getLexiconByName(name: string): Promise<LexiconRow | undefined> {
    const rows = await this.sql<PgLexiconRow[]>`SELECT * FROM lexicons WHERE name = ${name}`;
    return rows.length > 0 ? coerceLexicon(rows[0]) : undefined;
  }

  async getAllLexicons(): Promise<LexiconSummary[]> {
    const rows = await this.sql<Array<PgLexiconRow & { term_count: string | number; dimension_names: string[] | null }>>`
      SELECT l.*,
             (SELECT COUNT(*) FROM lexicon_terms t WHERE t.lexicon_id = l.id) AS term_count,
             (SELECT ARRAY_AGG(DISTINCT d.name)
                FROM lexicon_terms t JOIN dimensions d ON d.id = t.dimension_id
               WHERE t.lexicon_id = l.id) AS dimension_names
        FROM lexicons l
       ORDER BY l.name
    `;
    return rows.map((r) => ({
      ...coerceLexicon(r),
      term_count: Number(r.term_count),
      dimensions: (r.dimension_names ?? []).slice().sort(),
    }));
  }

  async deleteLexicon(id: number): Promise<boolean> {
    // Methods bound to this lexicon would be left dangling — drop them (and, by
    // cascade, the scores they produced) alongside the lexicon's terms.
    await this.sql`
      DELETE FROM methods
       WHERE kind = 'lexicon' AND (config::jsonb ->> 'lexicon_id')::int = ${id}
    `;
    const result = await this.sql`DELETE FROM lexicons WHERE id = ${id}`;
    return result.count > 0;
  }

  async insertLexiconTerms(terms: Array<{ lexiconId: number; dimensionId: number; term: string; value: number }>): Promise<number> {
    // Published dictionaries repeat terms — AFINN-es lists 332 twice, with
    // different scores. Postgres rejects an ON CONFLICT DO UPDATE that would
    // touch the same row twice in one statement ("cannot affect row a second
    // time"), which aborts the insert and leaves the lexicon half-loaded. Dedupe
    // first, last occurrence winning, which is what SQLite's row-by-row upsert
    // does anyway — so both adapters store the same thing.
    const byKey = new Map<string, { lexicon_id: number; dimension_id: number; term: string; value: number }>();
    for (const t of terms) {
      byKey.set(`${t.lexiconId}:${t.dimensionId}:${t.term}`, {
        lexicon_id: t.lexiconId, dimension_id: t.dimensionId, term: t.term, value: t.value,
      });
    }
    const rows = [...byKey.values()];

    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.sql`
        INSERT INTO lexicon_terms ${this.sql(chunk, 'lexicon_id', 'dimension_id', 'term', 'value')}
        ON CONFLICT (lexicon_id, dimension_id, term) DO UPDATE SET value = EXCLUDED.value
      `;
      inserted += chunk.length;
    }
    return inserted;
  }

  async getLexiconTerms(lexiconId: number, dimensionId: number): Promise<LexiconTermRow[]> {
    const rows = await this.sql<LexiconTermRow[]>`
      SELECT lexicon_id, dimension_id, term, value FROM lexicon_terms
      WHERE lexicon_id = ${lexiconId} AND dimension_id = ${dimensionId}
    `;
    return rows.map((r) => ({ lexicon_id: r.lexicon_id, dimension_id: r.dimension_id, term: r.term, value: r.value }));
  }

  // ---- Page sentiment helpers ----

  async upsertPageSentiment(pageId: number, dimensionId: number, methodId: number, score: number, rationale: string | null, model: string | null): Promise<PageSentimentRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgPageSentimentRow[]>`
      INSERT INTO page_sentiment (page_id, dimension_id, method_id, score, rationale, model, created_by)
      VALUES (${pageId}, ${dimensionId}, ${methodId}, ${score}, ${rationale}, ${model}, ${createdBy})
      ON CONFLICT (page_id, dimension_id, method_id) DO UPDATE SET
        score      = EXCLUDED.score,
        rationale  = EXCLUDED.rationale,
        model      = EXCLUDED.model,
        created_by = EXCLUDED.created_by
      RETURNING *
    `;
    return coercePageSentiment(rows[0]);
  }

  async getPageSentiment(pageId: number): Promise<PageSentimentRow[]> {
    const rows = await this.sql<PgPageSentimentRow[]>`
      SELECT * FROM page_sentiment WHERE page_id = ${pageId} ORDER BY dimension_id
    `;
    return rows.map(coercePageSentiment);
  }

  async getBookSentiment(bookId: number, dimensionIds?: number[], pageStart?: number, pageEnd?: number): Promise<PageSentimentRow[]> {
    let rows: PgPageSentimentRow[];

    if (dimensionIds && dimensionIds.length > 0 && pageStart !== undefined && pageEnd !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number >= ${pageStart}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (dimensionIds && dimensionIds.length > 0 && pageStart !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number >= ${pageStart}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (dimensionIds && dimensionIds.length > 0 && pageEnd !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (dimensionIds && dimensionIds.length > 0) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (pageStart !== undefined && pageEnd !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number >= ${pageStart}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (pageStart !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number >= ${pageStart}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (pageEnd !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    }

    return rows.map(coercePageSentiment);
  }

  /**
   * NB: pass arrays straight through with an explicit `::int[]` cast. This
   * driver's `sql.array()` helper does not yield a usable operand for `ANY()`
   * ("op ANY/ALL (array) requires array on right side"), and interpolating
   * pre-built sql fragments loses the parameter types on top of that — the
   * symptom is `operator does not exist: integer = text`.
   */
  async getSentimentScores(bookIds: number[], dimensionIds?: number[], methodIds?: number[]): Promise<SentimentScoreDetail[]> {
    if (bookIds.length === 0) return [];

    interface Raw {
      page_id: number; dimension_id: number; method_id: number; score: number; rationale: string | null;
      model: string | null; book_id: number; page_number: number; tags: unknown;
      book_title: string; dimension_name: string; method_name: string;
    }

    // NULL means "no filter", which keeps this one static query instead of
    // stitching sql fragments together — see the note on ANY() casts below.
    const dims = dimensionIds && dimensionIds.length > 0 ? dimensionIds : null;
    const methods = methodIds && methodIds.length > 0 ? methodIds : null;

    const rows = await this.sql<Raw[]>`
      SELECT ps.page_id, ps.dimension_id, ps.method_id, ps.score, ps.rationale, ps.model,
             p.book_id, p.page_number, p.tags,
             b.title AS book_title, d.name AS dimension_name, m.name AS method_name
      FROM page_sentiment ps
      JOIN pages      p ON ps.page_id = p.id
      JOIN books      b ON p.book_id = b.id
      JOIN dimensions d ON ps.dimension_id = d.id
      JOIN methods    m ON ps.method_id = m.id
      WHERE p.book_id = ANY(${bookIds}::int[])
        AND (${dims}::int[] IS NULL OR ps.dimension_id = ANY(${dims}::int[]))
        AND (${methods}::int[] IS NULL OR ps.method_id = ANY(${methods}::int[]))
      ORDER BY p.book_id, p.page_number, ps.dimension_id, ps.method_id
    `;

    return rows.map((r) => ({
      book_id: r.book_id,
      book_title: r.book_title,
      page_id: r.page_id,
      page_number: r.page_number,
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean) : [],
      dimension_id: r.dimension_id,
      dimension_name: r.dimension_name,
      method_id: r.method_id,
      method_name: r.method_name,
      score: r.score,
      rationale: r.rationale,
      model: r.model,
    }));
  }

  // ---- Page image helpers ----

  async getPageImage(bookId: number, pageNumber: number): Promise<string | null> {
    const rows = await this.sql<{ image_data: string }[]>`
      SELECT image_data FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return rows.length > 0 ? rows[0].image_data : null;
  }

  async setPageImage(bookId: number, pageNumber: number, imageData: string): Promise<void> {
    await this.sql`
      INSERT INTO page_images (book_id, page_number, image_data)
      VALUES (${bookId}, ${pageNumber}, ${imageData})
      ON CONFLICT (book_id, page_number) DO UPDATE SET image_data = EXCLUDED.image_data
    `;
  }

  async getPageImageKey(bookId: number, pageNumber: number): Promise<string | null> {
    const rows = await this.sql<{ object_key: string | null }[]>`
      SELECT object_key FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return rows.length > 0 ? rows[0].object_key : null;
  }

  async setPageImageKey(bookId: number, pageNumber: number, objectKey: string): Promise<void> {
    await this.sql`
      INSERT INTO page_images (book_id, page_number, image_data, object_key)
      VALUES (${bookId}, ${pageNumber}, '', ${objectKey})
      ON CONFLICT (book_id, page_number) DO UPDATE SET object_key = EXCLUDED.object_key, image_data = ''
    `;
  }

  async cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>): Promise<void> {
    if (images.length === 0) return;
    for (const img of images) {
      await this.sql`
        INSERT INTO page_images (book_id, page_number, image_data)
        VALUES (${bookId}, ${img.pageNumber}, ${img.imageData})
        ON CONFLICT (book_id, page_number) DO UPDATE SET image_data = EXCLUDED.image_data
      `;
    }
  }

  async hasAnyPageImage(bookId: number): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM page_images WHERE book_id = ${bookId} LIMIT 1) AS exists
    `;
    return rows.length > 0 && rows[0].exists;
  }

  async deletePage(bookId: number, pageNumber: number): Promise<boolean> {
    await this.sql`DELETE FROM page_ocr_runs WHERE page_id IN (SELECT id FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber})`;
    const result = await this.sql`DELETE FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber}`;
    if (result.count === 0) return false;
    await this.sql`DELETE FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}`;
    // Use negative intermediary to avoid UNIQUE constraint violations during renumber
    await this.sql`UPDATE pages SET page_number = -(page_number - 1) WHERE book_id = ${bookId} AND page_number > ${pageNumber}`;
    await this.sql`UPDATE pages SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
    await this.sql`UPDATE page_images SET page_number = -(page_number - 1) WHERE book_id = ${bookId} AND page_number > ${pageNumber}`;
    await this.sql`UPDATE page_images SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
    return true;
  }

  async insertPageAfter(bookId: number, afterPageNumber: number): Promise<PageRow> {
    const newPageNumber = afterPageNumber + 1;
    // Use negative intermediary to avoid UNIQUE constraint violations during renumber
    await this.sql`UPDATE pages SET page_number = -(page_number + 1) WHERE book_id = ${bookId} AND page_number >= ${newPageNumber}`;
    await this.sql`UPDATE pages SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
    await this.sql`UPDATE page_images SET page_number = -(page_number + 1) WHERE book_id = ${bookId} AND page_number >= ${newPageNumber}`;
    await this.sql`UPDATE page_images SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
    await this.sql`INSERT INTO pages (book_id, page_number, transcription, status) VALUES (${bookId}, ${newPageNumber}, NULL, 'pending')`;
    const rows = await this.sql<PageRow[]>`SELECT * FROM pages WHERE book_id = ${bookId} AND page_number = ${newPageNumber}`;
    return rows[0];
  }

  async recordOcrRun(bookId: number, pageNumber: number, model: string | null, text: string): Promise<OcrRunRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgOcrRunRow[]>`
      INSERT INTO page_ocr_runs (page_id, model, text, created_by)
      SELECT id, ${model}, ${text}, ${createdBy} FROM pages
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
      RETURNING *
    `;
    if (rows.length === 0) throw new Error(`Page ${pageNumber} not found for book ${bookId}`);
    return coerceOcrRun(rows[0]);
  }

  async getOcrRuns(bookId: number, pageNumber: number): Promise<OcrRunRow[]> {
    const rows = await this.sql<PgOcrRunRow[]>`
      SELECT r.* FROM page_ocr_runs r
      JOIN pages p ON p.id = r.page_id
      WHERE p.book_id = ${bookId} AND p.page_number = ${pageNumber}
      ORDER BY r.created_at, r.id
    `;
    return rows.map(coerceOcrRun);
  }
}

export async function createPostgresAdapter(): Promise<PostgresAdapter> {
  let sql: postgres.Sql;

  const sharedOptions: postgres.Options<Record<string, postgres.PostgresType>> = {
    // Redirect Postgres notices to stderr — default is console.log which corrupts MCP stdio
    onnotice: (notice) => process.stderr.write(`[OCR MCP] Postgres: ${notice.message}\n`),
  };

  if (process.env.DATABASE_URL) {
    sql = postgres(process.env.DATABASE_URL, sharedOptions);
  } else {
    sql = postgres({
      ...sharedOptions,
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? true : false,
    });
  }

  const adapter = new PostgresAdapter(sql);
  await adapter.init();
  return adapter;
}
