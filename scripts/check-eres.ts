#!/usr/bin/env node
/** Read-only: full page state for "Eres un amor" — dims, flags, source. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks, getPages, getPageImageKey } = await import('../src/core/database.js');
const { readPageImageBytes } = await import('../src/core/image-service.js');
const log = (m: string) => process.stderr.write(m + '\n');

function dimOf(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const book = (await getAllBooks()).find((b) => b.title === 'Eres un amor');
if (!book) { log('Eres un amor not found'); process.exit(1); }
const pages = await getPages(book.id);
log(`Eres un amor — id=${book.id} drive=${book.drive_file_id}`);
log(`pages=${pages.length} page_count(PDF)=${book.page_count ?? '?'}\n`);
for (const p of pages) {
  const key = await getPageImageKey(book.id, p.page_number);
  const r = await readPageImageBytes(book.id, p.page_number);
  const d = r ? dimOf(r.bytes) : null;
  log(
    `p${String(p.page_number).padStart(2)}: ${d ? `${String(d.w).padStart(4)}×${String(d.h).padStart(4)}` : ' no-image '} ` +
      `${r ? `${String(Math.round(r.bytes.length / 1024)).padStart(4)}KB` : '     '} ` +
      `${p.is_edited ? 'edited ' : '       '}${p.has_illustration ? 'illus ' : '      '}` +
      `${key ? 'R2' : 'b64'}`,
  );
}
process.exit(0);
