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
  getAllTags,
  hasAnyPageImage,
  insertPageAfter,
  deletePage,
  syncBookPageCount,
  setBookTitle,
  setBookHidden,
  deleteBook,
  getBookByDriveId,
  upsertBook,
  updateBookStatus,
  createBatchJob,
  getRecentBatchJobs,
  setPageIllustration,
  recordOcrRun,
  getOcrRuns,
  type BookRow,
  type PageRow,
  type OcrRunRow,
} from './database.js';
import { listPdfsInFolder, downloadPdf, type DriveFile } from './google-drive.js';
import { renderAllPdfPages } from './render-pdf.js';
import { readPageImageBase64, writePageImageBase64, imageRenderScale } from './image-service.js';
import { transcribeSinglePageImage, createOcrBatch, checkAndProcessBatch, DEFAULT_MODEL } from './ocr.js';
import * as blob from './blob-store.js';
import crypto from 'node:crypto';
import { verifyBookById, verifyPageById, markPageOkById } from './quality.js';
import { splitImageHorizontally } from './image-split.js';
import { parsePageTags } from './sections.js';

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
export async function listLibrary(opts: { includeHidden?: boolean } = {}): Promise<BookRow[]> {
  const [dbBooks, driveFiles] = await Promise.all([
    getAllBooks(),
    // Never trigger an interactive OAuth popup just to render the library —
    // fall back to DB-only if Drive isn't connected.
    listPdfsInFolder({ interactive: false }).catch(() => [] as DriveFile[]),
  ]);
  const visible = (b: BookRow) => opts.includeHidden || !b.hidden;

  if (driveFiles.length === 0) return dbBooks.filter(visible).map(withDerivedStatus);

  const dbByDriveId = new Map(dbBooks.map((b) => [b.drive_file_id, b]));
  const fromDrive = driveFiles.map((file): BookRow => {
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
      hidden: false,
      created_by: null,
      created_at: '',
      updated_at: '',
    };
  });
  // Uploaded books never appear in Drive, so the Drive listing alone would drop them.
  const uploaded = dbBooks.filter(isUploaded).map(withDerivedStatus);
  return [...fromDrive, ...uploaded]
    .filter(visible)
    .sort((a, b) => a.title.localeCompare(b.title));
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
  // An uploaded book has no Drive file; its PDF is in object storage, if anywhere.
  const pdfBuffer = isUploaded(book)
    ? (await blob.getObject(uploadedPdfKey(book.drive_file_id)))?.body
    : await downloadPdf(book.drive_file_id, { interactive: false });
  if (!pdfBuffer) return { imageData: null, driveUrl };
  const images = await renderAllPdfPages(pdfBuffer, imageRenderScale());
  for (let i = 0; i < images.length; i++) {
    await writePageImageBase64(book.id, i + 1, images[i]);
  }
  return { imageData: images[pageNumber - 1] ?? null, driveUrl };
}

/**
 * A page image, but only if it is already cached — never renders. The public
 * tier serves images through this: `getPageImageData` falls back to downloading
 * the PDF from Drive and rasterizing every page on a miss, which is far too
 * expensive to expose to anyone who can sign in with a Google account.
 */
export async function getCachedPageImage(
  bookName: string,
  pageNumber: number,
): Promise<string | null> {
  const book = await requireBook(bookName);
  return readPageImageBase64(book.id, pageNumber);
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

/** Distinct tags used across the whole library — powers the tag picker. */
export async function listTags(): Promise<string[]> {
  return getAllTags();
}

/**
 * Re-runs OCR on a single page using its cached image and records it as a new
 * OCR run (preserving the original and any prior runs). Does NOT overwrite the
 * working transcription — the caller previews the candidate and applies it via a
 * normal edit if it's better. Returns the new run plus the (unchanged) page row.
 */
export async function retranscribePageData(
  bookName: string,
  pageNumber: number,
  model: string = DEFAULT_MODEL,
): Promise<{ run: OcrRunRow; page: PageRow }> {
  const book = await requireBook(bookName);
  const { imageData } = await getPageImageData(bookName, pageNumber);
  if (!imageData) {
    throw new NotFoundError(
      `Page ${pageNumber} has no associated image (it may have been manually inserted).`,
    );
  }
  const transcription = await transcribeSinglePageImage(imageData, model);
  const run = await recordOcrRun(book.id, pageNumber, model, transcription);
  const page = await getSinglePage(book.id, pageNumber);
  if (!page) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  return { run, page };
}

/** Returns the OCR run history for a page (oldest first; first element = original). */
export async function getPageOcrRunsData(
  bookName: string,
  pageNumber: number,
): Promise<OcrRunRow[]> {
  const book = await requireBook(bookName);
  return getOcrRuns(book.id, pageNumber);
}

/**
 * The one scan a guest may see: the book's cover.
 *
 * A scan carries the same words the transcript does, so serving every page to
 * the public tier would hand over the books by another route — the transcript
 * lockdown would only have moved the leak from JSON to JPEG. A front cover is
 * the exception worth making: it is how a book is recognised in a list, it is
 * title and artwork rather than story, and without it the library is a column
 * of grey rectangles.
 *
 * Identified by the `front cover` tag where there is one, since page numbering
 * is not uniform — some books start at a dedication — and by the lowest page
 * number otherwise.
 */
const coverCache = new Map<string, { page: number | null; at: number }>();
// Short enough that a re-tagged cover appears without a restart, long enough
// that a library page load — one image request per book, so ~73 at once —
// doesn't repeat the lookup for every one of them.
const COVER_TTL_MS = 5 * 60 * 1000;

export async function getCoverPageNumber(bookName: string): Promise<number | null> {
  const hit = coverCache.get(bookName);
  if (hit && Date.now() - hit.at < COVER_TTL_MS) return hit.page;

  const resolved = await resolveCoverPageNumber(bookName);
  coverCache.set(bookName, { page: resolved, at: Date.now() });
  return resolved;
}

async function resolveCoverPageNumber(bookName: string): Promise<number | null> {
  const book = await getBookByName(bookName);
  if (!book) return null;
  const pages = await getPages(book.id);
  if (pages.length === 0) return null;
  // Lowest-numbered match rather than the first row returned: a book can carry
  // the tag more than once (one does — on both page 1 and page 5), and relying
  // on query order to break that tie would make which scan is public depend on
  // something no one guarantees.
  const tagged = pages
    .filter((p) => parsePageTags(p.tags).includes('front cover'))
    .map((p) => p.page_number);
  return tagged.length ? Math.min(...tagged) : Math.min(...pages.map((p) => p.page_number));
}

/** Inserts a blank page after the given number; returns the new page row. */
export async function insertPageData(
  bookName: string,
  afterPageNumber: number,
): Promise<PageRow> {
  const book = await requireBook(bookName);
  const page = await insertPageAfter(book.id, afterPageNumber);
  await syncBookPageCount(book.id);
  return page;
}

/** Deletes a page and renumbers the rest. */
export async function deletePageData(
  bookName: string,
  pageNumber: number,
): Promise<void> {
  const book = await requireBook(bookName);
  const ok = await deletePage(book.id, pageNumber);
  if (!ok) throw new NotFoundError(`Page ${pageNumber} not found in "${book.title}".`);
  await syncBookPageCount(book.id);
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
 * right half + rightText. Both are marked edited.
 *
 * The spread's original OCR is the *whole* spread, so it's assigned as the
 * original OCR run of BOTH halves (each half then shows the same full-spread
 * original in its history). Every other page is left untouched.
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

  // Capture the complete spread original BEFORE mutating, so both halves share it.
  const src = await getSinglePage(book.id, pageNumber);
  const existingRuns = await getOcrRuns(book.id, pageNumber);
  const originalRun = existingRuns[0];
  const originalText = originalRun?.text ?? src?.original_transcription ?? src?.transcription ?? '';
  const originalModel = originalRun?.model ?? null;

  let leftImg: string | null = null;
  let rightImg: string | null = null;
  if (imageData) {
    const halves = await splitImageHorizontally(imageData, ratio);
    leftImg = halves.left;
    rightImg = halves.right;
  }

  // Make room: a blank page becomes pageNumber + 1 (later pages shift down).
  await insertPageAfter(book.id, pageNumber);
  await syncBookPageCount(book.id);

  await updatePageTranscription(book.id, pageNumber, leftText, true);
  await updatePageTranscription(book.id, pageNumber + 1, rightText, true);
  if (leftImg) await writePageImageBase64(book.id, pageNumber, leftImg);
  if (rightImg) await writePageImageBase64(book.id, pageNumber + 1, rightImg);

  // Give each half the full-spread original as its first OCR run. The left page
  // usually already has it (its runs are preserved); the new right page gets it.
  if (originalText) {
    for (const pn of [pageNumber, pageNumber + 1]) {
      if ((await getOcrRuns(book.id, pn)).length === 0) {
        await recordOcrRun(book.id, pn, originalModel, originalText);
      }
    }
  }

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

// ---------------------------------------------------------------------------
// Library management — hiding, deleting and adding books
// ---------------------------------------------------------------------------

/**
 * Books added through the web app have no Drive file, so they get a synthetic
 * drive_file_id with this prefix. It keeps the column's uniqueness doing its job
 * and lets every caller tell the two kinds apart without a schema change.
 */
const UPLOAD_PREFIX = 'upload:';

export function isUploaded(book: Pick<BookRow, 'drive_file_id'>): boolean {
  return book.drive_file_id.startsWith(UPLOAD_PREFIX);
}

function uploadedPdfKey(driveFileId: string): string {
  return `pdfs/${driveFileId.slice(UPLOAD_PREFIX.length)}.pdf`;
}

/** Thrown when a request is well-formed but can't be carried out right now (→ 409). */
export class BookConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookConflictError';
  }
}

/**
 * Resolves a library entry to a DB row, creating one for a Drive file that has
 * never been transcribed. Hiding an untranscribed Drive book needs a row to
 * hold the flag; without one it would reappear on the next listing.
 */
async function bookForDriveId(driveFileId: string): Promise<BookRow> {
  const existing = await getBookByDriveId(driveFileId);
  if (existing) return existing;
  if (driveFileId.startsWith(UPLOAD_PREFIX)) throw new NotFoundError('Book not found.');
  const files = await listPdfsInFolder({ interactive: false });
  const file = files.find((f) => f.id === driveFileId);
  if (!file) throw new NotFoundError('That file is no longer in the Drive folder.');
  return upsertBook(file.id, file.name, file.name.replace(/\.pdf$/i, ''));
}

/** Hides or unhides a book. Reversible; nothing else about the book changes. */
export async function setBookHiddenData(driveFileId: string, hidden: boolean): Promise<BookRow> {
  const book = await bookForDriveId(driveFileId);
  await setBookHidden(book.id, hidden);
  return { ...book, hidden };
}

/**
 * Permanently deletes a book's pages, scores, OCR history and images. A book
 * that is still in the Drive folder comes back as untranscribed, because the
 * Drive file is the source and this app can only read it.
 */
export async function deleteBookData(driveFileId: string): Promise<{ stillInDrive: boolean }> {
  const book = await getBookByDriveId(driveFileId);
  if (!book) throw new NotFoundError('Book not found.');
  if (book.status === 'transcribing') {
    throw new BookConflictError('This book is being transcribed. Wait for that to finish before deleting it.');
  }
  const keys = await deleteBook(book.id);
  // Storage cleanup is best-effort: the rows are gone, and an orphaned object
  // costs a few cents where a failed delete would strand a half-deleted book.
  const extra = isUploaded(book) ? [uploadedPdfKey(book.drive_file_id)] : [];
  await Promise.all([...keys, ...extra].map((k) => blob.deleteObject(k)));
  return { stillInDrive: !isUploaded(book) };
}

/**
 * Submits a Drive book to the Batch API for transcription. Results land when
 * the HTTP server's batch poller picks them up (see processPendingOcrBatches).
 */
export async function transcribeDriveBookData(
  driveFileId: string,
  model: string = DEFAULT_MODEL,
): Promise<{ book: BookRow; batchId: string }> {
  const book = await bookForDriveId(driveFileId);
  if (isUploaded(book)) throw new BookConflictError('Uploaded books are transcribed when they are uploaded.');
  if (book.status === 'transcribing') throw new BookConflictError('This book is already being transcribed.');
  if (book.status === 'complete') throw new BookConflictError('This book is already transcribed.');
  const pdf = await downloadPdf(book.drive_file_id, { interactive: false });
  const batchId = await createOcrBatch(
    [{ bookId: book.id, bookTitle: book.title, pdfBase64: pdf.toString('base64') }],
    model,
  );
  await createBatchJob(batchId, [book.id]);
  await updateBookStatus(book.id, 'transcribing');
  return { book: { ...book, status: 'transcribing' }, batchId };
}

/**
 * Adds a book from an uploaded PDF: renders and stores its page images, keeps
 * the PDF in object storage when that's configured, and submits it for batch
 * transcription.
 *
 * Images are rendered here rather than on first view, as Drive books' are,
 * because without R2 there is nowhere to fetch the PDF back from later. If any
 * step fails the book is deleted again, so a bad upload can't leave a half-made
 * book in the library.
 */
export async function uploadBookData(input: {
  fileName: string;
  title?: string;
  pdf: Buffer;
  model?: string;
}): Promise<{ book: BookRow; batchId: string; pageCount: number }> {
  if (input.pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new BookConflictError('That file is not a PDF.');
  }
  const title = (input.title ?? '').trim() || input.fileName.replace(/\.pdf$/i, '').trim();
  if (!title) throw new BookConflictError('A title is required.');
  if (await getBookByName(title)) throw new BookConflictError(`A book called "${title}" already exists.`);

  const driveFileId = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
  const book = await upsertBook(driveFileId, input.fileName, title);
  try {
    const images = await renderAllPdfPages(input.pdf, imageRenderScale());
    if (images.length === 0) throw new BookConflictError('That PDF has no pages.');
    for (let i = 0; i < images.length; i++) {
      await writePageImageBase64(book.id, i + 1, images[i]);
    }
    if (blob.isConfigured()) await blob.putObject(uploadedPdfKey(driveFileId), input.pdf, 'application/pdf');
    const batchId = await createOcrBatch(
      [{ bookId: book.id, bookTitle: title, pdfBase64: input.pdf.toString('base64') }],
      input.model ?? DEFAULT_MODEL,
    );
    await createBatchJob(batchId, [book.id]);
    await updateBookStatus(book.id, 'transcribing');
    return { book: { ...book, status: 'transcribing' }, batchId, pageCount: images.length };
  } catch (err) {
    const keys = await deleteBook(book.id).catch(() => [] as string[]);
    await Promise.all([...keys, uploadedPdfKey(driveFileId)].map((k) => blob.deleteObject(k)));
    throw err;
  }
}

/**
 * Checks every OCR batch still in flight. The MCP server resumes these on
 * startup, but a book added from the web app may never see an MCP session, so
 * the HTTP server polls them alongside the sentiment batches.
 */
export async function processPendingOcrBatches(): Promise<
  Array<{ batchId: string; status: string; processedCount: number }>
> {
  const pending = (await getRecentBatchJobs('ocr', 50)).filter(
    (j) => j.status !== 'complete' && j.status !== 'failed',
  );
  const out: Array<{ batchId: string; status: string; processedCount: number }> = [];
  for (const job of pending) {
    try {
      const r = await checkAndProcessBatch(job.batch_id);
      out.push({ batchId: job.batch_id, status: r.status, processedCount: r.processedCount });
    } catch (err) {
      process.stderr.write(
        `[library] Could not check OCR batch ${job.batch_id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return out;
}
