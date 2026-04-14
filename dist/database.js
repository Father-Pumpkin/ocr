import { SqliteAdapter } from './database-sqlite.js';
import { createPostgresAdapter } from './database-postgres.js';
import os from 'os';
import path from 'path';
let _adapter = null;
export async function getAdapter() {
    if (_adapter)
        return _adapter;
    if (process.env.DB_HOST || process.env.DATABASE_URL) {
        _adapter = await createPostgresAdapter();
    }
    else {
        const dbPath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
        _adapter = new SqliteAdapter(dbPath);
    }
    return _adapter;
}
// Re-export all functions as async delegators
export async function getAllBooks() { return (await getAdapter()).getAllBooks(); }
export async function getBookByDriveId(id) { return (await getAdapter()).getBookByDriveId(id); }
export async function getBookByName(name) { return (await getAdapter()).getBookByName(name); }
export async function upsertBook(driveFileId, driveFileName, title) { return (await getAdapter()).upsertBook(driveFileId, driveFileName, title); }
export async function updateBookStatus(bookId, status, pageCount) { return (await getAdapter()).updateBookStatus(bookId, status, pageCount); }
export async function upsertPage(bookId, pageNumber, transcription, batchCustomId) { return (await getAdapter()).upsertPage(bookId, pageNumber, transcription, batchCustomId); }
export async function updatePageTranscription(bookId, pageNumber, transcription) { return (await getAdapter()).updatePageTranscription(bookId, pageNumber, transcription); }
export async function getPages(bookId, pageStart, pageEnd) { return (await getAdapter()).getPages(bookId, pageStart, pageEnd); }
export async function getPageByCustomId(id) { return (await getAdapter()).getPageByCustomId(id); }
export async function setPageTags(bookId, pageNumber, tags) { return (await getAdapter()).setPageTags(bookId, pageNumber, tags); }
export async function hasExistingTranscription(bookId, pageNumber) { return (await getAdapter()).hasExistingTranscription(bookId, pageNumber); }
export async function createBatchJob(batchId, bookIds) { return (await getAdapter()).createBatchJob(batchId, bookIds); }
export async function getBatchJob(batchId) { return (await getAdapter()).getBatchJob(batchId); }
export async function updateBatchJobStatus(batchId, status) { return (await getAdapter()).updateBatchJobStatus(batchId, status); }
export async function getInProgressBatchJobs() { return (await getAdapter()).getInProgressBatchJobs(); }
export async function createDimension(name, description, minLabel, maxLabel) { return (await getAdapter()).createDimension(name, description, minLabel, maxLabel); }
export async function getDimensionByName(name) { return (await getAdapter()).getDimensionByName(name); }
export async function getAllDimensions() { return (await getAdapter()).getAllDimensions(); }
export async function updateDimension(id, fields) { return (await getAdapter()).updateDimension(id, fields); }
export async function deleteDimension(id) { return (await getAdapter()).deleteDimension(id); }
export async function upsertPageSentiment(pageId, dimensionId, score, rationale, model) { return (await getAdapter()).upsertPageSentiment(pageId, dimensionId, score, rationale, model); }
export async function getPageSentiment(pageId) { return (await getAdapter()).getPageSentiment(pageId); }
export async function getBookSentiment(bookId, dimensionIds, pageStart, pageEnd) { return (await getAdapter()).getBookSentiment(bookId, dimensionIds, pageStart, pageEnd); }
export async function getPageImage(bookId, pageNumber) { return (await getAdapter()).getPageImage(bookId, pageNumber); }
export async function cachePageImages(bookId, images) { return (await getAdapter()).cachePageImages(bookId, images); }
export async function hasAnyPageImage(bookId) { return (await getAdapter()).hasAnyPageImage(bookId); }
export async function insertPageAfter(bookId, afterPageNumber) { return (await getAdapter()).insertPageAfter(bookId, afterPageNumber); }
export async function deletePage(bookId, pageNumber) { return (await getAdapter()).deletePage(bookId, pageNumber); }
