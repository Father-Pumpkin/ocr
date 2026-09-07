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
import { getAllBooks, getBookByName, getAllDimensions, getAllMethods, getPages, getSentimentScores, } from './database.js';
import { isTextPage } from './quality.js';
import { resolveSections, sectionsForPage, parsePageTags, isMeaningfulSection, } from './sections.js';
const round3 = (x) => Math.round(x * 1000) / 1000;
async function resolveBooks(names) {
    const all = await getAllBooks();
    if (!names || names.length === 0)
        return all.filter((b) => b.status === 'complete');
    const wanted = [];
    for (const n of names) {
        const b = await getBookByName(n);
        if (b)
            wanted.push(b);
    }
    return wanted;
}
async function resolveDimensions(names) {
    const all = await getAllDimensions();
    if (!names || names.length === 0)
        return all;
    const byName = new Map(all.map((d) => [d.name, d]));
    return names.map((n) => byName.get(n)).filter((d) => !!d);
}
async function resolveMethods(names) {
    const all = await getAllMethods();
    if (!names || names.length === 0)
        return all;
    const byName = new Map(all.map((m) => [m.name, m]));
    return names.map((n) => byName.get(n)).filter((m) => !!m);
}
/** Which group(s) a score row belongs to (a row can land in several tag groups). */
function groupKeys(r, groupBy, tagFilter, sections) {
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
async function countTextPages(books, pageStart, pageEnd) {
    let n = 0;
    for (const b of books) {
        const pages = await getPages(b.id, pageStart, pageEnd);
        n += pages.filter(isTextPage).length;
    }
    return n;
}
export async function analyzeSentiment(input) {
    const books = await resolveBooks(input.bookNames);
    const dims = await resolveDimensions(input.dimensionNames);
    const methods = await resolveMethods(input.methods);
    const tagFilter = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const sectionSpecs = (input.sections ?? []).filter(isMeaningfulSection);
    // Resolved against every page of each in-scope book, not the range-filtered
    // set: a section's own boundary marker may sit outside the requested range.
    const sectionPages = [];
    if (sectionSpecs.length) {
        for (const b of books) {
            for (const pg of await getPages(b.id)) {
                sectionPages.push({ book_id: b.id, page_number: pg.page_number, tags: parsePageTags(pg.tags) });
            }
        }
    }
    const resolvedSections = resolveSections(sectionSpecs, sectionPages);
    const sectionCoverage = resolvedSections.map((r) => ({
        label: r.label,
        startTag: r.spec.startTag?.trim() || null,
        endTag: r.spec.endTag?.trim() || null,
        booksResolved: r.booksResolved,
        booksSkipped: r.booksSkipped,
    }));
    const groupBy = input.groupBy ?? (books.length > 1 ? 'book' : 'page');
    const aggregate = input.aggregate ?? (groupBy === 'page' ? 'series' : 'mean');
    const shell = (summary, extra) => ({
        groupBy,
        aggregate,
        dimensions: dims.map((d) => d.name),
        books: books.map((b) => b.title),
        methods: methods.map((m) => m.name),
        tags: tagFilter,
        sections: sectionCoverage,
        sectionsByPageId: {},
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
    if (input.pageStart !== undefined)
        rows = rows.filter((r) => r.page_number >= input.pageStart);
    if (input.pageEnd !== undefined)
        rows = rows.filter((r) => r.page_number <= input.pageEnd);
    if (tagFilter.length)
        rows = rows.filter((r) => r.tags.some((t) => tagFilter.includes(t)));
    if (resolvedSections.length) {
        rows = rows.filter((r) => sectionsForPage(resolvedSections, r.book_id, r.page_number).length > 0);
    }
    const textPages = await countTextPages(books, input.pageStart, input.pageEnd);
    const scoredPages = new Set(rows.map((r) => r.page_id)).size;
    const methodCount = new Set(rows.map((r) => r.method_name)).size;
    if (rows.length === 0) {
        return shell(`No sentiment scores found yet for ${describeScope(books, dims, tagFilter)}. ` +
            `Run score_pages for these books/dimensions first (${textPages} text page(s) in scope).`, { textPages, scoredPages: 0, scores: 0 });
    }
    const sectionsByPageId = {};
    if (resolvedSections.length) {
        for (const r of rows) {
            if (sectionsByPageId[r.page_id] === undefined) {
                sectionsByPageId[r.page_id] = sectionsForPage(resolvedSections, r.book_id, r.page_number);
            }
        }
    }
    // Partition by dimension, then method, then the requested group key — so each
    // (dimension, method) is its own set of series/bars and methods never blend.
    const groups = [];
    for (const dim of dims) {
        const dimRows = rows.filter((r) => r.dimension_id === dim.id);
        const byMethod = new Map();
        for (const r of dimRows) {
            const arr = byMethod.get(r.method_name);
            if (arr)
                arr.push(r);
            else
                byMethod.set(r.method_name, [r]);
        }
        for (const [methodName, mRows] of byMethod) {
            const buckets = new Map();
            for (const r of mRows) {
                for (const key of groupKeys(r, groupBy, tagFilter, resolvedSections)) {
                    const arr = buckets.get(key);
                    if (arr)
                        arr.push(r);
                    else
                        buckets.set(key, [r]);
                }
            }
            for (const [key, rs] of buckets) {
                if (aggregate === 'series') {
                    const points = [...rs]
                        .sort((a, b) => a.page_number - b.page_number)
                        .map((r) => ({ page_number: r.page_number, score: r.score, book_title: r.book_title, rationale: r.rationale }));
                    groups.push({ key, dimension: dim.name, method: methodName, count: points.length, points });
                }
                else {
                    const mean = rs.reduce((s, r) => s + r.score, 0) / rs.length;
                    groups.push({ key, dimension: dim.name, method: methodName, count: rs.length, mean: round3(mean) });
                }
            }
        }
    }
    groups.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.method.localeCompare(b.method) || a.key.localeCompare(b.key));
    const gap = textPages > scoredPages
        ? ` Note: only ${scoredPages}/${textPages} in-scope text page(s) are scored — run score_pages to fill the rest.`
        : '';
    // A section that resolved in only a handful of books is the likeliest reason a
    // result looks thinner than expected, so it is stated rather than left to be
    // inferred from a small count.
    const sectionNote = sectionCoverage.length
        ? ` Sections: ${sectionCoverage
            .map((sc) => `${sc.label} (${sc.booksResolved} book(s)${sc.booksSkipped ? `, ${sc.booksSkipped} skipped for a missing marker` : ''})`)
            .join('; ')}.`
        : '';
    const summary = `${groups.length} group(s) over ${dims.length} dimension(s) and ${methodCount} method(s) for ` +
        `${describeScope(books, dims, tagFilter)}, grouped by ${groupBy} as ${aggregate} (${rows.length} score(s)).${gap}${sectionNote}`;
    return {
        groupBy,
        aggregate,
        dimensions: dims.map((d) => d.name),
        books: books.map((b) => b.title),
        methods: [...new Set(rows.map((r) => r.method_name))].sort(),
        tags: tagFilter,
        sections: sectionCoverage,
        sectionsByPageId,
        groups,
        rows,
        coverage: { booksMatched: books.length, textPages, scoredPages, scores: rows.length },
        summary,
    };
}
function describeScope(books, dims, tags) {
    const bookPart = books.length === 1 ? `"${books[0].title}"` : `${books.length} books`;
    const dimPart = dims.length === 1 ? `"${dims[0].name}"` : `${dims.length} dimensions`;
    const tagPart = tags.length ? ` tagged [${tags.join(', ')}]` : '';
    return `${bookPart} on ${dimPart}${tagPart}`;
}
