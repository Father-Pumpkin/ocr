/**
 * One-time migration: SQLite → Postgres
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-sqlite-to-postgres.ts
 *   DATABASE_URL=postgres://... DATABASE_PATH=./data/books.db npx tsx scripts/migrate-sqlite-to-postgres.ts
 */

import Database from 'better-sqlite3';
import postgres from 'postgres';
import path from 'path';
import os from 'os';

const sqlitePath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL must be set.');
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const sql = postgres(databaseUrl, { ssl: 'require' });

// ---- Read all SQLite data ----

const books = sqlite.prepare('SELECT * FROM books ORDER BY id').all() as any[];
const pages = sqlite.prepare('SELECT * FROM pages ORDER BY id').all() as any[];
const batchJobs = sqlite.prepare('SELECT * FROM batch_jobs ORDER BY id').all() as any[];

// dimensions and page_sentiment may not exist in older DBs
let dimensions: any[] = [];
let pageSentiments: any[] = [];
try {
  dimensions = sqlite.prepare('SELECT * FROM dimensions ORDER BY id').all() as any[];
  pageSentiments = sqlite.prepare('SELECT * FROM page_sentiment ORDER BY id').all() as any[];
} catch {
  // Tables don't exist in this SQLite DB yet — skip gracefully
}

console.log(`Found: ${books.length} books, ${pages.length} pages, ${batchJobs.length} batch jobs, ${dimensions.length} dimensions, ${pageSentiments.length} page sentiment rows`);

if (books.length === 0) {
  console.log('Nothing to migrate.');
  sqlite.close();
  await sql.end();
  process.exit(0);
}

// ---- Create schema ----

console.log('Creating schema...');
await sql`
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
await sql`
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
await sql`
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
await sql`
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
await sql`
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
console.log('Schema ready.');

// ---- Migrate books (preserve IDs so pages foreign keys stay valid) ----

console.log('\nMigrating books...');
for (const book of books) {
  await sql`
    INSERT INTO books (id, title, drive_file_id, drive_file_name, page_count, status, created_by, created_at, updated_at)
    OVERRIDING SYSTEM VALUE
    VALUES (
      ${book.id},
      ${book.title},
      ${book.drive_file_id},
      ${book.drive_file_name},
      ${book.page_count ?? null},
      ${book.status},
      ${book.created_by ?? null},
      ${book.created_at},
      ${book.updated_at}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  process.stdout.write(`.`);
}

// Reset the books sequence so future inserts don't collide
await sql`SELECT setval('books_id_seq', (SELECT MAX(id) FROM books))`;
console.log(' done');

// ---- Migrate pages ----

console.log('\nMigrating pages...');
for (const page of pages) {
  await sql`
    INSERT INTO pages (id, book_id, page_number, transcription, has_illustration, is_edited, status, batch_custom_id, tags, created_by, created_at, updated_at)
    OVERRIDING SYSTEM VALUE
    VALUES (
      ${page.id},
      ${page.book_id},
      ${page.page_number},
      ${page.transcription ?? null},
      ${page.has_illustration === 1},
      ${page.is_edited === 1},
      ${page.status},
      ${page.batch_custom_id ?? null},
      ${sql.json(JSON.parse(page.tags ?? '[]'))},
      ${page.created_by ?? null},
      ${page.created_at},
      ${page.updated_at}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  process.stdout.write(`.`);
}

await sql`SELECT setval('pages_id_seq', (SELECT MAX(id) FROM pages))`;
console.log(' done');

// ---- Migrate batch jobs ----

if (batchJobs.length > 0) {
  console.log('\nMigrating batch jobs...');
  for (const job of batchJobs) {
    await sql`
      INSERT INTO batch_jobs (id, batch_id, book_ids, status, created_by, created_at, completed_at)
      OVERRIDING SYSTEM VALUE
      VALUES (
        ${job.id},
        ${job.batch_id},
        ${sql.json(JSON.parse(job.book_ids ?? '[]'))},
        ${job.status},
        ${job.created_by ?? null},
        ${job.created_at},
        ${job.completed_at ?? null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    process.stdout.write(`.`);
  }
  await sql`SELECT setval('batch_jobs_id_seq', (SELECT MAX(id) FROM batch_jobs))`;
  console.log(' done');
}

// ---- Migrate dimensions ----

if (dimensions.length > 0) {
  console.log('\nMigrating dimensions...');
  for (const dim of dimensions) {
    await sql`
      INSERT INTO dimensions (id, name, description, min_label, max_label, created_by, created_at, updated_at)
      OVERRIDING SYSTEM VALUE
      VALUES (
        ${dim.id},
        ${dim.name},
        ${dim.description},
        ${dim.min_label},
        ${dim.max_label},
        ${dim.created_by ?? null},
        ${dim.created_at},
        ${dim.updated_at}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    process.stdout.write(`.`);
  }
  await sql`SELECT setval('dimensions_id_seq', (SELECT MAX(id) FROM dimensions))`;
  console.log(' done');
} else {
  console.log('\nNo dimensions to migrate — skipping.');
}

// ---- Migrate page_sentiment ----

if (pageSentiments.length > 0) {
  console.log('\nMigrating page sentiment rows...');
  for (const ps of pageSentiments) {
    await sql`
      INSERT INTO page_sentiment (id, page_id, dimension_id, score, rationale, model, created_by, created_at)
      OVERRIDING SYSTEM VALUE
      VALUES (
        ${ps.id},
        ${ps.page_id},
        ${ps.dimension_id},
        ${ps.score},
        ${ps.rationale ?? null},
        ${ps.model ?? null},
        ${ps.created_by ?? null},
        ${ps.created_at}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    process.stdout.write(`.`);
  }
  await sql`SELECT setval('page_sentiment_id_seq', (SELECT MAX(id) FROM page_sentiment))`;
  console.log(' done');
} else {
  console.log('\nNo page sentiment rows to migrate — skipping.');
}

sqlite.close();
await sql.end();

console.log('\nMigration complete.');
