#!/usr/bin/env node
/**
 * Poll all in-progress OCR batch jobs and process them as they finish. Each
 * processed book is stored (manual edits preserved) and auto-quality-checked.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/process-batches.ts
 *
 * Safe to run repeatedly / leave running. Exits when no batches remain in
 * progress or after the time cap.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { getInProgressBatchJobs } = await import('../src/core/database.js');
const { checkAndProcessBatch } = await import('../src/core/ocr.js');

const POLL_MS = 4 * 60 * 1000;
const MAX_MS = 3 * 60 * 60 * 1000;
const log = (m: string) => process.stderr.write(m + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < MAX_MS) {
    const jobs = await getInProgressBatchJobs();
    if (jobs.length === 0) {
      log('No batches in progress — done.');
      return;
    }
    log(`${jobs.length} batch(es) in progress; checking...`);
    for (const job of jobs) {
      try {
        const { summary } = await checkAndProcessBatch(job.batch_id);
        log(`  ${job.batch_id}: ${summary}`);
      } catch (err) {
        log(`  ${job.batch_id}: error — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if ((await getInProgressBatchJobs()).length === 0) {
      log('All batches processed and graded.');
      return;
    }
    await sleep(POLL_MS);
  }
  log('Time cap reached; rerun to keep processing.');
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
