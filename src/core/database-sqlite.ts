import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow, SentimentScoreDetail, MethodRow, LexiconRow, LexiconTermRow, OcrRunRow } from './database-adapter.js';

/** Parse a stored tags JSON string into a trimmed string[], tolerating malformed data. */
function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// SQLite raw row types (booleans stored as 0/1 integers)
interface SqlitePageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  original_transcription: string | null;
  ocr_quality: string | null;
  ocr_quality_reason: string | null;
  has_illustration: number;
  is_edited: number;
  status: string;
  batch_custom_id: string | null;
  tags: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function coercePage(row: SqlitePageRow): PageRow {
  return {
    ...row,
    has_illustration: row.has_illustration === 1,
    is_edited: row.is_edited === 1,
  };
}

export class SqliteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure the data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    this.runMigrations();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        drive_file_id   TEXT NOT NULL UNIQUE,
        drive_file_name TEXT NOT NULL,
        page_count      INTEGER,
        status          TEXT DEFAULT 'pending',
        ocr_quality     TEXT,
        ocr_quality_note TEXT,
        created_by      TEXT,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
        tags             TEXT NOT NULL DEFAULT '[]',
        created_by       TEXT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_id, page_number)
      );

      CREATE TABLE IF NOT EXISTS batch_jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id     TEXT NOT NULL UNIQUE,
        book_ids     TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'ocr',
        status       TEXT DEFAULT 'in_progress',
        created_by   TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS dimensions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        min_label   TEXT NOT NULL DEFAULT 'Low',
        max_label   TEXT NOT NULL DEFAULT 'High',
        created_by  TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS methods (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL,
        config      TEXT NOT NULL DEFAULT '{}',
        created_by  TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS lexicons (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        scale_min  REAL NOT NULL DEFAULT 0,
        scale_max  REAL NOT NULL DEFAULT 1,
        note       TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS lexicon_terms (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        lexicon_id   INTEGER NOT NULL REFERENCES lexicons(id) ON DELETE CASCADE,
        dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
        term         TEXT NOT NULL,
        value        REAL NOT NULL,
        UNIQUE(lexicon_id, dimension_id, term)
      );

      CREATE TABLE IF NOT EXISTS page_sentiment (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id      INTEGER NOT NULL REFERENCES pages(id),
        dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
        method_id    INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
        score        REAL NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
        rationale    TEXT,
        model        TEXT,
        created_by   TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(page_id, dimension_id, method_id)
      );

      CREATE TABLE IF NOT EXISTS page_images (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(id),
        page_number INTEGER NOT NULL,
        image_data  TEXT NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_id, page_number)
      );

      CREATE TABLE IF NOT EXISTS page_ocr_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        model       TEXT,
        text        TEXT NOT NULL,
        created_by  TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_page_ocr_runs_page ON page_ocr_runs(page_id, created_at);
    `);
  }

  private runMigrations(): void {
    // Add tags column if it doesn't exist (safe to run on existing DBs)
    try {
      this.db.exec(`ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists — no-op
    }

    // Add created_by columns if they don't exist
    try {
      this.db.exec(`ALTER TABLE books ADD COLUMN created_by TEXT`);
    } catch {
      // Column already exists — no-op
    }

    try {
      this.db.exec(`ALTER TABLE pages ADD COLUMN created_by TEXT`);
    } catch {
      // Column already exists — no-op
    }

    try {
      this.db.exec(`ALTER TABLE batch_jobs ADD COLUMN created_by TEXT`);
    } catch {
      // Column already exists — no-op
    }

    // Distinguish OCR batches from sentiment-scoring batches so resume routes correctly
    try {
      this.db.exec(`ALTER TABLE batch_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'ocr'`);
    } catch {
      // Column already exists — no-op
    }

    // Preserve the first OCR result for research. Add the column, then backfill
    // un-edited rows (their current text == the original). Edited rows are left
    // NULL since their true original is unrecoverable.
    try {
      this.db.exec(`ALTER TABLE pages ADD COLUMN original_transcription TEXT`);
    } catch {
      // Column already exists — no-op
    }
    try {
      this.db.exec(
        `UPDATE pages SET original_transcription = transcription WHERE original_transcription IS NULL AND is_edited = 0`
      );
    } catch {
      // Best-effort backfill
    }

    // OCR quality-check verdict columns
    try {
      this.db.exec(`ALTER TABLE pages ADD COLUMN ocr_quality TEXT`);
    } catch {
      // Column already exists — no-op
    }
    try {
      this.db.exec(`ALTER TABLE pages ADD COLUMN ocr_quality_reason TEXT`);
    } catch {
      // Column already exists — no-op
    }

    // Book-level OCR quality verdict
    try {
      this.db.exec(`ALTER TABLE books ADD COLUMN ocr_quality TEXT`);
    } catch {
      // Column already exists — no-op
    }
    try {
      this.db.exec(`ALTER TABLE books ADD COLUMN ocr_quality_note TEXT`);
    } catch {
      // Column already exists — no-op
    }

    // Object-storage key for page images (R2)
    try {
      this.db.exec(`ALTER TABLE page_images ADD COLUMN object_key TEXT`);
    } catch {
      // Column already exists — no-op
    }

    // Sentiment scoring methods: seed the built-in default LLM method, then make
    // `method` a first-class axis on page_sentiment. SQLite can't drop the old
    // 2-column UNIQUE in place, so rebuild the table (scores are recomputable).
    try {
      this.db.exec(`INSERT OR IGNORE INTO methods (name, kind, config) VALUES ('claude-default', 'llm', '{}')`);
    } catch {
      // methods table is created in initializeSchema; ignore on unexpected ordering
    }

    const psCols = this.db.prepare(`PRAGMA table_info(page_sentiment)`).all() as Array<{ name: string }>;
    if (psCols.length > 0 && !psCols.some((c) => c.name === 'method_id')) {
      const def = this.db.prepare(`SELECT id FROM methods WHERE name = 'claude-default'`).get() as { id: number } | undefined;
      const defaultId = Number(def?.id ?? 1);
      this.db.pragma('foreign_keys = OFF');
      const rebuild = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE page_sentiment_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            page_id      INTEGER NOT NULL REFERENCES pages(id),
            dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
            method_id    INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
            score        REAL NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
            rationale    TEXT,
            model        TEXT,
            created_by   TEXT,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(page_id, dimension_id, method_id)
          );
          INSERT INTO page_sentiment_new (id, page_id, dimension_id, method_id, score, rationale, model, created_by, created_at)
            SELECT id, page_id, dimension_id, ${defaultId}, score, rationale, model, created_by, created_at FROM page_sentiment;
          DROP TABLE page_sentiment;
          ALTER TABLE page_sentiment_new RENAME TO page_sentiment;
        `);
      });
      rebuild();
      this.db.pragma('foreign_keys = ON');
    }

    // Seed OCR run history from the legacy single-original column so existing
    // pages still show their original in the new history view. Idempotent: only
    // inserts for pages that have an original but no run yet.
    try {
      this.db.exec(`
        INSERT INTO page_ocr_runs (page_id, model, text, created_at)
        SELECT id, NULL, original_transcription, created_at FROM pages p
        WHERE original_transcription IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM page_ocr_runs r WHERE r.page_id = p.id)
      `);
    } catch {
      // Best-effort backfill (e.g. page_ocr_runs not yet created on unexpected ordering)
    }
  }

  // ---- Book helpers ----

  async upsertBook(driveFileId: string, driveFileName: string, title: string): Promise<BookRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO books (title, drive_file_id, drive_file_name, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(drive_file_id) DO UPDATE SET
        drive_file_name = excluded.drive_file_name,
        updated_at = CURRENT_TIMESTAMP
    `).run(title, driveFileId, driveFileName, createdBy);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM books WHERE drive_file_id = ?').get(driveFileId) as BookRow
    );
  }

  async setBookTitle(bookId: number, title: string): Promise<void> {
    this.db.prepare('UPDATE books SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, bookId);
    return Promise.resolve();
  }

  async getBookByDriveId(driveFileId: string): Promise<BookRow | undefined> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM books WHERE drive_file_id = ?').get(driveFileId) as BookRow | undefined
    );
  }

  async getBookByName(name: string): Promise<BookRow | undefined> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM books WHERE drive_file_name = ? OR title = ?').get(name, name) as BookRow | undefined
    );
  }

  async getAllBooks(): Promise<BookRow[]> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM books ORDER BY title').all() as BookRow[]
    );
  }

  async updateBookStatus(bookId: number, status: string, pageCount?: number): Promise<void> {
    if (pageCount !== undefined) {
      this.db.prepare(`
        UPDATE books SET status = ?, page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(status, pageCount, bookId);
    } else {
      this.db.prepare(`
        UPDATE books SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(status, bookId);
    }
    return Promise.resolve();
  }

  async setBookQuality(bookId: number, quality: string, note: string | null): Promise<void> {
    this.db.prepare(`UPDATE books SET ocr_quality = ?, ocr_quality_note = ? WHERE id = ?`).run(quality, note, bookId);
    return Promise.resolve();
  }

  // ---- Page helpers ----

  async upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void> {
    const hasIllustration = transcription.trim() === '[ILLUSTRATION]' ? 1 : 0;
    const status = 'complete';
    const createdBy = process.env.APP_USER_ID ?? null;

    this.db.prepare(`
      INSERT INTO pages (book_id, page_number, transcription, original_transcription, has_illustration, status, batch_custom_id, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(book_id, page_number) DO UPDATE SET
        transcription          = excluded.transcription,
        original_transcription = COALESCE(original_transcription, excluded.transcription),
        ocr_quality            = NULL,
        ocr_quality_reason     = NULL,
        has_illustration       = excluded.has_illustration,
        status                 = excluded.status,
        batch_custom_id        = excluded.batch_custom_id,
        updated_at             = CURRENT_TIMESTAMP
      WHERE is_edited = 0
    `).run(bookId, pageNumber, transcription, transcription, hasIllustration, status, batchCustomId ?? null, createdBy);

    return Promise.resolve();
  }

  async updatePageTranscription(bookId: number, pageNumber: number, transcription: string, markEdited = true): Promise<boolean> {
    const result = markEdited
      ? this.db.prepare(`
          UPDATE pages
          SET transcription = ?, is_edited = 1,
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE book_id = ? AND page_number = ?
        `).run(transcription, bookId, pageNumber)
      : this.db.prepare(`
          UPDATE pages
          SET transcription = ?, is_edited = 0,
              original_transcription = COALESCE(original_transcription, ?),
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE book_id = ? AND page_number = ?
        `).run(transcription, transcription, bookId, pageNumber);
    return Promise.resolve(result.changes > 0);
  }

  async getPages(bookId: number, pageStart?: number, pageEnd?: number): Promise<PageRow[]> {
    let rows: SqlitePageRow[];
    if (pageStart !== undefined && pageEnd !== undefined) {
      rows = this.db.prepare(`
        SELECT * FROM pages
        WHERE book_id = ? AND page_number BETWEEN ? AND ?
        ORDER BY page_number
      `).all(bookId, pageStart, pageEnd) as SqlitePageRow[];
    } else if (pageStart !== undefined) {
      rows = this.db.prepare(`
        SELECT * FROM pages
        WHERE book_id = ? AND page_number >= ?
        ORDER BY page_number
      `).all(bookId, pageStart) as SqlitePageRow[];
    } else {
      rows = this.db.prepare(`
        SELECT * FROM pages WHERE book_id = ? ORDER BY page_number
      `).all(bookId) as SqlitePageRow[];
    }
    return Promise.resolve(rows.map(coercePage));
  }

  async getPageByCustomId(batchCustomId: string): Promise<PageRow | undefined> {
    const row = this.db.prepare('SELECT * FROM pages WHERE batch_custom_id = ?').get(batchCustomId) as SqlitePageRow | undefined;
    return Promise.resolve(row ? coercePage(row) : undefined);
  }

  async setPageTags(bookId: number, pageNumber: number, tags: string[]): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE pages SET tags = ?, updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ? AND page_number = ?
    `).run(JSON.stringify(tags), bookId, pageNumber);
    return Promise.resolve(result.changes > 0);
  }

  async getAllTags(): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT tags FROM pages WHERE tags IS NOT NULL AND tags != '[]'`)
      .all() as { tags: string }[];
    const set = new Set<string>();
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.tags);
        if (Array.isArray(arr)) for (const t of arr) {
          const s = String(t).trim();
          if (s) set.add(s);
        }
      } catch {
        /* skip malformed tags */
      }
    }
    return Promise.resolve(
      [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
  }

  async setPageQuality(bookId: number, pageNumber: number, quality: string, reason: string | null): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE pages SET ocr_quality = ?, ocr_quality_reason = ?
      WHERE book_id = ? AND page_number = ?
    `).run(quality, reason, bookId, pageNumber);
    return Promise.resolve(result.changes > 0);
  }

  async setPageIllustration(bookId: number, pageNumber: number, isIllustration: boolean): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE pages SET has_illustration = ?, updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ? AND page_number = ?
    `).run(isIllustration ? 1 : 0, bookId, pageNumber);
    return Promise.resolve(result.changes > 0);
  }

  async hasExistingTranscription(bookId: number, pageNumber: number): Promise<boolean> {
    const row = this.db.prepare('SELECT transcription FROM pages WHERE book_id = ? AND page_number = ?').get(bookId, pageNumber) as { transcription: string | null } | undefined;
    return Promise.resolve(!!(row?.transcription));
  }

  // ---- Batch job helpers ----

  async createBatchJob(batchId: string, bookIds: number[], kind = 'ocr'): Promise<BatchJobRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO batch_jobs (batch_id, book_ids, kind, created_by) VALUES (?, ?, ?, ?)
    `).run(batchId, JSON.stringify(bookIds), kind, createdBy);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM batch_jobs WHERE batch_id = ?').get(batchId) as BatchJobRow
    );
  }

  async getBatchJob(batchId: string): Promise<BatchJobRow | undefined> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM batch_jobs WHERE batch_id = ?').get(batchId) as BatchJobRow | undefined
    );
  }

  async updateBatchJobStatus(batchId: string, status: string): Promise<void> {
    this.db.prepare(`
      UPDATE batch_jobs
      SET status = ?, completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE batch_id = ?
    `).run(status, status, batchId);
    return Promise.resolve();
  }

  async getInProgressBatchJobs(): Promise<BatchJobRow[]> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM batch_jobs WHERE status = 'in_progress'`).all() as BatchJobRow[]
    );
  }

  // ---- Dimension helpers ----

  async createDimension(name: string, description: string, minLabel: string, maxLabel: string): Promise<DimensionRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO dimensions (name, description, min_label, max_label, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, description, minLabel, maxLabel, createdBy);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM dimensions WHERE name = ?').get(name) as DimensionRow
    );
  }

  async getDimensionByName(name: string): Promise<DimensionRow | undefined> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM dimensions WHERE name = ?').get(name) as DimensionRow | undefined
    );
  }

  async getAllDimensions(): Promise<DimensionRow[]> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM dimensions ORDER BY name').all() as DimensionRow[]
    );
  }

  async updateDimension(id: number, fields: { description?: string; minLabel?: string; maxLabel?: string }): Promise<DimensionRow | undefined> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (fields.description !== undefined) {
      setClauses.push('description = ?');
      values.push(fields.description);
    }
    if (fields.minLabel !== undefined) {
      setClauses.push('min_label = ?');
      values.push(fields.minLabel);
    }
    if (fields.maxLabel !== undefined) {
      setClauses.push('max_label = ?');
      values.push(fields.maxLabel);
    }

    if (setClauses.length === 0) {
      return Promise.resolve(
        this.db.prepare('SELECT * FROM dimensions WHERE id = ?').get(id) as DimensionRow | undefined
      );
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    this.db.prepare(`
      UPDATE dimensions SET ${setClauses.join(', ')} WHERE id = ?
    `).run(...values);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM dimensions WHERE id = ?').get(id) as DimensionRow | undefined
    );
  }

  async deleteDimension(id: number): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM dimensions WHERE id = ?').run(id);
    return Promise.resolve(result.changes > 0);
  }

  // ---- Scoring method + lexicon helpers ----

  async createMethod(name: string, kind: string, config: string): Promise<MethodRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`INSERT INTO methods (name, kind, config, created_by) VALUES (?, ?, ?, ?)`)
      .run(name, kind, config, createdBy);
    return Promise.resolve(this.db.prepare('SELECT * FROM methods WHERE name = ?').get(name) as MethodRow);
  }

  async getMethodByName(name: string): Promise<MethodRow | undefined> {
    return Promise.resolve(this.db.prepare('SELECT * FROM methods WHERE name = ?').get(name) as MethodRow | undefined);
  }

  async getAllMethods(): Promise<MethodRow[]> {
    return Promise.resolve(this.db.prepare('SELECT * FROM methods ORDER BY name').all() as MethodRow[]);
  }

  async deleteMethod(id: number): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM methods WHERE id = ?').run(id);
    return Promise.resolve(r.changes > 0);
  }

  async createLexicon(name: string, scaleMin: number, scaleMax: number, note: string | null): Promise<LexiconRow> {
    this.db.prepare(`INSERT INTO lexicons (name, scale_min, scale_max, note) VALUES (?, ?, ?, ?)`)
      .run(name, scaleMin, scaleMax, note);
    return Promise.resolve(this.db.prepare('SELECT * FROM lexicons WHERE name = ?').get(name) as LexiconRow);
  }

  async getLexiconByName(name: string): Promise<LexiconRow | undefined> {
    return Promise.resolve(this.db.prepare('SELECT * FROM lexicons WHERE name = ?').get(name) as LexiconRow | undefined);
  }

  async insertLexiconTerms(terms: Array<{ lexiconId: number; dimensionId: number; term: string; value: number }>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO lexicon_terms (lexicon_id, dimension_id, term, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(lexicon_id, dimension_id, term) DO UPDATE SET value = excluded.value
    `);
    const insertAll = this.db.transaction((rows: typeof terms) => {
      for (const t of rows) stmt.run(t.lexiconId, t.dimensionId, t.term, t.value);
      return rows.length;
    });
    return Promise.resolve(insertAll(terms));
  }

  async getLexiconTerms(lexiconId: number, dimensionId: number): Promise<LexiconTermRow[]> {
    return Promise.resolve(
      this.db.prepare('SELECT lexicon_id, dimension_id, term, value FROM lexicon_terms WHERE lexicon_id = ? AND dimension_id = ?')
        .all(lexiconId, dimensionId) as LexiconTermRow[]
    );
  }

  // ---- Page sentiment helpers ----

  async upsertPageSentiment(pageId: number, dimensionId: number, methodId: number, score: number, rationale: string | null, model: string | null): Promise<PageSentimentRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO page_sentiment (page_id, dimension_id, method_id, score, rationale, model, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, dimension_id, method_id) DO UPDATE SET
        score     = excluded.score,
        rationale = excluded.rationale,
        model     = excluded.model,
        created_by = excluded.created_by
    `).run(pageId, dimensionId, methodId, score, rationale, model, createdBy);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM page_sentiment WHERE page_id = ? AND dimension_id = ? AND method_id = ?').get(pageId, dimensionId, methodId) as PageSentimentRow
    );
  }

  async getPageSentiment(pageId: number): Promise<PageSentimentRow[]> {
    return Promise.resolve(
      this.db.prepare('SELECT * FROM page_sentiment WHERE page_id = ? ORDER BY dimension_id').all(pageId) as PageSentimentRow[]
    );
  }

  async getBookSentiment(bookId: number, dimensionIds?: number[], pageStart?: number, pageEnd?: number): Promise<PageSentimentRow[]> {
    const conditions: string[] = ['pages.book_id = ?'];
    const values: unknown[] = [bookId];

    if (dimensionIds && dimensionIds.length > 0) {
      conditions.push(`page_sentiment.dimension_id IN (${dimensionIds.map(() => '?').join(', ')})`);
      values.push(...dimensionIds);
    }
    if (pageStart !== undefined) {
      conditions.push('pages.page_number >= ?');
      values.push(pageStart);
    }
    if (pageEnd !== undefined) {
      conditions.push('pages.page_number <= ?');
      values.push(pageEnd);
    }

    const sql = `
      SELECT page_sentiment.*
      FROM page_sentiment
      JOIN pages ON page_sentiment.page_id = pages.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pages.page_number, page_sentiment.dimension_id
    `;

    return Promise.resolve(
      this.db.prepare(sql).all(...values) as PageSentimentRow[]
    );
  }

  async getSentimentScores(bookIds: number[], dimensionIds?: number[], methodIds?: number[]): Promise<SentimentScoreDetail[]> {
    if (bookIds.length === 0) return Promise.resolve([]);

    const conditions = [`p.book_id IN (${bookIds.map(() => '?').join(', ')})`];
    const values: unknown[] = [...bookIds];
    if (dimensionIds && dimensionIds.length > 0) {
      conditions.push(`ps.dimension_id IN (${dimensionIds.map(() => '?').join(', ')})`);
      values.push(...dimensionIds);
    }
    if (methodIds && methodIds.length > 0) {
      conditions.push(`ps.method_id IN (${methodIds.map(() => '?').join(', ')})`);
      values.push(...methodIds);
    }

    const rows = this.db.prepare(`
      SELECT ps.page_id, ps.dimension_id, ps.method_id, ps.score, ps.rationale, ps.model,
             p.book_id, p.page_number, p.tags,
             b.title AS book_title,
             d.name  AS dimension_name,
             m.name  AS method_name
      FROM page_sentiment ps
      JOIN pages      p ON ps.page_id = p.id
      JOIN books      b ON p.book_id = b.id
      JOIN dimensions d ON ps.dimension_id = d.id
      JOIN methods    m ON ps.method_id = m.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.book_id, p.page_number, ps.dimension_id, ps.method_id
    `).all(...values) as Array<{
      page_id: number; dimension_id: number; method_id: number; score: number; rationale: string | null;
      model: string | null; book_id: number; page_number: number; tags: string;
      book_title: string; dimension_name: string; method_name: string;
    }>;

    return Promise.resolve(rows.map((r) => ({
      book_id: r.book_id,
      book_title: r.book_title,
      page_id: r.page_id,
      page_number: r.page_number,
      tags: parseTagsJson(r.tags),
      dimension_id: r.dimension_id,
      dimension_name: r.dimension_name,
      method_id: r.method_id,
      method_name: r.method_name,
      score: r.score,
      rationale: r.rationale,
      model: r.model,
    })));
  }

  // ---- Page image helpers ----

  async getPageImage(bookId: number, pageNumber: number): Promise<string | null> {
    const row = this.db.prepare('SELECT image_data FROM page_images WHERE book_id = ? AND page_number = ?').get(bookId, pageNumber) as { image_data: string } | undefined;
    return Promise.resolve(row?.image_data ?? null);
  }

  async setPageImage(bookId: number, pageNumber: number, imageData: string): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO page_images (book_id, page_number, image_data)
      VALUES (?, ?, ?)
    `).run(bookId, pageNumber, imageData);
    return Promise.resolve();
  }

  async getPageImageKey(bookId: number, pageNumber: number): Promise<string | null> {
    const row = this.db
      .prepare('SELECT object_key FROM page_images WHERE book_id = ? AND page_number = ?')
      .get(bookId, pageNumber) as { object_key: string | null } | undefined;
    return Promise.resolve(row?.object_key ?? null);
  }

  async setPageImageKey(bookId: number, pageNumber: number, objectKey: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO page_images (book_id, page_number, image_data, object_key)
      VALUES (?, ?, '', ?)
      ON CONFLICT(book_id, page_number) DO UPDATE SET object_key = excluded.object_key, image_data = ''
    `).run(bookId, pageNumber, objectKey);
    return Promise.resolve();
  }

  async cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO page_images (book_id, page_number, image_data)
      VALUES (?, ?, ?)
    `);
    const insert = this.db.transaction((imgs: Array<{ pageNumber: number; imageData: string }>) => {
      for (const img of imgs) {
        stmt.run(bookId, img.pageNumber, img.imageData);
      }
    });
    insert(images);
    return Promise.resolve();
  }

  async hasAnyPageImage(bookId: number): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM page_images WHERE book_id = ? LIMIT 1').get(bookId);
    return Promise.resolve(!!row);
  }

  async insertPageAfter(bookId: number, afterPageNumber: number): Promise<PageRow> {
    const newPageNumber = afterPageNumber + 1;

    const doInsert = this.db.transaction(() => {
      // Shift pages: use negative intermediary to avoid UNIQUE constraint conflicts
      this.db.prepare(`
        UPDATE pages SET page_number = -(page_number + 1)
        WHERE book_id = ? AND page_number >= ?
      `).run(bookId, newPageNumber);
      this.db.prepare(`
        UPDATE pages SET page_number = -page_number
        WHERE book_id = ? AND page_number < 0
      `).run(bookId);

      // Shift cached page images the same way
      this.db.prepare(`
        UPDATE page_images SET page_number = -(page_number + 1)
        WHERE book_id = ? AND page_number >= ?
      `).run(bookId, newPageNumber);
      this.db.prepare(`
        UPDATE page_images SET page_number = -page_number
        WHERE book_id = ? AND page_number < 0
      `).run(bookId);

      // Insert the new blank page
      this.db.prepare(`
        INSERT INTO pages (book_id, page_number, transcription, status)
        VALUES (?, ?, NULL, 'pending')
      `).run(bookId, newPageNumber);

      return this.db.prepare('SELECT * FROM pages WHERE book_id = ? AND page_number = ?')
        .get(bookId, newPageNumber) as SqlitePageRow;
    });

    const row = doInsert();
    return Promise.resolve(coercePage(row));
  }

  async deletePage(bookId: number, pageNumber: number): Promise<boolean> {
    const doDelete = this.db.transaction(() => {
      // Drop the page's OCR run history first (FK target goes away below).
      this.db.prepare(`
        DELETE FROM page_ocr_runs
        WHERE page_id IN (SELECT id FROM pages WHERE book_id = ? AND page_number = ?)
      `).run(bookId, pageNumber);

      // Delete the page and its cached image
      const result = this.db.prepare(
        'DELETE FROM pages WHERE book_id = ? AND page_number = ?'
      ).run(bookId, pageNumber);

      if (result.changes === 0) return false;

      this.db.prepare(
        'DELETE FROM page_images WHERE book_id = ? AND page_number = ?'
      ).run(bookId, pageNumber);

      // Shift pages above down by 1 (negative intermediary avoids UNIQUE conflicts)
      this.db.prepare(`
        UPDATE pages SET page_number = -(page_number - 1)
        WHERE book_id = ? AND page_number > ?
      `).run(bookId, pageNumber);
      this.db.prepare(`
        UPDATE pages SET page_number = -page_number
        WHERE book_id = ? AND page_number < 0
      `).run(bookId);

      this.db.prepare(`
        UPDATE page_images SET page_number = -(page_number - 1)
        WHERE book_id = ? AND page_number > ?
      `).run(bookId, pageNumber);
      this.db.prepare(`
        UPDATE page_images SET page_number = -page_number
        WHERE book_id = ? AND page_number < 0
      `).run(bookId);

      return true;
    });

    return Promise.resolve(doDelete());
  }

  async recordOcrRun(bookId: number, pageNumber: number, model: string | null, text: string): Promise<OcrRunRow> {
    const page = this.db.prepare('SELECT id FROM pages WHERE book_id = ? AND page_number = ?')
      .get(bookId, pageNumber) as { id: number } | undefined;
    if (!page) throw new Error(`Page ${pageNumber} not found for book ${bookId}`);
    const createdBy = process.env.APP_USER_ID ?? null;
    const info = this.db.prepare(`
      INSERT INTO page_ocr_runs (page_id, model, text, created_by)
      VALUES (?, ?, ?, ?)
    `).run(page.id, model, text, createdBy);
    const row = this.db.prepare('SELECT * FROM page_ocr_runs WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as OcrRunRow;
    return Promise.resolve(row);
  }

  async getOcrRuns(bookId: number, pageNumber: number): Promise<OcrRunRow[]> {
    const rows = this.db.prepare(`
      SELECT r.* FROM page_ocr_runs r
      JOIN pages p ON p.id = r.page_id
      WHERE p.book_id = ? AND p.page_number = ?
      ORDER BY r.created_at, r.id
    `).all(bookId, pageNumber) as OcrRunRow[];
    return Promise.resolve(rows);
  }
}
