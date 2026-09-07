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
  saveRubricMethod,
  seedLexiconsFromDisk,
  AnalysisInputError,
  type ExportFormat,
  type RunMode,
  type RunRequest,
  type SectionSpec,
} from '../../core/analysis-service.js';
import {
  GROUP_BY_VALUES,
  AGGREGATE_VALUES,
  type AnalyzeInput,
  type GroupBy,
  type Aggregate,
} from '../../core/sentiment-analysis.js';
import { requireMember, type AuthedRequest } from '../middleware/require-auth.js';
import { LIMITS } from '../middleware/rate-limit.js';
import { getMethodByName } from '../../core/database.js';
import { explainPageScore, ExplainError } from '../../core/explain.js';

/**
 * Sentiment analysis API for the web app: pick a style, pick a scope, run it,
 * read the results, download them. Scoring runs are started here and polled —
 * see core/analysis-service for why they aren't held open on the request.
 *
 * Reading the analysis — options, results, exports — is open to any signed-in
 * account, which is the point of the public tier: guests slice and download the
 * pre-computed scores. Everything that spends API budget or changes the shared
 * instrument set is member-only.
 *
 * Bag-of-words runs are the one exception: see allowGuestLexiconRuns.
 */
export const analysisRouter = Router();

/**
 * Scoring gate that lets guests run dictionary-based instruments.
 *
 * The reason to draw the line at "lexicon" rather than at "member" is that a
 * lexicon run is deterministic: the same dictionary over the same page text
 * always yields the same number, so a guest writing a score writes exactly the
 * value a member would have written. It fills the cache rather than changing
 * shared research data, costs no API budget, and runs locally in milliseconds.
 * Without this, the public tier can only ever see what someone else thought to
 * pre-compute — which defeats the point of offering five comparable dictionaries.
 *
 * Guests are still held to three conditions, each of which would break the
 * determinism argument:
 *
 *   - **No LLM styles.** They spend money and their output isn't reproducible.
 *   - **No `overwrite`.** Re-scoring is how an existing value *changes*; without
 *     it a guest can only fill in pairs that have no score yet.
 *   - **No custom rubric.** Rubrics only apply to LLM styles, but a guest
 *     sending one alongside a lexicon style would have it silently saved as a
 *     reusable named method.
 *
 * Uploading a dictionary stays member-only, so the set of instruments a guest
 * can run is exactly the set an approved account has already vetted.
 */
async function allowGuestLexiconRuns(req: Request, res: Response, next: () => void): Promise<void> {
  const user = (req as AuthedRequest).user;
  if (user?.role === 'member') {
    next();
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const style = typeof body.style === 'string' ? body.style : '';
  const [prefix, rest] = [style.slice(0, style.indexOf(':')), style.slice(style.indexOf(':') + 1)];

  // A saved `method:` style can be either kind, so it needs a lookup; a
  // `lexicon:` style is a loaded dictionary by construction.
  let isLexicon = prefix === 'lexicon';
  if (prefix === 'method' && rest) {
    isLexicon = (await getMethodByName(rest))?.kind === 'lexicon';
  }

  const refuse = (reason: string): void => {
    res.status(403).json({ error: reason, memberRequired: true });
  };

  if (!isLexicon) {
    refuse(
      'Claude-scored analyses are limited to approved accounts, because they cost money per page. ' +
        'You can run any of the bag-of-words dictionaries, and browse or download everything already scored.',
    );
    return;
  }
  if (body.overwrite) {
    refuse('Re-scoring pages that already have a score is limited to approved accounts.');
    return;
  }
  if (body.rubric) {
    refuse('Saving a custom rubric is limited to approved accounts.');
    return;
  }
  next();
}

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

/**
 * A repeatable query param (`?books=a&books=b`) or a comma-separated list.
 *
 * The object branch is not paranoia: qs returns `{0:'a',1:'b',…}` rather than an
 * array once a key repeats past its arrayLimit, and stringifying that yields
 * "[object Object]", which matches no book and produces an empty result with a
 * 200. server.ts raises the limit; this makes the parse survive it regardless.
 */
function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const raw = Array.isArray(v)
    ? v.map(String)
    : typeof v === 'object'
      ? Object.values(v as Record<string, unknown>).map(String)
      : String(v).split(',');
  const cleaned = raw.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/**
 * Sections arrive either as JSON objects (a run body) or as "start>end" strings
 * (a query string, where nesting objects would be worse than the separator).
 * An empty side means the edge of the book, so ">climax" is valid and means
 * "everything up to the climax".
 */
function sections(v: unknown): SectionSpec[] | undefined {
  const raw = Array.isArray(v)
    ? v
    : v === undefined || v === null || v === ''
      ? []
      : typeof v === 'object'
        ? Object.values(v as Record<string, unknown>)
        : [v];
  const out: SectionSpec[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const spec: SectionSpec = {
        name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : undefined,
        startTag: typeof o.startTag === 'string' && o.startTag.trim() ? o.startTag.trim() : null,
        endTag: typeof o.endTag === 'string' && o.endTag.trim() ? o.endTag.trim() : null,
      };
      if (spec.startTag || spec.endTag) out.push(spec);
      continue;
    }
    const text = String(entry ?? '');
    if (!text.includes('>')) continue;
    const [start, end] = text.split('>');
    const spec: SectionSpec = { startTag: start.trim() || null, endTag: end.trim() || null };
    if (spec.startTag || spec.endTag) out.push(spec);
  }
  return out.length ? out : undefined;
}

function posInt(v: unknown): number | undefined {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parse the scope + shape of an analysis read from the query string.
 *
 * groupBy and aggregate are validated rather than cast. An unrecognised value
 * used to reach the switch in groupKeys, fall through every case, and return
 * undefined — which the caller then tried to iterate, producing a 500 with an
 * internal message ("groupKeys is not a function or its return value is not
 * iterable"). A typo in a URL is the caller's mistake and deserves a 400 saying
 * so, not a stack-trace fragment.
 */
function analyzeInputFromQuery(req: Request): AnalyzeInput {
  const groupBy = str(req.query.groupBy);
  const aggregate = str(req.query.aggregate);
  if (groupBy && !GROUP_BY_VALUES.includes(groupBy as GroupBy)) {
    throw new AnalysisInputError(
      `Unknown groupBy "${groupBy}". Use one of: ${GROUP_BY_VALUES.join(', ')}.`,
    );
  }
  if (aggregate && !AGGREGATE_VALUES.includes(aggregate as Aggregate)) {
    throw new AnalysisInputError(
      `Unknown aggregate "${aggregate}". Use one of: ${AGGREGATE_VALUES.join(', ')}.`,
    );
  }
  return {
    bookNames: list(req.query.books),
    dimensionNames: list(req.query.dimensions),
    methods: list(req.query.methods),
    tags: list(req.query.tags),
    sections: sections(req.query.sections),
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
    sections: sections(b.sections),
    pageStart: posInt(b.pageStart),
    pageEnd: posInt(b.pageEnd),
    rubric: typeof b.rubric === 'string' ? b.rubric : undefined,
    rubricName: typeof b.rubricName === 'string' ? b.rubricName : undefined,
    negation: Boolean(b.negation),
    overwrite: Boolean(b.overwrite),
  };
}

// GET /api/analysis/options — everything the run form needs, in one call
analysisRouter.get('/analysis/options', async (req, res) => {
  try {
    const role = (req as AuthedRequest).user?.role === 'member' ? 'member' : 'guest';
    res.json(await getAnalysisOptions({ role }));
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/estimate — size a run (pages, calls, cap) before committing
analysisRouter.post('/analysis/estimate', allowGuestLexiconRuns, LIMITS.ESTIMATES, async (req, res) => {
  try {
    res.json(await estimateRun(runRequestFromBody(req.body)));
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/analysis/runs — start scoring; returns immediately, poll for progress
analysisRouter.post('/analysis/runs', allowGuestLexiconRuns, LIMITS.SCORING, async (req, res) => {
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
analysisRouter.get('/analysis/runs/:id', (req, res) => {
  const run = getRun(str(req.params.id));
  if (!run) {
    res.status(404).json({ error: 'That run is no longer available. Any scores it produced are still saved.' });
    return;
  }
  res.json({ run });
});

/**
 * Scores are public; the sentences a model wrote about a page are not.
 *
 * A lexicon rationale is a match count and harmless, but an LLM rationale can
 * quote the page it is describing, and there is no reliable way to tell one
 * that quotes from one that does not. Dropping it for guests keeps the rule
 * simple: no book text leaves the members' tier, by any route.
 */
function redactRationales<T extends { rows: Array<{ rationale: string | null }> }>(result: T): T {
  return { ...result, rows: result.rows.map((r) => ({ ...r, rationale: null })) };
}

// GET /api/analysis/results — aggregated scores for a slice, for the on-screen table
analysisRouter.get('/analysis/results', async (req, res) => {
  try {
    const result = await getResults(analyzeInputFromQuery(req));
    const guest = (req as AuthedRequest).user?.role !== 'member';
    res.json(guest ? redactRationales(result) : result);
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/analysis/explain — why one page scored what it did, term by term.
// A read like any other: open to guests, and it spends nothing.
analysisRouter.get('/analysis/explain', async (req, res) => {
  try {
    const pageNumber = posInt(req.query.page);
    if (!pageNumber) throw new AnalysisInputError('A page number is required.');
    const explanation = await explainPageScore({
      book: str(req.query.book),
      pageNumber,
      method: str(req.query.method),
      dimension: str(req.query.dimension),
      negation: str(req.query.negation) === '1',
    });
    // Guests get the reasoning without the text. The matched dictionary terms
    // stay — they are the analysis, and a handful of scored words is not the
    // page — but the transcript itself does not leave the members' tier. An LLM
    // rationale can quote the page, so it is withheld on the same grounds.
    const guest = (req as AuthedRequest).user?.role !== 'member';
    res.json(
      guest
        ? { ...explanation, text: '', rationale: null, textRedacted: true }
        : { ...explanation, textRedacted: false },
    );
  } catch (err) {
    if (err instanceof ExplainError) {
      res.status(404).json({ error: err.message });
      return;
    }
    handleError(err, res);
  }
});

// GET /api/analysis/export?format=pages.csv — download the analysis
analysisRouter.get('/analysis/export', LIMITS.EXPORTS, async (req, res) => {
  try {
    const format = (str(req.query.format) || 'pages.csv') as ExportFormat;
    const guest = (req as AuthedRequest).user?.role !== 'member';
    const file = await exportResults(analyzeInputFromQuery(req), format, { includeRationale: !guest });
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
// POST /api/analysis/methods — save a custom rubric as a reusable instrument.
// Member-only: it writes to the shared instrument set.
analysisRouter.post('/analysis/methods', requireMember, async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const method = await saveRubricMethod({
      name: str(b.name),
      rubric: str(b.rubric),
      model: str(b.model) || undefined,
    });
    res.status(201).json({ method });
  } catch (err) {
    handleError(err, res);
  }
});

analysisRouter.delete('/analysis/methods/:name', requireMember, async (req, res) => {
  try {
    await deleteMethodData(str(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});
