import { getPages, setPageQuality, setBookQuality } from './database.js';
import { verifyTranscription } from './ocr.js';
// At/above this fraction of flagged text pages, the whole book is "bad" and is
// better re-transcribed wholesale than page-by-page.
const BAD_RATIO = 0.7;
const CONCURRENCY = 5;
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await fn(items[idx]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
async function verifyOnePage(bookId, page) {
    const { ok, reason } = await verifyTranscription(page.transcription ?? '');
    const quality = ok ? 'ok' : 'suspect';
    const qReason = ok ? null : reason;
    await setPageQuality(bookId, page.page_number, quality, qReason);
    return { ...page, ocr_quality: quality, ocr_quality_reason: qReason };
}
export function isTextPage(p) {
    const t = (p.transcription ?? '').trim();
    return !p.has_illustration && t.length > 0 && t !== '[ILLUSTRATION]';
}
/** Compute + persist the book-level verdict from its (already-verified) pages. */
async function scoreAndStoreBook(bookId, pages) {
    const textPages = pages.filter(isTextPage).length;
    const flagged = pages.filter((p) => p.ocr_quality === 'suspect').length;
    let quality = 'ok';
    let note = null;
    if (flagged > 0 && textPages > 0) {
        note = `${flagged} of ${textPages} text page${textPages === 1 ? '' : 's'} flagged`;
        quality = flagged / textPages >= BAD_RATIO ? 'bad' : 'suspect';
    }
    await setBookQuality(bookId, quality, note);
    return { quality, note, flagged };
}
/** Verify every page of a book; stores page verdicts and the rolled-up book verdict. */
export async function verifyBookById(bookId) {
    const pages = await getPages(bookId);
    const checked = await mapLimit(pages, CONCURRENCY, (p) => verifyOnePage(bookId, p));
    const { quality, note, flagged } = await scoreAndStoreBook(bookId, checked);
    return { total: checked.length, flagged, quality, note, pages: checked };
}
/** Verify a single page, then recompute the book verdict. Returns the updated page (or null). */
export async function verifyPageById(bookId, pageNumber) {
    const pages = await getPages(bookId);
    const target = pages.find((p) => p.page_number === pageNumber);
    if (!target)
        return null;
    const updated = await verifyOnePage(bookId, target);
    const merged = pages.map((p) => (p.page_number === pageNumber ? updated : p));
    await scoreAndStoreBook(bookId, merged);
    return updated;
}
/**
 * Manually mark a page's OCR as acceptable (user accepts a flagged or unchecked
 * transcription), clearing any suspect reason, then recompute the book verdict.
 * Returns the updated page, or null if the page doesn't exist.
 */
export async function markPageOkById(bookId, pageNumber) {
    const pages = await getPages(bookId);
    const target = pages.find((p) => p.page_number === pageNumber);
    if (!target)
        return null;
    await setPageQuality(bookId, pageNumber, 'ok', null);
    const updated = { ...target, ocr_quality: 'ok', ocr_quality_reason: null };
    const merged = pages.map((p) => (p.page_number === pageNumber ? updated : p));
    await scoreAndStoreBook(bookId, merged);
    return updated;
}
