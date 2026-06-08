#!/usr/bin/env node
/**
 * Quality-check every complete book (page + book verdicts). Paced by the
 * verifier's built-in rate limiter, so it's safe to run on the whole library.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/grade-all.ts
 *
 * Re-running re-grades everything (idempotent); fine if a run is interrupted.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks } = await import('../src/core/database.js');
const { verifyBookById } = await import('../src/core/quality.js');

const log = (m: string) => process.stderr.write(m + '\n');

async function main(): Promise<void> {
  const books = (await getAllBooks()).filter((b) => b.status === 'complete');
  log(`Grading ${books.length} complete book(s) (paced ~43/min)...`);

  let ok = 0;
  let suspect = 0;
  let bad = 0;
  for (const b of books) {
    try {
      const r = await verifyBookById(b.id);
      if (r.quality === 'bad') bad++;
      else if (r.quality === 'suspect') suspect++;
      else ok++;
      log(`  ${b.title}: ${r.quality}${r.note ? ` (${r.note})` : ''}`);
    } catch (err) {
      log(`  ${b.title}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`\nDone. ok=${ok}  suspect=${suspect}  bad=${bad}`);
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
