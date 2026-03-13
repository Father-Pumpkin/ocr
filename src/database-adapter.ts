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
}
