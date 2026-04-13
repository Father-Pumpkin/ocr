/**
 * Smoke-test for the PDF rendering pipeline.
 * Run with: npm test
 *
 * Uses pdf-lib to generate a PDF with an embedded raster image, ensuring we
 * exercise the ImageData code path that real illustrated PDFs trigger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { renderAllPdfPages } from '../src/render-pdf.js';

// Minimal 1×1 red PNG — triggers ImageData in pdfjs when rendered
const ONE_PIXEL_RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==',
  'base64'
);

test('renderAllPdfPages: renders pages including embedded images', async () => {
  const pdfDoc = await PDFDocument.create();

  // Page 1: text only
  pdfDoc.addPage([612, 792]);

  // Page 2: embedded raster image — exercises the ImageData code path
  const page2 = pdfDoc.addPage([612, 792]);
  const pngImage = await pdfDoc.embedPng(ONE_PIXEL_RED_PNG);
  page2.drawImage(pngImage, { x: 100, y: 100, width: 200, height: 200 });
  page2.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(0, 0.5, 1) });

  const pdfBuffer = Buffer.from(await pdfDoc.save());
  const images = await renderAllPdfPages(pdfBuffer, 0.5);

  assert.strictEqual(images.length, 2, 'should return one image per page');
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    assert.strictEqual(typeof img, 'string', `page ${i + 1}: should be a string`);
    assert.ok(img.length > 500, `page ${i + 1}: image data suspiciously small`);
    assert.ok(!img.startsWith('data:'), `page ${i + 1}: should be raw base64, not a data URL`);
  }
});
