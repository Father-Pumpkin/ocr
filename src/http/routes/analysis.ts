import { Router, type Request, type Response } from 'express';
import {
  getAnalysisOptions,
  estimateRun,
  startRun,
  getRun,
  listRuns,
  getResults,
  exportResults,
  createDimensionData,
  updateDimensionData,
  deleteDimensionData,
  inspectLexicon,
  uploadLexicon,
  deleteLexiconData,
  deleteMethodData,
  listSentimentBatches,
  checkSentimentBatch,
  prewarmLexicons,
  seedLexiconsFromDisk,
  AnalysisInputError,
  type ExportFormat,
  type RunMode,
  type RunRequest,
} from '../../core/analysis-service.js';
import type { AnalyzeInput, GroupBy, Aggregate } from '../../core/sentiment-analysis.js';
import { requireMember } from '../middleware/require-auth.js';
import { LIMITS } from '../middleware/rate-limit.js';

/**
 * Sentiment analysis API for the web app: pick a style, pick a scope, run it,
 * read the results, download them. Scoring runs are started here and polled —
 * see core/analysis-service for why they aren't held open on the request.
 *
 * Reading the analysis — options, results, exports — is open to any signed-in
 * account, which is the point of the public tier: guests slice and download the
 * pre-computed scores. Everything that writes to page_sentiment, spends API
 * budget, or changes the shared instrument set is member-only.
 */
export const analysisRouter = Router();

function handleError(err: unknown, res: Response): void {
  if (err instanceof AnalysisInputError) {
    res.status(400).json({ error: err.message });
  } else {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Express types query params loosely; collapse whatever arrives to a string. */
function str(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? '');
  return v === undefined || v === null ? '' : String(v);
}

/** A repeatable query param (`?books=a&books=b`) or a comma-separated list. */
function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(',');
  const cleaned = raw.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

function posInt(v: unknown): number | undefined {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse the scope + shape of an analysis read from the query string. */
function analyzeInputFromQuery(req: Request): AnalyzeInput {
  const groupBy = str(req.query.groupBy);
  const aggregate = str(req.query.aggregate);
  return {
    bookNames: list(req.query.books),
    dimensionNames: list(req.query.dimensions),
    methods: list(req.query.methods),
    tags: list(req.query.tags),
    groupBy: groupBy ? (groupBy as GroupBy) : undefined,
    aggregate: aggregate ? (aggregate as Aggregate) : undefined,
    pageStart: posInt(req.query.pageStart),
    pageEnd: posInt(req.query.pageEnd),
  };
}

/** Parse a run request body, normalising the optional scope fields. */
function runRequestFromBody(body: unknown): RunRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const style = str(b.style);
  if (!style) throw new AnalysisInputError('Choose an analysis style.');
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length ? v.map(String) : undefined;
  // Omitted mode = follow the estimate's recommendation; anything else must be
  // one of the two we know about rather than silently ignored.
  const rawMode = str(b.mode);
  if (rawMode && rawMode !== 'standard' && rawMode !== 'batch') {
    throw new AnalysisInputError(`Unknown run mode "${rawMode}". Use "standard" or "batch".`);
  }
  return {
    style,
    mode: rawMode ? (rawMode as RunMode) : undefined,
    books: arr(b.books),
    dimensions: arr(b.dimensions),
    tags: arr(b.tags),
    pageStart: posInt(b.pageStart),
    pageEnd: posInt(b.pageEnd),
    rubric: typeof b.rubric === 'string' ? b.rubric : undefined,
    rubricName: typeof b.rubricName === 'string' ? b.rubricName : undefined,
    negation: Boolean(b.negation),
    overwrite: Boolean(b.overwrite),
  };
}

// GET /api/analysis/options — everything the run form needs, in one call
analysisRouter.get('/analysis/options', async (_req, res) => {
  try {
    res.json(await getAnalysisOptions());
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/estimate — size a run (pages, calls, cap) before committing
analysisRouter.post('/analysis/estimate', requireMember, LIMITS.SCORING, async (req, res) => {
  try {
    res.json(await estimateRun(runRequestFromBody(req.body)));
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/runs — start scoring; returns immediately, poll for progress
analysisRouter.post('/analysis/runs', requireMember, LIMITS.SCORING, async (req, res) => {
  try {
    res.status(202).json({ run: await startRun(runRequestFromBody(req.body)) });
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/analysis/runs — this server's recent runs (in-memory, newest first)
analysisRouter.get('/analysis/runs', requireMember, (_req, res) => {
  res.json({ runs: listRuns() });
});

// GET /api/analysis/runs/:id — progress for one run
analysisRouter.get('/analysis/runs/:id', requireMember, (req, res) => {
  const run = getRun(str(req.params.id));
  if (!run) {
    res.status(404).json({ error: 'That run is no longer available. Any scores it produced are still saved.' });
    return;
  }
  res.json({ run });
});

// GET /api/analysis/results — aggregated scores for a slice, for the on-screen table
analysisRouter.get('/analysis/results', async (req, res) => {
  try {
    res.json(await getResults(analyzeInputFromQuery(req)));
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/analysis/export?format=pages.csv — download the analysis
analysisRouter.get('/analysis/export', LIMITS.EXPORTS, async (req, res) => {
  try {
    const format = (str(req.query.format) || 'pages.csv') as ExportFormat;
    const file = await exportResults(analyzeInputFromQuery(req), format);
    res.set('Content-Type', file.contentType);
    res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.set('Cache-Control', 'no-store');
    res.send(file.body);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Batch jobs ------------------------------------------------------------

// GET /api/analysis/batches — sentiment batches, newest first (survives restarts)
analysisRouter.get('/analysis/batches', requireMember, async (_req, res) => {
  try {
    res.json({ batches: await listSentimentBatches() });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/batches/:id/check — ask the API where a batch is up to,
// storing its scores if it has finished
analysisRouter.post('/analysis/batches/:id/check', requireMember, async (req, res) => {
  try {
    res.json(await checkSentimentBatch(str(req.params.id)));
  } catch (err) {
    handleError(err, res);
  }
});

// --- Prewarming and seeding ------------------------------------------------

// POST /api/analysis/prewarm — score the whole library with every loaded
// dictionary. Local and free; returns a run to poll like any other.
analysisRouter.post('/analysis/prewarm', requireMember, LIMITS.SCORING, async (req, res) => {
  try {
    const overwrite = Boolean((req.body ?? {})?.overwrite);
    res.status(202).json({ run: await prewarmLexicons({ overwrite }) });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/lexicons/seed — re-scan the lexicons folder on disk
analysisRouter.post('/analysis/lexicons/seed', requireMember, LIMITS.SCORING, async (_req, res) => {
  try {
    res.json({ outcomes: await seedLexiconsFromDisk() });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Dimensions (what is being measured) -----------------------------------

analysisRouter.post('/analysis/dimensions', requireMember, async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dimension = await createDimensionData(
      str(b.name),
      str(b.description),
      str(b.minLabel) || 'Low',
      str(b.maxLabel) || 'High',
    );
    res.status(201).json({ dimension });
  } catch (err) {
    handleError(err, res);
  }
});

analysisRouter.patch('/analysis/dimensions/:name', requireMember, async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dimension = await updateDimensionData(str(req.params.name), {
      description: typeof b.description === 'string' ? b.description : undefined,
      minLabel: typeof b.minLabel === 'string' ? b.minLabel : undefined,
      maxLabel: typeof b.maxLabel === 'string' ? b.maxLabel : undefined,
    });
    res.json({ dimension });
  } catch (err) {
    handleError(err, res);
  }
});

analysisRouter.delete('/analysis/dimensions/:name', requireMember, async (req, res) => {
  try {
    await deleteDimensionData(str(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Lexicons (bag-of-words dictionaries) ----------------------------------

// POST /api/analysis/lexicons/preview — parse an upload's structure, import nothing
analysisRouter.post('/analysis/lexicons/preview', requireMember, (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const content = typeof b.content === 'string' ? b.content : '';
    if (!content.trim()) throw new AnalysisInputError('The uploaded file is empty.');
    res.json(
      inspectLexicon({
        content,
        fileName: str(b.fileName) || 'lexicon.csv',
        delimiter: typeof b.delimiter === 'string' && b.delimiter ? b.delimiter : undefined,
        hasHeader: typeof b.hasHeader === 'boolean' ? b.hasHeader : undefined,
      }),
    );
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/lexicons — import an uploaded dictionary and register its method
analysisRouter.post('/analysis/lexicons', requireMember, async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const valueColumns = b.valueColumns;
    const fixedValue = b.fixedValue === undefined || b.fixedValue === null ? undefined : Number(b.fixedValue);
    const isWordList = fixedValue !== undefined;
    if (isWordList && !Number.isFinite(fixedValue)) {
      throw new AnalysisInputError('A word list needs a numeric value for its terms.');
    }
    if (!isWordList && (!valueColumns || typeof valueColumns !== 'object' || Array.isArray(valueColumns))) {
      throw new AnalysisInputError('Map at least one value column to a dimension.');
    }
    const scaleMin = Number(b.scaleMin);
    const scaleMax = Number(b.scaleMax);
    if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax)) {
      throw new AnalysisInputError('The native scale needs a numeric minimum and maximum.');
    }
    const result = await uploadLexicon({
      name: str(b.name),
      fileName: str(b.fileName) || 'lexicon.csv',
      content: typeof b.content === 'string' ? b.content : '',
      termColumn: str(b.termColumn) || 'term',
      valueColumns:
        valueColumns && typeof valueColumns === 'object' && !Array.isArray(valueColumns)
          ? Object.fromEntries(
              Object.entries(valueColumns as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
          : {},
      fixedValue,
      dimension: typeof b.dimension === 'string' && b.dimension ? b.dimension : undefined,
      appendToExisting: Boolean(b.appendToExisting),
      scaleMin,
      scaleMax,
      delimiter: typeof b.delimiter === 'string' && b.delimiter ? b.delimiter : undefined,
      hasHeader: typeof b.hasHeader === 'boolean' ? b.hasHeader : undefined,
      labelValues:
        b.labelValues && typeof b.labelValues === 'object' && !Array.isArray(b.labelValues)
          ? Object.fromEntries(
              Object.entries(b.labelValues as Record<string, unknown>)
                .map(([k, v]) => [k, Number(v)])
                .filter(([, v]) => Number.isFinite(v as number)),
            )
          : undefined,
      note: typeof b.note === 'string' ? b.note : undefined,
      negation: Boolean(b.negation),
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

analysisRouter.delete('/analysis/lexicons/:name', requireMember, async (req, res) => {
  try {
    await deleteLexiconData(str(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/analysis/methods/:name — drop a saved rubric and the scores it made
analysisRouter.delete('/analysis/methods/:name', requireMember, async (req, res) => {
  try {
    await deleteMethodData(str(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});
