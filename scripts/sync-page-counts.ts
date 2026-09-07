#!/usr/bin/env node
/**
 * Recompute books.page_count from the page rows.
 *
 *   npx tsx scripts/sync-page-counts.ts          # report only
 *   npx tsx scripts/sync-page-counts.ts --write  # apply
 *
 * page_count was written once, at ingestion, from the PDF's page count. But each
 * PDF page is a two-page spread that gets split afterwards, and pages can be
 * inserted or deleted later, so the stored number drifted from the truth — the
 * library and the analysis book picker were showing it. Going forward it is kept
 * in step by syncBookPageCount (called on transcribe, insert, delete and split);
 * this is the one-off correction for rows written before that existed.
 *
 * Only completed books are touched: one mid-transcription has a page count that
 * is legitimately still growing.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
  const val = process.env[key];
  if (val && !path.isAbsolute(val)) process.env[key] = path.resolve(process.cwd(), val);
}

const write = process.argv.includes('--write');

const { getAllBooks, getPages, syncBookPageCount } = await import('../src/core/database.js');

const books = await getAllBooks();
const drifted: Array<{ title: string; stored: number | null; actual: number }> = [];

for (const book of books) {
  if (book.status !== 'complete') continue;
  const actual = (await getPages(book.id)).length;
  if (book.page_count !== actual) drifted.push({ title: book.title, stored: book.page_count, actual });
}

if (drifted.length === 0) {
  console.log(`All ${books.length} book(s) already report the right page count.`);
  process.exit(0);
}

console.log(`${drifted.length} of ${books.length} book(s) have a stale page_count:\n`);
for (const d of drifted.sort((a, b) => b.actual - (b.stored ?? 0) - (a.actual - (a.stored ?? 0)))) {
  const diff = d.actual - (d.stored ?? 0);
  console.log(`  ${d.title.padEnd(42)} ${String(d.stored ?? '—').padStart(4)} → ${String(d.actual).padStart(4)}  (${diff >= 0 ? '+' : ''}${diff})`);
}

if (!write) {
  console.log(`\nNothing written. Re-run with --write to apply.`);
  process.exit(0);
}

let fixed = 0;
for (const book of books) {
  if (book.status !== 'complete') continue;
  const actual = (await getPages(book.id)).length;
  if (book.page_count === actual) continue;
  await syncBookPageCount(book.id);
  fixed++;
}
console.log(`\nUpdated ${fixed} book(s).`);
process.exit(0);
