import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = '';

export async function renderAllPdfPages(
  pdfBuffer: Buffer,
  scale = 1.0
): Promise<string[]> {
  // Returns array of base64 JPEG strings, one per page (1-indexed: index 0 = page 1)
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
    // Use JPEG at 0.8 quality — smaller storage, good enough for reading
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    results.push(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
  }

  await pdf.destroy();
  return results;
}
