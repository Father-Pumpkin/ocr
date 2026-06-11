/**
 * Page-image read/write that prefers object storage (R2) and transparently
 * falls back to base64-in-database when R2 isn't configured. A page_images row
 * holds either a base64 blob (legacy) or an object_key pointing at R2.
 */
import crypto from 'node:crypto';
import { getPageImage, getPageImageKey, setPageImage, setPageImageKey } from './database.js';
import * as blob from './blob-store.js';
/**
 * Render scale for new page images. High-res only when object storage is on —
 * otherwise we'd bloat the database with large base64 strings.
 */
export function imageRenderScale() {
    if (!blob.isConfigured())
        return 1.0;
    const s = Number(process.env.IMAGE_RENDER_SCALE);
    return Number.isFinite(s) && s > 0 ? s : 3.0;
}
function sniffContentType(bytes) {
    if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png';
    }
    return 'image/jpeg';
}
/** Reads a page image as raw bytes + content type, or null if none. */
export async function readPageImageBytes(bookId, pageNumber) {
    const key = await getPageImageKey(bookId, pageNumber);
    if (key) {
        const obj = await blob.getObject(key);
        return obj ? { bytes: obj.body, contentType: obj.contentType } : null;
    }
    const b64 = await getPageImage(bookId, pageNumber);
    if (!b64)
        return null;
    const bytes = Buffer.from(b64, 'base64');
    return { bytes, contentType: sniffContentType(bytes) };
}
/** Reads a page image as base64 (for callers that pass it to the OCR API etc.). */
export async function readPageImageBase64(bookId, pageNumber) {
    const r = await readPageImageBytes(bookId, pageNumber);
    return r ? r.bytes.toString('base64') : null;
}
/** Stores a page image — to R2 when configured (random stable key), else base64. */
export async function writePageImageBytes(bookId, pageNumber, bytes, contentType) {
    if (blob.isConfigured()) {
        const key = `pages/${crypto.randomUUID()}`;
        await blob.putObject(key, bytes, contentType ?? sniffContentType(bytes));
        await setPageImageKey(bookId, pageNumber, key);
    }
    else {
        await setPageImage(bookId, pageNumber, bytes.toString('base64'));
    }
}
/** Convenience wrapper for callers that already hold base64 (renders, splits). */
export async function writePageImageBase64(bookId, pageNumber, base64) {
    await writePageImageBytes(bookId, pageNumber, Buffer.from(base64, 'base64'));
}
