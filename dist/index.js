#!/usr/bin/env node
// Redirect console.log to stderr — MCP stdio transport uses stdout exclusively
// for JSON, so any library that writes to console.log would break the protocol.
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
// Resolve relative path env vars to absolute paths using process.cwd()
for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
    const val = process.env[key];
    if (val && !path.isAbsolute(val))
        process.env[key] = path.resolve(process.cwd(), val);
}
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import { getAdapter, getInProgressBatchJobs, getAllDimensions, getDimensionByName, createDimension, updateDimension, deleteDimension, getAllTags, getBatchJob, getAllMethods, getMethodByName, createMethod, deleteMethod, getLexiconByName } from './core/database.js';
import { clearAuth } from './core/google-drive.js';
import { listBooks } from './tools/list-books.js';
import { transcribeBooks } from './tools/transcribe-books.js';
import { batchTranscribe } from './tools/batch-transcribe.js';
import { getTranscription } from './tools/get-transcription.js';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from './core/ocr.js';
import { checkAndProcessBatch, checkAndProcessSentimentBatch } from './core/ocr.js';
import { scorePages } from './core/sentiment.js';
import { analyzeSentiment } from './core/sentiment-analysis.js';
import { renderSentimentChartPng } from './core/sentiment-chart.js';
import { importLexicon } from './core/lexicon-import.js';
// ---------------------------------------------------------------------------
// Startup: ensure required directories exist
// ---------------------------------------------------------------------------
function ensureDirectories() {
    const credentialsPath = process.env.CREDENTIALS_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'credentials');
    const dirs = [credentialsPath];
    // Only create SQLite data directory when not using Postgres
    if (!process.env.DB_HOST && !process.env.DATABASE_URL) {
        const dbPath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
        dirs.push(path.dirname(dbPath));
    }
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            process.stderr.write(`[OCR MCP] Created directory: ${dir}\n`);
        }
    }
}
// ---------------------------------------------------------------------------
// Resume any in-progress batch jobs from a previous session
// ---------------------------------------------------------------------------
// A batch may be OCR or sentiment; route to the matching processor by its kind.
async function processBatchByKind(batchId) {
    const job = await getBatchJob(batchId);
    return job?.kind === 'sentiment'
        ? checkAndProcessSentimentBatch(batchId)
        : checkAndProcessBatch(batchId);
}
async function resumeInProgressBatches() {
    const jobs = await getInProgressBatchJobs();
    if (jobs.length === 0)
        return;
    process.stderr.write(`[OCR MCP] Resuming ${jobs.length} in-progress batch job(s)...\n`);
    for (const job of jobs) {
        try {
            const { summary } = job.kind === 'sentiment'
                ? await checkAndProcessSentimentBatch(job.batch_id)
                : await checkAndProcessBatch(job.batch_id);
            process.stderr.write(`[OCR MCP] Batch ${job.batch_id} (${job.kind}): ${summary}\n`);
        }
        catch (err) {
            process.stderr.write(`[OCR MCP] Error resuming batch ${job.batch_id}: ${err}\n`);
        }
    }
}
// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: 'ocr-mcp-server',
    version: '1.0.0',
});
// ---- Tool: list_books -------------------------------------------------------
server.tool('list_books', 'Lists all PDF files in the configured Google Drive folder, showing transcription status for each.', {}, async () => {
    try {
        const result = await listBooks();
        return { content: [{ type: 'text', text: result }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: transcribe_books -------------------------------------------------
server.tool('transcribe_books', 'Downloads PDFs from Google Drive and transcribes each page using Claude vision OCR. Supports single-request and Batch API modes.', {
    book_names: z
        .array(z.string())
        .describe('List of book filenames to transcribe (must match names from list_books). Pass an empty array to transcribe ALL books.'),
    use_batch: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, uses the Anthropic Batch API (cheaper, async). Returns a batch_id to check later with check_batch.'),
    overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, re-transcribes pages that already have transcriptions.'),
    model: z
        .enum(AVAILABLE_MODELS)
        .optional()
        .default(DEFAULT_MODEL)
        .describe('Claude model to use. Sonnet (default) is recommended. Haiku is faster/cheaper. Opus is most accurate.'),
}, async ({ book_names, use_batch, overwrite, model }) => {
    try {
        const result = await transcribeBooks({ book_names, use_batch, overwrite, model });
        return { content: [{ type: 'text', text: result }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: batch_transcribe -------------------------------------------------
server.tool('batch_transcribe', 'Submits books to the Anthropic Batch API for async transcription (50% cheaper, ~1hr turnaround). ' +
    'Defaults to all unprocessed books if no list is given. Always call with dry_run: true first to ' +
    'show the user what would be submitted and get confirmation before actually running.', {
    book_names: z
        .array(z.string())
        .default([])
        .describe('Books to transcribe. Pass an empty array to auto-select all eligible books.'),
    overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, resubmit books that are already complete.'),
    dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe('Preview what would be submitted without downloading or submitting anything. Use this first to confirm with the user.'),
}, async ({ book_names, overwrite, dry_run }) => {
    try {
        const result = await batchTranscribe({ book_names, overwrite, dry_run });
        return { content: [{ type: 'text', text: result }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: check_batch ------------------------------------------------------
server.tool('check_batch', 'Polls an Anthropic batch job for status. If complete, processes all results and stores them — transcriptions for an OCR batch, or sentiment scores for a score_pages batch (routed automatically by batch kind).', {
    batch_id: z.string().describe('The Anthropic batch ID returned by transcribe_books/batch_transcribe or score_pages.'),
}, async ({ batch_id }) => {
    try {
        const { summary } = await processBatchByKind(batch_id);
        return { content: [{ type: 'text', text: summary }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: get_transcription -------------------------------------------------
server.tool('get_transcription', 'Retrieves the transcription for a book, optionally filtered to a page range.', {
    book_name: z.string().describe('The book filename or title (as shown by list_books).'),
    page_start: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Starting page number (inclusive, 1-based).'),
    page_end: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Ending page number (inclusive, 1-based).'),
    include_illustrations: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, includes [ILLUSTRATION] pages in the output.'),
}, async ({ book_name, page_start, page_end, include_illustrations }) => {
    try {
        const result = await getTranscription({ book_name, page_start, page_end, include_illustrations });
        return { content: [{ type: 'text', text: result }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: list_dimensions --------------------------------------------------
server.tool('list_dimensions', 'Lists all researcher-defined sentiment dimensions available for analysis.', {}, async () => {
    try {
        const dimensions = await getAllDimensions();
        if (dimensions.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: 'No dimensions defined yet. Use create_dimension to add one.',
                    }],
            };
        }
        const header = 'Name                 | Description                                      | Min Label  | Max Label\n' +
            '---------------------|--------------------------------------------------|------------|----------';
        const rows = dimensions.map((d) => {
            const name = d.name.padEnd(20);
            const desc = d.description.length > 48 ? d.description.slice(0, 45) + '...' : d.description.padEnd(48);
            const min = d.min_label.padEnd(10);
            const max = d.max_label;
            return `${name} | ${desc} | ${min} | ${max}`;
        });
        return {
            content: [{ type: 'text', text: [header, ...rows].join('\n') }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: create_dimension -------------------------------------------------
server.tool('create_dimension', 'Creates a new sentiment dimension for analysis. The description is used to prompt Claude when scoring pages, so be precise about what to look for.', {
    name: z.string().describe('Short identifier, e.g. "affirmativeness". Used as the dimension key.'),
    description: z.string().describe('What Claude should look for when scoring this dimension. Be specific about what constitutes a high vs low score.'),
    min_label: z.string().optional().default('Low').describe('Label for the low end of the scale (0.0).'),
    max_label: z.string().optional().default('High').describe('Label for the high end of the scale (1.0).'),
}, async ({ name, description, min_label, max_label }) => {
    try {
        const dimension = await createDimension(name, description, min_label, max_label);
        return {
            content: [{
                    type: 'text',
                    text: `Created dimension "${dimension.name}" (id: ${dimension.id})\n` +
                        `Description: ${dimension.description}\n` +
                        `Scale: ${dimension.min_label} (0.0) → ${dimension.max_label} (1.0)`,
                }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: update_dimension -------------------------------------------------
server.tool('update_dimension', 'Updates an existing sentiment dimension. Useful for refining descriptions as research questions evolve. Existing scores are preserved but may no longer reflect the updated description.', {
    name: z.string().describe('The dimension name to update.'),
    description: z.string().optional().describe('New description for the dimension.'),
    min_label: z.string().optional().describe('New label for the low end (0.0).'),
    max_label: z.string().optional().describe('New label for the high end (1.0).'),
}, async ({ name, description, min_label, max_label }) => {
    try {
        const existing = await getDimensionByName(name);
        if (!existing) {
            return {
                content: [{ type: 'text', text: `Error: Dimension "${name}" not found.` }],
                isError: true,
            };
        }
        const updated = await updateDimension(existing.id, { description, minLabel: min_label, maxLabel: max_label });
        if (!updated) {
            return {
                content: [{ type: 'text', text: `Error: Dimension "${name}" could not be updated.` }],
                isError: true,
            };
        }
        return {
            content: [{
                    type: 'text',
                    text: `Updated dimension "${updated.name}" (id: ${updated.id})\n` +
                        `Description: ${updated.description}\n` +
                        `Scale: ${updated.min_label} (0.0) → ${updated.max_label} (1.0)`,
                }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: delete_dimension -------------------------------------------------
server.tool('delete_dimension', 'Deletes a sentiment dimension and all associated scores. This cannot be undone.', {
    name: z.string().describe('The dimension name to delete.'),
}, async ({ name }) => {
    try {
        const existing = await getDimensionByName(name);
        if (!existing) {
            return {
                content: [{ type: 'text', text: `Error: Dimension "${name}" not found.` }],
                isError: true,
            };
        }
        const deleted = await deleteDimension(existing.id);
        if (!deleted) {
            return {
                content: [{ type: 'text', text: `Error: Dimension "${name}" could not be deleted.` }],
                isError: true,
            };
        }
        return {
            content: [{
                    type: 'text',
                    text: `Deleted dimension "${name}" (id: ${existing.id}) and all associated page sentiment scores.`,
                }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: score_pages ------------------------------------------------------
server.tool('score_pages', 'Scores book pages on one or more sentiment dimensions with a chosen method and caches the scores (what charts are built from). Lexicon methods run locally and instantly; LLM methods score small scopes inline and submit large scopes to the Anthropic Batch API (call check_batch later). Pages already scored for a (dimension, method) are skipped unless overwrite is set. Define dimensions with create_dimension; see list_methods for available methods.', {
    books: z.array(z.string()).optional().default([]).describe('Book filenames/titles to score. Empty = all transcribed books.'),
    dimensions: z.array(z.string()).optional().default([]).describe('Dimension names to score on (see list_dimensions). Empty = all defined dimensions.'),
    method: z.string().optional().default('claude-default').describe('Scoring method name (see list_methods). Defaults to the built-in Claude scorer.'),
    page_start: z.number().int().positive().optional().describe('First page to score (inclusive, 1-based).'),
    page_end: z.number().int().positive().optional().describe('Last page to score (inclusive, 1-based).'),
    mode: z.enum(['auto', 'inline', 'batch']).optional().default('auto').describe("LLM methods only: 'auto' scores inline for small scopes and uses the Batch API for large; force 'inline' or 'batch'. (Lexicon methods always run locally.)"),
    overwrite: z.boolean().optional().default(false).describe('Re-score pages that already have a score for this dimension+method.'),
    model: z.enum(AVAILABLE_MODELS).optional().default(DEFAULT_MODEL).describe('LLM methods: Claude model to use when the method does not pin one.'),
}, async ({ books, dimensions, method, page_start, page_end, mode, overwrite, model }) => {
    try {
        const result = await scorePages({
            bookNames: books,
            dimensionNames: dimensions,
            method,
            pageStart: page_start,
            pageEnd: page_end,
            mode,
            overwrite,
            model,
        });
        return {
            content: [{ type: 'text', text: result.message }],
            structuredContent: {
                mode: result.mode,
                method: result.method,
                scored: result.scored,
                failed: result.failed,
                skipped: result.skipped,
                submitted: result.submitted,
                batchId: result.batchId,
                books: result.books,
                dimensions: result.dimensions,
            },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: chart_sentiment --------------------------------------------------
server.tool('chart_sentiment', 'Returns aggregated sentiment data ready to chart — a per-page series (narrative arc) or grouped means (bars) — for a flexible slice: a whole book, tags within a book, several books compared, a tag across books, or one method vs another. Scores are partitioned by method, so multiple scoring methods overlay as distinct series/bars. Render the returned structuredContent as a chart artifact for the user. Set render_png to also get a server-rendered PNG. Pages must be scored first with score_pages.', {
    books: z.array(z.string()).optional().default([]).describe('Book filenames/titles. Empty = all transcribed books.'),
    dimensions: z.array(z.string()).optional().default([]).describe('Dimension names (see list_dimensions). Empty = all dimensions.'),
    methods: z.array(z.string()).optional().default([]).describe('Scoring methods to include/compare (see list_methods). Empty = all methods that have scores.'),
    tags: z.array(z.string()).optional().default([]).describe('Restrict to pages carrying any of these tags; also the group keys when group_by is "tag" or "book_tag".'),
    group_by: z.enum(['page', 'book', 'tag', 'book_tag', 'method']).optional().describe('How to bucket pages. Default: "page" for a single book, "book" for several. Use "method" to compare instruments.'),
    aggregate: z.enum(['series', 'mean']).optional().describe('"series" = per-page points (arc); "mean" = one average per group (bars). Default follows group_by.'),
    page_start: z.number().int().positive().optional().describe('First page (inclusive, 1-based).'),
    page_end: z.number().int().positive().optional().describe('Last page (inclusive, 1-based).'),
    render_png: z.boolean().optional().default(false).describe('Also return a server-rendered PNG chart image.'),
}, async ({ books, dimensions, methods, tags, group_by, aggregate, page_start, page_end, render_png }) => {
    try {
        const result = await analyzeSentiment({
            bookNames: books,
            dimensionNames: dimensions,
            methods,
            tags,
            groupBy: group_by,
            aggregate,
            pageStart: page_start,
            pageEnd: page_end,
        });
        const content = [{ type: 'text', text: result.summary }];
        if (render_png && result.groups.length > 0) {
            content.push({ type: 'image', data: renderSentimentChartPng(result), mimeType: 'image/png' });
        }
        return {
            content,
            structuredContent: {
                groupBy: result.groupBy,
                aggregate: result.aggregate,
                dimensions: result.dimensions,
                books: result.books,
                methods: result.methods,
                tags: result.tags,
                groups: result.groups,
                coverage: result.coverage,
                summary: result.summary,
            },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: list_tags --------------------------------------------------------
server.tool('list_tags', 'Lists all distinct page tags used across the library — the values you can group or filter sentiment charts by with chart_sentiment.', {}, async () => {
    try {
        const tags = await getAllTags();
        const text = tags.length
            ? `Tags (${tags.length}):\n${tags.join('\n')}`
            : 'No tags have been applied to any pages yet.';
        return { content: [{ type: 'text', text }], structuredContent: { tags } };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: import_lexicon ---------------------------------------------------
server.tool('import_lexicon', 'Imports a sentiment lexicon (any word→value dictionary) from a file so it can be run as a scoring method. Maps value column(s) to dimensions and normalizes the native scale to 0–1. Accepts CSV/TSV with a header row, a JSON array of row-objects, or a JSON {term: value} map. After importing, register it with create_method (kind "lexicon").', {
    name: z.string().describe('A unique name for this lexicon (e.g. "ml-senticon").'),
    file_path: z.string().describe('Absolute path to the lexicon file (.csv, .tsv, or .json).'),
    term_column: z.string().describe('Column header holding the word/term (ignored for a JSON {term:value} map).'),
    value_columns: z.record(z.string(), z.string()).describe('Map of value column → dimension name, e.g. {"valence":"positivity"} or {"fear":"fear","joy":"joy"}. Dimensions are auto-created if missing.'),
    scale_min: z.number().describe("Minimum of the lexicon's native value scale (e.g. -5 for AFINN, 1 for ANEW, 0 for a 0–1 lexicon)."),
    scale_max: z.number().describe('Maximum of the native scale (e.g. 5, 9, or 1).'),
    delimiter: z.string().optional().describe('Delimiter for CSV/TSV; defaults to tab for .tsv, else comma.'),
    note: z.string().optional().describe('Optional note about the lexicon source.'),
}, async ({ name, file_path, term_column, value_columns, scale_min, scale_max, delimiter, note }) => {
    try {
        const r = await importLexicon({
            name,
            filePath: file_path,
            termColumn: term_column,
            valueColumns: value_columns,
            scaleMin: scale_min,
            scaleMax: scale_max,
            delimiter,
            note,
        });
        const perDim = Object.entries(r.perDimension).map(([d, c]) => `  ${d}: ${c} term(s)`).join('\n');
        return {
            content: [{
                    type: 'text',
                    text: `Imported lexicon "${r.name}" (id ${r.lexiconId}) from ${r.totalRows} row(s); stored ${r.inserted} term(s), ` +
                        `scale ${r.scale[0]}..${r.scale[1]} → 0..1.\n${perDim}\n\n` +
                        `Next: create_method { kind: "lexicon", lexicon: "${r.name}" }, then score_pages with that method.`,
                }],
            structuredContent: {
                lexiconId: r.lexiconId,
                name: r.name,
                totalRows: r.totalRows,
                inserted: r.inserted,
                perDimension: r.perDimension,
                scale: r.scale,
            },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: create_method ----------------------------------------------------
server.tool('create_method', 'Registers a scoring method (instrument). kind "llm" saves a model + optional custom prompt (omit prompt to use each dimension\'s description). kind "lexicon" binds an imported lexicon (see import_lexicon) plus an aggregation rule. Score with score_pages { method }, and compare instruments with chart_sentiment { group_by: "method" }.', {
    name: z.string().describe('Unique method name, e.g. "claude-opus", "my-rubric", or "ml-senticon".'),
    kind: z.enum(['llm', 'lexicon']).describe('"llm" = Claude prompt + model; "lexicon" = run an imported dictionary locally.'),
    model: z.enum(AVAILABLE_MODELS).optional().describe('LLM methods: model to use (defaults to Sonnet).'),
    prompt: z.string().optional().describe('LLM methods: a custom scoring rubric. Omit to use each dimension\'s description.'),
    lexicon: z.string().optional().describe('Lexicon methods: the name of a lexicon imported with import_lexicon.'),
    negation: z.boolean().optional().default(false).describe('Lexicon methods: flip a term\'s value when a Spanish negator precedes it within a few tokens.'),
}, async ({ name, kind, model, prompt, lexicon, negation }) => {
    try {
        let config;
        if (kind === 'lexicon') {
            if (!lexicon) {
                return { content: [{ type: 'text', text: 'Error: lexicon methods require a "lexicon" name. Import it first with import_lexicon.' }], isError: true };
            }
            const lex = await getLexiconByName(lexicon);
            if (!lex) {
                return { content: [{ type: 'text', text: `Error: lexicon "${lexicon}" not found. Import it first with import_lexicon.` }], isError: true };
            }
            config = { lexicon_id: lex.id, aggregation: 'mean', negation: !!negation };
        }
        else {
            config = { model: model ?? DEFAULT_MODEL, ...(prompt ? { prompt } : {}) };
        }
        const m = await createMethod(name, kind, JSON.stringify(config));
        return {
            content: [{ type: 'text', text: `Created ${kind} method "${m.name}" (id ${m.id}).` }],
            structuredContent: { id: m.id, name: m.name, kind: m.kind },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: list_methods -----------------------------------------------------
server.tool('list_methods', 'Lists all scoring methods (instruments) — the built-in Claude default plus any you created. Use these names with score_pages and chart_sentiment.', {}, async () => {
    try {
        const methods = await getAllMethods();
        if (methods.length === 0) {
            return { content: [{ type: 'text', text: 'No scoring methods defined.' }] };
        }
        const lines = methods.map((m) => {
            let detail = '';
            try {
                const c = JSON.parse(m.config || '{}');
                detail = m.kind === 'lexicon'
                    ? `lexicon_id=${c.lexicon_id}${c.negation ? ', negation on' : ''}`
                    : `model=${c.model ?? 'default'}${c.prompt ? ', custom prompt' : ''}`;
            }
            catch { /* ignore malformed config */ }
            return `${m.name}  [${m.kind}]  ${detail}`;
        });
        return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: { methods: methods.map((m) => ({ name: m.name, kind: m.kind })) },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: delete_method ----------------------------------------------------
server.tool('delete_method', 'Deletes a scoring method and all sentiment scores it produced. This cannot be undone.', {
    name: z.string().describe('The method name to delete.'),
}, async ({ name }) => {
    try {
        const m = await getMethodByName(name);
        if (!m) {
            return { content: [{ type: 'text', text: `Error: method "${name}" not found.` }], isError: true };
        }
        await deleteMethod(m.id);
        return { content: [{ type: 'text', text: `Deleted method "${name}" (id ${m.id}) and all of its sentiment scores.` }] };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---- Tool: clear_auth -------------------------------------------------------
server.tool('clear_auth', 'Clears the stored Google credentials and any pending device flow, so the next Drive operation will start a fresh authorization. Use this if you authorized with the wrong Google account or if Drive access is failing.', {}, async () => {
    try {
        clearAuth();
        return {
            content: [{
                    type: 'text',
                    text: 'Google auth cleared. The next Drive operation will open a new browser window for authorization.',
                }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});
// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function main() {
    ensureDirectories();
    // Initialize the adapter (creates tables / runs migrations)
    try {
        await getAdapter();
        process.stderr.write('[OCR MCP] Database initialised.\n');
    }
    catch (err) {
        process.stderr.write(`[OCR MCP] Failed to initialise database: ${err}\n`);
        process.exit(1);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[OCR MCP] Server running on stdio transport.\n');
    // Fire-and-forget: resume any batches that were in-progress when server last stopped
    resumeInProgressBatches().catch((err) => process.stderr.write(`[OCR MCP] Error resuming in-progress batches: ${err}\n`));
}
main().catch((err) => {
    process.stderr.write(`[OCR MCP] Fatal error: ${err}\n`);
    process.exit(1);
});
