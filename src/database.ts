import { SqliteAdapter } from './database-sqlite.js';
import { createPostgresAdapter } from './database-postgres.js';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow } from './database-adapter.js';
import os from 'os';
import path from 'path';

export type { BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow };

let _adapter: DatabaseAdapter | null = null;

export async function getAdapter(): Promise<DatabaseAdapter> {
  if (_adapter) return _adapter;
  if (process.env.DB_HOST || process.env.DATABASE_URL) {
    _adapter = await createPostgresAdapter();
  } else {
    const dbPath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
    _adapter = new SqliteAdapter(dbPath);
  }
  return _adapter;
}

// Re-export all functions as async delegators
export async function getAllBooks() { return (await getAdapter()).getAllBooks(); }
export async function getBookByDriveId(id: string) { return (await getAdapter()).getBookByDriveId(id); }
export async function getBookByName(name: string) { return (await getAdapter()).getBookByName(name); }
export async function upsertBook(driveFileId: string, driveFileName: string, title: string) { return (await getAdapter()).upsertBook(driveFileId, driveFileName, title); }
export async function updateBookStatus(bookId: number, status: string, pageCount?: number) { return (await getAdapter()).updateBookStatus(bookId, status, pageCount); }
export async function upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string) { return (await getAdapter()).upsertPage(bookId, pageNumber, transcription, batchCustomId); }
export async function updatePageTranscription(bookId: number, pageNumber: number, transcription: string) { return (await getAdapter()).updatePageTranscription(bookId, pageNumber, transcription); }
export async function getPages(bookId: number, pageStart?: number, pageEnd?: number) { return (await getAdapter()).getPages(bookId, pageStart, pageEnd); }
export async function getPageByCustomId(id: string) { return (await getAdapter()).getPageByCustomId(id); }
export async function setPageTags(bookId: number, pageNumber: number, tags: string[]) { return (await getAdapter()).setPageTags(bookId, pageNumber, tags); }
export async function hasExistingTranscription(bookId: number, pageNumber: number) { return (await getAdapter()).hasExistingTranscription(bookId, pageNumber); }
export async function createBatchJob(batchId: string, bookIds: number[]) { return (await getAdapter()).createBatchJob(batchId, bookIds); }
export async function getBatchJob(batchId: string) { return (await getAdapter()).getBatchJob(batchId); }
export async function updateBatchJobStatus(batchId: string, status: string) { return (await getAdapter()).updateBatchJobStatus(batchId, status); }
export async function getInProgressBatchJobs() { return (await getAdapter()).getInProgressBatchJobs(); }
export async function createDimension(name: string, description: string, minLabel: string, maxLabel: string) { return (await getAdapter()).createDimension(name, description, minLabel, maxLabel); }
export async function getDimensionByName(name: string) { return (await getAdapter()).getDimensionByName(name); }
export async function getAllDimensions() { return (await getAdapter()).getAllDimensions(); }
export async function updateDimension(id: number, fields: { description?: string; minLabel?: string; maxLabel?: string }) { return (await getAdapter()).updateDimension(id, fields); }
export async function deleteDimension(id: number) { return (await getAdapter()).deleteDimension(id); }
export async function upsertPageSentiment(pageId: number, dimensionId: number, score: number, rationale: string | null, model: string | null) { return (await getAdapter()).upsertPageSentiment(pageId, dimensionId, score, rationale, model); }
export async function getPageSentiment(pageId: number) { return (await getAdapter()).getPageSentiment(pageId); }
export async function getBookSentiment(bookId: number, dimensionIds?: number[], pageStart?: number, pageEnd?: number) { return (await getAdapter()).getBookSentiment(bookId, dimensionIds, pageStart, pageEnd); }
export async function getPageImage(bookId: number, pageNumber: number) { return (await getAdapter()).getPageImage(bookId, pageNumber); }
export async function cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>) { return (await getAdapter()).cachePageImages(bookId, images); }
export async function hasAnyPageImage(bookId: number) { return (await getAdapter()).hasAnyPageImage(bookId); }
