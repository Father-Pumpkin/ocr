#!/usr/bin/env node
/**
 * Recase every book's display title to proper Spanish sentence case, and the
 * title where it appears on the title page's OCR text. Verbatim OCR is kept in
 * original_transcription; recased title pages are marked edited so a future
 * re-transcribe won't clobber them. Paced by the shared verifier rate limiter.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/title-case-pass.ts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks, getPages, setBookTitle, updatePageTranscription } = await import('../src/core/database.js');
const { recaseTitle } = await import('../src/core/ocr.js');

const log = (m: string) => process.stderr.write(m + '\n');

async function main(): Promise<void> {
  const books = (await getAllBooks()).filter((b) => b.status === 'complete');
  log(`Recasing ${books.length} book title(s)...`);

  let titleChanges = 0;
  let pageChanges = 0;
  for (const book of books) {
    const pages = await getPages(book.id);
    const titlePage = pages.find((p) => {
      const t = (p.transcription ?? '').trim();
      return !p.has_illustration && !p.is_edited && t.length > 0 && t !== '[ILLUSTRATION]';
    });

    let result;
    try {
      result = await recaseTitle(book.title, titlePage?.transcription ?? null);
    } catch (err) {
      log(`  ${book.title}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (result.title && result.title !== book.title) {
      await setBookTitle(book.id, result.title);
      titleChanges++;
      log(`  "${book.title}" → "${result.title}"`);
    }
    if (result.pageText && titlePage && result.pageText !== titlePage.transcription) {
      await updatePageTranscription(book.id, titlePage.page_number, result.pageText, true);
      pageChanges++;
      log(`     ↳ recased title text on p${titlePage.page_number}`);
    }
  }

  log(`\nDone. ${titleChanges} title(s) recased, ${pageChanges} title-page(s) updated.`);
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
