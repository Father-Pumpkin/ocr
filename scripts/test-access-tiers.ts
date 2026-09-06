#!/usr/bin/env node
/**
 * Access-tier regression test. Boots the HTTP server with the gate on and hits
 * every API route three times — anonymous, guest, member — asserting the
 * boundary from the outside, which is the only place it matters.
 *
 *   npx tsx scripts/test-access-tiers.ts    (or: npm run test:access)
 *
 * Companion to test-auth-gate.ts, which proves anonymous callers are shut out.
 * This one proves the *second* boundary: that a signed-in account which isn't on
 * ALLOWED_EMAILS can read the library but cannot edit anything, spend Anthropic
 * credits, or touch Drive.
 *
 * Add a route to ROUTES whenever you add one to the API. A route absent here is
 * a route nobody is checking.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

// Force the gate on, with a scratch DB so the test never touches real data.
process.env.AUTH_ENABLED = '1';
delete process.env.NODE_ENV; // keep isProd() false so cookies aren't Secure-only
delete process.env.DB_HOST;
delete process.env.DATABASE_URL;
process.env.SESSION_SECRET = 'test-secret-access-tiers';
process.env.BASE_URL = 'http://localhost:5192';
process.env.ALLOWED_EMAILS = 'member@example.com';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'dummy-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret';
const DB = path.join(os.tmpdir(), `ocr-access-tiers-${process.pid}.db`);
process.env.DATABASE_PATH = DB;
process.env.LEXICON_DIR = path.join(os.tmpdir(), 'ocr-access-tiers-no-lexicons');

const PORT = 5192;
const BASE = `http://localhost:${PORT}`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** `guest: 'allow'` = a read the public tier is meant to have. */
interface Route { method: Method; path: string; guest: 'allow' | 'deny'; body?: unknown }

const BOOK = 'Acceso Prueba';
const B = encodeURIComponent(BOOK);

const ROUTES: Route[] = [
  // Reads — the public tier
  { method: 'GET', path: '/api/me', guest: 'allow' },
  { method: 'GET', path: '/api/library', guest: 'allow' },
  { method: 'GET', path: '/api/tags', guest: 'allow' },
  { method: 'GET', path: '/api/models', guest: 'allow' },
  { method: 'GET', path: `/api/books/${B}/pages`, guest: 'allow' },
  { method: 'GET', path: `/api/books/${B}/pages/1/image`, guest: 'allow' },
  { method: 'GET', path: `/api/books/${B}/pages/1/ocr-runs`, guest: 'allow' },
  { method: 'GET', path: '/api/analysis/options', guest: 'allow' },
  { method: 'GET', path: '/api/analysis/results', guest: 'allow' },
  { method: 'GET', path: '/api/analysis/export?format=pages.csv', guest: 'allow' },

  // Book edits
  { method: 'PATCH', path: `/api/books/${B}/pages/1`, guest: 'deny', body: { transcription: 'nope' } },
  { method: 'PUT', path: `/api/books/${B}/pages/1/image`, guest: 'deny', body: { imageBase64: 'AAAA' } },
  { method: 'POST', path: `/api/books/${B}/pages`, guest: 'deny', body: { afterPageNumber: 1 } },
  { method: 'DELETE', path: `/api/books/${B}/pages/1`, guest: 'deny' },
  { method: 'POST', path: `/api/books/${B}/pages/1/mark-ok`, guest: 'deny' },
  { method: 'POST', path: `/api/books/${B}/pages/1/split`, guest: 'deny', body: { leftText: 'a', rightText: 'b' } },
  { method: 'PATCH', path: `/api/books/${B}`, guest: 'deny', body: { title: 'Renamed' } },
  { method: 'POST', path: `/api/books/${B}/pages/1/illustration`, guest: 'deny', body: { isIllustration: true } },

  // Anything that reaches Claude
  { method: 'POST', path: `/api/books/${B}/pages/1/retranscribe`, guest: 'deny', body: {} },
  { method: 'POST', path: `/api/books/${B}/pages/1/verify`, guest: 'deny' },
  { method: 'POST', path: `/api/books/${B}/verify`, guest: 'deny' },

  // Analysis writes / spend
  { method: 'POST', path: '/api/analysis/estimate', guest: 'deny', body: { style: 'llm:claude-sonnet-4-6' } },
  { method: 'POST', path: '/api/analysis/runs', guest: 'deny', body: { style: 'llm:claude-sonnet-4-6' } },
  { method: 'GET', path: '/api/analysis/runs', guest: 'deny' },
  { method: 'GET', path: '/api/analysis/runs/abc', guest: 'deny' },
  { method: 'GET', path: '/api/analysis/batches', guest: 'deny' },
  { method: 'POST', path: '/api/analysis/batches/abc/check', guest: 'deny' },
  { method: 'POST', path: '/api/analysis/prewarm', guest: 'deny', body: {} },
  { method: 'POST', path: '/api/analysis/lexicons/seed', guest: 'deny' },
  { method: 'POST', path: '/api/analysis/lexicons/preview', guest: 'deny', body: { content: 'a,1', fileName: 'x.csv' } },
  { method: 'POST', path: '/api/analysis/lexicons', guest: 'deny', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/analysis/lexicons/afinn', guest: 'deny' },
  { method: 'DELETE', path: '/api/analysis/methods/lex-afinn', guest: 'deny' },
  { method: 'POST', path: '/api/analysis/dimensions', guest: 'deny', body: { name: 'x', description: 'y' } },
  { method: 'PATCH', path: '/api/analysis/dimensions/polarity', guest: 'deny', body: { description: 'z' } },
  { method: 'DELETE', path: '/api/analysis/dimensions/polarity', guest: 'deny' },

  // Drive
  { method: 'GET', path: '/api/auth/drive/status', guest: 'deny' },
  { method: 'POST', path: '/api/auth/drive/connect', guest: 'deny' },
  { method: 'POST', path: '/api/auth/drive/disconnect', guest: 'deny' },
];

const { createHttpServer } = await import('../src/http/server.js');
const { createSessionToken, SESSION_COOKIE } = await import('../src/http/session.js');
const { upsertBook, updateBookStatus, upsertPage } = await import('../src/core/database.js');

/**
 * Two different things return 401 here: the session gate, and Google Drive
 * refusing an unauthenticated request from deep inside a handler. Only the
 * former is an access-tier result, so the error text is returned alongside the
 * status to tell them apart — otherwise a member legitimately blocked by Drive
 * looks like a member blocked by the tier.
 */
const SESSION_401 = 'Authentication required';

async function call(route: Route, cookie: string | null): Promise<{ status: number; error: string }> {
  const res = await fetch(BASE + route.path, {
    method: route.method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
    },
    body: route.body !== undefined ? JSON.stringify(route.body) : undefined,
    redirect: 'manual',
  });
  let error = '';
  try {
    error = String(((await res.clone().json()) as { error?: unknown })?.error ?? '');
  } catch {
    /* non-JSON body (an image, a CSV) — no error to read */
  }
  return { status: res.status, error };
}

const blockedByTier = (r: { status: number; error: string }): boolean =>
  r.status === 403 || (r.status === 401 && r.error === SESSION_401);

const book = await upsertBook('drive-access-tiers', 'Access.pdf', BOOK);
await upsertPage(book.id, 1, 'Una página de prueba.');
await updateBookStatus(book.id, 'complete', 1);

await createHttpServer(PORT);

const member = createSessionToken('member@example.com');
const guest = createSessionToken('someone-else@gmail.com');

let failures = 0;
for (const r of ROUTES) {
  const anon = await call(r, null);
  const g = await call(r, guest);
  const m = await call(r, member);

  const anonOk = anon.status === 401;
  const guestOk = r.guest === 'deny' ? g.status === 403 : !blockedByTier(g);
  // A member may still get 400/404/500 on test fixtures, or a Drive 401 — what
  // must never happen is being blocked by the tier itself.
  const memberOk = !blockedByTier(m);
  const ok = anonOk && guestOk && memberOk;
  if (!ok) {
    failures++;
    console.log(
      `FAIL  ${r.method} ${r.path}  anon=${anon.status} guest=${g.status} member=${m.status}` +
        `  (expected anon 401, guest ${r.guest === 'deny' ? '403' : 'not blocked'}, member not blocked)`,
    );
  }
}
console.log(`${ROUTES.length - failures}/${ROUTES.length} routes enforce the expected tiers`);

// The role must follow the allowlist, not the token it was minted with.
const token = createSessionToken('promote-me@gmail.com');
const probe: Route = { method: 'GET', path: '/api/analysis/batches', guest: 'deny' };
const before = (await call(probe, token)).status;
process.env.ALLOWED_EMAILS = 'member@example.com,promote-me@gmail.com';
const promoted = (await call(probe, token)).status;
process.env.ALLOWED_EMAILS = 'member@example.com';
const demoted = (await call(probe, token)).status;
if (before !== 403 || promoted === 403 || demoted !== 403) {
  failures++;
  console.log(`FAIL  role is not derived per request (before=${before} promoted=${promoted} demoted=${demoted})`);
} else {
  console.log('PASS  role derived per request — allowlist edits apply immediately, both directions');
}

try {
  fs.rmSync(DB, { force: true });
} catch {
  /* best effort */
}

if (failures > 0) {
  console.log(`\n${failures} ACCESS CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL_ACCESS_TIER_CHECKS_PASS');
process.exit(0);
