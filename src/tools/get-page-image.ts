import { getBookByName, getPageImage, cachePageImages, hasAnyPageImage } from '../database.js';
import { downloadPdf } from '../google-drive.js';
import { renderAllPdfPages } from '../render-pdf.js';

export async function getPageImageTool(
  bookName: string,
  pageNumber: number
): Promise<{ imageData: string | null; driveUrl: string }> {
  const book = await getBookByName(bookName);
  if (!book) throw new Error(`Book not found: ${bookName}`);

  const driveUrl = `https://drive.google.com/file/d/${book.drive_file_id}/view`;

  // Check cache first
  const cached = await getPageImage(book.id, pageNumber);
  if (cached) return { imageData: cached, driveUrl };

  // If other pages are already cached, this page has no corresponding PDF page
  // (e.g. it was manually inserted). Don't re-render — return null image.
  const hasCache = await hasAnyPageImage(book.id);
  if (hasCache) return { imageData: null, driveUrl };

  // Full cache miss — download PDF and render all pages
  process.stderr.write(`[OCR MCP] Rendering pages for "${bookName}" from Drive...\n`);
  const pdfBuffer = await downloadPdf(book.drive_file_id);
  const images = await renderAllPdfPages(pdfBuffer, 1.0);

  await cachePageImages(book.id, images.map((imageData, i) => ({
    pageNumber: i + 1,
    imageData,
  })));

  // Page beyond PDF range = manually inserted, no image
  return { imageData: images[pageNumber - 1] ?? null, driveUrl };
}
