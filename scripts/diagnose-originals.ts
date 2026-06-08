#!/usr/bin/env node
/**
 * Read-only diagnostic: assess what's recoverable for original_transcription
 * backfill, and which books are stuck in 'transcribing'.
 *   npm run diagnose
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set — this diagnostic targets Postgres/Neon.');
  process.exit(1);
}
const sql = postgres(url);

async function main(): Promise<void> {
  const byStatus = await sql`SELECT status, count(*)::int AS n FROM books GROUP BY status ORDER BY n DESC`;
  const transcribing = await sql`
    SELECT id, title, updated_at, NOW() - updated_at AS age FROM books WHERE status='transcribing' ORDER BY updated_at
  `;
  const pageStats = await sql`
    SELECT
      count(*)::int                                                                          AS total_pages,
      count(*) FILTER (WHERE is_edited)::int                                                  AS edited,
      count(*) FILTER (WHERE original_transcription IS NULL)::int                             AS no_original,
      count(*) FILTER (WHERE original_transcription IS NULL AND is_edited)::int               AS edited_no_original,
      count(*) FILTER (WHERE original_transcription IS NULL AND is_edited
                       AND batch_custom_id IS NOT NULL)::int                                  AS edited_no_original_batched
    FROM pages
  `;
  const batches = await sql`
    SELECT count(*)::int AS n, min(created_at) AS oldest, max(created_at) AS newest FROM batch_jobs
  `;
  const recent = await sql`SELECT batch_id, status, created_at, NOW() - created_at AS age FROM batch_jobs ORDER BY created_at DESC LIMIT 12`;

  console.log('\n=== books by status ==='); console.table(byStatus);
  console.log('\n=== stuck in transcribing ==='); console.table(transcribing);
  console.log('\n=== page recovery targets ==='); console.log(pageStats[0]);
  console.log('\n=== batch_jobs summary ==='); console.log(batches[0]);
  console.log('\n=== recent batches (Anthropic keeps results ~29 days) ==='); console.table(recent);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
