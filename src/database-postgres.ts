import postgres from 'postgres';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow } from './database-adapter.js';

// Raw Postgres row types (dates come back as Date objects from the driver)
interface PgBookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgPageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  has_illustration: boolean;
  is_edited: boolean;
  status: string;
  batch_custom_id: string | null;
  tags: unknown; // JSONB — comes back as parsed JS value
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgBatchJobRow {
  id: number;
  batch_id: string;
  book_ids: unknown; // JSONB — comes back as parsed JS value
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
  score: number;
  rationale: string | null;
  model: string | null;
  created_by: string | null;
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
      CREATE TABLE IF NOT EXISTS page_sentiment (
        id           SERIAL PRIMARY KEY,
        page_id      INTEGER NOT NULL REFERENCES pages(id),
        dimension_id INTEGER NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
        score        FLOAT NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
        rationale    TEXT,
        model        TEXT,
        created_by   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(page_id, dimension_id)
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
  }

  // ---- Book helpers ----

  async upsertBook(driveFileId: string, driveFileName: string, title: string): Promise<BookRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgBookRow[]>`
      INSERT INTO books (title, drive_file_id, drive_file_name, created_by)
      VALUES (${title}, ${driveFileId}, ${driveFileName}, ${createdBy})
      ON CONFLICT(drive_file_id) DO UPDATE SET
        title = EXCLUDED.title,
        drive_file_name = EXCLUDED.drive_file_name,
        updated_at = NOW()
      RETURNING *
    `;
    return coerceBook(rows[0]);
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

  // ---- Page helpers ----

  async upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void> {
    const hasIllustration = transcription.trim() === '[ILLUSTRATION]';
    const status = 'complete';
    const createdBy = process.env.APP_USER_ID ?? null;
    const batchId = batchCustomId ?? null;

    await this.sql`
      INSERT INTO pages (book_id, page_number, transcription, has_illustration, status, batch_custom_id, created_by, updated_at)
      VALUES (${bookId}, ${pageNumber}, ${transcription}, ${hasIllustration}, ${status}, ${batchId}, ${createdBy}, NOW())
      ON CONFLICT(book_id, page_number) DO UPDATE SET
        transcription    = EXCLUDED.transcription,
        has_illustration = EXCLUDED.has_illustration,
        status           = EXCLUDED.status,
        batch_custom_id  = EXCLUDED.batch_custom_id,
        updated_at       = NOW()
    `;
  }

  async updatePageTranscription(bookId: number, pageNumber: number, transcription: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE pages
      SET transcription = ${transcription}, is_edited = TRUE, updated_at = NOW()
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

  async hasExistingTranscription(bookId: number, pageNumber: number): Promise<boolean> {
    const rows = await this.sql<{ transcription: string | null }[]>`
      SELECT transcription FROM pages WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return rows.length > 0 && rows[0].transcription != null && rows[0].transcription !== '';
  }

  // ---- Batch job helpers ----

  async createBatchJob(batchId: string, bookIds: number[]): Promise<BatchJobRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgBatchJobRow[]>`
      INSERT INTO batch_jobs (batch_id, book_ids, created_by)
      VALUES (${batchId}, ${this.sql.json(bookIds)}, ${createdBy})
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

  // ---- Page sentiment helpers ----

  async upsertPageSentiment(pageId: number, dimensionId: number, score: number, rationale: string | null, model: string | null): Promise<PageSentimentRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    const rows = await this.sql<PgPageSentimentRow[]>`
      INSERT INTO page_sentiment (page_id, dimension_id, score, rationale, model, created_by)
      VALUES (${pageId}, ${dimensionId}, ${score}, ${rationale}, ${model}, ${createdBy})
      ON CONFLICT(page_id, dimension_id) DO UPDATE SET
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
          AND page_sentiment.dimension_id = ANY(${this.sql.array(dimensionIds)})
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
          AND page_sentiment.dimension_id = ANY(${this.sql.array(dimensionIds)})
          AND pages.page_number >= ${pageStart}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (dimensionIds && dimensionIds.length > 0 && pageEnd !== undefined) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${this.sql.array(dimensionIds)})
          AND pages.page_number <= ${pageEnd}
        ORDER BY pages.page_number, page_sentiment.dimension_id
      `;
    } else if (dimensionIds && dimensionIds.length > 0) {
      rows = await this.sql<PgPageSentimentRow[]>`
        SELECT page_sentiment.*
        FROM page_sentiment
        JOIN pages ON page_sentiment.page_id = pages.id
        WHERE pages.book_id = ${bookId}
          AND page_sentiment.dimension_id = ANY(${this.sql.array(dimensionIds)})
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

  // ---- Page image helpers ----

  async getPageImage(bookId: number, pageNumber: number): Promise<string | null> {
    const rows = await this.sql<{ image_data: string }[]>`
      SELECT image_data FROM page_images WHERE book_id = ${bookId} AND page_number = ${pageNumber}
    `;
    return rows.length > 0 ? rows[0].image_data : null;
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
