export interface BookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  /** Book-level OCR quality verdict: null (unchecked) | 'ok' | 'suspect' | 'bad'. */
  ocr_quality: string | null;
  /** Human-readable note, e.g. "12 of 20 text pages flagged". */
  ocr_quality_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  /** First machine OCR result, preserved for research. Never overwritten by manual edits. Null for pre-migration edited pages. */
  original_transcription: string | null;
  /** Last OCR quality-check verdict: null (unchecked) | 'ok' | 'suspect'. Cleared when the transcription changes. */
  ocr_quality: string | null;
  /** When ocr_quality is 'suspect', a short reason from the proofreader. */
  ocr_quality_reason: string | null;
  has_illustration: boolean;
  is_edited: boolean;
  status: string;
  batch_custom_id: string | null;
  tags: string; // JSON array string e.g. '["climax"]'
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchJobRow {
  id: number;
  batch_id: string;
  book_ids: string; // JSON array string
  status: string;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DimensionRow {
  id: number;
  name: string;
  description: string;
  min_label: string;
  max_label: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageSentimentRow {
  id: number;
  page_id: number;
  dimension_id: number;
  score: number; // 0.0 to 1.0
  rationale: string | null;
  model: string | null;
  created_by: string | null;
  created_at: string;
}

export interface DatabaseAdapter {
  // Books
  upsertBook(driveFileId: string, driveFileName: string, title: string): Promise<BookRow>;
  getBookByDriveId(driveFileId: string): Promise<BookRow | undefined>;
  getBookByName(name: string): Promise<BookRow | undefined>;
  getAllBooks(): Promise<BookRow[]>;
  updateBookStatus(bookId: number, status: string, pageCount?: number): Promise<void>;
  /** Stores a book-level OCR quality verdict ('ok' | 'suspect' | 'bad') and note. */
  setBookQuality(bookId: number, quality: string, note: string | null): Promise<void>;
  /** Updates a book's display title (preserved across re-transcription). */
  setBookTitle(bookId: number, title: string): Promise<void>;

  // Pages
  upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void>;
  /** markEdited=true (default) flags a manual edit; false is for machine re-OCR and also captures original_transcription if not yet set. */
  updatePageTranscription(bookId: number, pageNumber: number, transcription: string, markEdited?: boolean): Promise<boolean>;
  getPages(bookId: number, pageStart?: number, pageEnd?: number): Promise<PageRow[]>;
  getPageByCustomId(batchCustomId: string): Promise<PageRow | undefined>;
  setPageTags(bookId: number, pageNumber: number, tags: string[]): Promise<boolean>;
  /** Distinct tags used across every page in the library, for the tag picker. */
  getAllTags(): Promise<string[]>;
  /** Stores an OCR quality verdict ('ok' | 'suspect') and reason for a page. */
  setPageQuality(bookId: number, pageNumber: number, quality: string, reason: string | null): Promise<boolean>;
  /** Sets a page's illustration-only flag. */
  setPageIllustration(bookId: number, pageNumber: number, isIllustration: boolean): Promise<boolean>;
  hasExistingTranscription(bookId: number, pageNumber: number): Promise<boolean>;

  // Batch jobs
  createBatchJob(batchId: string, bookIds: number[]): Promise<BatchJobRow>;
  getBatchJob(batchId: string): Promise<BatchJobRow | undefined>;
  updateBatchJobStatus(batchId: string, status: string): Promise<void>;
  getInProgressBatchJobs(): Promise<BatchJobRow[]>;

  // Dimensions
  createDimension(name: string, description: string, minLabel: string, maxLabel: string): Promise<DimensionRow>;
  getDimensionByName(name: string): Promise<DimensionRow | undefined>;
  getAllDimensions(): Promise<DimensionRow[]>;
  updateDimension(id: number, fields: { description?: string; minLabel?: string; maxLabel?: string }): Promise<DimensionRow | undefined>;
  deleteDimension(id: number): Promise<boolean>;

  // Page sentiment
  upsertPageSentiment(pageId: number, dimensionId: number, score: number, rationale: string | null, model: string | null): Promise<PageSentimentRow>;
  getPageSentiment(pageId: number): Promise<PageSentimentRow[]>;
  getBookSentiment(bookId: number, dimensionIds?: number[], pageStart?: number, pageEnd?: number): Promise<PageSentimentRow[]>;

  // Page images
  getPageImage(bookId: number, pageNumber: number): Promise<string | null>;
  setPageImage(bookId: number, pageNumber: number, imageData: string): Promise<void>;
  /** Object-storage key for a page image (R2), or null if stored as base64/absent. */
  getPageImageKey(bookId: number, pageNumber: number): Promise<string | null>;
  /** Points a page image at an object-storage key (clears the base64 blob). */
  setPageImageKey(bookId: number, pageNumber: number, objectKey: string): Promise<void>;
  cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>): Promise<void>;
  hasAnyPageImage(bookId: number): Promise<boolean>;

  // Page insertion / deletion
  insertPageAfter(bookId: number, afterPageNumber: number): Promise<PageRow>;
  deletePage(bookId: number, pageNumber: number): Promise<boolean>;
}
