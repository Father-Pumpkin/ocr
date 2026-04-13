/**
 * Smoke-test for the PDF rendering pipeline.
 * Run with: npm test
 *
 * Uses pdf-lib to generate a real in-memory PDF so we exercise the full
 * pdfjs-dist + @napi-rs/canvas stack without needing Google Drive or any
 * external resources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { renderAllPdfPages } from '../src/render-pdf.js';

test('renderAllPdfPages: renders a 2-page PDF to base64 JPEG', async () => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([612, 792]); // page 1
  pdfDoc.addPage([612, 792]); // page 2
  const pdfBuffer = Buffer.from(await pdfDoc.save());

  const images = await renderAllPdfPages(pdfBuffer, 0.5); // 0.5x scale for speed

  assert.strictEqual(images.length, 2, 'should return one image per page');

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    assert.strictEqual(typeof img, 'string', `page ${i + 1}: image should be a string`);
    assert.ok(img.length > 500, `page ${i + 1}: image data suspiciously small`);
    assert.ok(!img.startsWith('data:'), `page ${i + 1}: should be raw base64, not a data URL`);
  }
});
