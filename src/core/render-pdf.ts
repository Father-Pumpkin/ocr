import { createCanvas } from '@napi-rs/canvas';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Use the legacy build — handles font fallbacks better in Node.js.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Point workerSrc to our shim which polyfills ImageData before loading the real pdfjs worker.
// The shim compiles to dist/pdf-worker-shim.js alongside this file (dist/render-pdf.js).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const shimPath = path.join(__dirname, 'pdf-worker-shim.js');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(shimPath).toString();

export async function renderAllPdfPages(
  pdfBuffer: Buffer,
  scale = 1.0
): Promise<string[]> {
  // Returns array of base64 JPEG strings (index 0 = page 1)
  const data = new Uint8Array(pdfBuffer);
  const pdf = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const results: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    results.push(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
  }

  await pdf.destroy();
  return results;
}
