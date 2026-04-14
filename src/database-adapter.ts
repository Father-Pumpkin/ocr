export interface BookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
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

  // Pages
  upsertPage(bookId: number, pageNumber: number, transcription: string, batchCustomId?: string): Promise<void>;
  updatePageTranscription(bookId: number, pageNumber: number, transcription: string): Promise<boolean>;
  getPages(bookId: number, pageStart?: number, pageEnd?: number): Promise<PageRow[]>;
  getPageByCustomId(batchCustomId: string): Promise<PageRow | undefined>;
  setPageTags(bookId: number, pageNumber: number, tags: string[]): Promise<boolean>;
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
  cachePageImages(bookId: number, images: Array<{ pageNumber: number; imageData: string }>): Promise<void>;
  hasAnyPageImage(bookId: number): Promise<boolean>;

  // Page insertion
  insertPageAfter(bookId: number, afterPageNumber: number): Promise<PageRow>;
}
