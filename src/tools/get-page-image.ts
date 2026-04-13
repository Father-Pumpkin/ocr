import { getBookByName, getPageImage, cachePageImages } from '../database.js';
import { downloadPdf } from '../google-drive.js';
import { renderAllPdfPages } from '../render-pdf.js';

export async function getPageImageTool(
  bookName: string,
  pageNumber: number
): Promise<{ imageData: string; driveUrl: string }> {
  const book = await getBookByName(bookName);
  if (!book) throw new Error(`Book not found: ${bookName}`);

  const driveUrl = `https://drive.google.com/file/d/${book.drive_file_id}/view`;

  // Check cache
  const cached = await getPageImage(book.id, pageNumber);
  if (cached) return { imageData: cached, driveUrl };

  // Cache miss — download PDF and render all pages
  process.stderr.write(`[OCR MCP] Rendering pages for "${bookName}" from Drive...\n`);
  const pdfBuffer = await downloadPdf(book.drive_file_id);
  const images = await renderAllPdfPages(pdfBuffer, 1.0);

  // Cache all pages
  await cachePageImages(book.id, images.map((imageData, i) => ({
    pageNumber: i + 1,
    imageData,
  })));

  const imageData = images[pageNumber - 1];
  if (!imageData) throw new Error(`Page ${pageNumber} not found in rendered PDF.`);

  return { imageData, driveUrl };
}
