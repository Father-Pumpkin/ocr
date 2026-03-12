import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  const dbPath = path.resolve(
    process.cwd(),
    process.env.DATABASE_PATH ?? './data/books.db'
  );

  // Ensure the data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);
  runMigrations(db);

  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      drive_file_id   TEXT NOT NULL UNIQUE,
      drive_file_name TEXT NOT NULL,
      page_count      INTEGER,
      status          TEXT DEFAULT 'pending',
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
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(book_id, page_number)
    );

    CREATE TABLE IF NOT EXISTS batch_jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id     TEXT NOT NULL UNIQUE,
      book_ids     TEXT NOT NULL,
      status       TEXT DEFAULT 'in_progress',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
  `);
}

function runMigrations(db: Database.Database): void {
  // Add tags column if it doesn't exist (safe to run on existing DBs)
  try {
    db.exec(`ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    // Column already exists — no-op
  }
}

// ---- Book helpers ----

export interface BookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  has_illustration: number; // SQLite stores booleans as 0/1
  is_edited: number;
  status: string;
  batch_custom_id: string | null;
  tags: string; // JSON array of tag strings, e.g. '["climax","resolution"]'
  created_at: string;
  updated_at: string;
}

export interface BatchJobRow {
  id: number;
  batch_id: string;
  book_ids: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export function upsertBook(
  driveFileId: string,
  driveFileName: string,
  title: string
): BookRow {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO books (title, drive_file_id, drive_file_name)
    VALUES (?, ?, ?)
    ON CONFLICT(drive_file_id) DO UPDATE SET
      title = excluded.title,
      drive_file_name = excluded.drive_file_name,
      updated_at = CURRENT_TIMESTAMP
  `).run(title, driveFileId, driveFileName);

  return db.prepare('SELECT * FROM books WHERE drive_file_id = ?').get(driveFileId) as BookRow;
}

export function getBookByDriveId(driveFileId: string): BookRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM books WHERE drive_file_id = ?')
    .get(driveFileId) as BookRow | undefined;
}

export function getBookByName(name: string): BookRow | undefined {
  const db = getDatabase();
  // Try exact match on file name first, then title
  return (
    (db.prepare('SELECT * FROM books WHERE drive_file_name = ? OR title = ?').get(name, name) as BookRow | undefined)
  );
}

export function getAllBooks(): BookRow[] {
  return getDatabase().prepare('SELECT * FROM books ORDER BY title').all() as BookRow[];
}

export function updateBookStatus(bookId: number, status: string, pageCount?: number): void {
  const db = getDatabase();
  if (pageCount !== undefined) {
    db.prepare(`
      UPDATE books SET status = ?, page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, pageCount, bookId);
  } else {
    db.prepare(`
      UPDATE books SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, bookId);
  }
}

// ---- Page helpers ----

export function upsertPage(
  bookId: number,
  pageNumber: number,
  transcription: string,
  batchCustomId?: string
): void {
  const db = getDatabase();
  const hasIllustration = transcription.trim() === '[ILLUSTRATION]' ? 1 : 0;
  const status = 'complete';

  db.prepare(`
    INSERT INTO pages (book_id, page_number, transcription, has_illustration, status, batch_custom_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(book_id, page_number) DO UPDATE SET
      transcription    = excluded.transcription,
      has_illustration = excluded.has_illustration,
      status           = excluded.status,
      batch_custom_id  = excluded.batch_custom_id,
      updated_at       = CURRENT_TIMESTAMP
  `).run(bookId, pageNumber, transcription, hasIllustration, status, batchCustomId ?? null);
}

export function updatePageTranscription(
  bookId: number,
  pageNumber: number,
  transcription: string
): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE pages
    SET transcription = ?, is_edited = 1, updated_at = CURRENT_TIMESTAMP
    WHERE book_id = ? AND page_number = ?
  `).run(transcription, bookId, pageNumber);
  return result.changes > 0;
}

export function getPages(
  bookId: number,
  pageStart?: number,
  pageEnd?: number
): PageRow[] {
  const db = getDatabase();
  if (pageStart !== undefined && pageEnd !== undefined) {
    return db.prepare(`
      SELECT * FROM pages
      WHERE book_id = ? AND page_number BETWEEN ? AND ?
      ORDER BY page_number
    `).all(bookId, pageStart, pageEnd) as PageRow[];
  } else if (pageStart !== undefined) {
    return db.prepare(`
      SELECT * FROM pages
      WHERE book_id = ? AND page_number >= ?
      ORDER BY page_number
    `).all(bookId, pageStart) as PageRow[];
  } else {
    return db.prepare(`
      SELECT * FROM pages WHERE book_id = ? ORDER BY page_number
    `).all(bookId) as PageRow[];
  }
}

export function getPageByCustomId(batchCustomId: string): PageRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM pages WHERE batch_custom_id = ?')
    .get(batchCustomId) as PageRow | undefined;
}

export function setPageTags(bookId: number, pageNumber: number, tags: string[]): boolean {
  const result = getDatabase().prepare(`
    UPDATE pages SET tags = ?, updated_at = CURRENT_TIMESTAMP
    WHERE book_id = ? AND page_number = ?
  `).run(JSON.stringify(tags), bookId, pageNumber);
  return result.changes > 0;
}

export function hasExistingTranscription(bookId: number, pageNumber: number): boolean {
  const row = getDatabase()
    .prepare('SELECT transcription FROM pages WHERE book_id = ? AND page_number = ?')
    .get(bookId, pageNumber) as { transcription: string | null } | undefined;
  return !!(row?.transcription);
}

// ---- Batch job helpers ----

export function createBatchJob(batchId: string, bookIds: number[]): BatchJobRow {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO batch_jobs (batch_id, book_ids) VALUES (?, ?)
  `).run(batchId, JSON.stringify(bookIds));

  return db.prepare('SELECT * FROM batch_jobs WHERE batch_id = ?').get(batchId) as BatchJobRow;
}

export function getBatchJob(batchId: string): BatchJobRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM batch_jobs WHERE batch_id = ?')
    .get(batchId) as BatchJobRow | undefined;
}

export function updateBatchJobStatus(batchId: string, status: string): void {
  getDatabase().prepare(`
    UPDATE batch_jobs
    SET status = ?, completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE batch_id = ?
  `).run(status, status, batchId);
}
