#!/usr/bin/env node
/**
 * Upgrade the page-count-mismatched books to high-res. These books have extra
 * text-only pages, but their image-bearing pages line up 1:1 with the PDF (in
 * order) — so we re-render the PDF at high-res and drop each render onto the
 * image-bearing pages positionally. Books with no images yet (never cached) get
 * the first PDF-count pages filled. Requires Drive + R2.
 *
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/rerender-mismatched.ts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const blob = await import('../src/core/blob-store.js');
if (!blob.isConfigured()) {
  process.stderr.write('R2 not configured. Aborting.\n');
  process.exit(1);
}

const { getAllBooks, getPages, getPageImageKey } = await import('../src/core/database.js');
const { downloadPdf } = await import('../src/core/google-drive.js');
const { renderAllPdfPages } = await import('../src/core/render-pdf.js');
const { writePageImageBase64, imageRenderScale } = await import('../src/core/image-service.js');

const log = (m: string) => process.stderr.write(m + '\n');

const titles = new Set([
  'Ahora me llamo Luisa',
  'Amar con los pelos revueltos',
  'Ane Mona y Hulda',
  'Cebollino y Pimentón',
  'El rancho de Cris',
  'Liu',
  'Un día de cara y vaca',
  '¡Déjame en paz! Yo soy de colores ¿y tú.',
]);

const scale = imageRenderScale();
log(`Re-rendering ${titles.size} mismatched books at ${scale}×...`);

for (const book of await getAllBooks()) {
  if (!titles.has(book.title)) continue;
  const pages = await getPages(book.id);

  let renders: string[];
  try {
    renders = await renderAllPdfPages(await downloadPdf(book.drive_file_id, { interactive: false }), scale);
  } catch (err) {
    log(`  ${book.title}: render FAILED — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  // Pages that currently hold an image, in page order — they map 1:1 to the PDF.
  const imaged: number[] = [];
  for (const p of pages) {
    if (await getPageImageKey(book.id, p.page_number)) imaged.push(p.page_number);
  }
  const targets = imaged.length > 0 ? imaged : pages.map((p) => p.page_number);

  const n = Math.min(targets.length, renders.length);
  for (let i = 0; i < n; i++) {
    await writePageImageBase64(book.id, targets[i], renders[i]);
  }
  log(`  ${book.title}: upgraded ${n} page(s) at ${scale}× (${imaged.length} had images, PDF=${renders.length})`);
}

log('\nDone.');
process.exit(0);
