#!/usr/bin/env node
/**
 * Deterministic smoke test for the login gate. Boots the HTTP server in-process
 * with the gate ON and asserts that protected routes are blocked without a
 * valid session, allowed with one, and bypassed when the gate is off (dev).
 *
 *   npx tsx scripts/test-auth-gate.ts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

// Force the gate ON with the required secrets (independent of .env).
process.env.AUTH_ENABLED = '1';
delete process.env.NODE_ENV; // keep isProd() false so cookies aren't Secure-only
process.env.SESSION_SECRET = 'test-secret';
process.env.BASE_URL = 'http://localhost:5191';
process.env.ALLOWED_EMAILS = 'allowed@example.com';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'dummy-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret';

const PORT = 5191;
const { createHttpServer } = await import('../src/http/server.js');
const { createSessionToken } = await import('../src/http/session.js');

await createHttpServer(PORT);
const base = `http://localhost:${PORT}`;

let allOk = true;
async function check(name: string, p: string, init: RequestInit, expect: number): Promise<void> {
  let status = 0;
  try {
    status = (await fetch(base + p, init)).status;
  } catch (err) {
    status = -1;
    void err;
  }
  const ok = status === expect;
  if (!ok) allOk = false;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${status} (expected ${expect})\n`);
}

// Gate ON
await check('health is public', '/api/health', {}, 200);
await check('me blocked without session', '/api/me', {}, 401);
await check('library (credit-spending data) blocked', '/api/library', {}, 401);
await check('forged cookie rejected', '/api/me', { headers: { cookie: 'ocr_session=forged.deadbeef' } }, 401);

const token = createSessionToken('allowed@example.com');
await check('valid session allowed', '/api/me', { headers: { cookie: `ocr_session=${token}` } }, 200);

// Gate OFF (local dev bypass)
process.env.AUTH_ENABLED = '';
await check('gate off -> dev bypass', '/api/me', {}, 200);

process.stdout.write(allOk ? '\nALL_GATE_CHECKS_PASS\n' : '\nGATE_CHECKS_FAILED\n');
process.exit(allOk ? 0 : 1);
