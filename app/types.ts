// Mirrors the row shapes returned by the backend (src/core/database-adapter.ts).

export interface BookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
  /** Book-level OCR quality verdict: null | 'ok' | 'suspect' | 'bad'. */
  ocr_quality: string | null;
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

/** One machine OCR result for a page; the earliest run is the "original". */
export interface OcrRun {
  id: number;
  page_id: number;
  /** Model that produced this run, e.g. 'claude-sonnet-4-6'; null = unknown. */
  model: string | null;
  text: string;
  created_by: string | null;
  created_at: string;
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

/* ---- Sentiment analysis ---------------------------------------------------
   Mirrors src/core/analysis-service.ts. A *dimension* is what gets measured; a
   *style* is the instrument that measures it — either a bag-of-words dictionary
   or Claude reading the page.
-------------------------------------------------------------------------- */

export type StyleFamily = 'bag_of_words' | 'llm';

export interface AnalysisStyle {
  id: string;
  family: StyleFamily;
  label: string;
  description: string;
  /** False for catalogue dictionaries whose file hasn't been uploaded yet. */
  available: boolean;
  method?: string;
  model?: string;
  lexicon?: { name: string; termCount: number; dimensions: string[]; scale: [number, number] };
  /** Catalogue provenance: where the dictionary comes from and how to load it. */
  preset?: {
    id: string;
    sourceUrl: string | null;
    licence: string | null;
    sourceConfirmed: boolean;
    note: string;
  };
  hint?: string;
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

export interface LexiconSummary {
  id: number;
  name: string;
  scale_min: number;
  scale_max: number;
  note: string | null;
  created_at: string;
  term_count: number;
  dimensions: string[];
}

export interface AnalysisOptions {
  styles: AnalysisStyle[];
  dimensions: DimensionRow[];
  books: Array<{ title: string; pageCount: number | null }>;
  tags: string[];
  models: string[];
  defaultModel: string;
  /** Ceiling on a standard run, and on a batch submission. */
  maxLlmCalls: number;
  maxBatchItems: number;
  /** Pairs above which batch is the recommended mode. */
  batchThreshold: number;
  lexicons: LexiconSummary[];
  exportFormats: ExportFormat[];
  /** Bag-of-words methods that could be prewarmed over the whole library. */
  lexiconMethods: string[];
}

/** How a run executes: inline while you watch, or through the Batch API. */
export type RunMode = 'standard' | 'batch';

export type ExportFormat = 'pages.csv' | 'summary.csv' | 'json';

export interface ScoringEstimate {
  style: string;
  method: string;
  kind: string;
  books: number;
  dimensions: number;
  /** Page–dimension pairs this run would score. */
  pairs: number;
  alreadyScored: number;
  requiredCalls: number;
  /** What the server suggests for a scope this size. Always overridable. */
  recommendedMode: RunMode;
  batchThreshold: number;
  /** A standard run of this size would exceed maxLlmCalls. */
  capExceeded: boolean;
  /** A batch submission of this size would exceed maxBatchItems. */
  batchCapExceeded: boolean;
  maxLlmCalls: number | null;
  maxBatchItems: number | null;
  problem: string | null;
}

/** A sentiment batch in flight. DB-backed, so it outlives the page. */
export interface SentimentBatch {
  batchId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  bookCount: number;
}

/** Result of scanning the lexicons folder on disk. */
export interface SeedOutcome {
  file: string;
  lexicon: string;
  status: 'imported' | 'skipped' | 'failed';
  terms?: number;
  reason?: string;
}

export interface AnalysisRun {
  id: string;
  status: 'running' | 'submitted' | 'complete' | 'error';
  mode: RunMode;
  /** Batch runs only: the Anthropic batch to watch. */
  batchId: string | null;
  style: string;
  method: string;
  done: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  scope: {
    books?: string[];
    dimensions?: string[];
    tags?: string[];
    pageStart?: number;
    pageEnd?: number;
  };
  result: { message: string; scored: number; failed: number; skipped: number } | null;
  error: string | null;
}

export type GroupBy = 'page' | 'book' | 'tag' | 'book_tag' | 'method';
export type Aggregate = 'series' | 'mean';

export interface SeriesPoint {
  page_number: number;
  score: number;
  book_title: string;
  rationale: string | null;
}

export interface AnalyzeGroup {
  key: string;
  dimension: string;
  method: string;
  count: number;
  mean?: number;
  points?: SeriesPoint[];
}

export interface AnalyzeResult {
  groupBy: GroupBy;
  aggregate: Aggregate;
  dimensions: string[];
  books: string[];
  methods: string[];
  tags: string[];
  groups: AnalyzeGroup[];
  coverage: { booksMatched: number; textPages: number; scoredPages: number; scores: number };
  summary: string;
}

export interface LexiconPreview {
  format: 'json' | 'delimited';
  /** One term per line, no value column — a polarity list rather than a table. */
  isWordList: boolean;
  columns: string[];
  sampleRows: Array<Record<string, string>>;
  rowCount: number;
  numericColumns: string[];
  /** True when the first row was read as data rather than column names. */
  headerless: boolean;
  /** Value columns holding repeated words rather than numbers, with the labels found. */
  labelColumns: Array<{ column: string; labels: string[] }>;
  observedRange: { min: number; max: number } | null;
  delimiter?: string;
  /** Matched catalogue entry, when the filename identifies a known dictionary. */
  preset?: {
    id: string;
    sourceUrl: string | null;
    licence: string | null;
    sourceConfirmed: boolean;
    note: string;
    format: {
      kind: 'delimited' | 'wordlist';
      delimiter?: string;
      termColumn?: string;
      valueColumn?: string;
      hasHeader?: boolean;
      labelValues?: Record<string, number>;
      scale: [number, number];
      polarityFiles?: Array<{ match: string; value: number }>;
    } | null;
  };
}

/** The scope + shape of an analysis read; serialized into the results/export query. */
export interface AnalysisQuery {
  books?: string[];
  dimensions?: string[];
  methods?: string[];
  tags?: string[];
  groupBy?: GroupBy;
  aggregate?: Aggregate;
  pageStart?: number;
  pageEnd?: number;
}
