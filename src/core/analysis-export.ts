/**
 * Turns stored sentiment scores into a downloadable file. Three shapes, because
 * they answer different questions:
 *
 *   - `pages.csv`   — long format, one row per (page × dimension × method). The
 *                     research artifact: load it straight into R/pandas/SPSS.
 *   - `summary.csv` — one row per group, matching whatever slice the user chose
 *                     (per book, per tag, per method…). The at-a-glance table.
 *   - `analysis.json` — everything above plus the scope and coverage metadata,
 *                     for anyone re-plotting the run programmatically.
 *
 * Nothing here queries the database; callers pass in the rows and the aggregate
 * so a single fetch serves both the on-screen preview and the download.
 */
import type { AnalyzeResult } from './sentiment-analysis.js';
import type { SentimentScoreDetail } from './database.js';

export type ExportFormat = 'pages.csv' | 'summary.csv' | 'json';

export const EXPORT_FORMATS: ExportFormat[] = ['pages.csv', 'summary.csv', 'json'];

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
}

/**
 * Scores are means over floats, so they arrive with full binary precision
 * (0.7666666666666666). Four decimals is far finer than any instrument here
 * resolves and keeps the file readable.
 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** RFC 4180: quote a field when it contains a delimiter, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Array<Array<unknown>>): string {
  // A BOM keeps accented Spanish terms readable when the file is opened in Excel.
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Filesystem-safe slug for the downloaded filename. */
function slug(parts: string[]): string {
  const s = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || 'analysis';
}

/**
 * Name the download after what it contains: the scope when it's narrow enough to
 * be meaningful, the date always, so repeated runs don't collide in Downloads.
 */
function exportFilename(result: AnalyzeResult, format: ExportFormat): string {
  const scope =
    result.books.length === 1 ? result.books[0] : `${result.books.length}-books`;
  const dims = result.dimensions.length === 1 ? result.dimensions[0] : `${result.dimensions.length}-dimensions`;
  const date = new Date().toISOString().slice(0, 10);
  const stem = slug(['sentiment', scope, dims, date]);
  return format === 'json' ? `${stem}.json` : `${stem}-${format}`;
}

function pagesCsv(rows: SentimentScoreDetail[]): string {
  const header = [
    'book', 'page', 'tags', 'dimension', 'method', 'model', 'score', 'rationale',
  ];
  const body = [...rows]
    .sort(
      (a, b) =>
        a.book_title.localeCompare(b.book_title) ||
        a.dimension_name.localeCompare(b.dimension_name) ||
        a.method_name.localeCompare(b.method_name) ||
        a.page_number - b.page_number,
    )
    .map((r) => [
      r.book_title,
      r.page_number,
      r.tags.join('; '),
      r.dimension_name,
      r.method_name,
      r.model ?? '',
      round4(r.score),
      r.rationale ?? '',
    ]);
  return csv([header, ...body]);
}

function summaryCsv(result: AnalyzeResult): string {
  // A 'series' analysis has no per-group mean stored, so derive one from its
  // points — the summary sheet should be usable whichever shape was requested.
  const header = ['group', 'dimension', 'method', 'pages', 'mean_score'];
  const body = result.groups.map((g) => {
    const mean =
      g.mean ??
      (g.points && g.points.length
        ? Math.round((g.points.reduce((s, p) => s + p.score, 0) / g.points.length) * 1000) / 1000
        : '');
    return [g.key, g.dimension, g.method, g.count, mean];
  });
  return csv([header, ...body]);
}

export interface ExportInput {
  result: AnalyzeResult;
  rows: SentimentScoreDetail[];
  format: ExportFormat;
}

export function buildExport({ result, rows, format }: ExportInput): ExportFile {
  const filename = exportFilename(result, format);
  if (format === 'json') {
    const body = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: {
          books: result.books,
          dimensions: result.dimensions,
          methods: result.methods,
          tags: result.tags,
          groupBy: result.groupBy,
          aggregate: result.aggregate,
        },
        coverage: result.coverage,
        summary: result.summary,
        groups: result.groups,
        pages: rows.map((r) => ({
          book: r.book_title,
          page: r.page_number,
          tags: r.tags,
          dimension: r.dimension_name,
          method: r.method_name,
          model: r.model,
          score: round4(r.score),
          rationale: r.rationale,
        })),
      },
      null,
      2,
    );
    return { filename, contentType: 'application/json; charset=utf-8', body };
  }
  const body = format === 'pages.csv' ? pagesCsv(rows) : summaryCsv(result);
  return { filename, contentType: 'text/csv; charset=utf-8', body };
}
