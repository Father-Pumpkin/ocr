import { createCanvas } from 'canvas';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// pdfjs-dist v4 instantiates CanvasFactory with `new`, so it must be a class
class NodeCanvasFactory {
    create(width, height) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
    }
    reset(item, width, height) {
        item.canvas.width = width;
        item.canvas.height = height;
    }
    destroy(item) {
        item.canvas.width = 0;
        item.canvas.height = 0;
    }
}
// pdfjs-dist in ESM / Node requires a specific import path and worker setup.
// We import the legacy build which works in Node without a DOM worker.
let pdfjsLib = null;
async function getPdfjs() {
    if (pdfjsLib)
        return pdfjsLib;
    // Dynamically import to allow the module to initialise correctly
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Point to the bundled worker file so pdfjs-dist v4 can initialise correctly
    const require = createRequire(import.meta.url);
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    return pdfjsLib;
}
/**
 * Renders every page of a PDF buffer to a base64-encoded PNG.
 *
 * @param pdfBuffer  Raw PDF bytes
 * @param scale      Render scale (default 2.0 — good quality for OCR)
 * @returns          Array of { pageNumber, base64 } objects
 */
export async function renderPdfPages(pdfBuffer, scale = 2.0) {
    const pdfjs = await getPdfjs();
    // pdfjs expects a Uint8Array
    const uint8 = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjs.getDocument({
        data: uint8,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
        CanvasFactory: NodeCanvasFactory,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    });
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    process.stderr.write(`[OCR MCP] Rendering ${numPages} page(s) from PDF...\n`);
    const results = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDocument.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        // The node-canvas context is API-compatible with the DOM context that pdfjs
        // expects, but the TypeScript types diverge slightly. We cast through
        // `unknown` to satisfy the compiler without losing runtime correctness.
        const ctx = canvas.getContext('2d');
        // pdfjs render context expects a CanvasRenderingContext2D compatible object
        await page.render({
            canvasContext: ctx,
            viewport,
        }).promise;
        // Export as PNG base64 (strip the data:image/png;base64, prefix)
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        results.push({ pageNumber: pageNum, base64 });
        process.stderr.write(`[OCR MCP]   Rendered page ${pageNum}/${numPages}\n`);
    }
    return results;
}
/**
 * Returns just the page count of a PDF without rendering pages.
 */
export async function getPdfPageCount(pdfBuffer) {
    const pdfjs = await getPdfjs();
    const uint8 = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjs.getDocument({
        data: uint8,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
        CanvasFactory: NodeCanvasFactory,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    });
    const doc = await loadingTask.promise;
    return doc.numPages;
}
