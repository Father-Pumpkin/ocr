#!/usr/bin/env node
/**
 * Undo the "Eres un amor" p11/p12 split so it can be re-tested after the fix:
 * rebuild page 11 as the full high-res spread (PDF page 11) with the two halves'
 * text merged (blank-line separated, so the split dialog re-prefills cleanly),
 * then delete page 12 — renumbering the book back to 19 pages.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { getAllBooks, getPages } = await import('../src/core/database.js');
const { downloadPdf } = await import('../src/core/google-drive.js');
const { renderAllPdfPages } = await import('../src/core/render-pdf.js');
const { setPageImageData, updatePageText, deletePageData } = await import('../src/core/book-service.js');
const { readPageImageBytes, imageRenderScale } = await import('../src/core/image-service.js');
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

const TITLE = 'Eres un amor';
const book = (await getAllBooks()).find((b) => b.title === TITLE);
if (!book) { log('Eres un amor not found'); process.exit(1); }

const pages = await getPages(book.id);
const p11 = pages.find((p) => p.page_number === 11);
const p12 = pages.find((p) => p.page_number === 12);
if (!p11 || !p12) { log('pages 11/12 missing'); process.exit(1); }
if (pages.length !== 20) { log(`expected 20 pages, found ${pages.length} — aborting to be safe`); process.exit(1); }

const combined = [p11.transcription, p12.transcription].map((t) => (t ?? '').trim()).filter(Boolean).join('\n\n');
log(`merged text (p11 + p12):\n---\n${combined}\n---\n`);

const renders = await renderAllPdfPages(await downloadPdf(book.drive_file_id, { interactive: false }), imageRenderScale());
const spread = renders[10]; // PDF page 11
log(`spread render (PDF p11): ${widthOf(Buffer.from(spread, 'base64'))}px`);

await setPageImageData(TITLE, 11, spread); // page 11 → full spread
await updatePageText(TITLE, 11, combined); // page 11 → merged text
await deletePageData(TITLE, 12); // remove page 12, renumber 13..20 → 12..19

const after = await getPages(book.id);
const r11 = await readPageImageBytes(book.id, 11);
log(`\n✓ pages now: ${after.length} (range ${after[0].page_number}..${after[after.length - 1].page_number})`);
log(`✓ page 11 image: ${r11 ? `${widthOf(r11.bytes)}px ${(r11.bytes.length / 1024).toFixed(0)}KB` : 'missing'}`);
log('\nDone — split undone. Page 11 is the full spread again.');
process.exit(0);
