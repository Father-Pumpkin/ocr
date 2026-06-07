#!/usr/bin/env node
/**
 * Re-OCR every page currently flagged 'suspect' on Opus, via the Batch API
 * (50% cheaper). Bundles just the flagged page images into one batch, then
 * polls and processes (re-store + re-grade) as it finishes. Skips hand-edited
 * pages. Resumable: the batch id is saved to .suspects-batch.json, so re-running
 * after an interruption continues the same batch instead of resubmitting.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/reocr-suspects.ts
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const STATE_FILE = path.join(ROOT, '.suspects-batch.json');
const MODEL = 'claude-opus-4-6';

const { getAllBooks, getPages } = await import('../src/core/database.js');
const { getPageImageData } = await import('../src/core/book-service.js');
const { createPageImageBatch, processPageImageBatch } = await import('../src/core/ocr.js');

const log = (m: string) => process.stderr.write(m + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collectAndSubmit(): Promise<string | null> {
  const books = await getAllBooks();
  const items: { bookId: number; pageNumber: number; imageBase64: string }[] = [];
  for (const book of books) {
    const pages = await getPages(book.id);
    for (const p of pages) {
      if (p.ocr_quality !== 'suspect' || p.is_edited) continue;
      try {
        const { imageData } = await getPageImageData(book.title, p.page_number);
        if (imageData) items.push({ bookId: book.id, pageNumber: p.page_number, imageBase64: imageData });
        else log(`  skip ${book.title} p${p.page_number}: no cached image`);
      } catch (err) {
        log(`  skip ${book.title} p${p.page_number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (items.length === 0) {
    log('No suspect pages with images to re-OCR.');
    return null;
  }
  log(`Submitting ${items.length} flagged page(s) to an Opus batch...`);
  const batchId = await createPageImageBatch(items, MODEL);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ batchId, count: items.length }, null, 2));
  log(`Batch ${batchId} submitted (state saved).`);
  return batchId;
}

async function main(): Promise<void> {
  let batchId: string | null;
  if (fs.existsSync(STATE_FILE)) {
    batchId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).batchId;
    log(`Resuming existing batch ${batchId}`);
  } else {
    batchId = await collectAndSubmit();
    if (!batchId) return;
  }

  for (;;) {
    const r = await processPageImageBatch(batchId);
    if (r.status !== 'ended') {
      log(`Batch ${r.status}; checking again in 4 min...`);
      await sleep(4 * 60 * 1000);
      continue;
    }
    log(`\nDone. cleared=${r.cleared}  still-suspect=${r.stillSuspect}  errored=${r.errored}`);
    fs.unlinkSync(STATE_FILE);
    break;
  }
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
