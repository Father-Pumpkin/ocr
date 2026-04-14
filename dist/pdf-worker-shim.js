/**
 * Custom pdfjs worker shim for Node.js.
 * Polyfills ImageData before loading the real pdfjs worker, then re-exports
 * WorkerMessageHandler so pdfjs can use it both as a real Worker thread
 * and in fallback "fake worker" mode.
 */
import { ImageData } from '@napi-rs/canvas';
// Set up browser globals that pdfjs worker expects
globalThis.ImageData = ImageData;
// @ts-ignore — no type declarations for internal worker entry point
const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
export const WorkerMessageHandler = workerModule.WorkerMessageHandler;
