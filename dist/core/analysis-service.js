/**
 * analysis-service: everything the web app's Sentiment Analysis screen needs,
 * in the shape the screen needs it. The MCP tools drive `sentiment.ts` and
 * `sentiment-analysis.ts` directly; this module wraps the same functions with
 * the extras an interactive UI requires and the tools don't:
 *
 *   - a **style** vocabulary — the app offers two families of instrument,
 *     "bag of words" (a dictionary, scored locally) and "LLM" (Claude reads the
 *     page). `listStyles` merges the catalogue of known Spanish lexicons
 *     (see lexicon-catalogue.ts) with whatever has actually been loaded, so the
 *     picker shows the full range and marks which entries are ready to run.
 *   - **method materialization** — the DB keys scores by method row, but the UI
 *     thinks in "Claude Sonnet" or "a custom rubric". `resolveMethodForRun`
 *     turns a style choice into a persisted method, creating it on first use so
 *     runs stay comparable across sessions.
 *   - **two ways to run** — a *standard* run scores inline while the user
 *     watches, tracked by an in-memory registry they poll. A *batch* run goes to
 *     the Anthropic Batch API: about half the price, about an hour, and tracked
 *     in `batch_jobs` so it survives a restart. Past ~100 page-dimension pairs
 *     the estimate recommends batch, but either is always available.
 *   - **ceilings** — a standard run is capped by MAX_LLM_CALLS_PER_RUN (default
 *     500) because someone is waiting on it; a batch by MAX_BATCH_ITEMS_PER_RUN
 *     (default 20,000) because nobody is. Over-cap runs are refused up front
 *     with the numbers rather than quietly spending.
 *   - **prewarming** — bag-of-words scoring is local, instant and free, so every
 *     loaded dictionary can simply be run over the whole library ahead of time.
 */
import { randomUUID } from 'node:crypto';
import { getAllBooks, getAllDimensions, getAllLexicons, getAllMethods, getAllTags, getMethodByName, getRecentBatchJobs, createMethod, deleteMethod, createDimension, getDimensionByName, updateDimension, deleteDimension, deleteLexicon, getLexiconByName, } from './database.js';
import { AVAILABLE_MODELS, DEFAULT_MODEL, checkAndProcessSentimentBatch } from './ocr.js';
import { parseMethodConfig } from './scoring.js';
import { scorePages, estimateScoring, BATCH_RECOMMEND_THRESHOLD, } from './sentiment.js';
import { analyzeSentiment } from './sentiment-analysis.js';
import { buildExport, EXPORT_FORMATS } from './analysis-export.js';
import { importLexicon, previewLexicon } from './lexicon-import.js';
import { LEXICON_PRESETS, POLARITY_DIMENSION, POLARITY_DIMENSION_DESCRIPTION, ensureLexiconMethod, lexiconMethodName, presetFor, seedLexiconsFromDisk, } from './lexicon-catalogue.js';
export { EXPORT_FORMATS, BATCH_RECOMMEND_THRESHOLD, seedLexiconsFromDisk };
/** Thrown for anything the caller got wrong — HTTP maps these to 400. */
export class AnalysisInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AnalysisInputError';
    }
}
// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------
function envInt(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
/** LLM calls one *standard* run may make. Override with MAX_LLM_CALLS_PER_RUN. */
export function maxLlmCallsPerRun() {
    return envInt('MAX_LLM_CALLS_PER_RUN', 500);
}
/** Items one *batch* submission may carry. Override with MAX_BATCH_ITEMS_PER_RUN. */
export function maxBatchItemsPerRun() {
    return envInt('MAX_BATCH_ITEMS_PER_RUN', 20000);
}
function presetSummary(preset) {
    return {
        id: preset.id,
        sourceUrl: preset.source.url,
        licence: preset.source.licence,
        sourceConfirmed: preset.source.confirmed,
        note: preset.note,
    };
}
/** The method (if any) already bound to a given lexicon id. */
function methodForLexicon(methods, lexiconId) {
    return methods.find((m) => m.kind === 'lexicon' && parseMethodConfig(m).lexicon_id === lexiconId);
}
/** A stable method name for a plain (no custom rubric) Claude run on a model. */
function modelMethodName(model) {
    return model;
}
/**
 * The full option set for the picker: every LLM model plus every bag-of-words
 * dictionary, loaded or merely known about.
 */
export async function listStyles() {
    const [methods, lexicons] = await Promise.all([getAllMethods(), getAllLexicons()]);
    const llm = AVAILABLE_MODELS.map((model) => ({
        id: `llm:${model}`,
        family: 'llm',
        label: model === DEFAULT_MODEL ? `${model} (default)` : model,
        description: "Claude reads each page and scores it against the dimension's rubric.",
        available: true,
        method: modelMethodName(model),
        model,
    }));
    // Saved custom rubrics are first-class styles too — that's the point of saving one.
    const customRubrics = methods
        .filter((m) => m.kind === 'llm' && !!parseMethodConfig(m).prompt)
        .map((m) => {
        const cfg = parseMethodConfig(m);
        return {
            id: `method:${m.name}`,
            family: 'llm',
            label: m.name,
            description: `Custom rubric on ${cfg.model ?? DEFAULT_MODEL}.`,
            available: true,
            method: m.name,
            model: cfg.model ?? DEFAULT_MODEL,
        };
    });
    const bagOfWords = lexicons.map((lex) => {
        const preset = presetFor(lex.name);
        const bound = methodForLexicon(methods, lex.id);
        return {
            id: `lexicon:${lex.name}`,
            family: 'bag_of_words',
            label: preset ? `${preset.label} — ${lex.name}` : lex.name,
            description: preset?.description ??
                lex.note ??
                'A loaded dictionary, matched word by word and averaged over the page.',
            available: lex.term_count > 0,
            method: bound?.name ?? lexiconMethodName(lex.name),
            lexicon: {
                name: lex.name,
                termCount: lex.term_count,
                dimensions: lex.dimensions,
                scale: [lex.scale_min, lex.scale_max],
            },
            preset: preset ? presetSummary(preset) : undefined,
            hint: lex.term_count === 0 ? 'This lexicon imported no usable terms — load it again.' : undefined,
        };
    });
    // Catalogue entries with nothing loaded yet: shown greyed out with a nudge.
    const matchedIds = new Set(lexicons.map((l) => presetFor(l.name)?.id).filter(Boolean));
    const missing = LEXICON_PRESETS.filter((p) => !matchedIds.has(p.id)).map((p) => ({
        id: `catalogue:${p.id}`,
        family: 'bag_of_words',
        label: p.label,
        description: p.description,
        available: false,
        preset: presetSummary(p),
        hint: p.source.confirmed
            ? `Not loaded — drop its file in the lexicons folder, or upload it here.`
            : `Not loaded — source unconfirmed, see the note.`,
    }));
    return [...llm, ...customRubrics, ...bagOfWords, ...missing];
}
export async function getAnalysisOptions() {
    const [styles, dimensions, books, tags, lexicons, methods] = await Promise.all([
        listStyles(),
        getAllDimensions(),
        getAllBooks(),
        getAllTags(),
        getAllLexicons(),
        getAllMethods(),
    ]);
    return {
        styles,
        dimensions,
        books: books
            .filter((b) => b.status === 'complete')
            .map((b) => ({ title: b.title, pageCount: b.page_count }))
            .sort((a, b) => a.title.localeCompare(b.title)),
        tags,
        models: AVAILABLE_MODELS,
        defaultModel: DEFAULT_MODEL,
        maxLlmCalls: maxLlmCallsPerRun(),
        maxBatchItems: maxBatchItemsPerRun(),
        batchThreshold: BATCH_RECOMMEND_THRESHOLD,
        lexicons,
        exportFormats: EXPORT_FORMATS,
        lexiconMethods: methods.filter((m) => m.kind === 'lexicon').map((m) => m.name),
    };
}
/**
 * Resolve a style id (plus any rubric) to a method row, creating it the first
 * time it's used. Scores are keyed by method, so a stable name per style is what
 * makes "Claude Sonnet vs AFINN" comparable across sessions.
 */
export async function resolveMethodForRun(req) {
    const [prefix, rest] = splitStyleId(req.style);
    if (prefix === 'catalogue') {
        const preset = LEXICON_PRESETS.find((p) => p.id === rest);
        throw new AnalysisInputError(`The ${preset?.label ?? rest} dictionary hasn't been loaded yet. Add its file to the lexicons folder or upload it, then run this style.`);
    }
    if (prefix === 'method') {
        const existing = await getMethodByName(rest);
        if (!existing)
            throw new AnalysisInputError(`Scoring method "${rest}" no longer exists.`);
        return existing;
    }
    if (prefix === 'lexicon') {
        const lex = await getLexiconByName(rest);
        if (!lex)
            throw new AnalysisInputError(`Lexicon "${rest}" not found. Load it first.`);
        return ensureLexiconMethod(lex.id, lex.name, req.negation ?? true);
    }
    if (prefix === 'llm') {
        const model = rest;
        if (!AVAILABLE_MODELS.includes(model)) {
            throw new AnalysisInputError(`Unknown model "${model}".`);
        }
        const rubric = req.rubric?.trim();
        if (rubric) {
            const name = req.rubricName?.trim();
            if (!name) {
                throw new AnalysisInputError('Give the custom rubric a name so the run can be identified and repeated.');
            }
            const existing = await getMethodByName(name);
            if (existing) {
                const cfg = parseMethodConfig(existing);
                if (cfg.prompt !== rubric || cfg.model !== model) {
                    throw new AnalysisInputError(`A different method named "${name}" already exists. Choose another name, or delete the existing one.`);
                }
                return existing;
            }
            return createMethod(name, 'llm', JSON.stringify({ model, prompt: rubric }));
        }
        const name = modelMethodName(model);
        return (await getMethodByName(name)) ?? createMethod(name, 'llm', JSON.stringify({ model }));
    }
    throw new AnalysisInputError(`Unrecognised analysis style "${req.style}".`);
}
function splitStyleId(id) {
    const i = (id ?? '').indexOf(':');
    if (i < 0)
        throw new AnalysisInputError(`Unrecognised analysis style "${id}".`);
    return [id.slice(0, i), id.slice(i + 1)];
}
/**
 * Translate a UI request into the scoring engine's input shape. `mode` is left
 * unset when the caller didn't override it, so estimateScoring can report what
 * it *would* do; startRun pins it once the decision is made.
 */
function toScoreInput(req, method, mode) {
    return {
        bookNames: req.books,
        dimensionNames: req.dimensions,
        method: method.name,
        tags: req.tags,
        pageStart: req.pageStart,
        pageEnd: req.pageEnd,
        overwrite: req.overwrite,
        mode: mode === 'batch' ? 'batch' : mode === 'standard' ? 'inline' : undefined,
        maxLlmCalls: maxLlmCallsPerRun(),
        maxBatchItems: maxBatchItemsPerRun(),
    };
}
/** How many pages/calls a run would take, and which way it should go. */
export async function estimateRun(req) {
    const method = await resolveMethodForRun(req);
    const estimate = await estimateScoring(toScoreInput(req, method));
    return { ...estimate, style: req.style };
}
const runs = new Map();
const RUN_RETENTION_MS = 60 * 60 * 1000;
const MAX_RUNS = 50;
/** Drop finished runs the client is no longer plausibly polling. */
function pruneRuns() {
    const cutoff = Date.now() - RUN_RETENTION_MS;
    for (const [id, run] of runs) {
        const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
        if (!Number.isNaN(finished) && finished < cutoff)
            runs.delete(id);
    }
    while (runs.size > MAX_RUNS) {
        const oldest = runs.keys().next().value;
        if (oldest === undefined)
            break;
        runs.delete(oldest);
    }
}
function newRun(fields) {
    return {
        id: randomUUID(),
        status: 'running',
        done: 0,
        total: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        batchId: null,
        scope: {},
        result: null,
        error: null,
        ...fields,
    };
}
/**
 * Start scoring and return immediately with a run the client can poll. A
 * standard run scores inline and reports progress; a batch run submits to the
 * Batch API and returns the batch id to watch. Either way the scope is sized
 * first, so an over-cap run is refused before anything is spent.
 */
export async function startRun(req) {
    const method = await resolveMethodForRun(req);
    const probe = await estimateScoring(toScoreInput(req, method));
    if (probe.problem)
        throw new AnalysisInputError(probe.problem);
    if (probe.pairs === 0) {
        throw new AnalysisInputError(`Nothing to score — all ${probe.alreadyScored} page–dimension pair(s) in this scope already have a "${method.name}" score. Tick re-score to run them again.`);
    }
    // Lexicon methods have no batch to submit to; they always run locally.
    const mode = method.kind === 'lexicon' ? 'standard' : (req.mode ?? probe.recommendedMode);
    if (mode === 'batch' && probe.batchCapExceeded) {
        throw new AnalysisInputError(`This batch would submit ${probe.requiredCalls} score(s), over this server's limit of ${maxBatchItemsPerRun()}. Narrow the scope.`);
    }
    if (mode === 'standard' && probe.capExceeded) {
        throw new AnalysisInputError(`This run needs ${probe.requiredCalls} Claude calls, over this server's standard-run limit of ${maxLlmCallsPerRun()}. ` +
            `Submit it as a batch instead, or narrow the scope.`);
    }
    pruneRuns();
    const scope = {
        books: req.books,
        dimensions: req.dimensions,
        tags: req.tags,
        pageStart: req.pageStart,
        pageEnd: req.pageEnd,
    };
    const input = toScoreInput(req, method, mode);
    if (mode === 'batch') {
        // Submitting is a single API call, so it's awaited: the user learns straight
        // away whether their batch was accepted and gets the id to watch.
        const result = await scorePages(input);
        const run = newRun({
            mode,
            style: req.style,
            method: method.name,
            status: result.batchId ? 'submitted' : 'error',
            total: probe.pairs,
            batchId: result.batchId,
            scope,
            result,
            error: result.batchId ? null : result.message,
            finishedAt: new Date().toISOString(),
        });
        runs.set(run.id, run);
        return run;
    }
    const run = newRun({ mode, style: req.style, method: method.name, total: probe.pairs, scope });
    runs.set(run.id, run);
    // Deliberately not awaited: the HTTP handler returns the run id straight away
    // and the client polls. Every failure path is captured onto the run itself.
    void scorePages({ ...input, onProgress: (done) => { run.done = done; } })
        .then((result) => {
        run.result = result;
        run.status = result.capExceeded ? 'error' : 'complete';
        if (result.capExceeded)
            run.error = result.message;
        run.done = result.scored + result.failed;
    })
        .catch((err) => {
        run.status = 'error';
        run.error = err instanceof Error ? err.message : String(err);
    })
        .finally(() => {
        run.finishedAt = new Date().toISOString();
    });
    return run;
}
export function getRun(id) {
    return runs.get(id);
}
export function listRuns() {
    return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
function toSentimentBatch(row) {
    let bookCount = 0;
    try {
        const ids = JSON.parse(row.book_ids || '[]');
        bookCount = Array.isArray(ids) ? ids.length : 0;
    }
    catch {
        /* malformed book_ids — the count is cosmetic */
    }
    return {
        batchId: row.batch_id,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        bookCount,
    };
}
export async function listSentimentBatches(limit = 20) {
    return (await getRecentBatchJobs('sentiment', limit)).map(toSentimentBatch);
}
/** Ask the API where a batch is up to, storing its scores if it has finished. */
export async function checkSentimentBatch(batchId) {
    try {
        return await checkAndProcessSentimentBatch(batchId);
    }
    catch (err) {
        throw new AnalysisInputError(err instanceof Error ? err.message : String(err));
    }
}
/**
 * Check every sentiment batch still in flight. Called on a timer by the HTTP
 * server so results land without anyone pressing a button; safe to call often,
 * since a batch that hasn't ended just reports its progress.
 */
export async function processPendingSentimentBatches() {
    const pending = (await getRecentBatchJobs('sentiment', 50)).filter((j) => j.status !== 'complete' && j.status !== 'failed');
    const out = [];
    for (const job of pending) {
        try {
            const r = await checkAndProcessSentimentBatch(job.batch_id);
            out.push({ batchId: job.batch_id, status: r.status, processedCount: r.processedCount });
        }
        catch (err) {
            process.stderr.write(`[analysis] Could not check sentiment batch ${job.batch_id}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Prewarming — run every loaded dictionary over the whole library
// ---------------------------------------------------------------------------
/**
 * Score the entire library with every bag-of-words method that's loaded. Free
 * and local, so there's no cap and no reason not to: it just means the results
 * are already there the first time anyone opens the screen. Runs in the
 * background and reports progress through the same registry as a standard run.
 */
export async function prewarmLexicons(opts = {}) {
    const methods = (await getAllMethods()).filter((m) => m.kind === 'lexicon');
    if (methods.length === 0) {
        throw new AnalysisInputError('No dictionaries are loaded yet. Add one to the lexicons folder or upload it, then prewarm.');
    }
    // Restrict each dictionary to the constructs it actually has terms for.
    // Without this, a polarity lexicon is asked to score every other dimension too
    // and returns nothing for all of them — wasted work, and pairs that never
    // resolve, so a second prewarm would find the same "unscored" pairs forever.
    const lexiconsById = new Map((await getAllLexicons()).map((l) => [l.id, l]));
    // Size every method first so the progress bar has a real denominator.
    const plans = [];
    for (const method of methods) {
        const lexiconId = parseMethodConfig(method).lexicon_id;
        const covered = lexiconId ? (lexiconsById.get(lexiconId)?.dimensions ?? []) : [];
        if (covered.length === 0)
            continue;
        const input = {
            method: method.name,
            dimensionNames: covered,
            overwrite: opts.overwrite,
            mode: 'inline',
        };
        const estimate = await estimateScoring(input);
        if (estimate.pairs > 0)
            plans.push({ method, input, pairs: estimate.pairs });
    }
    pruneRuns();
    const total = plans.reduce((s, p) => s + p.pairs, 0);
    const run = newRun({
        mode: 'standard',
        style: 'prewarm:lexicons',
        method: methods.map((m) => m.name).join(', '),
        total,
        scope: {},
    });
    runs.set(run.id, run);
    if (total === 0) {
        run.status = 'complete';
        run.finishedAt = new Date().toISOString();
        run.result = {
            mode: 'noop',
            method: run.method,
            scored: 0,
            failed: 0,
            skipped: 0,
            submitted: 0,
            batchId: null,
            books: 0,
            dimensions: 0,
            capExceeded: false,
            requiredCalls: 0,
            message: 'Every page is already scored by every loaded dictionary — nothing to prewarm.',
        };
        return run;
    }
    void (async () => {
        let completed = 0;
        let scored = 0;
        let failed = 0;
        let skipped = 0;
        try {
            for (const plan of plans) {
                const base = completed;
                const result = await scorePages({
                    ...plan.input,
                    onProgress: (done) => { run.done = base + done; },
                });
                completed += plan.pairs;
                run.done = completed;
                scored += result.scored;
                failed += result.failed;
                skipped += result.skipped;
            }
            run.status = 'complete';
            run.result = {
                mode: 'inline',
                method: run.method,
                scored,
                failed,
                skipped,
                submitted: 0,
                batchId: null,
                books: 0,
                dimensions: 0,
                capExceeded: false,
                requiredCalls: 0,
                message: `Prewarmed ${plans.length} dictionar${plans.length === 1 ? 'y' : 'ies'}: scored ${scored} page–dimension pair(s)` +
                    (failed ? `, ${failed} with no dictionary hits` : '') +
                    (skipped ? `, ${skipped} already scored` : '') + '.',
            };
        }
        catch (err) {
            run.status = 'error';
            run.error = err instanceof Error ? err.message : String(err);
        }
        finally {
            run.finishedAt = new Date().toISOString();
        }
    })();
    return run;
}
export async function getResults(input) {
    return analyzeSentiment(input);
}
export async function exportResults(input, format) {
    if (!EXPORT_FORMATS.includes(format)) {
        throw new AnalysisInputError(`Unsupported export format "${format}". Use one of: ${EXPORT_FORMATS.join(', ')}.`);
    }
    const result = await analyzeSentiment(input);
    if (result.rows.length === 0) {
        throw new AnalysisInputError('Nothing to export yet — no scores match this selection. Run the analysis first.');
    }
    return buildExport({ result, rows: result.rows, format });
}
// ---------------------------------------------------------------------------
// Dimensions (what is measured)
// ---------------------------------------------------------------------------
export async function createDimensionData(name, description, minLabel, maxLabel) {
    const trimmed = name.trim();
    if (!trimmed)
        throw new AnalysisInputError('A dimension needs a name.');
    if (!description.trim()) {
        throw new AnalysisInputError('A dimension needs a description — it is the rubric Claude scores against.');
    }
    if (await getDimensionByName(trimmed)) {
        throw new AnalysisInputError(`A dimension named "${trimmed}" already exists.`);
    }
    return createDimension(trimmed, description.trim(), minLabel.trim() || 'Low', maxLabel.trim() || 'High');
}
export async function updateDimensionData(name, fields) {
    const existing = await getDimensionByName(name);
    if (!existing)
        throw new AnalysisInputError(`Dimension "${name}" not found.`);
    const updated = await updateDimension(existing.id, fields);
    if (!updated)
        throw new AnalysisInputError(`Dimension "${name}" could not be updated.`);
    return updated;
}
export async function deleteDimensionData(name) {
    const existing = await getDimensionByName(name);
    if (!existing)
        throw new AnalysisInputError(`Dimension "${name}" not found.`);
    await deleteDimension(existing.id);
}
/** Make sure the shared polarity construct exists before a dictionary loads into it. */
export async function ensurePolarityDimension() {
    const existing = await getDimensionByName(POLARITY_DIMENSION);
    if (existing)
        return existing;
    return createDimension(POLARITY_DIMENSION, POLARITY_DIMENSION_DESCRIPTION, 'Negative', 'Positive');
}
/** Parse an uploaded file's structure so the UI can offer real column names. */
export function inspectLexicon(input) {
    try {
        const preview = previewLexicon(input);
        const preset = presetFor(input.fileName);
        return preset
            ? { ...preview, preset: { ...presetSummary(preset), format: preset.format } }
            : preview;
    }
    catch (err) {
        throw new AnalysisInputError(err instanceof Error ? err.message : String(err));
    }
}
/**
 * Import an uploaded dictionary and register the method that runs it, so the new
 * bag-of-words style is immediately selectable — one step from the user's side.
 */
export async function uploadLexicon(req) {
    const name = req.name.trim();
    if (!name)
        throw new AnalysisInputError('Give the lexicon a name.');
    const existing = await getLexiconByName(name);
    if (existing && !req.appendToExisting) {
        throw new AnalysisInputError(`A lexicon named "${name}" already exists. Tick "add to the existing lexicon" if this is its other half, or choose another name.`);
    }
    // Anything loading into the shared polarity construct needs it to exist with a
    // sensible description, not the generic one the importer would invent.
    const targets = new Set([...Object.values(req.valueColumns), req.dimension].filter(Boolean));
    if (targets.has(POLARITY_DIMENSION))
        await ensurePolarityDimension();
    // importLexicon creates the lexicon row before parsing, so a parse failure
    // (a wrong column, an unmapped label) would otherwise strand an empty lexicon
    // that shows up in the picker as a broken style.
    let imported;
    try {
        imported = await importLexicon({
            name,
            content: req.content,
            fileName: req.fileName,
            termColumn: req.termColumn,
            valueColumns: req.valueColumns,
            fixedValue: req.fixedValue,
            dimension: req.dimension,
            appendToExisting: req.appendToExisting,
            scaleMin: req.scaleMin,
            scaleMax: req.scaleMax,
            delimiter: req.delimiter,
            hasHeader: req.hasHeader,
            labelValues: req.labelValues,
            note: req.note,
        });
    }
    catch (err) {
        if (!existing) {
            const orphan = await getLexiconByName(name);
            if (orphan)
                await deleteLexicon(orphan.id);
        }
        throw new AnalysisInputError(err instanceof Error ? err.message : String(err));
    }
    if (imported.inserted === 0) {
        // Leaving an empty lexicon behind would show up as a broken style.
        if (!existing)
            await deleteLexicon(imported.lexiconId);
        throw new AnalysisInputError('No usable terms were found. Check the term and value columns match the file, and that values are numeric.');
    }
    const method = await ensureLexiconMethod(imported.lexiconId, name, req.negation ?? true);
    const lexicon = (await getAllLexicons()).find((l) => l.id === imported.lexiconId);
    return { lexicon, method, inserted: imported.inserted, perDimension: imported.perDimension };
}
export async function deleteLexiconData(name) {
    const lex = await getLexiconByName(name);
    if (!lex)
        throw new AnalysisInputError(`Lexicon "${name}" not found.`);
    await deleteLexicon(lex.id);
}
export async function deleteMethodData(name) {
    const method = await getMethodByName(name);
    if (!method)
        throw new AnalysisInputError(`Method "${name}" not found.`);
    await deleteMethod(method.id);
}
