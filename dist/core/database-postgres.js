import postgres from 'postgres';
function coerceBook(row) {
    return {
        ...row,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
    };
}
function coercePage(row) {
    return {
        ...row,
        tags: JSON.stringify(row.tags ?? []),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
    };
}
function coerceOcrRun(row) {
    return { ...row, created_at: row.created_at.toISOString() };
}
function coerceBatchJob(row) {
    return {
        ...row,
        book_ids: JSON.stringify(row.book_ids ?? []),
        created_at: row.created_at.toISOString(),
        completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    };
}
function coerceDimension(row) {
    return {
        ...row,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
    };
}
function coercePageSentiment(row) {
    return {
        ...row,
        created_at: row.created_at.toISOString(),
    };
}
function coerceMethod(row) {
    return { ...row, created_at: row.created_at.toISOString() };
}
function coerceLexicon(row) {
    return { ...row, created_at: row.created_at.toISOString() };
}
export class PostgresAdapter {
    sql;
    constructor(sql) {
        this.sql = sql;
    }
    async init() {
        await this.sql `
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
        await this.sql `
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
        await this.sql `
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
        await this.sql `
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
        await this.sql `
      CREATE TABLE IF NOT EXISTS methods (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        kind       TEXT NOT NULL,
        config     TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
        await this.sql `
      CREATE TABLE IF NOT EXISTS lexicons (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        scale_min  DOUBLE PRECISION NOT NULL DEFAULT 0,
        scale_max  DOUBLE PRECISION NOT NULL DEFAULT 1,
        note       TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
        await this.sql `
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
        await this.sql `
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
        await this.sql `
      CREATE TABLE IF NOT EXISTS page_images (
        id          SERIAL PRIMARY KEY,
        book_id     INTEGER NOT NULL REFERENCES books(id),
        page_number INTEGER NOT NULL,
        image_data  TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(book_id, page_number)
      )
    `;
        await this.sql `
      CREATE TABLE IF NOT EXISTS page_ocr_runs (
        id          SERIAL PRIMARY KEY,
        page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        model       TEXT,
        text        TEXT NOT NULL,
        created_by  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
        await this.sql `CREATE INDEX IF NOT EXISTS idx_page_ocr_runs_page ON page_ocr_runs (page_id, created_at)`;
        // Preserve the first OCR result for research. Additive migration for existing
        // DBs (the CREATE above is a no-op when the table already exists). Backfill
        // un-edited rows; edited rows keep NULL since their true original is gone.
        await this.sql `ALTER TABLE pages ADD COLUMN IF NOT EXISTS original_transcription TEXT`;
        await this.sql `UPDATE pages SET original_transcription = transcription WHERE original_transcription IS NULL AND is_edited = FALSE`;
        // OCR quality-check verdict columns (additive)
        await this.sql `ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_quality TEXT`;
        await this.sql `ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_quality_reason TEXT`;
        await this.sql `ALTER TABLE books ADD COLUMN IF NOT EXISTS ocr_quality TEXT`;
        await this.sql `ALTER TABLE books ADD COLUMN IF NOT EXISTS ocr_quality_note TEXT`;
        // Object-storage key for page images (R2)
        await this.sql `ALTER TABLE page_images ADD COLUMN IF NOT EXISTS object_key TEXT`;
        // Distinguish OCR batches from sentiment-scoring batches so resume routes correctly
        await this.sql `ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ocr'`;
        // Sentiment scoring methods: seed the default LLM method, make `method` a
        // first-class axis on page_sentiment (page+dimension+method), and migrate the
        // old 2-column unique. Idempotent and safe on both fresh and existing DBs.
        await this.sql `INSERT INTO methods (name, kind, config) VALUES ('claude-default', 'llm', '{}') ON CONFLICT (name) DO NOTHING`;
        await this.sql `ALTER TABLE page_sentiment ADD COLUMN IF NOT EXISTS method_id INTEGER REFERENCES methods(id) ON DELETE CASCADE`;
        await this.sql `UPDATE page_sentiment SET method_id = (SELECT id FROM methods WHERE name = 'claude-default') WHERE method_id IS NULL`;
        await this.sql `ALTER TABLE page_sentiment ALTER COLUMN method_id SET NOT NULL`;
        await this.sql `ALTER TABLE page_sentiment DROP CONSTRAINT IF EXISTS page_sentiment_page_id_dimension_id_key`;
        await this.sql `CREATE UNIQUE INDEX IF NOT EXISTS page_sentiment_page_dim_method_key ON page_sentiment (page_id, dimension_id, method_id)`;
        // Seed OCR run history from the legacy single-original column so existing
        // pages still show their original in the new history view. Idempotent: only
        // inserts for pages that have an original but no run yet.
        await this.sql `
      INSERT INTO page_ocr_runs (page_id, model, text, created_at)
      SELECT id, NULL, original_transcription, created_at FROM pages p
      WHERE original_transcription IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM page_ocr_runs r WHERE r.page_id = p.id)
    `;
    }
    // ---- Book helpers ----
    async upsertBook(driveFileId, driveFileName, title) {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
      INSERT INTO books (title, drive_file_id, drive_file_name, created_by)
      VALUES (${title}, ${driveFileId}, ${driveFileName}, ${createdBy})
      ON CONFLICT(drive_file_id) DO UPDATE SET
        drive_file_name = EXCLUDED.drive_file_name,
        updated_at = NOW()
      RETURNING *
    `;
        return coerceBook(rows[0]);
    }
    async setBookTitle(bookId, title) {
        await this.sql `UPDATE books SET title = ${title}, updated_at = NOW() WHERE id = ${bookId}`;
    }
    async getBookByDriveId(driveFileId) {
        const rows = await this.sql `
      SELECT * FROM books WHERE drive_file_id = ${driveFileId}
    `;
        return rows.length > 0 ? coerceBook(rows[0]) : undefined;
    }
    async getBookByName(name) {
        const rows = await this.sql `
      SELECT * FROM books WHERE drive_file_name = ${name} OR title = ${name} LIMIT 1
    `;
        return rows.length > 0 ? coerceBook(rows[0]) : undefined;
    }
    async getAllBooks() {
        const rows = await this.sql `
      SELECT * FROM books ORDER BY title
    `;
        return rows.map(coerceBook);
    }
    async updateBookStatus(bookId, status, pageCount) {
        if (pageCount !== undefined) {
            await this.sql `
        UPDATE books SET status = ${status}, page_count = ${pageCount}, updated_at = NOW()
        WHERE id = ${bookId}
      `;
        }
        else {
            await this.sql `
        UPDATE books SET status = ${status}, updated_at = NOW()
        WHERE id = ${bookId}
      `;
        }
    }
    async setBookQuality(bookId, quality, note) {
        await this.sql `
      UPDATE books SET ocr_quality = ${quality}, ocr_quality_note = ${note} WHERE id = ${bookId}
    `;
    }
    // ---- Page helpers ----
    async upsertPage(bookId, pageNumber, transcription, batchCustomId) {
        const hasIllustration = transcription.trim() === '[ILLUSTRATION]';
        const status = 'complete';
        const createdBy = process.env.APP_USER_ID ?? null;
        const batchId = batchCustomId ?? null;
        await this.sql `
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
    async updatePageTranscription(bookId, pageNumber, transcription, markEdited = true) {
        const result = markEdited
            ? await this.sql `
          UPDATE pages
          SET transcription = ${transcription}, is_edited = TRUE,
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = NOW()
          WHERE book_id = ${bookId} AND page_number = ${pageNumber}
        `
            : await this.sql `
          UPDATE pages
          SET transcription = ${transcription}, is_edited = FALSE,
              original_transcription = COALESCE(original_transcription, ${transcription}),
              ocr_quality = NULL, ocr_quality_reason = NULL,
              updated_at = NOW()
          WHERE book_id = ${bookId} AND page_number = ${pageNumber}
        `;
        return result.count > 0;
    }
    async getPages(bookId, pageStart, pageEnd) {
        let rows;
        if (pageStart !== undefined && pageEnd !== undefined) {
            rows = await this.sql `
        SELECT * FROM pages
        WHERE book_id = ${bookId} AND page_number BETWEEN ${pageStart} AND ${pageEnd}
        ORDER BY page_number
      `;
        }
        else if (pageStart !== undefined) {
            rows = await this.sql `
        SELECT * FROM pages
        WHERE book_id = ${bookId} AND page_number >= ${pageStart}
        ORDER BY page_number
      `;
        }
        else {
            rows = await this.sql `
        SELECT * FROM pages WHERE book_id = ${bookId} ORDER BY page_number
      `;
        }
        return rows.map(coercePage);
    }
    async getPageByCustomId(batchCustomId) {
        const rows = await this.sql `
      SELECT * FROM pages WHERE batch_custom_id = ${batchCustomId}
    `;
        return rows.length > 0 ? coercePage(rows[0]) : undefined;
    }
    async setPageTags(bookId, pageNumber, tags) {
        const result = await this.sql `
      UPDATE pages SET tags = ${this.sql.json(tags)}, updated_at = NOW()
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return result.count > 0;
    }
    async getAllTags() {
        // tags is JSONB; expand each page's array to rows and dedupe.
        const rows = await this.sql `
      SELECT DISTINCT t AS tag
      FROM pages, jsonb_array_elements_text(pages.tags) AS t
      WHERE jsonb_typeof(pages.tags) = 'array'
    `;
        return rows
            .map((r) => r.tag.trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
    async setPageQuality(bookId, pageNumber, quality, reason) {
        const result = await this.sql `
      UPDATE pages SET ocr_quality = ${quality}, ocr_quality_reason = ${reason}
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return result.count > 0;
    }
    async setPageIllustration(bookId, pageNumber, isIllustration) {
        const result = await this.sql `
      UPDATE pages SET has_illustration = ${isIllustration}, updated_at = NOW()
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return result.count > 0;
    }
    async hasExistingTranscription(bookId, pageNumber) {
        const rows = await this.sql `
      SELECT transcription FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return rows.length > 0 && rows[0].transcription != null && rows[0].transcription !== '';
    }
    // ---- Batch job helpers ----
    async createBatchJob(batchId, bookIds, kind = 'ocr') {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
      INSERT INTO batch_jobs (batch_id, book_ids, kind, created_by)
      VALUES (${batchId}, ${this.sql.json(bookIds)}, ${kind}, ${createdBy})
      RETURNING *
    `;
        return coerceBatchJob(rows[0]);
    }
    async getBatchJob(batchId) {
        const rows = await this.sql `
      SELECT * FROM batch_jobs WHERE batch_id = ${batchId}
    `;
        return rows.length > 0 ? coerceBatchJob(rows[0]) : undefined;
    }
    async updateBatchJobStatus(batchId, status) {
        await this.sql `
      UPDATE batch_jobs
      SET status = ${status},
          completed_at = CASE WHEN ${status} = 'complete' THEN NOW() ELSE completed_at END
      WHERE batch_id = ${batchId}
    `;
    }
    async getInProgressBatchJobs() {
        const rows = await this.sql `
      SELECT * FROM batch_jobs WHERE status = 'in_progress'
    `;
        return rows.map(coerceBatchJob);
    }
    // ---- Dimension helpers ----
    async getRecentBatchJobs(kind, limit) {
        const rows = await this.sql `
      SELECT * FROM batch_jobs WHERE kind = ${kind}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
        return rows.map(coerceBatchJob);
    }
    async createDimension(name, description, minLabel, maxLabel) {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
      INSERT INTO dimensions (name, description, min_label, max_label, created_by)
      VALUES (${name}, ${description}, ${minLabel}, ${maxLabel}, ${createdBy})
      RETURNING *
    `;
        return coerceDimension(rows[0]);
    }
    async getDimensionByName(name) {
        const rows = await this.sql `
      SELECT * FROM dimensions WHERE name = ${name}
    `;
        return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
    }
    async getAllDimensions() {
        const rows = await this.sql `
      SELECT * FROM dimensions ORDER BY name
    `;
        return rows.map(coerceDimension);
    }
    async updateDimension(id, fields) {
        const setFields = { updated_at: new Date() };
        if (fields.description !== undefined)
            setFields['description'] = fields.description;
        if (fields.minLabel !== undefined)
            setFields['min_label'] = fields.minLabel;
        if (fields.maxLabel !== undefined)
            setFields['max_label'] = fields.maxLabel;
        // If only updated_at, nothing meaningful to update — just return current row
        if (Object.keys(setFields).length === 1) {
            const rows = await this.sql `SELECT * FROM dimensions WHERE id = ${id}`;
            return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
        }
        const rows = await this.sql `
      UPDATE dimensions
      SET ${this.sql(setFields)}
      WHERE id = ${id}
      RETURNING *
    `;
        return rows.length > 0 ? coerceDimension(rows[0]) : undefined;
    }
    async deleteDimension(id) {
        const result = await this.sql `
      DELETE FROM dimensions WHERE id = ${id}
    `;
        return result.count > 0;
    }
    // ---- Scoring method + lexicon helpers ----
    async createMethod(name, kind, config) {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
      INSERT INTO methods (name, kind, config, created_by)
      VALUES (${name}, ${kind}, ${config}, ${createdBy})
      RETURNING *
    `;
        return coerceMethod(rows[0]);
    }
    async getMethodByName(name) {
        const rows = await this.sql `SELECT * FROM methods WHERE name = ${name}`;
        return rows.length > 0 ? coerceMethod(rows[0]) : undefined;
    }
    async getAllMethods() {
        const rows = await this.sql `SELECT * FROM methods ORDER BY name`;
        return rows.map(coerceMethod);
    }
    async deleteMethod(id) {
        const result = await this.sql `DELETE FROM methods WHERE id = ${id}`;
        return result.count > 0;
    }
    async createLexicon(name, scaleMin, scaleMax, note) {
        const rows = await this.sql `
      INSERT INTO lexicons (name, scale_min, scale_max, note)
      VALUES (${name}, ${scaleMin}, ${scaleMax}, ${note})
      RETURNING *
    `;
        return coerceLexicon(rows[0]);
    }
    async getLexiconByName(name) {
        const rows = await this.sql `SELECT * FROM lexicons WHERE name = ${name}`;
        return rows.length > 0 ? coerceLexicon(rows[0]) : undefined;
    }
    async getAllLexicons() {
        const rows = await this.sql `
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
    async deleteLexicon(id) {
        // Methods bound to this lexicon would be left dangling — drop them (and, by
        // cascade, the scores they produced) alongside the lexicon's terms.
        await this.sql `
      DELETE FROM methods
       WHERE kind = 'lexicon' AND (config::jsonb ->> 'lexicon_id')::int = ${id}
    `;
        const result = await this.sql `DELETE FROM lexicons WHERE id = ${id}`;
        return result.count > 0;
    }
    async insertLexiconTerms(terms) {
        // Published dictionaries repeat terms — AFINN-es lists 332 twice, with
        // different scores. Postgres rejects an ON CONFLICT DO UPDATE that would
        // touch the same row twice in one statement ("cannot affect row a second
        // time"), which aborts the insert and leaves the lexicon half-loaded. Dedupe
        // first, last occurrence winning, which is what SQLite's row-by-row upsert
        // does anyway — so both adapters store the same thing.
        const byKey = new Map();
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
            await this.sql `
        INSERT INTO lexicon_terms ${this.sql(chunk, 'lexicon_id', 'dimension_id', 'term', 'value')}
        ON CONFLICT (lexicon_id, dimension_id, term) DO UPDATE SET value = EXCLUDED.value
      `;
            inserted += chunk.length;
        }
        return inserted;
    }
    async getLexiconTerms(lexiconId, dimensionId) {
        const rows = await this.sql `
      SELECT lexicon_id, dimension_id, term, value FROM lexicon_terms
      WHERE lexicon_id = ${lexiconId} AND dimension_id = ${dimensionId}
    `;
        return rows.map((r) => ({ lexicon_id: r.lexicon_id, dimension_id: r.dimension_id, term: r.term, value: r.value }));
    }
    // ---- Page sentiment helpers ----
    async upsertPageSentiment(pageId, dimensionId, methodId, score, rationale, model) {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
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
    async getPageSentiment(pageId) {
        const rows = await this.sql `
      SELECT * FROM page_sentiment WHERE page_id = ${pageId} ORDER BY dimension_id
    `;
        return rows.map(coercePageSentiment);
    }
    async getBookSentiment(bookId, dimensionIds, pageStart, pageEnd) {
        let rows;
        if (dimensionIds && dimensionIds.length > 0 && pageStart !== undefined && pageEnd !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number >= ${pageStart}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (dimensionIds && dimensionIds.length > 0 && pageStart !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number >= ${pageStart}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (dimensionIds && dimensionIds.length > 0 && pageEnd !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (dimensionIds && dimensionIds.length > 0) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${dimensionIds}::int[])
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (pageStart !== undefined && pageEnd !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number >= ${pageStart}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (pageStart !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number >= ${pageStart}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else if (pageEnd !== undefined) {
            rows = await this.sql `
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
        }
        else {
            rows = await this.sql `
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
    async getSentimentScores(bookIds, dimensionIds, methodIds) {
        if (bookIds.length === 0)
            return [];
        // NULL means "no filter", which keeps this one static query instead of
        // stitching sql fragments together — see the note on ANY() casts below.
        const dims = dimensionIds && dimensionIds.length > 0 ? dimensionIds : null;
        const methods = methodIds && methodIds.length > 0 ? methodIds : null;
        const rows = await this.sql `
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
            tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t).trim()).filter(Boolean) : [],
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
    async getPageImage(bookId, pageNumber) {
        const rows = await this.sql `
      SELECT image_data FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return rows.length > 0 ? rows[0].image_data : null;
    }
    async setPageImage(bookId, pageNumber, imageData) {
        await this.sql `
      INSERT INTO page_images (book_id, page_number, image_data)
      VALUES (${bookId}, ${pageNumber}, ${imageData})
      ON CONFLICT (book_id, page_number) DO UPDATE SET image_data = EXCLUDED.image_data
    `;
    }
    async getPageImageKey(bookId, pageNumber) {
        const rows = await this.sql `
      SELECT object_key FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
        return rows.length > 0 ? rows[0].object_key : null;
    }
    async setPageImageKey(bookId, pageNumber, objectKey) {
        await this.sql `
      INSERT INTO page_images (book_id, page_number, image_data, object_key)
      VALUES (${bookId}, ${pageNumber}, '', ${objectKey})
      ON CONFLICT (book_id, page_number) DO UPDATE SET object_key = EXCLUDED.object_key, image_data = ''
    `;
    }
    async cachePageImages(bookId, images) {
        if (images.length === 0)
            return;
        for (const img of images) {
            await this.sql `
        INSERT INTO page_images (book_id, page_number, image_data)
        VALUES (${bookId}, ${img.pageNumber}, ${img.imageData})
        ON CONFLICT (book_id, page_number) DO UPDATE SET image_data = EXCLUDED.image_data
      `;
        }
    }
    async hasAnyPageImage(bookId) {
        const rows = await this.sql `
      SELECT EXISTS (SELECT 1 FROM page_images WHERE book_id = ${bookId} LIMIT 1) AS exists
    `;
        return rows.length > 0 && rows[0].exists;
    }
    async deletePage(bookId, pageNumber) {
        await this.sql `DELETE FROM page_ocr_runs WHERE page_id IN (SELECT id FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber})`;
        const result = await this.sql `DELETE FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber}`;
        if (result.count === 0)
            return false;
        await this.sql `DELETE FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}`;
        // Use negative intermediary to avoid UNIQUE constraint violations during renumber
        await this.sql `UPDATE pages SET page_number = -(page_number - 1) WHERE book_id = ${bookId} AND page_number > ${pageNumber}`;
        await this.sql `UPDATE pages SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
        await this.sql `UPDATE page_images SET page_number = -(page_number - 1) WHERE book_id = ${bookId} AND page_number > ${pageNumber}`;
        await this.sql `UPDATE page_images SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
        return true;
    }
    async insertPageAfter(bookId, afterPageNumber) {
        const newPageNumber = afterPageNumber + 1;
        // Use negative intermediary to avoid UNIQUE constraint violations during renumber
        await this.sql `UPDATE pages SET page_number = -(page_number + 1) WHERE book_id = ${bookId} AND page_number >= ${newPageNumber}`;
        await this.sql `UPDATE pages SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
        await this.sql `UPDATE page_images SET page_number = -(page_number + 1) WHERE book_id = ${bookId} AND page_number >= ${newPageNumber}`;
        await this.sql `UPDATE page_images SET page_number = -page_number WHERE book_id = ${bookId} AND page_number < 0`;
        await this.sql `INSERT INTO pages (book_id, page_number, transcription, status) VALUES (${bookId}, ${newPageNumber}, NULL, 'pending')`;
        const rows = await this.sql `SELECT * FROM pages WHERE book_id = ${bookId} AND page_number = ${newPageNumber}`;
        return rows[0];
    }
    async recordOcrRun(bookId, pageNumber, model, text) {
        const createdBy = process.env.APP_USER_ID ?? null;
        const rows = await this.sql `
      INSERT INTO page_ocr_runs (page_id, model, text, created_by)
      SELECT id, ${model}, ${text}, ${createdBy} FROM pages
      WHERE book_id = ${bookId} AND page_number = ${pageNumber}
      RETURNING *
    `;
        if (rows.length === 0)
            throw new Error(`Page ${pageNumber} not found for book ${bookId}`);
        return coerceOcrRun(rows[0]);
    }
    async getOcrRuns(bookId, pageNumber) {
        const rows = await this.sql `
      SELECT r.* FROM page_ocr_runs r
      JOIN pages p ON p.id = r.page_id
      WHERE p.book_id = ${bookId} AND p.page_number = ${pageNumber}
      ORDER BY r.created_at, r.id
    `;
        return rows.map(coerceOcrRun);
    }
}
export async function createPostgresAdapter() {
    let sql;
    const sharedOptions = {
        // Redirect Postgres notices to stderr — default is console.log which corrupts MCP stdio
        onnotice: (notice) => process.stderr.write(`[OCR MCP] Postgres: ${notice.message}\n`),
    };
    if (process.env.DATABASE_URL) {
        sql = postgres(process.env.DATABASE_URL, sharedOptions);
    }
    else {
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
