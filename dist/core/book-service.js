/**
 * book-service: the canonical entry point for non-MCP consumers of this codebase.
 *
 * The MCP tool layer (src/tools/*) and the future HTTP/Electron layers should
 * both depend on functions exposed here rather than reaching into core/*
 * primitives directly. Tools that return formatted text strings stay where they
 * are; this module is for structured-data operations that any UI can consume.
 */
import { getAllBooks, getBookByName, getPages, updatePageTranscription, setPageTags, getPageImage, setPageImage, cachePageImages, hasAnyPageImage, insertPageAfter, deletePage, } from './database.js';
import { listPdfsInFolder, downloadPdf } from './google-drive.js';
import { renderAllPdfPages } from './render-pdf.js';
import { transcribeSinglePageImage, DEFAULT_MODEL } from './ocr.js';
import { verifyBookById, verifyPageById } from './quality.js';
export { getDriveAuthStatus, startDriveConnect, clearAuth } from './google-drive.js';
export { AuthRequiredError } from './google-drive.js';
// A transcription that hasn't progressed in this long is treated as failed —
// the job died (crash, error, un-checked batch) and will never complete.
const TRANSCRIBING_STALE_MS = 24 * 60 * 60 * 1000;
/** Surface a stuck 'transcribing' book as 'failed' (display only; non-destructive). */
function withDerivedStatus(book) {
    if (book.status !== 'transcribing')
        return book;
    const updated = Date.parse(book.updated_at);
    if (!Number.isNaN(updated) && Date.now() - updated > TRANSCRIBING_STALE_MS) {
        return { ...book, status: 'failed' };
    }
    return book;
}
/**
 * Returns the merged library view: every PDF in the Drive folder, joined with
 * the matching DB book row when available. Drive files we've never seen get a
 * synthetic placeholder with id=-1 and status='pending'. If Drive is
 * unreachable we fall back to the DB-only view.
 */
export async function listLibrary() {
    const [dbBooks, driveFiles] = await Promise.all([
        getAllBooks(),
        // Never trigger an interactive OAuth popup just to render the library —
        // fall back to DB-only if Drive isn't connected.
        listPdfsInFolder({ interactive: false }).catch(() => []),
    ]);
    if (driveFiles.length === 0)
        return dbBooks.map(withDerivedStatus);
    const dbByDriveId = new Map(dbBooks.map((b) => [b.drive_file_id, b]));
    return driveFiles.map((file) => {
        const db = dbByDriveId.get(file.id);
        return db ? withDerivedStatus(db) : {
            id: -1,
            title: file.name.replace(/\.pdf$/i, ''),
            drive_file_id: file.id,
            drive_file_name: file.name,
            page_count: null,
            status: 'pending',
            ocr_quality: null,
            ocr_quality_note: null,
            created_by: null,
            created_at: '',
            updated_at: '',
        };
    });
}
/**
 * Returns the book row and its pages for the requested range. Returns null
 * book when the name doesn't match — callers decide whether to surface that
 * as an error or render an empty state.
 */
export async function getBookPagesData(bookName, pageStart, pageEnd) {
    const book = await getBookByName(bookName);
    if (!book)
        return { book: null, pages: [] };
    const pages = await getPages(book.id, pageStart, pageEnd);
    return { book, pages };
}
// ---------------------------------------------------------------------------
// Page operations — structured (data-returning) equivalents of the MCP tools.
// HTTP routes and the web chat call these; they throw NotFoundError so callers
// can map to 404 cleanly.
// ---------------------------------------------------------------------------
/** Thrown when a named book or a specific page can't be located. */
export class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
    }
}
async function requireBook(bookName) {
    const book = await getBookByName(bookName);
    if (!book)
        throw new NotFoundError(`Book not found: "${bookName}"`);
    return book;
}
async function getSinglePage(bookId, pageNumber) {
    const pages = await getPages(bookId, pageNumber, pageNumber);
    return pages[0];
}
/**
 * Returns a rendered page image as base64 JPEG plus the Drive view URL.
 * Renders and caches all pages on first miss; pages beyond the PDF range
 * (e.g. manually inserted) resolve to imageData: null.
 */
export async function getPageImageData(bookName, pageNumber) {
    const book = await requireBook(bookName);
    const driveUrl = `https://drive.google.com/file/d/${book.drive_file_id}/view`;
    const cached = await getPageImage(book.id, pageNumber);
    if (cached)
        return { imageData: cached, driveUrl };
    // Other pages cached but not this one → no corresponding PDF page.
    if (await hasAnyPageImage(book.id))
        return { imageData: null, driveUrl };
    // Full miss — render the whole PDF once and cache.
    const pdfBuffer = await downloadPdf(book.drive_file_id, { interactive: false });
    const images = await renderAllPdfPages(pdfBuffer, 1.0);
    await cachePageImages(book.id, images.map((imageData, i) => ({ pageNumber: i + 1, imageData })));
    return { imageData: images[pageNumber - 1] ?? null, driveUrl };
}
/** Updates a page's transcription (marks it edited) and returns the new row. */
export async function updatePageText(bookName, pageNumber, transcription) {
    const book = await requireBook(bookName);
    const ok = await updatePageTranscription(book.id, pageNumber, transcription);
    if (!ok)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    const page = await getSinglePage(book.id, pageNumber);
    if (!page)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    return page;
}
/** Replaces a page's tags with the supplied list and returns the new row. */
export async function setPageTagsData(bookName, pageNumber, tags) {
    const book = await requireBook(bookName);
    const ok = await setPageTags(book.id, pageNumber, tags);
    if (!ok)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    const page = await getSinglePage(book.id, pageNumber);
    if (!page)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    return page;
}
/** Re-runs OCR on a single page using its cached image; returns the new row. */
export async function retranscribePageData(bookName, pageNumber, model = DEFAULT_MODEL) {
    const book = await requireBook(bookName);
    const { imageData } = await getPageImageData(bookName, pageNumber);
    if (!imageData) {
        throw new NotFoundError(`Page ${pageNumber} has no associated image (it may have been manually inserted).`);
    }
    const transcription = await transcribeSinglePageImage(imageData, model);
    // markEdited=false: this is a fresh machine transcription, not a manual edit.
    await updatePageTranscription(book.id, pageNumber, transcription, false);
    // Auto-verify the fresh transcription (also refreshes the book-level verdict).
    const page = await verifyPageById(book.id, pageNumber);
    if (!page)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    return page;
}
/** Inserts a blank page after the given number; returns the new page row. */
export async function insertPageData(bookName, afterPageNumber) {
    const book = await requireBook(bookName);
    return insertPageAfter(book.id, afterPageNumber);
}
/** Deletes a page and renumbers the rest. */
export async function deletePageData(bookName, pageNumber) {
    const book = await requireBook(bookName);
    const ok = await deletePage(book.id, pageNumber);
    if (!ok)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
}
/**
 * Stores/replaces the cached image for a page. Accepts base64 with or without a
 * data-URL prefix; stores raw base64 to match how getPageImageData returns it.
 */
export async function setPageImageData(bookName, pageNumber, imageBase64) {
    const book = await requireBook(bookName);
    const raw = imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
    if (!raw)
        throw new NotFoundError('Image data is empty.');
    await setPageImage(book.id, pageNumber, raw);
}
// ---------------------------------------------------------------------------
// OCR quality check — delegates to core/quality.ts (stores page + book verdicts)
// ---------------------------------------------------------------------------
/** Quality-check a single page; stores page + book verdicts; returns the row. */
export async function verifyPageData(bookName, pageNumber) {
    const book = await requireBook(bookName);
    const page = await verifyPageById(book.id, pageNumber);
    if (!page)
        throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
    return page;
}
/** Quality-check every page of a book; stores verdicts; returns a summary. */
export async function verifyBookData(bookName) {
    const book = await requireBook(bookName);
    return verifyBookById(book.id);
}
