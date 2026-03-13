import { SqliteAdapter } from './database-sqlite.js';
import { createPostgresAdapter } from './database-postgres.js';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow } from './database-adapter.js';
import os from 'os';
import path from 'path';

export type { BookRow, PageRow, BatchJobRow };

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
