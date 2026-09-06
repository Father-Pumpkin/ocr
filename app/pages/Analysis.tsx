import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, type RunRequest } from '../lib/api';
import type {
  Aggregate,
  AnalysisOptions,
  AnalysisRun,
  AnalysisStyle,
  AnalyzeResult,
  ExportFormat,
  GroupBy,
  RunMode,
  ScoringEstimate,
  SentimentBatch,
  StyleFamily,
} from '../types';
import { Button, Card, ErrorBox, Label, Loading, Spinner, Badge, buttonClass } from '../components/ui';
import { TagSelect } from '../components/TagSelect';
import { LexiconUpload } from '../components/LexiconUpload';
import { Search, Download, Plus, Upload, Check, Refresh } from '../components/icons';
import { useIsMember } from '../lib/session';

/**
 * Sentiment analysis: pick an instrument, pick what it measures, pick what it
 * runs over, then download the result.
 *
 * There are two ways to run. A **standard** run scores inline while you watch,
 * polled rather than held open on one request so a few hundred pages don't time
 * out behind a proxy. A **batch** run goes to the Anthropic Batch API — about
 * half the price, about an hour — and is tracked in the database, so it survives
 * closing the tab. Past the server's threshold the estimate recommends batch,
 * but the choice is always the user's.
 *
 * Scores are cached per (page, dimension, method), which is why re-running a
 * scope you've already done is nearly instant and why the results panel can be
 * read back at any time without re-scoring.
 */

const FAMILY_LABEL: Record<StyleFamily, string> = {
  bag_of_words: 'Bag of words',
  llm: 'LLM',
};

const FAMILY_BLURB: Record<StyleFamily, string> = {
  bag_of_words:
    'Every word on the page is looked up in a sentiment dictionary and the matches are averaged. Local, instant, free, and perfectly reproducible.',
  llm: 'Claude reads each page and scores it against the dimension\'s rubric. Handles context, irony and negation that a word list misses — one API call per page.',
};

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  page: 'Page by page',
  book: 'By book',
  tag: 'By tag',
  book_tag: 'By book × tag',
  method: 'By method',
};

const EXPORT_LABEL: Record<ExportFormat, string> = {
  'pages.csv': 'Per-page CSV',
  'summary.csv': 'Summary CSV',
  json: 'JSON',
};

export function Analysis() {
  // Guests get the whole read side of this screen — pick a slice of the
  // pre-computed scores, compare instruments, download it. What they don't get
  // is anything that writes to page_sentiment or spends API budget.
  const isMember = useIsMember();
  const [params] = useSearchParams();
  const [options, setOptions] = useState<AnalysisOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- Selection -----------------------------------------------------------
  const [family, setFamily] = useState<StyleFamily>('llm');
  const [styleId, setStyleId] = useState('');
  const [rubric, setRubric] = useState('');
  const [rubricName, setRubricName] = useState('');
  const [showRubric, setShowRubric] = useState(false);
  const [dimensions, setDimensions] = useState<string[]>([]);
  // Empty = every transcribed book, matching the backend's own default.
  const [books, setBooks] = useState<string[]>(() => params.getAll('book'));
  const [bookQuery, setBookQuery] = useState('');
  const [pageStart, setPageStart] = useState('');
  const [pageEnd, setPageEnd] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  // null = follow the estimate's recommendation; a value overrides it.
  const [modeOverride, setModeOverride] = useState<RunMode | null>(null);

  // --- Run + results -------------------------------------------------------
  const [estimate, setEstimate] = useState<ScoringEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<AnalyzeResult | null>(null);
  const [resultsBusy, setResultsBusy] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy | ''>('');
  const [aggregate, setAggregate] = useState<Aggregate | ''>('');
  // Off: show only the instrument selected above. On: every instrument that has
  // scores for this scope, so a lexicon and Claude can be read side by side.
  const [compareMethods, setCompareMethods] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewDimension, setShowNewDimension] = useState(false);
  const [batches, setBatches] = useState<SentimentBatch[]>([]);
  const [prewarming, setPrewarming] = useState(false);

  const reloadOptions = useCallback(async () => {
    const opts = await api.getAnalysisOptions();
    setOptions(opts);
    return opts;
  }, []);

  const reloadBatches = useCallback(async () => {
    try {
      setBatches((await api.getBatches()).batches);
    } catch {
      /* the batch panel is supplementary — never block the page on it */
    }
  }, []);

  useEffect(() => {
    if (isMember) void reloadBatches();
  }, [reloadBatches, isMember]);

  useEffect(() => {
    reloadOptions()
      .then((opts) => {
        // Guests can't run anything, so start them on a bag-of-words style —
        // those are the ones with scores already computed to look at.
        const first = isMember
          ? opts.styles.find((s) => s.family === 'llm' && s.available)
          : opts.styles.find((s) => s.family === 'bag_of_words' && s.available);
        setStyleId((prev) => prev || first?.id || '');
        if (!isMember && first?.family === 'bag_of_words') setFamily('bag_of_words');
        setDimensions((prev) => (prev.length ? prev : opts.dimensions.slice(0, 1).map((d) => d.name)));
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : String(e)));
  }, [reloadOptions, isMember]);

  // A guest has no Run button, so nothing would ever populate the results panel.
  // Show them whatever is already scored for the current selection.
  useEffect(() => {
    if (!isMember && options && !results) void loadResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMember, options]);

  const style = useMemo(
    () => options?.styles.find((s) => s.id === styleId) ?? null,
    [options, styleId],
  );

  const runRequest: RunRequest = useMemo(
    () => ({
      style: styleId,
      books: books.length ? books : undefined,
      dimensions: dimensions.length ? dimensions : undefined,
      tags: tags.length ? tags : undefined,
      pageStart: pageStart ? Number(pageStart) : undefined,
      pageEnd: pageEnd ? Number(pageEnd) : undefined,
      rubric: showRubric && rubric.trim() ? rubric : undefined,
      rubricName: showRubric && rubric.trim() ? rubricName : undefined,
      mode: modeOverride ?? undefined,
      overwrite,
    }),
    [styleId, books, dimensions, tags, pageStart, pageEnd, showRubric, rubric, rubricName, overwrite, modeOverride],
  );

  // Size the run whenever the selection settles. Debounced because typing a page
  // range would otherwise fire a request per keystroke.
  const estimateKey = JSON.stringify(runRequest);
  useEffect(() => {
    if (!styleId || !style?.available || !isMember) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setEstimating(true);
    const timer = setTimeout(() => {
      api
        .estimateAnalysis(runRequest)
        .then((e) => !cancelled && setEstimate(e))
        .catch((e) => {
          if (!cancelled) {
            setEstimate(null);
            setRunError(e instanceof ApiError ? e.message : String(e));
          }
        })
        .finally(() => !cancelled && setEstimating(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // runRequest is rebuilt each render; estimateKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, style?.available, isMember]);

  // --- Results -------------------------------------------------------------

  const resultsQuery = useMemo(
    () => ({
      books: books.length ? books : undefined,
      dimensions: dimensions.length ? dimensions : undefined,
      methods: compareMethods || !style?.method ? undefined : [style.method],
      tags: tags.length ? tags : undefined,
      pageStart: pageStart ? Number(pageStart) : undefined,
      pageEnd: pageEnd ? Number(pageEnd) : undefined,
      groupBy: groupBy || undefined,
      aggregate: aggregate || undefined,
    }),
    [books, dimensions, style?.method, compareMethods, tags, pageStart, pageEnd, groupBy, aggregate],
  );

  const loadResults = useCallback(async () => {
    setResultsBusy(true);
    try {
      setResults(await api.getAnalysisResults(resultsQuery));
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setResultsBusy(false);
    }
  }, [resultsQuery]);

  // Reload the panel whenever its shape changes, but only once results exist —
  // before the first run there is nothing to show and no reason to ask.
  const hasResults = results !== null;
  useEffect(() => {
    if (hasResults) void loadResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, aggregate, compareMethods]);

  // --- Running -------------------------------------------------------------

  const pollRef = useRef<number | null>(null);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  async function onRun() {
    setRunError(null);
    try {
      const { run: started } = await api.startAnalysisRun(runRequest);
      setRun(started);
      // A batch is handed off, not watched: it lands in the batch panel and the
      // server polls it. Nothing to progress-bar here.
      if (started.mode === 'batch') {
        if (started.status === 'error') setRunError(started.error ?? 'The batch could not be submitted.');
        await reloadBatches();
        return;
      }
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const { run: latest } = await api.getAnalysisRun(started.id);
          setRun(latest);
          if (latest.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            if (latest.status === 'error') setRunError(latest.error ?? 'The run failed.');
            await loadResults();
            // A run can mint a method (a model's first use, or a saved rubric).
            await reloadOptions().catch(() => undefined);
          }
        } catch (e) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setRunError(e instanceof ApiError ? e.message : String(e));
        }
      }, 1000);
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function onPrewarm() {
    setPrewarming(true);
    setRunError(null);
    try {
      const { run: started } = await api.prewarmLexicons();
      setRun(started);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const { run: latest } = await api.getAnalysisRun(started.id);
          setRun(latest);
          if (latest.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setPrewarming(false);
            if (latest.status === 'error') setRunError(latest.error ?? 'Prewarming failed.');
            await loadResults();
          }
        } catch (e) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setPrewarming(false);
          setRunError(e instanceof ApiError ? e.message : String(e));
        }
      }, 1000);
    } catch (e) {
      setPrewarming(false);
      setRunError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (loadError) return <ErrorBox message={`Couldn't load analysis options: ${loadError}`} />;
  if (!options) return <Loading label="Loading analysis options…" />;

  const familyStyles = options.styles.filter((s) => s.family === family);
  const filteredBooks = options.books.filter((b) =>
    bookQuery.trim() ? b.title.toLowerCase().includes(bookQuery.trim().toLowerCase()) : true,
  );
  const running = run?.status === 'running';
  const effectiveMode: RunMode = modeOverride ?? estimate?.recommendedMode ?? 'standard';
  const modeCapExceeded = estimate
    ? effectiveMode === 'batch'
      ? estimate.batchCapExceeded
      : estimate.capExceeded
    : false;
  const canRun =
    !!style?.available &&
    dimensions.length > 0 &&
    !running &&
    !!estimate &&
    !estimate.problem &&
    !modeCapExceeded &&
    estimate.pairs > 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">Sentiment analysis</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {isMember
            ? 'Score pages on a construct, then download the results. Pick how to measure, what to measure, and what to run it over.'
            : 'Explore the sentiment scores already computed for this library. Choose an instrument, a construct and a slice of the corpus, compare instruments against each other, and download the result.'}
        </p>
      </header>

      {/* ---- Step 1: the instrument ---- */}
      <Section step={1} title="How to measure" hint="The scoring instrument.">
        <div className="flex gap-2">
          {(['llm', 'bag_of_words'] as StyleFamily[]).map((f) => (
            <button
              key={f}
              onClick={() => {
                setFamily(f);
                const first = options.styles.find((s) => s.family === f && s.available);
                setStyleId(first?.id ?? '');
              }}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                family === f
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-border bg-surface text-muted hover:text-ink'
              }`}
            >
              {FAMILY_LABEL[f]}
            </button>
          ))}
        </div>
        <p className="mt-2.5 max-w-2xl text-sm text-muted">{FAMILY_BLURB[family]}</p>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {familyStyles.map((s) => (
            <StyleCard key={s.id} style={s} selected={s.id === styleId} onSelect={() => setStyleId(s.id)} />
          ))}
        </div>

        {family === 'bag_of_words' && isMember && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => setShowUpload(true)} className={buttonClass('secondary', 'sm')}>
              <Upload className="h-4 w-4" />
              Upload a dictionary
            </button>
            <button
              onClick={onPrewarm}
              disabled={prewarming || options.lexiconMethods.length === 0}
              title={
                options.lexiconMethods.length === 0
                  ? 'Load a dictionary first'
                  : 'Score every book with every loaded dictionary — local, instant and free'
              }
              className={buttonClass('secondary', 'sm')}
            >
              <Refresh className="h-4 w-4" />
              {prewarming ? 'Pre-computing…' : 'Pre-compute the whole library'}
            </button>
            {options.lexiconMethods.length > 0 && (
              <span className="text-xs text-muted">
                {options.lexiconMethods.length} dictionar
                {options.lexiconMethods.length === 1 ? 'y' : 'ies'} loaded
              </span>
            )}
          </div>
        )}
        <p className="mt-2.5 text-xs text-faint">
          {family === 'bag_of_words'
            ? 'Dictionaries can also be dropped into the server\u2019s lexicons folder — they load on startup.'
            : ''}
        </p>

        {family === 'llm' && isMember && (
          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={showRubric}
                onChange={(e) => setShowRubric(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Use a custom rubric instead of each dimension's description
            </label>
            {showRubric && (
              <div className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2 p-4">
                <label className="block">
                  <Label>Rubric name</Label>
                  <input
                    value={rubricName}
                    onChange={(e) => setRubricName(e.target.value)}
                    placeholder="e.g. fear-strict"
                    className="mt-1.5 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <span className="mt-1 block text-xs text-muted">
                    Saved as a reusable method, so this run can be repeated and compared later.
                  </span>
                </label>
                <label className="block">
                  <Label>Rubric</Label>
                  <textarea
                    value={rubric}
                    onChange={(e) => setRubric(e.target.value)}
                    rows={4}
                    placeholder="What should Claude look for? Be specific about what makes a page score high vs low."
                    className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ---- Step 2: dimensions ---- */}
      <Section step={2} title="What to measure" hint="One score per page, per dimension.">
        {options.dimensions.length === 0 ? (
          <p className="text-sm text-muted">No dimensions defined yet — create one to get started.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.dimensions.map((d) => {
              const on = dimensions.includes(d.name);
              return (
                <button
                  key={d.id}
                  title={d.description}
                  onClick={() =>
                    setDimensions((prev) => (on ? prev.filter((n) => n !== d.name) : [...prev, d.name]))
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
                    on ? 'border-accent bg-accent text-accent-ink' : 'border-border bg-surface text-muted hover:text-ink'
                  }`}
                >
                  {on && <Check className="h-3.5 w-3.5" />}
                  {d.name}
                </button>
              );
            })}
          </div>
        )}
        {isMember && (
          <button onClick={() => setShowNewDimension(true)} className={buttonClass('secondary', 'sm', 'mt-3')}>
            <Plus className="h-4 w-4" />
            New dimension
          </button>
        )}
        {showNewDimension && (
          <NewDimensionForm
            onCancel={() => setShowNewDimension(false)}
            onCreated={async (created) => {
              setShowNewDimension(false);
              await reloadOptions().catch(() => undefined);
              setDimensions((prev) => [...prev, created]);
            }}
          />
        )}
      </Section>

      {/* ---- Step 3: scope ---- */}
      <Section step={3} title="What to run it on" hint="A whole book, a section of one, or the whole library.">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="flex items-center justify-between gap-3">
              <Label>Books</Label>
              <span className="text-xs text-muted">
                {books.length === 0 ? `All ${options.books.length} transcribed` : `${books.length} selected`}
              </span>
            </div>
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                value={bookQuery}
                onChange={(e) => setBookQuery(e.target.value)}
                placeholder="Filter titles…"
                className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface">
              {filteredBooks.map((b) => {
                const on = books.includes(b.title);
                return (
                  <label
                    key={b.title}
                    className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-1.5 text-sm text-ink last:border-b-0 hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setBooks((prev) => (on ? prev.filter((t) => t !== b.title) : [...prev, b.title]))
                      }
                      className="accent-[var(--accent)]"
                    />
                    <span className="flex-1 truncate">{b.title}</span>
                    {b.pageCount != null && <span className="text-xs text-faint">{b.pageCount}p</span>}
                  </label>
                );
              })}
              {filteredBooks.length === 0 && <p className="px-3 py-4 text-sm text-muted">No titles match.</p>}
            </div>
            {books.length > 0 && (
              <button onClick={() => setBooks([])} className={buttonClass('ghost', 'sm', 'mt-2')}>
                Clear selection (use every book)
              </button>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <Label>Page range</Label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  value={pageStart}
                  onChange={(e) => setPageStart(e.target.value.replace(/\D/g, ''))}
                  placeholder="from"
                  inputMode="numeric"
                  className="h-9 w-24 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <span className="text-muted">–</span>
                <input
                  value={pageEnd}
                  onChange={(e) => setPageEnd(e.target.value.replace(/\D/g, ''))}
                  placeholder="to"
                  inputMode="numeric"
                  className="h-9 w-24 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <span className="text-xs text-muted">Leave blank for every page.</span>
              </div>
            </div>
            <div>
              <Label>Tagged pages only</Label>
              <div className="mt-1.5">
                <TagSelect value={tags} onChange={setTags} suggestions={options.tags} placeholder="Any tag…" />
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span>
                Re-score pages that already have a score
                <span className="block text-xs text-muted">
                  Off by default: existing scores for this instrument are reused, so repeat runs are cheap.
                </span>
              </span>
            </label>
          </div>
        </div>
      </Section>

      {/* ---- Run (members) / explanation (guests) ---- */}
      {!isMember && (
        <Card className="p-5">
          <p className="text-sm text-muted">
            Running new analyses is limited to approved accounts — scores are shared research data, and the
            LLM instruments cost money per page. Everything already scored is yours to slice and download
            below.
          </p>
        </Card>
      )}
      {isMember && (
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <EstimateLine
            estimate={estimate}
            estimating={estimating}
            style={style}
            mode={effectiveMode}
            maxLlmCalls={options.maxLlmCalls}
            maxBatchItems={options.maxBatchItems}
          />
          <Button variant="primary" onClick={onRun} disabled={!canRun}>
            {running ? 'Running…' : effectiveMode === 'batch' ? 'Submit batch' : 'Run analysis'}
          </Button>
        </div>

        {estimate && estimate.kind !== 'lexicon' && estimate.pairs > 0 && (
          <ModeSelector
            estimate={estimate}
            value={modeOverride}
            onChange={setModeOverride}
            effective={effectiveMode}
          />
        )}

        {running && run && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-3.5 w-3.5" />
              Scored {run.done} of {run.total} page–dimension pairs…
            </p>
          </div>
        )}

        {run?.status === 'complete' && run.result && (
          <p className="mt-3 text-sm text-ok">{run.result.message}</p>
        )}
        {run?.status === 'submitted' && (
          <p className="mt-3 text-sm text-ok">
            Batch <code className="rounded bg-surface-2 px-1 text-xs">{run.batchId}</code> submitted with{' '}
            {run.total.toLocaleString()} score{run.total === 1 ? '' : 's'}. It takes about an hour; the server
            collects the results on its own, and you can close this tab.
          </p>
        )}
        {runError && (
          <div className="mt-3">
            <ErrorBox message={runError} />
          </div>
        )}
      </Card>
      )}

      {isMember && batches.length > 0 && (
        <BatchPanel
          batches={batches}
          onRefresh={reloadBatches}
          onChecked={async () => {
            await reloadBatches();
            if (results) await loadResults();
          }}
        />
      )}

      {/* ---- Results ---- */}
      {results && (
        <ResultsPanel
          results={results}
          busy={resultsBusy}
          groupBy={groupBy}
          aggregate={aggregate}
          onGroupBy={setGroupBy}
          onAggregate={setAggregate}
          compareMethods={compareMethods}
          onCompareMethods={setCompareMethods}
          exportUrl={(f) => api.analysisExportUrl(resultsQuery, f)}
          exportFormats={options.exportFormats}
        />
      )}

      {isMember && showUpload && (
        <LexiconUpload
          dimensions={options.dimensions}
          onClose={() => setShowUpload(false)}
          onImported={async (lex) => {
            setShowUpload(false);
            await reloadOptions().catch(() => undefined);
            setFamily('bag_of_words');
            setStyleId(`lexicon:${lex.name}`);
          }}
        />
      )}
    </div>
  );
}

/* ---- Pieces --------------------------------------------------------------- */

function Section({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-baseline gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
          {step}
        </span>
        <div>
          <h2 className="font-serif text-lg font-semibold text-ink">{title}</h2>
          <p className="text-xs text-muted">{hint}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function StyleCard({
  style,
  selected,
  onSelect,
}: {
  style: AnalysisStyle;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={!style.available}
      title={style.hint}
      className={`rounded-xl border p-3.5 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent-soft'
          : 'border-border bg-surface hover:border-border-strong'
      } ${style.available ? '' : 'cursor-not-allowed opacity-50'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{style.label}</span>
        {style.lexicon && (
          <Badge tone="neutral">{style.lexicon.termCount.toLocaleString()} terms</Badge>
        )}
        {!style.available && <Badge tone="warn">not loaded</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted">{style.description}</p>
      {style.lexicon && style.lexicon.dimensions.length > 0 && (
        <p className="mt-1.5 text-xs text-faint">Covers: {style.lexicon.dimensions.join(', ')}</p>
      )}
      {style.hint && <p className="mt-1.5 text-xs text-warn">{style.hint}</p>}
    </button>
  );
}

function EstimateLine({
  estimate,
  estimating,
  style,
  mode,
  maxLlmCalls,
  maxBatchItems,
}: {
  estimate: ScoringEstimate | null;
  estimating: boolean;
  style: AnalysisStyle | null;
  mode: RunMode;
  maxLlmCalls: number;
  maxBatchItems: number;
}) {
  if (!style) return <p className="text-sm text-muted">Choose an instrument to begin.</p>;
  if (!style.available) {
    return <p className="text-sm text-warn">{style.hint ?? 'This instrument isn\'t available yet.'}</p>;
  }
  if (estimating || !estimate) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="h-3.5 w-3.5" /> Sizing the run…
      </p>
    );
  }
  if (estimate.problem) return <p className="text-sm text-warn">{estimate.problem}</p>;

  if (estimate.pairs === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing new to score — all {estimate.alreadyScored} page–dimension pair(s) in this scope already have a{' '}
        <strong className="text-ink">{estimate.method}</strong> score. Tick “re-score” to run them again.
      </p>
    );
  }

  const capExceeded = mode === 'batch' ? estimate.batchCapExceeded : estimate.capExceeded;
  const limit = mode === 'batch' ? maxBatchItems : maxLlmCalls;
  const calls = estimate.requiredCalls.toLocaleString();
  const cost =
    estimate.kind === 'lexicon'
      ? 'scored locally, no API calls'
      : mode === 'batch'
        ? `${calls} Claude call${estimate.requiredCalls === 1 ? '' : 's'} via the Batch API (limit ${limit.toLocaleString()})`
        : `${calls} Claude call${estimate.requiredCalls === 1 ? '' : 's'} (standard-run limit ${limit.toLocaleString()})`;

  return (
    <p className={`text-sm ${capExceeded ? 'text-danger' : 'text-muted'}`}>
      {estimate.pairs.toLocaleString()} page–dimension pair{estimate.pairs === 1 ? '' : 's'} across{' '}
      {estimate.books} book{estimate.books === 1 ? '' : 's'} — {cost}.
      {estimate.alreadyScored > 0 && ` ${estimate.alreadyScored.toLocaleString()} already scored, skipped.`}
      {capExceeded &&
        (mode === 'standard' && !estimate.batchCapExceeded
          ? ' Submit it as a batch, or narrow the scope.'
          : ' Narrow the scope to run it.')}
    </p>
  );
}

/**
 * Standard vs batch. The server recommends by scope size; this only ever
 * suggests, so an override in either direction is one click and stays put.
 */
function ModeSelector({
  estimate,
  value,
  onChange,
  effective,
}: {
  estimate: ScoringEstimate;
  value: RunMode | null;
  onChange: (m: RunMode | null) => void;
  effective: RunMode;
}) {
  const options: Array<{ mode: RunMode; label: string; blurb: string }> = [
    {
      mode: 'standard',
      label: 'Standard',
      blurb: 'Scores now while you watch. Full price.',
    },
    {
      mode: 'batch',
      label: 'Batch',
      blurb: 'About half the price, about an hour. Close the tab if you like.',
    },
  ];
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label>How to run</Label>
        <span className="text-xs text-muted">
          {estimate.pairs > estimate.batchThreshold
            ? `Over ${estimate.batchThreshold} pairs — batch recommended.`
            : `Under ${estimate.batchThreshold} pairs — standard recommended.`}
        </span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const selected = effective === o.mode;
          const recommended = estimate.recommendedMode === o.mode;
          const overCap = o.mode === 'batch' ? estimate.batchCapExceeded : estimate.capExceeded;
          return (
            <button
              key={o.mode}
              onClick={() => onChange(recommended && value === null ? null : o.mode)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-border-strong'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="font-medium text-ink">{o.label}</span>
                {recommended && <Badge tone="accent">recommended</Badge>}
                {overCap && <Badge tone="danger">over the limit</Badge>}
              </span>
              <span className="mt-1 block text-xs text-muted">{o.blurb}</span>
            </button>
          );
        })}
      </div>
      {value !== null && value !== estimate.recommendedMode && (
        <button onClick={() => onChange(null)} className={buttonClass('ghost', 'sm', 'mt-2')}>
          Use the recommendation instead
        </button>
      )}
    </div>
  );
}

/**
 * Batches in flight. The server checks these on a timer, so this panel is for
 * visibility and for anyone impatient enough to want to check right now.
 */
function BatchPanel({
  batches,
  onRefresh,
  onChecked,
}: {
  batches: SentimentBatch[];
  onRefresh: () => Promise<void>;
  onChecked: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function check(batchId: string) {
    setBusy(batchId);
    setNote(null);
    try {
      const r = await api.checkBatch(batchId);
      setNote(r.summary);
      await onChecked();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-semibold text-ink">Batches</h2>
          <p className="mt-1 text-sm text-muted">
            Submitted to the Batch API. The server collects results on its own every few minutes — checking here
            just asks now.
          </p>
        </div>
        <button onClick={() => void onRefresh()} className={buttonClass('secondary', 'sm')}>
          <Refresh className="h-4 w-4" />
          Refresh
        </button>
      </div>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {batches.map((b) => (
          <li key={b.batchId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <code className="block truncate text-xs text-ink">{b.batchId}</code>
              <span className="text-xs text-muted">
                {new Date(b.createdAt).toLocaleString()} · {b.bookCount} book{b.bookCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={b.status === 'complete' ? 'ok' : b.status === 'failed' ? 'danger' : 'warn'}>
                {b.status}
              </Badge>
              {b.status !== 'complete' && (
                <Button variant="secondary" size="sm" onClick={() => check(b.batchId)} disabled={busy === b.batchId}>
                  {busy === b.batchId ? 'Checking…' : 'Check now'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
    </Card>
  );
}

function ResultsPanel({
  results,
  busy,
  groupBy,
  aggregate,
  onGroupBy,
  onAggregate,
  compareMethods,
  onCompareMethods,
  exportUrl,
  exportFormats,
}: {
  results: AnalyzeResult;
  busy: boolean;
  groupBy: GroupBy | '';
  aggregate: Aggregate | '';
  onGroupBy: (g: GroupBy | '') => void;
  onAggregate: (a: Aggregate | '') => void;
  compareMethods: boolean;
  onCompareMethods: (v: boolean) => void;
  exportUrl: (f: ExportFormat) => string;
  exportFormats: ExportFormat[];
}) {
  const hasScores = results.groups.length > 0;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-lg font-semibold text-ink">Results</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{results.summary}</p>
        </div>
        {hasScores && (
          <div className="flex flex-wrap gap-2">
            {exportFormats.map((f) => (
              <a key={f} href={exportUrl(f)} download className={buttonClass('secondary', 'sm')}>
                <Download className="h-4 w-4" />
                {EXPORT_LABEL[f]}
              </a>
            ))}
          </div>
        )}
      </div>

      {hasScores && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              Group by
              <select
                value={groupBy}
                onChange={(e) => onGroupBy(e.target.value as GroupBy | '')}
                className="h-8 rounded-lg border border-border bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <option value="">Automatic</option>
                {(Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((g) => (
                  <option key={g} value={g}>
                    {GROUP_BY_LABEL[g]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              Show
              <select
                value={aggregate}
                onChange={(e) => onAggregate(e.target.value as Aggregate | '')}
                className="h-8 rounded-lg border border-border bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <option value="">Automatic</option>
                <option value="mean">Group averages</option>
                <option value="series">Every page</option>
              </select>
            </label>
            <label
              className="flex items-center gap-2 text-sm text-muted"
              title="Include every instrument that has scores for this scope, not just the one selected above"
            >
              <input
                type="checkbox"
                checked={compareMethods}
                onChange={(e) => onCompareMethods(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Compare all instruments
            </label>
            {busy && <Spinner className="h-4 w-4 text-muted" />}
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 font-medium">Dimension</th>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 text-right font-medium">Pages</th>
                  <th className="px-3 py-2 font-medium">Mean score</th>
                </tr>
              </thead>
              <tbody>
                {results.groups.map((g, i) => {
                  const mean =
                    g.mean ??
                    (g.points?.length
                      ? g.points.reduce((s, p) => s + p.score, 0) / g.points.length
                      : null);
                  return (
                    <tr key={`${g.dimension}-${g.method}-${g.key}-${i}`} className="border-t border-border">
                      <td className="max-w-xs truncate px-3 py-2 text-ink" title={g.key}>
                        {g.key}
                      </td>
                      <td className="px-3 py-2 text-muted">{g.dimension}</td>
                      <td className="px-3 py-2 text-muted">{g.method}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{g.count}</td>
                      <td className="px-3 py-2">
                        {mean === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                              <span
                                className="block h-full rounded-full bg-accent"
                                style={{ width: `${Math.round(mean * 100)}%` }}
                              />
                            </span>
                            <span className="tabular-nums text-ink">{mean.toFixed(3)}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted">
            {results.coverage.scores.toLocaleString()} score
            {results.coverage.scores === 1 ? '' : 's'} over {results.coverage.scoredPages.toLocaleString()} of{' '}
            {results.coverage.textPages.toLocaleString()} text pages in scope.
          </p>
        </>
      )}
    </Card>
  );
}

function NewDimensionForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minLabel, setMinLabel] = useState('Low');
  const [maxLabel, setMaxLabel] = useState('High');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { dimension } = await api.createDimension({ name, description, minLabel, maxLabel });
      onCreated(dimension.name);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  const input =
    'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-border bg-surface-2 p-4">
      {error && <ErrorBox message={error} />}
      <label className="block">
        <Label>Name</Label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. fear"
          className={`mt-1.5 ${input}`}
        />
      </label>
      <label className="block">
        <Label>Description</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What makes a page score high vs low? This becomes the rubric Claude scores against."
          className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <Label>Label at 0.0</Label>
          <input value={minLabel} onChange={(e) => setMinLabel(e.target.value)} className={`mt-1.5 ${input}`} />
        </label>
        <label className="block">
          <Label>Label at 1.0</Label>
          <input value={maxLabel} onChange={(e) => setMaxLabel(e.target.value)} className={`mt-1.5 ${input}`} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={busy || !name.trim() || !description.trim()}
        >
          {busy ? 'Creating…' : 'Create dimension'}
        </Button>
      </div>
    </div>
  );
}
