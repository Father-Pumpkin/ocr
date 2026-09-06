/**
 * Sentiment aggregation — turns stored page scores into the series/grouped data
 * a chart needs. Pure TS over getSentimentScores so the slicing logic (by page,
 * book, tag, book×tag, or method; as a per-page series or a group mean) lives in
 * one place and works identically on SQLite and Postgres.
 *
 * Scores are always partitioned by **method** as well, so when more than one
 * scoring instrument is in scope they overlay as distinct series/bars rather than
 * being averaged together — that's what powers "lexicon X vs lexicon Y vs Claude".
 *
 * One analyzeSentiment() call covers every requested chart shape:
 *   - whole book ............... books:[X], groupBy:'page', aggregate:'series'
 *   - two tags in one book ..... books:[X], tags:[A,B], groupBy:'tag', aggregate:'mean'
 *   - N books compared ......... books:[X,Y,Z], groupBy:'book', aggregate:'mean'
 *   - a tag across books ....... tags:[T], groupBy:'book', aggregate:'mean'
 *   - method vs method ......... methods:[A,B], groupBy:'method', aggregate:'mean'
 */
import {
  getAllBooks,
  getBookByName,
  getAllDimensions,
  getAllMethods,
  getPages,
  getSentimentScores,
  type BookRow,
  type DimensionRow,
  type MethodRow,
  type SentimentScoreDetail,
} from './database.js';
import { isTextPage } from './quality.js';

export type GroupBy = 'page' | 'book' | 'tag' | 'book_tag' | 'method';
export type Aggregate = 'series' | 'mean';

export interface AnalyzeInput {
  bookNames?: string[];
  dimensionNames?: string[];
  /** Scoring methods to include. Empty/undefined = all methods that have scores. */
  methods?: string[];
  tags?: string[];
  groupBy?: GroupBy;
  aggregate?: Aggregate;
  pageStart?: number;
  pageEnd?: number;
}

export interface SeriesPoint {
  page_number: number;
  score: number;
  book_title: string;
  rationale: string | null;
}

export interface AnalyzeGroup {
  /** Display label: a book title, a tag, "book — tag", or a method name. */
  key: string;
  dimension: string;
  /** The scoring instrument these scores came from. */
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
  /**
   * Every score row that survived the filters, ungrouped. The aggregation above
   * is a view of these; exports and any other per-page consumer use them directly
   * rather than re-running the same query with the same filters.
   */
  rows: SentimentScoreDetail[];
  coverage: {
    booksMatched: number;
    textPages: number;
    scoredPages: number;
    scores: number;
  };
  summary: string;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

async function resolveBooks(names?: string[]): Promise<BookRow[]> {
  const all = await getAllBooks();
  if (!names || names.length === 0) return all.filter((b) => b.status === 'complete');
  const wanted: BookRow[] = [];
  for (const n of names) {
    const b = await getBookByName(n);
    if (b) wanted.push(b);
  }
  return wanted;
}

async function resolveDimensions(names?: string[]): Promise<DimensionRow[]> {
  const all = await getAllDimensions();
  if (!names || names.length === 0) return all;
  const byName = new Map(all.map((d) => [d.name, d]));
  return names.map((n) => byName.get(n)).filter((d): d is DimensionRow => !!d);
}

async function resolveMethods(names?: string[]): Promise<MethodRow[]> {
  const all = await getAllMethods();
  if (!names || names.length === 0) return all;
  const byName = new Map(all.map((m) => [m.name, m]));
  return names.map((n) => byName.get(n)).filter((m): m is MethodRow => !!m);
}

/** Which group(s) a score row belongs to (a row can land in several tag groups). */
function groupKeys(r: SentimentScoreDetail, groupBy: GroupBy, tagFilter: string[]): string[] {
  switch (groupBy) {
    case 'page':
    case 'book':
      return [r.book_title];
    case 'method':
      return [r.method_name];
    case 'tag': {
      const tags = tagFilter.length ? r.tags.filter((t) => tagFilter.includes(t)) : r.tags;
      return tags.length ? tags : ['(untagged)'];
    }
    case 'book_tag': {
      const tags = tagFilter.length ? r.tags.filter((t) => tagFilter.includes(t)) : r.tags;
      return (tags.length ? tags : ['(untagged)']).map((t) => `${r.book_title} — ${t}`);
    }
  }
}

async function countTextPages(books: BookRow[], pageStart?: number, pageEnd?: number): Promise<number> {
  let n = 0;
  for (const b of books) {
    const pages = await getPages(b.id, pageStart, pageEnd);
    n += pages.filter(isTextPage).length;
  }
  return n;
}

export async function analyzeSentiment(input: AnalyzeInput): Promise<AnalyzeResult> {
  const books = await resolveBooks(input.bookNames);
  const dims = await resolveDimensions(input.dimensionNames);
  const methods = await resolveMethods(input.methods);
  const tagFilter = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);

  const groupBy: GroupBy = input.groupBy ?? (books.length > 1 ? 'book' : 'page');
  const aggregate: Aggregate = input.aggregate ?? (groupBy === 'page' ? 'series' : 'mean');

  const shell = (summary: string, extra?: Partial<AnalyzeResult['coverage']>): AnalyzeResult => ({
    groupBy,
    aggregate,
    dimensions: dims.map((d) => d.name),
    books: books.map((b) => b.title),
    methods: methods.map((m) => m.name),
    tags: tagFilter,
    groups: [],
    rows: [],
    coverage: { booksMatched: books.length, textPages: 0, scoredPages: 0, scores: 0, ...extra },
    summary,
  });

  if (books.length === 0) {
    return shell('No matching books. Run list_books to see what is available.');
  }
  if (dims.length === 0) {
    return shell('No sentiment dimensions defined. Create one with create_dimension, then run score_pages.');
  }

  const bookIds = books.map((b) => b.id);
  const dimIds = dims.map((d) => d.id);
  const methodIds = input.methods && input.methods.length > 0 ? methods.map((m) => m.id) : undefined;
  let rows = await getSentimentScores(bookIds, dimIds, methodIds);

  if (input.pageStart !== undefined) rows = rows.filter((r) => r.page_number >= input.pageStart!);
  if (input.pageEnd !== undefined) rows = rows.filter((r) => r.page_number <= input.pageEnd!);
  if (tagFilter.length) rows = rows.filter((r) => r.tags.some((t) => tagFilter.includes(t)));

  const textPages = await countTextPages(books, input.pageStart, input.pageEnd);
  const scoredPages = new Set(rows.map((r) => r.page_id)).size;
  const methodCount = new Set(rows.map((r) => r.method_name)).size;

  if (rows.length === 0) {
    return shell(
      `No sentiment scores found yet for ${describeScope(books, dims, tagFilter)}. ` +
        `Run score_pages for these books/dimensions first (${textPages} text page(s) in scope).`,
      { textPages, scoredPages: 0, scores: 0 },
    );
  }

  // Partition by dimension, then method, then the requested group key — so each
  // (dimension, method) is its own set of series/bars and methods never blend.
  const groups: AnalyzeGroup[] = [];
  for (const dim of dims) {
    const dimRows = rows.filter((r) => r.dimension_id === dim.id);
    const byMethod = new Map<string, SentimentScoreDetail[]>();
    for (const r of dimRows) {
      const arr = byMethod.get(r.method_name);
      if (arr) arr.push(r);
      else byMethod.set(r.method_name, [r]);
    }
    for (const [methodName, mRows] of byMethod) {
      const buckets = new Map<string, SentimentScoreDetail[]>();
      for (const r of mRows) {
        for (const key of groupKeys(r, groupBy, tagFilter)) {
          const arr = buckets.get(key);
          if (arr) arr.push(r);
          else buckets.set(key, [r]);
        }
      }
      for (const [key, rs] of buckets) {
        if (aggregate === 'series') {
          const points = [...rs]
            .sort((a, b) => a.page_number - b.page_number)
            .map((r) => ({ page_number: r.page_number, score: r.score, book_title: r.book_title, rationale: r.rationale }));
          groups.push({ key, dimension: dim.name, method: methodName, count: points.length, points });
        } else {
          const mean = rs.reduce((s, r) => s + r.score, 0) / rs.length;
          groups.push({ key, dimension: dim.name, method: methodName, count: rs.length, mean: round3(mean) });
        }
      }
    }
  }

  groups.sort((a, b) =>
    a.dimension.localeCompare(b.dimension) || a.method.localeCompare(b.method) || a.key.localeCompare(b.key),
  );

  const gap = textPages > scoredPages
    ? ` Note: only ${scoredPages}/${textPages} in-scope text page(s) are scored — run score_pages to fill the rest.`
    : '';
  const summary =
    `${groups.length} group(s) over ${dims.length} dimension(s) and ${methodCount} method(s) for ` +
    `${describeScope(books, dims, tagFilter)}, grouped by ${groupBy} as ${aggregate} (${rows.length} score(s)).${gap}`;

  return {
    groupBy,
    aggregate,
    dimensions: dims.map((d) => d.name),
    books: books.map((b) => b.title),
    methods: [...new Set(rows.map((r) => r.method_name))].sort(),
    tags: tagFilter,
    groups,
    rows,
    coverage: { booksMatched: books.length, textPages, scoredPages, scores: rows.length },
    summary,
  };
}

function describeScope(books: BookRow[], dims: DimensionRow[], tags: string[]): string {
  const bookPart = books.length === 1 ? `"${books[0].title}"` : `${books.length} books`;
  const dimPart = dims.length === 1 ? `"${dims[0].name}"` : `${dims.length} dimensions`;
  const tagPart = tags.length ? ` tagged [${tags.join(', ')}]` : '';
  return `${bookPart} on ${dimPart}${tagPart}`;
}
