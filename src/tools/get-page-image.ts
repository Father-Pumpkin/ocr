import { getBookByName, hasAnyPageImage } from '../core/database.js';
import { downloadPdf } from '../core/google-drive.js';
import { renderAllPdfPages } from '../core/render-pdf.js';
import { readPageImageBase64, writePageImageBase64, imageRenderScale } from '../core/image-service.js';

export async function getPageImageTool(
  bookName: string,
  pageNumber: number
): Promise<{ imageData: string | null; driveUrl: string }> {
  const book = await getBookByName(bookName);
  if (!book) throw new Error(`Book not found: ${bookName}`);

  const driveUrl = `https://drive.google.com/file/d/${book.drive_file_id}/view`;

  // Check cache first (object storage when configured, else base64).
  const cached = await readPageImageBase64(book.id, pageNumber);
  if (cached) return { imageData: cached, driveUrl };

  // If other pages are already cached, this page has no corresponding PDF page
  // (e.g. it was manually inserted). Don't re-render — return null image.
  const hasCache = await hasAnyPageImage(book.id);
  if (hasCache) return { imageData: null, driveUrl };

  // Full cache miss — download PDF and render all pages.
  process.stderr.write(`[OCR MCP] Rendering pages for "${bookName}" from Drive...\n`);
  const pdfBuffer = await downloadPdf(book.drive_file_id);
  const images = await renderAllPdfPages(pdfBuffer, imageRenderScale());
  for (let i = 0; i < images.length; i++) await writePageImageBase64(book.id, i + 1, images[i]);

  // Page beyond PDF range = manually inserted, no image.
  return { imageData: images[pageNumber - 1] ?? null, driveUrl };
}
