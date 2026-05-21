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
  type BookRow,
  type PageRow,
} from './database.js';
import { listPdfsInFolder, type DriveFile } from './google-drive.js';

export type {
  BookRow,
  PageRow,
  BatchJobRow,
  DimensionRow,
  PageSentimentRow,
} from './database-adapter.js';
export type { DriveFile } from './google-drive.js';
export { AuthRequiredError } from './google-drive.js';

/**
 * Returns the merged library view: every PDF in the Drive folder, joined with
 * the matching DB book row when available. Drive files we've never seen get a
 * synthetic placeholder with id=-1 and status='pending'. If Drive is
 * unreachable we fall back to the DB-only view.
 */
export async function listLibrary(): Promise<BookRow[]> {
  const [dbBooks, driveFiles] = await Promise.all([
    getAllBooks(),
    listPdfsInFolder().catch(() => [] as DriveFile[]),
  ]);

  if (driveFiles.length === 0) return dbBooks;

  const dbByDriveId = new Map(dbBooks.map((b) => [b.drive_file_id, b]));
  return driveFiles.map((file) => dbByDriveId.get(file.id) ?? {
    id: -1,
    title: file.name.replace(/\.pdf$/i, ''),
    drive_file_id: file.id,
    drive_file_name: file.name,
    page_count: null,
    status: 'pending',
    created_by: null,
    created_at: '',
    updated_at: '',
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
