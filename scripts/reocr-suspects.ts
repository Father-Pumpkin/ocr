#!/usr/bin/env node
/**
 * Re-OCR every page currently flagged 'suspect' on Opus, then re-grade it.
 * Skips hand-edited pages. Sequential (one page at a time) so it stays well
 * under the per-minute rate limit.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/reocr-suspects.ts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { getAllBooks, getPages } = await import('../src/core/database.js');
const { retranscribePageData } = await import('../src/core/book-service.js');

const MODEL = 'claude-opus-4-6';
const log = (m: string) => process.stderr.write(m + '\n');

async function main(): Promise<void> {
  const books = await getAllBooks();
  // Collect suspect, non-edited pages across the whole library.
  const targets: { title: string; page: number }[] = [];
  for (const book of books) {
    const pages = await getPages(book.id);
    for (const p of pages) {
      if (p.ocr_quality === 'suspect' && !p.is_edited) targets.push({ title: book.title, page: p.page_number });
    }
  }
  log(`${targets.length} suspect page(s) to re-OCR on Opus.`);

  let cleared = 0;
  let stillFlagged = 0;
  let errored = 0;
  for (const t of targets) {
    try {
      const updated = await retranscribePageData(t.title, t.page, MODEL);
      if (updated.ocr_quality === 'suspect') {
        stillFlagged++;
        log(`  ${t.title} p${t.page}: still suspect — ${updated.ocr_quality_reason ?? ''}`);
      } else {
        cleared++;
        log(`  ${t.title} p${t.page}: ✓ cleared`);
      }
    } catch (err) {
      errored++;
      log(`  ${t.title} p${t.page}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`\nDone. cleared=${cleared}  still-suspect=${stillFlagged}  errored=${errored}`);
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
