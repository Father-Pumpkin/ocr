/**
 * Tag-bounded sections: "from the inciting incident to the climax", resolved
 * per book.
 *
 * An absolute page range can't express this. Page 6 is the first page of content
 * in one book and page 4 in another, so a fixed `pageStart`/`pageEnd` compares
 * different parts of different books. A section is defined by the structural
 * markers already tagged onto pages, and resolves to a different range in every
 * book — which is what makes "mean polarity in the final act" a question you can
 * ask across a whole corpus.
 *
 * Three rules decide what a section covers, each chosen deliberately:
 *
 *   - **Both ends inclusive.** The marker pages belong to the section that names
 *     them. Chained sections therefore overlap by one page at each shared
 *     boundary — which is correct rather than sloppy: the climax page genuinely
 *     belongs both to "up to the climax" and to "from the climax". Sections are
 *     independent groups, so an overlap double-counts nothing within a group.
 *
 *   - **A missing marker skips the book.** Only ~10 books carry `climax`, so a
 *     section bounded by it simply has nothing to say about the other 60. The
 *     alternative — clamping to the book's first/last page — would silently turn
 *     "inciting incident → climax" into "the whole book" for every book lacking
 *     both markers, quietly poisoning the mean. Callers get the skipped count so
 *     the UI can say how many books a section actually resolved in.
 *
 *   - **First occurrence starts, last occurrence ends.** A marker can span
 *     several pages (`author's note` covers 65 pages across 23 books). Starting
 *     at its first page and ending at its last means a section bounded by one
 *     contains all of it, in either direction.
 *
 * An omitted marker means "the edge of the book", so `{ endTag: 'climax' }` is
 * everything up to and including the climax.
 */

export interface SectionSpec {
  /** Optional display label. Defaults to "<start> → <end>". */
  name?: string;
  /** Tag marking the section's first page. Omitted = the start of the book. */
  startTag?: string | null;
  /** Tag marking the section's last page. Omitted = the end of the book. */
  endTag?: string | null;
}

/** The minimum a page needs to expose for section resolution. */
export interface SectionPage {
  book_id: number;
  page_number: number;
  tags: string[];
}

export interface SectionRange {
  /** Inclusive. */
  start: number;
  /** Inclusive. */
  end: number;
}

export interface ResolvedSection {
  label: string;
  spec: SectionSpec;
  /** book_id → inclusive page range. Books the section didn't resolve in are absent. */
  ranges: Map<number, SectionRange>;
  /** Books where both markers were found and the range was well-ordered. */
  booksResolved: number;
  /** Books skipped for a missing marker or markers in the wrong order. */
  booksSkipped: number;
}

export const BOOK_START = 'start of book';
export const BOOK_END = 'end of book';

/** Human-readable name for a section, used as the results group key. */
export function sectionLabel(spec: SectionSpec): string {
  const named = spec.name?.trim();
  if (named) return named;
  return `${spec.startTag?.trim() || BOOK_START} → ${spec.endTag?.trim() || BOOK_END}`;
}

/** Drop specs that say nothing — an unnamed whole-book section is not a section. */
export function isMeaningfulSection(spec: SectionSpec): boolean {
  return Boolean(spec.startTag?.trim() || spec.endTag?.trim());
}

/**
 * Resolve each spec against the pages of every book it can.
 *
 * `pages` must be the *complete* page list for each book in scope. Resolving
 * against an already-range-filtered list would look for markers in a window that
 * may not contain them, so an absolute page range has to be applied after this,
 * not before.
 */
export function resolveSections(specs: SectionSpec[], pages: SectionPage[]): ResolvedSection[] {
  const byBook = new Map<number, SectionPage[]>();
  for (const p of pages) {
    const arr = byBook.get(p.book_id);
    if (arr) arr.push(p);
    else byBook.set(p.book_id, [p]);
  }

  return specs.map((spec) => {
    const startTag = spec.startTag?.trim() || null;
    const endTag = spec.endTag?.trim() || null;
    const ranges = new Map<number, SectionRange>();
    let skipped = 0;

    for (const [bookId, bookPages] of byBook) {
      const numbers = bookPages.map((p) => p.page_number);
      if (numbers.length === 0) continue;

      // First page carrying the start marker; last carrying the end marker.
      const startMatches = startTag ? bookPages.filter((p) => p.tags.includes(startTag)) : [];
      const endMatches = endTag ? bookPages.filter((p) => p.tags.includes(endTag)) : [];
      if ((startTag && startMatches.length === 0) || (endTag && endMatches.length === 0)) {
        skipped++;
        continue;
      }

      const start = startTag
        ? Math.min(...startMatches.map((p) => p.page_number))
        : Math.min(...numbers);
      const end = endTag ? Math.max(...endMatches.map((p) => p.page_number)) : Math.max(...numbers);

      // Markers out of order (an "end" that precedes its "start") describes no
      // pages. Treated as a miss rather than silently swapped, because a swap
      // would report a confident range for a book that is tagged wrong.
      if (start > end) {
        skipped++;
        continue;
      }
      ranges.set(bookId, { start, end });
    }

    return {
      label: sectionLabel(spec),
      spec,
      ranges,
      booksResolved: ranges.size,
      booksSkipped: skipped,
    };
  });
}

/** Labels of every section containing this page. Empty = outside all of them. */
export function sectionsForPage(
  resolved: ResolvedSection[],
  bookId: number,
  pageNumber: number,
): string[] {
  const hits: string[] = [];
  for (const s of resolved) {
    const r = s.ranges.get(bookId);
    if (r && pageNumber >= r.start && pageNumber <= r.end) hits.push(s.label);
  }
  return hits;
}

/** Whether a page falls in any of the sections — the scope filter. */
export function pageInAnySection(
  resolved: ResolvedSection[],
  bookId: number,
  pageNumber: number,
): boolean {
  for (const s of resolved) {
    const r = s.ranges.get(bookId);
    if (r && pageNumber >= r.start && pageNumber <= r.end) return true;
  }
  return false;
}

/** Parse the page tags column (a JSON array string), tolerating anything odd. */
export function parsePageTags(tags: string | string[] | null | undefined): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  try {
    const parsed = JSON.parse(tags || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
