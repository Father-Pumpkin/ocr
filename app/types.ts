// Mirrors the row shapes returned by the backend (src/core/database-adapter.ts).

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
  /** First machine OCR result, preserved for research (read-only). */
  original_transcription: string | null;
  /** Last quality-check verdict: null (unchecked) | 'ok' | 'suspect'. */
  ocr_quality: string | null;
  ocr_quality_reason: string | null;
  has_illustration: boolean;
  is_edited: boolean;
  status: string;
  batch_custom_id: string | null;
  tags: string; // JSON array string, e.g. '["climax"]'
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Parse a PageRow.tags JSON string into a string[], tolerating bad data. */
export function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
