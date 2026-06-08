/**
 * book-service: the canonical entry point for non-MCP consumers of this codebase.
 *
 * The MCP tool layer (src/tools/*) and the future HTTP/Electron layers should
 * both depend on functions exposed here rather than reaching into core/*
 * primitives directly. Tools that return formatted text strings stay where they
 * are; this module is for structured-data operations that any UI can consume.
 */

import {
  getAllBooks,
  getBookByName,
  getPages,
  updatePageTranscription,
  setPageTags,
  hasAnyPageImage,
  insertPageAfter,
  deletePage,
  setBookTitle,
  setPageIllustration,
  type BookRow,
  type PageRow,
} from './database.js';
import { listPdfsInFolder, downloadPdf, type DriveFile } from './google-drive.js';
import { renderAllPdfPages } from './render-pdf.js';
import { readPageImageBase64, writePageImageBase64, imageRenderScale } from './image-service.js';
import { transcribeSinglePageImage, DEFAULT_MODEL } from './ocr.js';
import { verifyBookById, verifyPageById, markPageOkById } from './quality.js';
import { splitImageHorizontally } from './image-split.js';

export { getDriveAuthStatus, startDriveConnect, clearAuth } from './google-drive.js';

export type {
  BookRow,
  PageRow,
  BatchJobRow,
  DimensionRow,
  PageSentimentRow,
} from './database-adapter.js';
export type { DriveFile } from './google-drive.js';
export { AuthRequiredError } from './google-drive.js';

// A transcription that hasn't progressed in this long is treated as failed —
// the job died (crash, error, un-checked batch) and will never complete.
const TRANSCRIBING_STALE_MS = 24 * 60 * 60 * 1000;

/** Surface a stuck 'transcribing' book as 'failed' (display only; non-destructive). */
function withDerivedStatus(book: BookRow): BookRow {
  if (book.status !== 'transcribing') return book;
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
export async function listLibrary(): Promise<BookRow[]> {
  const [dbBooks, driveFiles] = await Promise.all([
    getAllBooks(),
    // Never trigger an interactive OAuth popup just to render the library —
    // fall back to DB-only if Drive isn't connected.
    listPdfsInFolder({ interactive: false }).catch(() => [] as DriveFile[]),
  ]);

  if (driveFiles.length === 0) return dbBooks.map(withDerivedStatus);

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
export async function getBookPagesData(
  bookName: string,
  pageStart?: number,
  pageEnd?: number,
): Promise<{ book: BookRow | null; pages: PageRow[] }> {
  const book = await getBookByName(bookName);
  if (!book) return { book: null, pages: [] };
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
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

async function requireBook(bookName: string): Promise<BookRow> {
  const book = await getBookByName(bookName);
  if (!book) throw new NotFoundError(`Book not found: "${bookName}"`);
  return book;
}

async function getSinglePage(bookId: number, pageNumber: number): Promise<PageRow | undefined> {
  const pages = await getPages(bookId, pageNumber, pageNumber);
  return pages[0];
}

/**
 * Returns a rendered page image as base64 JPEG plus the Drive view URL.
 * Renders and caches all pages on first miss; pages beyond the PDF range
 * (e.g. manually inserted) resolve to imageData: null.
 */
export async function getPageImageData(
  bookName: string,
  pageNumber: number,
): Promise<{ imageData: string | null; driveUrl: string }> {
  const book = await requireBook(bookName);
  const driveUrl = `https://drive.google.com/file/d/${book.drive_file_id}/view`;

  const cached = await readPageImageBase64(book.id, pageNumber);
  if (cached) return { imageData: cached, driveUrl };

  // Other pages cached but not this one → no corresponding PDF page.
  if (await hasAnyPageImage(book.id)) return { imageData: null, driveUrl };

  // Full miss — render the whole PDF once and store (object storage when configured).
  const pdfBuffer = await downloadPdf(book.drive_file_id, { interactive: false });
  const images = await renderAllPdfPages(pdfBuffer, imageRenderScale());
  for (let i = 0; i < images.length; i++) {
    await writePageImageBase64(book.id, i + 1, images[i]);
  }
  return { imageData: images[pageNumber - 1] ?? null, driveUrl };
}

/** Updates a page's transcription (marks it edited) and returns the new row. */
export async function updatePageText(
  bookName: string,
  pageNumber: number,
  transcription: string,
): Promise<PageRow> {
  const book = await requireBook(bookName);
  const ok = await updatePageTranscription(book.id, pageNumber, transcription);
  if (!ok) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  const page = await getSinglePage(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}

/** Replaces a page's tags with the supplied list and returns the new row. */
export async function setPageTagsData(
  bookName: string,
  pageNumber: number,
  tags: string[],
): Promise<PageRow> {
  const book = await requireBook(bookName);
  const ok = await setPageTags(book.id, pageNumber, tags);
  if (!ok) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  const page = await getSinglePage(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}

/** Re-runs OCR on a single page using its cached image; returns the new row. */
export async function retranscribePageData(
  bookName: string,
  pageNumber: number,
  model: string = DEFAULT_MODEL,
): Promise<PageRow> {
  const book = await requireBook(bookName);
  const { imageData } = await getPageImageData(bookName, pageNumber);
  if (!imageData) {
    throw new NotFoundError(
      `Page ${pageNumber} has no associated image (it may have been manually inserted).`,
    );
  }
  const transcription = await transcribeSinglePageImage(imageData, model);
  // markEdited=false: this is a fresh machine transcription, not a manual edit.
  await updatePageTranscription(book.id, pageNumber, transcription, false);
  // Auto-verify the fresh transcription (also refreshes the book-level verdict).
  const page = await verifyPageById(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}

/** Inserts a blank page after the given number; returns the new page row. */
export async function insertPageData(
  bookName: string,
  afterPageNumber: number,
): Promise<PageRow> {
  const book = await requireBook(bookName);
  return insertPageAfter(book.id, afterPageNumber);
}

/** Deletes a page and renumbers the rest. */
export async function deletePageData(
  bookName: string,
  pageNumber: number,
): Promise<void> {
  const book = await requireBook(bookName);
  const ok = await deletePage(book.id, pageNumber);
  if (!ok) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
}

/**
 * Stores/replaces the cached image for a page. Accepts base64 with or without a
 * data-URL prefix; stores raw base64 to match how getPageImageData returns it.
 */
export async function setPageImageData(
  bookName: string,
  pageNumber: number,
  imageBase64: string,
): Promise<void> {
  const book = await requireBook(bookName);
  const raw = imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
  if (!raw) throw new NotFoundError('Image data is empty.');
  await writePageImageBase64(book.id, pageNumber, raw);
}

// ---------------------------------------------------------------------------
// OCR quality check — delegates to core/quality.ts (stores page + book verdicts)
// ---------------------------------------------------------------------------

/** Quality-check a single page; stores page + book verdicts; returns the row. */
export async function verifyPageData(bookName: string, pageNumber: number): Promise<PageRow> {
  const book = await requireBook(bookName);
  const page = await verifyPageById(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}

/** Quality-check every page of a book; stores verdicts; returns a summary. */
export async function verifyBookData(
  bookName: string,
): Promise<{ total: number; flagged: number; quality: string; note: string | null; pages: PageRow[] }> {
  const book = await requireBook(bookName);
  return verifyBookById(book.id);
}

/** Manually accept a page's OCR (clears the suspect flag); re-rolls the book verdict. */
export async function markPageOkData(bookName: string, pageNumber: number): Promise<PageRow> {
  const book = await requireBook(bookName);
  const page = await markPageOkById(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}

/**
 * Splits a two-page spread into two pages at `ratio` of the image width. The
 * current page keeps the left half + leftText; a new page after it gets the
 * right half + rightText. Both are marked edited. Returns the two page rows.
 */
export async function splitPageData(
  bookName: string,
  pageNumber: number,
  leftText: string,
  rightText: string,
  ratio = 0.5,
): Promise<{ left: PageRow; right: PageRow }> {
  const book = await requireBook(bookName);
  const { imageData } = await getPageImageData(bookName, pageNumber);

  let leftImg: string | null = null;
  let rightImg: string | null = null;
  if (imageData) {
    const halves = await splitImageHorizontally(imageData, ratio);
    leftImg = halves.left;
    rightImg = halves.right;
  }

  // Make room: a blank page becomes pageNumber + 1 (later pages shift down).
  await insertPageAfter(book.id, pageNumber);

  await updatePageTranscription(book.id, pageNumber, leftText, true);
  await updatePageTranscription(book.id, pageNumber + 1, rightText, true);
  if (leftImg) await writePageImageBase64(book.id, pageNumber, leftImg);
  if (rightImg) await writePageImageBase64(book.id, pageNumber + 1, rightImg);

  const left = await getSinglePage(book.id, pageNumber);
  const right = await getSinglePage(book.id, pageNumber + 1);
  if (!left || !right) throw new NotFoundError(`Failed to split page ${pageNumber} in "${book.title}".`);
  return { left, right };
}

/** Renames a book (its display title). Returns the updated book row. */
export async function renameBookData(bookName: string, newTitle: string): Promise<BookRow> {
  const book = await requireBook(bookName);
  const title = newTitle.trim();
  await setBookTitle(book.id, title);
  return (await getBookByName(title)) ?? { ...book, title };
}

/** Toggles a page's illustration-only flag; sets '[ILLUSTRATION]' text when on. */
export async function setPageIllustrationData(
  bookName: string,
  pageNumber: number,
  isIllustration: boolean,
): Promise<PageRow> {
  const book = await requireBook(bookName);
  const ok = await setPageIllustration(book.id, pageNumber, isIllustration);
  if (!ok) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  if (isIllustration) {
    await updatePageTranscription(book.id, pageNumber, '[ILLUSTRATION]', true);
  } else {
    const current = await getSinglePage(book.id, pageNumber);
    if (current && (current.transcription ?? '').trim() === '[ILLUSTRATION]') {
      await updatePageTranscription(book.id, pageNumber, '', true);
    }
  }
  const page = await getSinglePage(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return page;
}
