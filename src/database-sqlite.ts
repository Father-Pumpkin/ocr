import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow } from './database-adapter.js';

// SQLite raw row types (booleans stored as 0/1 integers)
interface SqlitePageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
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
        created_by      TEXT,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(id),
        page_number      INTEGER NOT NULL,
        transcription    TEXT,
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
        status       TEXT DEFAULT 'in_progress',
        created_by   TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
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
  }

  // ---- Book helpers ----

  async upsertBook(driveFileId: string, driveFileName: string, title: string): Promise<BookRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO books (title, drive_file_id, drive_file_name, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(drive_file_id) DO UPDATE SET
        title = excluded.title,
        drive_file_name = excluded.drive_file_name,
        updated_at = CURRENT_TIMESTAMP
    `).run(title, driveFileId, driveFileName, createdBy);

    return Promise.resolve(
      this.db.prepare('SELECT * FROM books WHERE drive_file_id = ?').get(driveFileId) as BookRow
    );
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

  // ---- Page helpers ----

  async upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void> {
    const hasIllustration = transcription.trim() === '[ILLUSTRATION]' ? 1 : 0;
    const status = 'complete';
    const createdBy = process.env.APP_USER_ID ?? null;

    this.db.prepare(`
      INSERT INTO pages (book_id, page_number, transcription, has_illustration, status, batch_custom_id, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(book_id, page_number) DO UPDATE SET
        transcription    = excluded.transcription,
        has_illustration = excluded.has_illustration,
        status           = excluded.status,
        batch_custom_id  = excluded.batch_custom_id,
        updated_at       = CURRENT_TIMESTAMP
    `).run(bookId, pageNumber, transcription, hasIllustration, status, batchCustomId ?? null, createdBy);

    return Promise.resolve();
  }

  async updatePageTranscription(bookId: number, pageNumber: number, transcription: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE pages
      SET transcription = ?, is_edited = 1, updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ? AND page_number = ?
    `).run(transcription, bookId, pageNumber);
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

  async hasExistingTranscription(bookId: number, pageNumber: number): Promise<boolean> {
    const row = this.db.prepare('SELECT transcription FROM pages WHERE book_id = ? AND page_number = ?').get(bookId, pageNumber) as { transcription: string | null } | undefined;
    return Promise.resolve(!!(row?.transcription));
  }

  // ---- Batch job helpers ----

  async createBatchJob(batchId: string, bookIds: number[]): Promise<BatchJobRow> {
    const createdBy = process.env.APP_USER_ID ?? null;
    this.db.prepare(`
      INSERT INTO batch_jobs (batch_id, book_ids, created_by) VALUES (?, ?, ?)
    `).run(batchId, JSON.stringify(bookIds), createdBy);

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
}
