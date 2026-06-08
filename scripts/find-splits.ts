#!/usr/bin/env node
/**
 * Read-only: find leftover page splits by scanning image dimensions. A split
 * leaves a page whose width is ~half its book's typical page (a vertical crop).
 * Flags any page noticeably narrower than its book's median width.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks, getPages } = await import('../src/core/database.js');
const { readPageImageBytes } = await import('../src/core/image-service.js');
const log = (m: string) => process.stderr.write(m + '\n');

function pngSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function jpegSize(b: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
const dimOf = (b: Buffer) => pngSize(b) ?? jpegSize(b);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

let flaggedBooks = 0;
for (const book of await getAllBooks()) {
  const pages = await getPages(book.id);
  const dims: { n: number; w: number; h: number }[] = [];
  for (const p of pages) {
    const r = await readPageImageBytes(book.id, p.page_number);
    if (!r) continue;
    const d = dimOf(r.bytes);
    if (d) dims.push({ n: p.page_number, w: d.w, h: d.h });
  }
  if (dims.length === 0) continue;
  const med = median(dims.map((d) => d.w));
  const narrow = dims.filter((d) => d.w < med * 0.7);
  if (narrow.length > 0) {
    flaggedBooks++;
    log(
      `\n⚠ ${book.title} (median width ${med}px, ${pages.length} pages vs PDF ${book.page_count ?? '?'})`,
    );
    for (const d of narrow) log(`    page ${d.n}: ${d.w}×${d.h}  ← narrow (likely split half)`);
  }
}

log(flaggedBooks === 0 ? '\nNo narrow/split pages found in any book.' : `\n${flaggedBooks} book(s) flagged.`);
process.exit(0);
