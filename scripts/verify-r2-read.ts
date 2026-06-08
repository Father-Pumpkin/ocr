#!/usr/bin/env node
/** Read-only: verify migrated pages read back from R2 as real high-res JPEGs. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const blob = await import('../src/core/blob-store.js');
const { getAllBooks, getPageImageKey } = await import('../src/core/database.js');
const { readPageImageBytes } = await import('../src/core/image-service.js');
const log = (m: string) => process.stderr.write(m + '\n');

/** Pull width/height from a JPEG's SOF marker. */
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

log(`R2 configured: ${blob.isConfigured()}\n`);

const targets = new Set([
  'Un día de cara y vaca',
  'Liu',
  'Ane Mona y Hulda',
  'El rancho de Cris',
  'Eres un amor',
]);

for (const book of await getAllBooks()) {
  if (!targets.has(book.title)) continue;
  const key = await getPageImageKey(book.id, 1);
  const r = await readPageImageBytes(book.id, 1);
  if (!r) { log(`${book.title} p1: NO IMAGE`); continue; }
  const dim = jpegSize(r.bytes);
  log(
    `${book.title} p1: ${(r.bytes.length / 1024).toFixed(0)}KB ${r.contentType} ` +
      `${dim ? `${dim.w}×${dim.h}` : 'dims?'} ` +
      `source=${key ? 'R2(' + key + ')' : 'base64'}`,
  );
}

log('\nDone.');
process.exit(0);
