#!/usr/bin/env node
/** Render Eres un amor pages 10-12 + dump current DB p11/p12 to inspect quality. */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { getAllBooks } = await import('../src/core/database.js');
const { downloadPdf } = await import('../src/core/google-drive.js');
const { renderAllPdfPages } = await import('../src/core/render-pdf.js');
const { readPageImageBytes, imageRenderScale } = await import('../src/core/image-service.js');
const log = (m: string) => process.stderr.write(m + '\n');

const out = path.join(ROOT, 'tmp-eres');
fs.mkdirSync(out, { recursive: true });

const book = (await getAllBooks()).find((b) => b.title === 'Eres un amor')!;
const scale = imageRenderScale();
const renders = await renderAllPdfPages(await downloadPdf(book.drive_file_id, { interactive: false }), scale);
log(`rendered ${renders.length} PDF pages at ${scale}×\n`);

for (const pdfPage of [10, 11, 12]) {
  const b = Buffer.from(renders[pdfPage - 1], 'base64');
  fs.writeFileSync(path.join(out, `pdf${pdfPage}.jpg`), b);
  log(`PDF p${pdfPage} render: ${(b.length / 1024).toFixed(0)}KB → tmp-eres/pdf${pdfPage}.jpg`);
}
for (const dbPage of [11, 12]) {
  const r = await readPageImageBytes(book.id, dbPage);
  if (r) {
    fs.writeFileSync(path.join(out, `db${dbPage}.jpg`), r.bytes);
    log(`DB  p${dbPage} stored: ${(r.bytes.length / 1024).toFixed(0)}KB → tmp-eres/db${dbPage}.jpg`);
  }
}
log('\nDone.');
process.exit(0);
