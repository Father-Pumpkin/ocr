#!/usr/bin/env node
/**
 * Redo the low-res "Eres un amor" p11/p12 split at high resolution. Pages 11 &
 * 12 are the left/right halves of PDF page 11; the rest of the book is already
 * 3×. We re-render that spread at full scale and re-split it at the SAME gutter
 * ratio (derived from the current half widths), then write the sharp halves.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { getAllBooks } = await import('../src/core/database.js');
const { downloadPdf } = await import('../src/core/google-drive.js');
const { renderAllPdfPages } = await import('../src/core/render-pdf.js');
const { splitImageHorizontally } = await import('../src/core/image-split.js');
const { readPageImageBytes, writePageImageBase64, imageRenderScale } = await import('../src/core/image-service.js');
const log = (m: string) => process.stderr.write(m + '\n');

function widthOf(b: Buffer): number {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return b.readUInt32BE(16);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b.readUInt16BE(i + 7);
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

const SOURCE_PDF_PAGE = 11; // 1-indexed; DB p11+p12 are this spread's two halves
const book = (await getAllBooks()).find((b) => b.title === 'Eres un amor');
if (!book) { log('Eres un amor not found'); process.exit(1); }

// Derive the gutter ratio from the existing low-res halves.
const cur11 = await readPageImageBytes(book.id, 11);
const cur12 = await readPageImageBytes(book.id, 12);
if (!cur11 || !cur12) { log('Pages 11/12 missing images'); process.exit(1); }
const lw = widthOf(cur11.bytes);
const rw = widthOf(cur12.bytes);
const ratio = lw / (lw + rw);
log(`current halves: ${lw} + ${rw}px → ratio ${ratio.toFixed(4)}`);

const scale = imageRenderScale();
const renders = await renderAllPdfPages(await downloadPdf(book.drive_file_id, { interactive: false }), scale);
log(`rendered ${renders.length} PDF pages at ${scale}×`);
if (renders.length < SOURCE_PDF_PAGE) { log('PDF has too few pages'); process.exit(1); }

const source = renders[SOURCE_PDF_PAGE - 1];
log(`source spread (PDF p${SOURCE_PDF_PAGE}): ${widthOf(Buffer.from(source, 'base64'))}px wide`);

const { left, right } = await splitImageHorizontally(source, ratio);
await writePageImageBase64(book.id, 11, left);
await writePageImageBase64(book.id, 12, right);

const lBuf = Buffer.from(left, 'base64');
const rBuf = Buffer.from(right, 'base64');
log(`✓ new p11: ${widthOf(lBuf)}px ${(lBuf.length / 1024).toFixed(0)}KB`);
log(`✓ new p12: ${widthOf(rBuf)}px ${(rBuf.length / 1024).toFixed(0)}KB`);
log('\nDone.');
process.exit(0);
