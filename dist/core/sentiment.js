/**
 * Sentiment scoring orchestration — the hybrid engine that populates
 * page_sentiment, now method-aware. Resolves book / dimension / method, collects
 * the (page, dimension) pairs still needing a score *for that method*, and runs:
 *   - lexicon methods locally & synchronously (no API, instant, free),
 *   - LLM methods inline for small scopes or via the Anthropic Batch API for large.
 *
 * Reuses quality.ts's mapLimit / isTextPage and the Scorer abstraction in scoring.ts.
 *
 * Callers that run interactively (the web app) pass `onProgress` to drive a
 * progress bar and one of two ceilings, depending on how the run will execute:
 * `maxLlmCalls` bounds a *standard* (inline) run, which the user waits on, and
 * `maxBatchItems` bounds a *batch* submission, which can be far larger because
 * it costs no wall-clock. `estimateScoring` answers "how big is this run, and
 * which way should it go?" without spending anything.
 */
import { getAllBooks, getBookByName, getAllDimensions, getMethodByName, getPages, getSentimentScores, upsertPageSentiment, createBatchJob, } from './database.js';
import { createSentimentBatch, DEFAULT_MODEL } from './ocr.js';
import { getScorer, parseMethodConfig } from './scoring.js';
import { mapLimit, isTextPage } from './quality.js';
// Below this many page×dimension pairs, an LLM method scores inline; at/above it
// submits a Batch API job. Lexicon methods ignore this — they always run locally.
const INLINE_MAX_ITEMS = 40;
const CONCURRENCY = 5;
const DEFAULT_METHOD = 'claude-default';
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
/** Page tags are stored as a JSON array string; tolerate anything malformed. */
function pageTags(page) {
    try {
        const parsed = JSON.parse(page.tags || '[]');
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch {
        return [];
    }
}
/** (page, dimension) pairs in scope still needing a score for this method. */
async function collectItems(books, dims, pageStart, pageEnd, overwrite, methodId, tags = []) {
    const bookIds = books.map((b) => b.id);
    const dimIds = dims.map((d) => d.id);
    const existing = overwrite
        ? new Set()
        : new Set((await getSentimentScores(bookIds, dimIds, [methodId])).map((r) => `${r.page_id}:${r.dimension_id}`));
    const items = [];
    let skipped = 0;
    for (const book of books) {
        const pages = await getPages(book.id, pageStart, pageEnd);
        for (const p of pages) {
            if (!isTextPage(p))
                continue;
            if (tags.length && !pageTags(p).some((t) => tags.includes(t)))
                continue;
            for (const d of dims) {
                if (existing.has(`${p.id}:${d.id}`)) {
                    skipped++;
                    continue;
                }
                items.push({ pageId: p.id, dimension: d, text: p.transcription ?? '' });
            }
        }
    }
    return { items, skipped };
}
/**
 * Above this many page-dimension pairs, an LLM run is recommended to go through
 * the Batch API: ~50% cheaper, and a standard run of that size would keep the
 * user staring at a progress bar for many minutes. It is only a recommendation —
 * callers may run either way.
 */
export const BATCH_RECOMMEND_THRESHOLD = 100;
/**
 * How big would this run be? Resolves exactly the same scope scorePages would,
 * but stops before spending anything — so the UI can show the cost up front and
 * refuse an over-cap run without a wasted round trip.
 */
export async function estimateScoring(input) {
    const methodName = input.method ?? DEFAULT_METHOD;
    const method = await getMethodByName(methodName);
    const books = await resolveBooks(input.bookNames);
    const dims = await resolveDimensions(input.dimensionNames);
    const cap = input.maxLlmCalls ?? null;
    const batchCap = input.maxBatchItems ?? null;
    const shell = (problem) => ({
        method: methodName,
        kind: method?.kind ?? 'llm',
        books: books.length,
        dimensions: dims.length,
        pairs: 0,
        alreadyScored: 0,
        requiredCalls: 0,
        recommendedMode: 'standard',
        batchThreshold: BATCH_RECOMMEND_THRESHOLD,
        capExceeded: false,
        batchCapExceeded: false,
        maxLlmCalls: cap,
        maxBatchItems: batchCap,
        problem,
    });
    if (!method)
        return shell(`Scoring method "${methodName}" not found.`);
    if (books.length === 0)
        return shell('No matching transcribed books in scope.');
    if (dims.length === 0)
        return shell('No sentiment dimensions selected.');
    const { items, skipped } = await collectItems(books, dims, input.pageStart, input.pageEnd, !!input.overwrite, method.id, input.tags);
    const requiredCalls = method.kind === 'lexicon' ? 0 : items.length;
    const recommendedMode = method.kind === 'lexicon' || items.length <= BATCH_RECOMMEND_THRESHOLD ? 'standard' : 'batch';
    return {
        ...shell(null),
        kind: method.kind,
        pairs: items.length,
        alreadyScored: skipped,
        requiredCalls,
        recommendedMode,
        capExceeded: cap !== null && requiredCalls > cap,
        batchCapExceeded: batchCap !== null && requiredCalls > batchCap,
    };
}
/**
 * Score pages on dimensions with a chosen method, caching into page_sentiment.
 * Already-scored (page, dimension, method) triples are skipped unless `overwrite`.
 */
export async function scorePages(input) {
    const methodName = input.method ?? DEFAULT_METHOD;
    const method = await getMethodByName(methodName);
    const books = await resolveBooks(input.bookNames);
    const dims = await resolveDimensions(input.dimensionNames);
    const base = {
        method: methodName,
        scored: 0,
        failed: 0,
        skipped: 0,
        submitted: 0,
        batchId: null,
        books: books.length,
        dimensions: dims.length,
        capExceeded: false,
        requiredCalls: 0,
    };
    if (!method) {
        return { ...base, mode: 'noop', message: `Scoring method "${methodName}" not found. Run list_methods, or create one with create_method.` };
    }
    if (books.length === 0) {
        return { ...base, mode: 'noop', message: 'No matching transcribed books to score. Run list_books to see what is available.' };
    }
    if (dims.length === 0) {
        return { ...base, mode: 'noop', message: 'No sentiment dimensions defined. Create one first with create_dimension.' };
    }
    const { items, skipped } = await collectItems(books, dims, input.pageStart, input.pageEnd, !!input.overwrite, method.id, input.tags);
    base.skipped = skipped;
    if (items.length === 0) {
        return { ...base, mode: 'noop', message: `Nothing to score — all ${skipped} in-scope page–dimension pair(s) already have a "${methodName}" score. Pass overwrite: true to re-score.` };
    }
    // Lexicon methods are local, deterministic, and free — always run synchronously.
    if (method.kind === 'lexicon') {
        const scorer = await getScorer(method);
        let scored = 0;
        let failed = 0;
        let done = 0;
        for (const it of items) {
            const r = await scorer.score(it.text, it.dimension);
            if (r) {
                await upsertPageSentiment(it.pageId, it.dimension.id, method.id, r.score, r.rationale || null, r.model);
                scored++;
            }
            else {
                failed++;
            }
            input.onProgress?.(++done, items.length);
        }
        return {
            ...base,
            mode: 'inline',
            scored,
            failed,
            message: `Scored ${scored} page–dimension pair(s) with lexicon method "${methodName}"` +
                (failed ? `, ${failed} had no lexicon hits` : '') +
                (skipped ? `, skipped ${skipped} already-scored` : '') +
                '.',
        };
    }
    // LLM methods: every pair costs one API call. Resolve *how* the run will
    // execute first, because a standard run and a batch submission are held to
    // very different ceilings — and check that ceiling before anything goes out.
    base.requiredCalls = items.length;
    const cfg = parseMethodConfig(method);
    const llmModel = cfg.model || input.model || DEFAULT_MODEL;
    const mode = input.mode === 'inline' || input.mode === 'batch'
        ? input.mode
        : items.length <= INLINE_MAX_ITEMS
            ? 'inline'
            : 'batch';
    const cap = mode === 'batch' ? input.maxBatchItems : input.maxLlmCalls;
    if (cap !== undefined && items.length > cap) {
        return {
            ...base,
            mode: 'noop',
            capExceeded: true,
            message: mode === 'batch'
                ? `This batch would submit ${items.length} score(s), over the limit of ${cap}. Narrow the scope, or raise the limit.`
                : `This run needs ${items.length} Claude call(s), over the standard-run limit of ${cap}. ` +
                    `Narrow the scope (fewer books, a page range, or one dimension at a time), submit it as a batch, or raise the limit.`,
        };
    }
    if (mode === 'batch') {
        const batchItems = items.map((it) => ({
            pageId: it.pageId,
            dimensionId: it.dimension.id,
            methodId: method.id,
            text: it.text,
            dimension: it.dimension,
            promptOverride: cfg.prompt,
        }));
        const batchId = await createSentimentBatch(batchItems, llmModel);
        await createBatchJob(batchId, books.map((b) => b.id), 'sentiment');
        return {
            ...base,
            mode: 'batch',
            submitted: items.length,
            batchId,
            message: `Submitted ${items.length} page–dimension score(s) for method "${methodName}" to the Batch API as ${batchId} ` +
                `(~50% cheaper, ~1h turnaround). Call check_batch with this id to store the results.` +
                (skipped ? ` Skipped ${skipped} already-scored.` : ''),
        };
    }
    const scorer = await getScorer(method, input.model);
    let scored = 0;
    let failed = 0;
    let done = 0;
    await mapLimit(items, CONCURRENCY, async (it) => {
        const r = await scorer.score(it.text, it.dimension);
        if (r) {
            await upsertPageSentiment(it.pageId, it.dimension.id, method.id, r.score, r.rationale || null, r.model);
            scored++;
        }
        else {
            failed++;
        }
        input.onProgress?.(++done, items.length);
    });
    return {
        ...base,
        mode: 'inline',
        scored,
        failed,
        message: `Scored ${scored} page–dimension pair(s) inline with "${methodName}"` +
            (failed ? `, ${failed} could not be scored` : '') +
            (skipped ? `, skipped ${skipped} already-scored` : '') +
            '.',
    };
}
