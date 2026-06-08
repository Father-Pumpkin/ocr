#!/usr/bin/env node
/**
 * Re-transcribe every book in the Drive folder on Sonnet via the Batch API.
 * Manual edits are preserved (upsertPage skips is_edited rows). Auto-chunks by
 * PDF size to stay under the Anthropic batch size limit.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/retranscribe-all.ts          # submit
 *   RETRANSCRIBE_DRY=1 ... npx tsx scripts/retranscribe-all.ts          # preview only
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { listPdfsInFolder, downloadPdf } = await import('../src/core/google-drive.js');
const { upsertBook, updateBookStatus, createBatchJob } = await import('../src/core/database.js');
const { createOcrBatch } = await import('../src/core/ocr.js');

const MODEL = 'claude-sonnet-4-6';
const MAX_BATCH_BYTES = 150 * 1024 * 1024; // keep raw PDF per batch under ~150MB
const DRY = process.env.RETRANSCRIBE_DRY === '1';

const log = (m: string) => process.stderr.write(m + '\n');

async function main(): Promise<void> {
  const files = await listPdfsInFolder();
  const total = files.reduce((s, f) => s + parseInt(f.size ?? '0', 10), 0);
  log(`Found ${files.length} PDF(s), ${(total / 1_048_576).toFixed(1)} MB total.`);

  // Chunk by cumulative size
  const chunks: (typeof files)[] = [];
  let cur: typeof files = [];
  let curBytes = 0;
  for (const f of files) {
    const sz = parseInt(f.size ?? '0', 10);
    if (cur.length && curBytes + sz > MAX_BATCH_BYTES) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += sz;
  }
  if (cur.length) chunks.push(cur);
  log(`Will submit ${chunks.length} batch(es) on ${MODEL}.`);

  if (DRY) {
    chunks.forEach((c, i) => {
      const mb = c.reduce((s, f) => s + parseInt(f.size ?? '0', 10), 0) / 1_048_576;
      log(`  batch ${i + 1}: ${c.length} books, ${mb.toFixed(1)} MB`);
    });
    log('DRY run — nothing submitted.');
    return;
  }

  const batchIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    log(`\nBatch ${i + 1}/${chunks.length}: preparing ${chunk.length} books...`);
    const requests: { bookId: number; bookTitle: string; pdfBase64: string }[] = [];
    const bookIds: number[] = [];
    for (const f of chunk) {
      const title = f.name.replace(/\.pdf$/i, '');
      const book = await upsertBook(f.id, f.name, title);
      bookIds.push(book.id);
      await updateBookStatus(book.id, 'transcribing');
      const pdf = await downloadPdf(f.id);
      requests.push({ bookId: book.id, bookTitle: title, pdfBase64: pdf.toString('base64') });
      log(`  ✓ ${title}`);
    }
    const batchId = await createOcrBatch(requests, MODEL);
    await createBatchJob(batchId, bookIds);
    batchIds.push(batchId);
    log(`  → submitted batch ${batchId}`);
  }

  log(`\nDone. Submitted ${batchIds.length} batch(es):`);
  batchIds.forEach((id) => log(`  ${id}`));
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
