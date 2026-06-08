#!/usr/bin/env node
/** List every page still flagged ocr_quality='suspect', with its reason. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks, getPages } = await import('../src/core/database.js');
const log = (m: string) => process.stderr.write(m + '\n');

const books = await getAllBooks();
let n = 0;
for (const book of books) {
  const pages = await getPages(book.id);
  for (const p of pages) {
    if (p.ocr_quality !== 'suspect' || p.is_edited) continue;
    n++;
    const reason = (p.ocr_quality_reason ?? '').replace(/\s+/g, ' ').trim();
    log(`${n}. ${book.title} — p${p.page_number}: ${reason || '(no reason)'}`);
  }
}
log(`\nTotal still-suspect (unedited): ${n}`);
