import { SqliteAdapter } from './database-sqlite.js';
import { createPostgresAdapter } from './database-postgres.js';
import type { DatabaseAdapter, BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow, SentimentScoreDetail, MethodRow, LexiconRow, LexiconSummary, LexiconTermRow, OcrRunRow } from './database-adapter.js';
import os from 'os';
import path from 'path';

export type { BookRow, PageRow, BatchJobRow, DimensionRow, PageSentimentRow, SentimentScoreDetail, MethodRow, LexiconRow, LexiconSummary, LexiconTermRow, OcrRunRow };

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
export async function setBookQuality(bookId: number, quality: string, note: string | null) { return (await getAdapter()).setBookQuality(bookId, quality, note); }
export async function setBookTitle(bookId: number, title: string) { return (await getAdapter()).setBookTitle(bookId, title); }
export async function upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string) { return (await getAdapter()).upsertPage(bookId, pageNumber, transcription, batchCustomId); }
export async function updatePageTranscription(bookId: number, pageNumber: number, transcription: string, markEdited?: boolean) { return (await getAdapter()).updatePageTranscription(bookId, pageNumber, transcription, markEdited); }
export async function getPages(bookId: number, pageStart?: number, pageEnd?: number) { return (await getAdapter()).getPages(bookId, pageStart, pageEnd); }
export async function getPageByCustomId(id: string) { return (await getAdapter()).getPageByCustomId(id); }
export async function setPageTags(bookId: number, pageNumber: number, tags: string[]) { return (await getAdapter()).setPageTags(bookId, pageNumber, tags); }
export async function getAllTags() { return (await getAdapter()).getAllTags(); }
export async function setPageQuality(bookId: number, pageNumber: number, quality: string, reason: string | null) { return (await getAdapter()).setPageQuality(bookId, pageNumber, quality, reason); }
export async function setPageIllustration(bookId: number, pageNumber: number, isIllustration: boolean) { return (await getAdapter()).setPageIllustration(bookId, pageNumber, isIllustration); }
export async function hasExistingTranscription(bookId: number, pageNumber: number) { return (await getAdapter()).hasExistingTranscription(bookId, pageNumber); }
export async function createBatchJob(batchId: string, bookIds: number[], kind?: string) { return (await getAdapter()).createBatchJob(batchId, bookIds, kind); }
export async function getBatchJob(batchId: string) { return (await getAdapter()).getBatchJob(batchId); }
export async function updateBatchJobStatus(batchId: string, status: string) { return (await getAdapter()).updateBatchJobStatus(batchId, status); }
export async function getInProgressBatchJobs() { return (await getAdapter()).getInProgressBatchJobs(); }
export async function getRecentBatchJobs(kind: string, limit: number) { return (await getAdapter()).getRecentBatchJobs(kind, limit); }
export async function createDimension(name: string, description: string, minLabel: string, maxLabel: string) { return (await getAdapter()).createDimension(name, description, minLabel, maxLabel); }
export async function getDimensionByName(name: string) { return (await getAdapter()).getDimensionByName(name); }
export async function getAllDimensions() { return (await getAdapter()).getAllDimensions(); }
export async function updateDimension(id: number, fields: { description?: string; minLabel?: string; maxLabel?: string }) { return (await getAdapter()).updateDimension(id, fields); }
export async function deleteDimension(id: number) { return (await getAdapter()).deleteDimension(id); }
export async function upsertPageSentiment(pageId: number, dimensionId: number, methodId: number, score: number, rationale: string | null, model: string | null) { return (await getAdapter()).upsertPageSentiment(pageId, dimensionId, methodId, score, rationale, model); }
export async function getPageSentiment(pageId: number) { return (await getAdapter()).getPageSentiment(pageId); }
export async function getBookSentiment(bookId: number, dimensionIds?: number[], pageStart?: number, pageEnd?: number) { return (await getAdapter()).getBookSentiment(bookId, dimensionIds, pageStart, pageEnd); }
export async function getSentimentScores(bookIds: number[], dimensionIds?: number[], methodIds?: number[]) { return (await getAdapter()).getSentimentScores(bookIds, dimensionIds, methodIds); }
export async function createMethod(name: string, kind: string, config: string) { return (await getAdapter()).createMethod(name, kind, config); }
export async function getMethodByName(name: string) { return (await getAdapter()).getMethodByName(name); }
export async function getAllMethods() { return (await getAdapter()).getAllMethods(); }
export async function deleteMethod(id: number) { return (await getAdapter()).deleteMethod(id); }
export async function createLexicon(name: string, scaleMin: number, scaleMax: number, note: string | null) { return (await getAdapter()).createLexicon(name, scaleMin, scaleMax, note); }
export async function getLexiconByName(name: string) { return (await getAdapter()).getLexiconByName(name); }
export async function insertLexiconTerms(terms: Array<{ lexiconId: number; dimensionId: number; term: string; value: number }>) { return (await getAdapter()).insertLexiconTerms(terms); }
export async function getAllLexicons() { return (await getAdapter()).getAllLexicons(); }
export async function deleteLexicon(id: number) { return (await getAdapter()).deleteLexicon(id); }
export async function getLexiconTerms(lexiconId: number, dimensionId: number) { return (await getAdapter()).getLexiconTerms(lexiconId, dimensionId); }
export async function getPageImage(bookId: number, pageNumber: number) { return (await getAdapter()).getPageImage(bookId, pageNumber); }
export async function setPageImage(bookId: number, pageNumber: number, imageData: string) { return (await getAdapter()).setPageImage(bookId, pageNumber, imageData); }
export async function getPageImageKey(bookId: number, pageNumber: number) { return (await getAdapter()).getPageImageKey(bookId, pageNumber); }
export async function setPageImageKey(bookId: number, pageNumber: number, objectKey: string) { return (await getAdapter()).setPageImageKey(bookId, pageNumber, objectKey); }
export async function cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>) { return (await getAdapter()).cachePageImages(bookId, images); }
export async function hasAnyPageImage(bookId: number) { return (await getAdapter()).hasAnyPageImage(bookId); }
export async function insertPageAfter(bookId: number, afterPageNumber: number) { return (await getAdapter()).insertPageAfter(bookId, afterPageNumber); }
export async function deletePage(bookId: number, pageNumber: number) { return (await getAdapter()).deletePage(bookId, pageNumber); }
export async function recordOcrRun(bookId: number, pageNumber: number, model: string | null, text: string) { return (await getAdapter()).recordOcrRun(bookId, pageNumber, model, text); }
export async function getOcrRuns(bookId: number, pageNumber: number) { return (await getAdapter()).getOcrRuns(bookId, pageNumber); }
