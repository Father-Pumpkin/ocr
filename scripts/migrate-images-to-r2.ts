#!/usr/bin/env node
/**
 * Migrate page images into object storage (R2) and bump resolution.
 *
 * For books that still map 1:1 to their source PDF, re-render every page at
 * IMAGE_RENDER_SCALE (high-res). For books edited structurally (split / insert /
 * delete — where DB page count ≠ PDF page count), move the EXISTING image as-is
 * (re-rendering would mis-map). Idempotent: pages already pointing at R2 are
 * skipped, so it's safe to re-run after an interruption.
 *
 * Requires Drive (to re-render) and R2 (R2_* env) configured.
 *   CREDENTIALS_PATH=<abs> npx tsx scripts/migrate-images-to-r2.ts
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
  process.stderr.write('R2 is not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET). Aborting.\n');
  process.exit(1);
}

const { getAllBooks, getPages, getPageImageKey } = await import('../src/core/database.js');
const { downloadPdf } = await import('../src/core/google-drive.js');
const { renderAllPdfPages } = await import('../src/core/render-pdf.js');
const { readPageImageBase64, writePageImageBase64, imageRenderScale } = await import('../src/core/image-service.js');

const log = (m: string) => process.stderr.write(m + '\n');
const scale = imageRenderScale();
log(`Migrating page images to R2 at ${scale}×...`);

let rerendered = 0;
let moved = 0;
let skipped = 0;

for (const book of await getAllBooks()) {
  if (book.id < 0 || book.status !== 'complete') continue;
  const pages = await getPages(book.id);
  if (pages.length === 0) continue;

  // Skip books already fully in R2.
  let allKeyed = true;
  for (const p of pages) {
    if (!(await getPageImageKey(book.id, p.page_number))) {
      allKeyed = false;
      break;
    }
  }
  if (allKeyed) {
    log(`  ${book.title}: already in R2`);
    skipped += pages.length;
    continue;
  }

  let images: string[] | null = null;
  try {
    const pdf = await downloadPdf(book.drive_file_id, { interactive: false });
    images = await renderAllPdfPages(pdf, scale);
  } catch (err) {
    log(`  ${book.title}: render failed (${err instanceof Error ? err.message : String(err)}); moving existing images`);
  }

  if (images && images.length === pages.length) {
    for (let i = 0; i < images.length; i++) await writePageImageBase64(book.id, i + 1, images[i]);
    rerendered += images.length;
    log(`  ${book.title}: re-rendered ${images.length} pages at ${scale}×`);
  } else {
    let n = 0;
    for (const p of pages) {
      if (await getPageImageKey(book.id, p.page_number)) continue;
      const b64 = await readPageImageBase64(book.id, p.page_number);
      if (b64) {
        await writePageImageBase64(book.id, p.page_number, b64);
        n++;
      }
    }
    moved += n;
    log(`  ${book.title}: moved ${n} images as-is (DB pages ${pages.length} ≠ PDF ${images?.length ?? 'n/a'})`);
  }
}

log(`\nDone. re-rendered=${rerendered}  moved-as-is=${moved}  already-in-R2=${skipped}`);
process.exit(0);
