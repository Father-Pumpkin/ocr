#!/usr/bin/env node
/**
 * Rate-limit regression test.
 *
 *   npx tsx scripts/test-rate-limits.ts    (or: npm run test:limits)
 *
 * The failure mode that matters most here isn't "the limiter doesn't fire" — it
 * is "the limiter fires on a normal page load". The library page requests one
 * image per book, so an ordinary visit is a burst of ~76 requests in a second.
 * The first case below reproduces that burst and asserts nothing is throttled;
 * the rest check that the genuinely expensive endpoints are.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

process.env.AUTH_ENABLED = '1';
delete process.env.NODE_ENV;
delete process.env.DB_HOST;
delete process.env.DATABASE_URL;
delete process.env.RATE_LIMIT_DISABLED;
delete process.env.RATE_LIMIT_FACTOR;
process.env.SESSION_SECRET = 'test-secret-rate-limits';
process.env.BASE_URL = 'http://localhost:5193';
process.env.ALLOWED_EMAILS = 'member@example.com';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'dummy-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret';
const DB = path.join(os.tmpdir(), `ocr-rate-limits-${process.pid}.db`);
process.env.DATABASE_PATH = DB;
process.env.LEXICON_DIR = path.join(os.tmpdir(), 'ocr-rate-limits-no-lexicons');

const PORT = 5193;
const BASE = `http://localhost:${PORT}`;

const { createHttpServer } = await import('../src/http/server.js');
const { createSessionToken, SESSION_COOKIE } = await import('../src/http/session.js');
const { resetRateLimits } = await import('../src/http/middleware/rate-limit.js');
const { upsertBook, updateBookStatus, upsertPage } = await import('../src/core/database.js');

const BOOK = 'Limite Prueba';
const book = await upsertBook('drive-rate-limits', 'Limits.pdf', BOOK);
await upsertPage(book.id, 1, 'Una página de prueba.');
await updateBookStatus(book.id, 'complete', 1);

await createHttpServer(PORT);

const member = createSessionToken('member@example.com');
const guestA = createSessionToken('guest-a@gmail.com');
const guestB = createSessionToken('guest-b@gmail.com');

async function get(pathname: string, cookie: string): Promise<Response> {
  return fetch(BASE + pathname, {
    headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    redirect: 'manual',
  });
}

/** Fire n requests concurrently, the way a browser loads a page of thumbnails. */
async function burst(pathname: string, cookie: string, n: number): Promise<number[]> {
  return Promise.all(Array.from({ length: n }, () => get(pathname, cookie).then((r) => r.status)));
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. A library-sized burst must sail through. This is the regression guard.
resetRateLimits();
const IMAGE = `/api/books/${encodeURIComponent(BOOK)}/pages/1/image`;
const thumbnails = await burst(IMAGE, guestA, 120);
check(
  'a 120-image burst (library page load) is not throttled',
  !thumbnails.includes(429),
  `statuses: ${[...new Set(thumbnails)].sort().join(', ')}`,
);

// 2. Ordinary reads in bulk are fine too.
resetRateLimits();
const reads = await burst('/api/library', guestA, 150);
check('150 library reads are not throttled', !reads.includes(429));

// 3. Exports are expensive and guests get 10/min.
resetRateLimits();
const exportPath = '/api/analysis/export?format=pages.csv';
const exports: number[] = [];
for (let i = 0; i < 12; i++) exports.push((await get(exportPath, guestA)).status);
const throttledAt = exports.findIndex((s) => s === 429);
check(
  'guest exports are throttled after 10 in a minute',
  throttledAt === 10,
  `first 429 at request ${throttledAt + 1}`,
);

// 4. A 429 must say how long to wait, in a header and in the body.
const blocked = await get(exportPath, guestA);
const body = (await blocked.json()) as { rateLimited?: boolean; retryAfterSeconds?: number };
check(
  '429 carries Retry-After and a machine-readable body',
  blocked.status === 429 &&
    !!blocked.headers.get('retry-after') &&
    body.rateLimited === true &&
    typeof body.retryAfterSeconds === 'number',
  `Retry-After=${blocked.headers.get('retry-after')}s`,
);

// 5. One user's limit must not spend another's.
const otherGuest = (await get(exportPath, guestB)).status;
check('a separate guest has their own budget', otherGuest !== 429, `guest B got ${otherGuest}`);

// 6. Members get more headroom than guests on the same endpoint.
const memberExports: number[] = [];
for (let i = 0; i < 12; i++) memberExports.push((await get(exportPath, member)).status);
check(
  'a member is not throttled where a guest already is',
  !memberExports.includes(429),
  `member ran ${memberExports.length} exports clean`,
);

// 7. The escape hatch has to actually work.
resetRateLimits();
process.env.RATE_LIMIT_DISABLED = '1';
const unlimited: number[] = [];
for (let i = 0; i < 15; i++) unlimited.push((await get(exportPath, guestA)).status);
delete process.env.RATE_LIMIT_DISABLED;
check('RATE_LIMIT_DISABLED=1 turns limiting off', !unlimited.includes(429));

// 8. And the tightening dial.
resetRateLimits();
process.env.RATE_LIMIT_FACTOR = '0.2'; // 10/min -> 2/min for guests
const tightened: number[] = [];
for (let i = 0; i < 4; i++) tightened.push((await get(exportPath, guestA)).status);
delete process.env.RATE_LIMIT_FACTOR;
check(
  'RATE_LIMIT_FACTOR scales the limits',
  tightened.filter((s) => s === 429).length === 2,
  `statuses: ${tightened.join(', ')}`,
);

try {
  fs.rmSync(DB, { force: true });
} catch {
  /* best effort */
}

if (failures > 0) {
  console.log(`\n${failures} RATE LIMIT CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL_RATE_LIMIT_CHECKS_PASS');
process.exit(0);
