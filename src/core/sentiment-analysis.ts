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
import {
  resolveSections,
  sectionsForPage,
  pageInAnySection,
  parsePageTags,
  isMeaningfulSection,
  type SectionSpec,
  type SectionPage,
  type ResolvedSection,
} from './sections.js';

export type GroupBy = 'page' | 'book' | 'tag' | 'book_tag' | 'method' | 'section' | 'book_section';

export const GROUP_BY_VALUES: readonly GroupBy[] = [
  'page', 'book', 'tag', 'book_tag', 'method', 'section', 'book_section',
];
export const AGGREGATE_VALUES: readonly Aggregate[] = ['series', 'mean'];
export type Aggregate = 'series' | 'mean';

export interface AnalyzeInput {
  bookNames?: string[];
  dimensionNames?: string[];
  /** Scoring methods to include. Empty/undefined = all methods that have scores. */
  methods?: string[];
  tags?: string[];
  /**
   * Tag-bounded sections, resolved per book (see core/sections). Supplying any
   * restricts the rows to their union; with groupBy 'section' each becomes its
   * own group, which is how sections get compared against each other.
   */
  sections?: SectionSpec[];
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

/**
 * How a group's scores are actually distributed.
 *
 * The mean on its own was misleading in ways that showed up immediately in real
 * data. Three cases from this corpus, all of which a bare mean renders
 * identically to a well-behaved one:
 *
 *   - A book whose pages are half at 0.0 and half at 1.0 has a mean of 0.500 and
 *     lands exactly on the "neutral" midpoint, despite containing no neutral
 *     page at all. `sd` and `railShare` separate that from genuine neutrality.
 *   - A group's mean can sit two thirds of the axis away from its median when
 *     the distribution is skewed — one book reads mean 0.577, median 1.000.
 *   - Some instruments are effectively binary classifiers (one puts 60% of pages
 *     at 0 or 1; another puts 0.4% there), so their "means" are not the same
 *     kind of quantity and should not be compared as if they were.
 *
 * `nBooks` exists because `count` is pages, and pages within one book are not
 * independent observations. A group of 50 pages drawn from 10 books, one of
 * which supplies a quarter of them, is weaker evidence than the count suggests.
 *
 * All of it is arithmetic over rows already in memory — no extra queries.
 */
export interface GroupStats {
  sd: number;
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
  /** Half-width of the 95% CI of the mean (1.96 × standard error). */
  ci95: number;
  /** Distinct books behind the group — the real unit of replication. */
  nBooks: number;
  /** Share of scores pinned at 0 or 1; high values mean a near-binary instrument. */
  railShare: number;
}

export interface AnalyzeGroup {
  /** Display label: a book title, a tag, "book — tag", a method, or a section. */
  key: string;
  dimension: string;
  /** The scoring instrument these scores came from. */
  method: string;
  count: number;
  mean?: number;
  /** Present whenever a mean is. See GroupStats for why the mean isn't enough. */
  stats?: GroupStats;
  /**
   * The pages this group averaged over, so a reader can go from a number back to
   * the text behind it. Membership depends on the grouping rule, which lives
   * here — recomputing it in the client would be a second copy of that logic,
   * free to drift from this one.
   */
  pageIds?: number[];
  points?: SeriesPoint[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describe(rows: SentimentScoreDetail[]): GroupStats {
  const values = rows.map((r) => r.score).sort((a, b) => a - b);
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  // Population sd: these are all the scored pages in the group, not a sample
  // drawn from a larger pool of them.
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return {
    sd: round3(sd),
    median: round3(quantile(values, 0.5)),
    q1: round3(quantile(values, 0.25)),
    q3: round3(quantile(values, 0.75)),
    min: round3(values[0]),
    max: round3(values[n - 1]),
    ci95: round3(n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0),
    nBooks: new Set(rows.map((r) => r.book_id)).size,
    railShare: round3(values.filter((v) => v <= 0.001 || v >= 0.999).length / n),
  };
}

export interface SectionCoverage {
  label: string;
  startTag: string | null;
  endTag: string | null;
  booksResolved: number;
  /** Books lacking one of the markers — the section says nothing about them. */
  booksSkipped: number;
}

export interface AnalyzeResult {
  groupBy: GroupBy;
  aggregate: Aggregate;
  dimensions: string[];
  books: string[];
  methods: string[];
  tags: string[];
  /** One entry per section asked for, with how many books it resolved in. */
  sections: SectionCoverage[];
  /**
   * page_id → the sections containing it. Keyed by page rather than by score
   * row because membership depends only on where the page sits in its book, not
   * on which dimension or method scored it. Empty unless sections were asked for.
   */
  sectionsByPageId: Record<number, string[]>;
  /**
   * book title → the first and last page it actually has. Lets a client place a
   * page at its true position in its book rather than within whatever subset an
   * instrument happened to score.
   */
  bookPageSpans: Record<string, { first: number; last: number }>;
  /**
   * section label → book title → the scenes that section covers in that book.
   *
   * With a section applied the arc runs over the section, not the book, so a
   * position axis has to be measured against this rather than the book's full
   * span. It comes from the server because section boundaries are resolved
   * here; deriving them from the plotted points would make the axis depend on
   * which scenes an instrument happened to score.
   */
  sectionRanges: Record<string, Record<string, { first: number; last: number }>>;
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

/**
 * How a grouping reads in prose. The parameter values stay as they are — they
 * are the API contract, and MCP callers pass them literally — but a sentence
 * shown to a person should use the words the app uses everywhere else.
 */
const GROUP_BY_PROSE: Record<GroupBy, string> = {
  page: 'scene',
  book: 'book',
  tag: 'tag',
  book_tag: 'book × tag',
  method: 'method',
  section: 'section',
  book_section: 'book × section',
};

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
function groupKeys(
  r: SentimentScoreDetail,
  groupBy: GroupBy,
  tagFilter: string[],
  sections: ResolvedSection[],
): string[] {
  switch (groupBy) {
    case 'page':
    case 'book':
      return [r.book_title];
    case 'method':
      return [r.method_name];
    case 'section': {
      // Sections may overlap at a shared boundary marker, so one page can land
      // in two groups. That's intended — see core/sections.
      const hits = sectionsForPage(sections, r.book_id, r.page_number);
      return hits.length ? hits : ['(outside every section)'];
    }
    case 'book_section': {
      // The axis that shows whether a corpus-level arc is real. Grouping by
      // section alone pools every book together and hides the spread; grouping
      // by book alone collapses each book to one number and hides the arc. Only
      // the cross of the two shows that a book can run opposite to the average.
      const hits = sectionsForPage(sections, r.book_id, r.page_number);
      return (hits.length ? hits : ['(outside every section)']).map((sec) => `${r.book_title} — ${sec}`);
    }
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

/**
 * Count in-scope text pages, and record each book's real page span on the way
 * through.
 *
 * The span matters for any "position in book" axis. Deriving position from the
 * *scored* pages instead puts the same physical page at a different position for
 * every instrument, because dictionaries differ in which pages they match at
 * all — one dictionary finding a word on page 1 and another not shifts every
 * point of one line relative to the other. Anchoring to the book fixes that, and
 * `books.page_count` can't be used for it: it still holds the pre-split spread
 * count and understates 60 of the 72 books here.
 */
async function scanPages(
  books: BookRow[],
  pageStart: number | undefined,
  pageEnd: number | undefined,
  sections: ResolvedSection[],
): Promise<{ textPages: number; spans: Record<string, { first: number; last: number }> }> {
  let textPages = 0;
  const spans: Record<string, { first: number; last: number }> = {};
  for (const b of books) {
    const pages = await getPages(b.id, pageStart, pageEnd);
    // "In scope" has to mean the same thing the filters mean. Counting every
    // text page while a section admits none produced "0 scores … 115 text pages
    // in scope", which reads as missing data rather than an empty filter.
    const inScope = sections.length
      ? pages.filter((p) => pageInAnySection(sections, b.id, p.page_number))
      : pages;
    textPages += inScope.filter(isTextPage).length;
    const numbers = pages.map((p) => p.page_number);
    if (numbers.length) {
      spans[b.title] = { first: Math.min(...numbers), last: Math.max(...numbers) };
    }
  }
  return { textPages, spans };
}

export async function analyzeSentiment(input: AnalyzeInput): Promise<AnalyzeResult> {
  const books = await resolveBooks(input.bookNames);
  const dims = await resolveDimensions(input.dimensionNames);
  const methods = await resolveMethods(input.methods);
  const tagFilter = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const sectionSpecs = (input.sections ?? []).filter(isMeaningfulSection);

  // Resolved against every page of each in-scope book, not the range-filtered
  // set: a section's own boundary marker may sit outside the requested range.
  const sectionPages: SectionPage[] = [];
  if (sectionSpecs.length) {
    for (const b of books) {
      for (const pg of await getPages(b.id)) {
        sectionPages.push({ book_id: b.id, page_number: pg.page_number, tags: parsePageTags(pg.tags) });
      }
    }
  }
  const resolvedSections = resolveSections(sectionSpecs, sectionPages);
  const sectionCoverage: SectionCoverage[] = resolvedSections.map((r) => ({
    label: r.label,
    startTag: r.spec.startTag?.trim() || null,
    endTag: r.spec.endTag?.trim() || null,
    booksResolved: r.booksResolved,
    booksSkipped: r.booksSkipped,
  }));

  const groupBy: GroupBy = input.groupBy ?? (books.length > 1 ? 'book' : 'page');
  const aggregate: Aggregate = input.aggregate ?? (groupBy === 'page' ? 'series' : 'mean');

  const shell = (summary: string, extra?: Partial<AnalyzeResult['coverage']>): AnalyzeResult => ({
    groupBy,
    aggregate,
    dimensions: dims.map((d) => d.name),
    books: books.map((b) => b.title),
    methods: methods.map((m) => m.name),
    tags: tagFilter,
    sections: sectionCoverage,
    sectionsByPageId: {},
    bookPageSpans: {},
    sectionRanges: {},
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
  if (resolvedSections.length) {
    rows = rows.filter((r) => sectionsForPage(resolvedSections, r.book_id, r.page_number).length > 0);
  }

  const { textPages, spans: bookPageSpans } = await scanPages(books, input.pageStart, input.pageEnd, resolvedSections);
  const scoredPages = new Set(rows.map((r) => r.page_id)).size;
  const methodCount = new Set(rows.map((r) => r.method_name)).size;

  if (rows.length === 0) {
    // An empty result has two very different causes, and blaming the wrong one
    // sends people off to re-run scoring that has already happened. A section
    // that resolved in no book is a filter problem, not a missing-data problem.
    const deadSections = sectionCoverage.filter((sc) => sc.booksResolved === 0);
    if (sectionCoverage.length > 0 && deadSections.length === sectionCoverage.length) {
      const which =
        deadSections.length === 1
          ? `the section “${deadSections[0].label}”`
          : `none of the ${deadSections.length} sections`;
      return shell(
        `No scenes are in scope — ${which} matched any of the ${books.length} selected book(s), ` +
          `because they do not carry both marker tags. Only some books here have narrative markers such as ` +
          `“climax”. Pick a section whose tags these books do have, or clear the section to use every scene.`,
        { textPages, scoredPages: 0, scores: 0 },
      );
    }
    return shell(
      `No sentiment scores found yet for ${describeScope(books, dims, tagFilter)}` +
        `${sectionCoverage.length ? ' within the selected section(s)' : ''}. ` +
        `Score these scenes first (${textPages} text scene(s) in scope).`,
      { textPages, scoredPages: 0, scores: 0 },
    );
  }

  const titleById = new Map(books.map((b) => [b.id, b.title]));
  const sectionRanges: Record<string, Record<string, { first: number; last: number }>> = {};
  for (const resolved of resolvedSections) {
    const perBook: Record<string, { first: number; last: number }> = {};
    for (const [bookId, range] of resolved.ranges) {
      const title = titleById.get(bookId);
      if (title) perBook[title] = { first: range.start, last: range.end };
    }
    sectionRanges[resolved.label] = perBook;
  }

  const sectionsByPageId: Record<number, string[]> = {};
  if (resolvedSections.length) {
    for (const r of rows) {
      if (sectionsByPageId[r.page_id] === undefined) {
        sectionsByPageId[r.page_id] = sectionsForPage(resolvedSections, r.book_id, r.page_number);
      }
    }
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
        for (const key of groupKeys(r, groupBy, tagFilter, resolvedSections)) {
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
          groups.push({
            key,
            dimension: dim.name,
            method: methodName,
            count: rs.length,
            mean: round3(mean),
            stats: describe(rs),
            pageIds: [...new Set(rs.map((r) => r.page_id))],
          });
        }
      }
    }
  }

  // Sections keep the order they were defined in. Sorting them alphabetically
  // would put "climax → denouement" before "inciting incident → climax" and
  // render a narrative arc backwards; the order the user listed them in is the
  // order they mean. Everything else is alphabetical.
  const sectionOrder = new Map(sectionCoverage.map((sc, i) => [sc.label, i]));
  const keyRank = (key: string): number =>
    groupBy === 'section' ? (sectionOrder.get(key) ?? Number.MAX_SAFE_INTEGER) : 0;
  groups.sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      a.method.localeCompare(b.method) ||
      keyRank(a.key) - keyRank(b.key) ||
      a.key.localeCompare(b.key),
  );

  const gap = textPages > scoredPages
    ? ` Note: only ${scoredPages}/${textPages} in-scope text scene(s) are scored — score the rest to fill them in.`
    : '';
  // A section that resolved in only a handful of books is the likeliest reason a
  // result looks thinner than expected, so it is stated rather than left to be
  // inferred from a small count.
  const sectionNote = sectionCoverage.length
    ? ` Sections: ${sectionCoverage
        .map((sc) => `${sc.label} (${sc.booksResolved} book(s)${sc.booksSkipped ? `, ${sc.booksSkipped} skipped for a missing marker` : ''})`)
        .join('; ')}.`
    : '';
  const summary =
    `${groups.length} group(s) over ${dims.length} dimension(s) and ${methodCount} method(s) for ` +
    `${describeScope(books, dims, tagFilter)}, grouped by ${GROUP_BY_PROSE[groupBy]} as ${aggregate} (${rows.length} score(s)).${gap}${sectionNote}`;

  return {
    groupBy,
    aggregate,
    dimensions: dims.map((d) => d.name),
    books: books.map((b) => b.title),
    methods: [...new Set(rows.map((r) => r.method_name))].sort(),
    tags: tagFilter,
    sections: sectionCoverage,
    sectionsByPageId,
    bookPageSpans,
    sectionRanges,
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
