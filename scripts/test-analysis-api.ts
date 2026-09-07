#!/usr/bin/env node
/**
 * Analysis API regression test.
 *
 *   npx tsx scripts/test-analysis-api.ts    (or: npm run test:analysis)
 *
 * These are the failures that return a 200 and an empty result rather than an
 * error, which is what makes them worth a test: nothing goes red, the screen
 * just quietly says there is nothing to show.
 *
 * The one that prompted this file: Express parses the query string with qs,
 * whose default arrayLimit is 20. Repeat `?books=` more than twenty times and
 * qs stops building an array and hands back an object keyed by index; the
 * filter then stringified to "[object Object]", matched no book, and returned
 * an empty analysis with a 200. With 72 books in the library, ticking 21 of
 * them was enough.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

delete process.env.NODE_ENV;
delete process.env.DB_HOST;
delete process.env.DATABASE_URL;
delete process.env.AUTH_ENABLED;
process.env.RATE_LIMIT_DISABLED = '1';
const DB = path.join(os.tmpdir(), `ocr-analysis-api-${process.pid}.db`);
process.env.DATABASE_PATH = DB;
process.env.LEXICON_DIR = path.join(os.tmpdir(), 'ocr-analysis-api-no-lexicons');

const PORT = 5194;
const BASE = `http://localhost:${PORT}`;

const { createHttpServer } = await import('../src/http/server.js');
const {
  upsertBook,
  updateBookStatus,
  upsertPage,
  setPageTags,
  createDimension,
  createMethod,
  upsertPageSentiment,
  getPages,
} = await import('../src/core/database.js');

// --- Fixture ---------------------------------------------------------------
// 25 books, deliberately more than qs's arrayLimit of 20. Every page carries a
// score so any empty result is a filtering bug rather than missing data.
const BOOK_COUNT = 25;
const PAGES_PER_BOOK = 6;

const dimension = await createDimension('polarity', 'Test construct', 'negative', 'positive');
const method = await createMethod('lex-test', 'lexicon', JSON.stringify({ lexicon_id: 1 }));

const titles: string[] = [];
for (let b = 1; b <= BOOK_COUNT; b++) {
  const title = `Libro ${String(b).padStart(2, '0')}`;
  titles.push(title);
  const book = await upsertBook(`drive-analysis-${b}`, `${title}.pdf`, title);
  for (let p = 1; p <= PAGES_PER_BOOK; p++) {
    await upsertPage(book.id, p, `Texto de prueba número ${p}.`);
    // One book gets the structural markers a section is defined by.
    if (b === 1) {
      if (p === 2) await setPageTags(book.id, p, ['inciting incident']);
      if (p === 4) await setPageTags(book.id, p, ['climax']);
      if (p === 6) await setPageTags(book.id, p, ['denouement']);
    }
  }
  // upsertPage returns void, so read the rows back to get their ids.
  for (const row of await getPages(book.id)) {
    await upsertPageSentiment(row.id, dimension.id, method.id, row.page_number / 10, null, null);
  }
  await updateBookStatus(book.id, 'complete', PAGES_PER_BOOK);
}

await createHttpServer(PORT);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Results {
  groups: Array<{ key: string; count: number; mean?: number; points?: unknown[] }>;
  books: string[];
  sections: Array<{ label: string; booksResolved: number; booksSkipped: number }>;
}

async function results(query: string): Promise<Results> {
  const res = await fetch(`${BASE}/api/analysis/results?${query}`);
  return (await res.json()) as Results;
}

const booksParam = (n: number): string =>
  titles.slice(0, n).map((t) => `books=${encodeURIComponent(t)}`).join('&');

// 1. The regression: more repeats than qs's arrayLimit must still be a list.
for (const n of [20, 21, 25]) {
  const r = await results(`dimensions=polarity&groupBy=book&aggregate=mean&${booksParam(n)}`);
  check(
    `${n} selected books are all returned`,
    r.groups.length === n && r.books.length === n,
    `groups=${r.groups.length}, books echoed=${r.books.length}`,
  );
}

// 2. Omitting the filter still means "every transcribed book".
const all = await results('dimensions=polarity&groupBy=book&aggregate=mean');
check('no books filter = the whole library', all.groups.length === BOOK_COUNT, `groups=${all.groups.length}`);

// 3. Sections resolve inclusively, and a shared boundary lands in both.
//    Book 01: inciting incident p2, climax p4, denouement p6.
const secs =
  'sections=' + encodeURIComponent('inciting incident>climax') +
  '&sections=' + encodeURIComponent('climax>denouement');
const arc = await results(`dimensions=polarity&groupBy=section&aggregate=mean&${secs}`);
const first = arc.groups.find((g) => g.key.startsWith('inciting'));
const second = arc.groups.find((g) => g.key.startsWith('climax'));
check(
  'both section ends are inclusive',
  first?.count === 3 && second?.count === 3,
  `p2–p4 = ${first?.count} page(s), p4–p6 = ${second?.count} page(s)`,
);

// 4. Sections keep the order they were given, not alphabetical order —
//    otherwise a narrative arc renders backwards.
check(
  'sections keep their defined order',
  arc.groups[0]?.key.startsWith('inciting') && arc.groups[1]?.key.startsWith('climax'),
  arc.groups.map((g) => g.key).join(' then '),
);

// 5. A book missing a marker is skipped, not clamped to its whole length.
const cov = arc.sections[0];
check(
  'books without the markers are skipped, not clamped',
  cov?.booksResolved === 1 && cov?.booksSkipped === BOOK_COUNT - 1,
  `${cov?.booksResolved} resolved, ${cov?.booksSkipped} skipped`,
);

try {
  fs.rmSync(DB, { force: true });
} catch {
  /* best effort */
}

if (failures > 0) {
  console.log(`\n${failures} ANALYSIS API CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL_ANALYSIS_API_CHECKS_PASS');
process.exit(0);
