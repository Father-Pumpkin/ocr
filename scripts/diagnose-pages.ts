#!/usr/bin/env node
/** Read-only: inspect page structure of the books that mismatched the PDF. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllBooks, getPages, getPageImageKey } = await import('../src/core/database.js');
const log = (m: string) => process.stderr.write(m + '\n');

const mismatched = new Set([
  'Ahora me llamo Luisa',
  'Amar con los pelos revueltos',
  'Ane Mona y Hulda',
  'Cebollino y Pimentón',
  'El rancho de Cris',
  'Liu',
  'Un día de cara y vaca',
  '¡Déjame en paz! Yo soy de colores ¿y tú.',
]);

for (const book of await getAllBooks()) {
  if (!mismatched.has(book.title)) continue;
  const pages = await getPages(book.id);
  let withImg = 0;
  let edited = 0;
  let illust = 0;
  let blank = 0;
  for (const p of pages) {
    if (await getPageImageKey(book.id, p.page_number)) withImg++;
    if (p.is_edited) edited++;
    if (p.has_illustration) illust++;
    if (!(p.transcription ?? '').trim()) blank++;
  }
  const nums = pages.map((p) => p.page_number);
  const contiguous = nums.every((n, i) => n === i + 1);
  log(
    `${book.title}\n` +
      `   pages=${pages.length} page_count=${book.page_count ?? 'null'} ` +
      `range=${nums[0]}..${nums[nums.length - 1]} contiguous=${contiguous}\n` +
      `   withImage=${withImg} blank=${blank} illustration=${illust} edited=${edited}`,
  );
}
