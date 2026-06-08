#!/usr/bin/env node
/** Quick R2 connection check: put + get + delete a tiny test object. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const blob = await import('../src/core/blob-store.js');
const log = (m: string) => process.stderr.write(m + '\n');

if (!blob.isConfigured()) {
  log('R2 not configured — R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET missing.');
  process.exit(1);
}

const key = 'pages/_r2-connection-test';
const body = Buffer.from('r2 connection test');
try {
  await blob.putObject(key, body, 'text/plain');
  const got = await blob.getObject(key);
  await blob.deleteObject(key);
  if (got && got.body.toString() === body.toString()) {
    log('R2 OK — put + get + delete round-trip succeeded.');
    process.exit(0);
  }
  log('R2 FAIL — readback did not match what was written.');
  process.exit(1);
} catch (err) {
  log('R2 FAIL — ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
