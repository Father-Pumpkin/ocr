import { useMemo, useState } from 'react';
import type { AnalyzeResult, AnalyzeGroup, ScoreRow } from '../types';
import { ScoreInspector } from './ScoreInspector';

/**
 * The results, drawn.
 *
 * Inline SVG rather than a charting library: it inherits the theme's CSS
 * variables so light/dark works for free, and the client keeps its dependency
 * list at React plus Router.
 *
 * Three views, because the questions people bring here are three different
 * shapes and the first version answered only one of them:
 *
 *   - **Compare** — grouped means as a sorted dot plot with 95% CI whiskers.
 *     Replaces bars, for reasons in DotPlot.
 *   - **Arc** — score across a book, one line per group, optionally smoothed.
 *   - **Agree** — two instruments' page scores against each other. Agreement is
 *     a *bivariate* property and every other view here is univariate in score,
 *     so without this the tool's headline feature ("compare instruments") could
 *     only be eyeballed off overlapping lines.
 *
 * Several things this file is careful about were wrong in the first version and
 * were caught against real data; each is commented where it is handled.
 */

/**
 * Chosen for separation first, harmony second.
 *
 * The previous set was drawn from the app's warm palette and several pairs were
 * too close to tell apart on a line chart — gold against bronze, terracotta
 * against rose. These are spread around the hue circle instead, and each is
 * mid-saturation so it reads on both the off-white and the near-black ground.
 */
const PALETTE = [
  '#d1603d', // orange
  '#2a9d8f', // teal
  '#7161ef', // indigo
  '#c9a227', // gold
  '#3a86ff', // blue
  '#c1436d', // raspberry
  '#4c9a2a', // green
  '#8d6e63', // taupe
];

/** Above this many groups a dot plot is taller than any screen. */
const MAX_ROWS = 40;
/** Above this many lines they merge into a solid band — measured, not guessed. */
const MAX_LINES = 8;

export type ChartView = 'compare' | 'arc' | 'agree';
type View = ChartView;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * What to call a line, dot or bar.
 *
 * The group key alone is not enough: grouping by page with several instruments
 * overlaid gives every group the same key — the book title — so a legend would
 * read "La boda" five times. The distinguishing part goes FIRST, because labels
 * are truncated from the right; appending it and then truncating produced five
 * identical labels again.
 */
function labelFor(g: AnalyzeGroup, vary: { methods: boolean; dimensions: boolean }): string {
  const prefix: string[] = [];
  if (vary.methods) prefix.push(g.method);
  if (vary.dimensions) prefix.push(g.dimension);
  return prefix.length ? `${prefix.join(' / ')} — ${g.key}` : g.key;
}

function varying(groups: AnalyzeGroup[]) {
  return {
    methods: new Set(groups.map((g) => g.method)).size > 1,
    dimensions: new Set(groups.map((g) => g.dimension)).size > 1,
  };
}

/**
 * Colour by instrument when instruments vary, otherwise by position.
 *
 * Colour used to be `PALETTE[index % 8]`, which encodes nothing a reader could
 * use: with 72 books × 5 methods the five readings of one book landed 72 rows
 * apart in five arbitrary colours, while readers reasonably assume colour means
 * instrument. Now it does, whenever more than one is on screen.
 */
/**
 * Colour by instrument when instruments vary, otherwise by position.
 *
 * The index comes from the full list of instruments the app knows about, not
 * from the ones currently on screen, so lex-afinn keeps the same colour in every
 * view and does not change hue when you add or remove another dictionary. A
 * hash of the name would also be stable but could collide; a fixed list cannot.
 */
function colorer(
  groups: AnalyzeGroup[],
  vary: { methods: boolean },
  instrumentOrder: string[],
) {
  if (!vary.methods) return (_g: AnalyzeGroup, i: number) => PALETTE[i % PALETTE.length];
  const order = instrumentOrder.length
    ? instrumentOrder
    : [...new Set(groups.map((g) => g.method))].sort();
  return (g: AnalyzeGroup) => {
    const i = order.indexOf(g.method);
    return PALETTE[(i < 0 ? order.length : i) % PALETTE.length];
  };
}

const fmt = (n: number) => n.toFixed(3);

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'rounded-full border px-2.5 py-0.5 text-xs ' +
        (active ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-ink')
      }
    >
      {children}
    </button>
  );
}

/**
 * A hover readout that actually appears when you hover.
 *
 * The charts relied on SVG <title>, which is the browser's native tooltip: it
 * waits about a second, truncates, cannot be styled, and never fires on touch.
 * On a scatter of 1,200 overlapping dots that is the difference between "what
 * is this point" being answerable and not. This is a positioned div driven by
 * mouse position, so it is instant and can carry several lines.
 */
function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[]; color?: string } | null>(null);
  const show = (e: { clientX: number; clientY: number }, lines: string[], color?: string, host?: Element | null) => {
    const box = host?.getBoundingClientRect();
    setTip({
      x: e.clientX - (box?.left ?? 0),
      y: e.clientY - (box?.top ?? 0),
      lines,
      color,
    });
  };
  const hide = () => setTip(null);
  const node = tip ? (
    <div
      className="pointer-events-none absolute z-10 max-w-xs rounded border border-border bg-surface px-2 py-1 text-[11px] leading-snug text-ink shadow-lg"
      // Nudged up and right of the cursor so it never sits under the pointer.
      style={{ left: tip.x + 12, top: tip.y - 8 }}
    >
      {tip.color && (
        <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ backgroundColor: tip.color }} />
      )}
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'font-medium' : 'text-muted'}>
          {l}
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-muted">{children}</p>;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function ScoreChart({
  result,
  view,
  onView,
  instrumentOrder = [],
}: {
  result: AnalyzeResult;
  view: ChartView;
  onView: (v: ChartView) => void;
  /** Every instrument the app knows, so colour is stable across selections. */
  instrumentOrder?: string[];
}) {
  const groups = result.groups;
  const methodsPresent = useMemo(
    () => [...new Set((result.rows ?? []).map((r) => r.method_name))].sort(),
    [result.rows],
  );
  const hasSeries = groups.some((g) => (g.points?.length ?? 0) > 0);
  const canAgree = methodsPresent.length > 1;

  // Which group the reader has opened up. Cleared when the shape of the result
  // changes underneath it, so the panel can never describe a stale selection.
  const [inspect, setInspect] = useState<AnalyzeGroup | null>(null);
  const resultKey = `${result.groupBy}:${result.aggregate}:${groups.length}`;
  const [lastKey, setLastKey] = useState(resultKey);
  if (lastKey !== resultKey) {
    setLastKey(resultKey);
    if (inspect) setInspect(null);
  }
  const effective: View = view;

  if (groups.length === 0) {
    return <p className="mt-4 text-sm text-muted">Nothing to plot in this selection.</p>;
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>View</span>
        <Chip active={effective === 'compare'} onClick={() => onView('compare')} title="Group averages with 95% confidence intervals">
          Compare groups
        </Chip>
        <Chip active={effective === 'arc'} onClick={() => onView('arc')} title="Score across the book, scene by scene">
          Across the scenes
        </Chip>
        <Chip
          active={effective === 'agree'}
          onClick={() => onView('agree')}
          title="Two dictionaries plotted against each other, scene by scene"
        >
          Compare instruments
        </Chip>
      </div>

      {effective === 'compare' && (
        <DotPlot groups={groups} onInspect={setInspect} inspected={inspect} instrumentOrder={instrumentOrder} />
      )}
      {effective === 'arc' &&
        (hasSeries ? (
          <ArcChart result={result} onInspect={setInspect} instrumentOrder={instrumentOrder} />
        ) : (
          <p className="text-sm text-muted">Loading per-scene scores…</p>
        ))}
      {effective === 'agree' &&
        (canAgree ? (
          <AgreementChart rows={result.rows ?? []} methods={methodsPresent} />
        ) : (
          <p className="text-sm text-muted">
            Only one instrument has scores for this selection, so there is nothing to compare it against.
          </p>
        ))}

      {inspect && (
        <ScoreInspector group={inspect} rows={result.rows ?? []} onClose={() => setInspect(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare — sorted dot plot with confidence intervals
// ---------------------------------------------------------------------------

/**
 * Bars replaced by dots-and-whiskers, for three measured reasons.
 *
 * **Bars started at zero.** Every book mean in this corpus sits between 0.53 and
 * 0.72, so on a 0–1 axis 53% of every bar was identical ink and the entire
 * signal occupied 19% of the track. The axis is now clipped to the data (plus
 * whiskers), which is honest as long as the zero point is not implied — and a
 * dot implies no baseline, where a bar does.
 *
 * **They were sorted by name.** Finding the extremes meant comparing bar ends
 * 1,400px of scroll apart. Sorted by value, the extremes are the first and last
 * rows.
 *
 * **They showed no uncertainty.** 94% of book pairs in this corpus have
 * overlapping 95% CIs; the chart drew 72 confidently different lengths. The
 * whisker is what stops a reader believing a difference that isn't there.
 */
function DotPlot({
  groups,
  onInspect,
  inspected,
  instrumentOrder,
}: {
  groups: AnalyzeGroup[];
  onInspect: (g: AnalyzeGroup) => void;
  inspected: AnalyzeGroup | null;
  instrumentOrder: string[];
}) {
  const [sortByValue, setSortByValue] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const vary = varying(groups);
  const color = colorer(groups, vary, instrumentOrder);

  const all = useMemo(() => {
    const withMean = groups
      .map((g, i) => {
        const mean =
          g.mean ??
          (g.points?.length ? g.points.reduce((s, p) => s + p.score, 0) / g.points.length : null);
        return mean === null ? null : { g, mean, i, label: labelFor(g, vary), color: color(g, i) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return sortByValue ? [...withMean].sort((a, b) => b.mean - a.mean) : withMean;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sortByValue]);

  if (all.length === 0) return <p className="text-sm text-muted">Nothing to plot in this selection.</p>;

  // Truncating keeps the two ends — the rows a reader of a sorted plot wants —
  // rather than an arbitrary alphabetical prefix.
  const truncated = !showAll && all.length > MAX_ROWS;
  const head = Math.ceil(MAX_ROWS / 2);
  const rows = truncated ? [...all.slice(0, head), ...all.slice(-(MAX_ROWS - head))] : all;
  const hiddenCount = all.length - rows.length;

  const lo = Math.min(...all.map((r) => r.mean - (r.g.stats?.ci95 ?? 0)));
  const hi = Math.max(...all.map((r) => r.mean + (r.g.stats?.ci95 ?? 0)));
  const pad = Math.max(0.02, (hi - lo) * 0.08);
  const min = Math.max(0, lo - pad);
  const max = Math.min(1, hi + pad);
  const span = max - min || 1;
  const pct = (v: number) => ((v - min) / span) * 100;
  const midpointVisible = min < 0.5 && max > 0.5;

  const ticks = [min, min + span / 2, max];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Chip active={sortByValue} onClick={() => setSortByValue(!sortByValue)}>
          {sortByValue ? 'Sorted by score' : 'Sorted by name'}
        </Chip>
        <span>click a row to see the scenes behind it</span>
        <span>
          axis {min.toFixed(2)}–{max.toFixed(2)}
          {(min > 0 || max < 1) && ' (zoomed to the data, not 0–1)'}
        </span>
      </div>

      <div className="space-y-1.5">
        {rows.map(({ g, mean, label, color: c }) => {
          const st = g.stats;
          const thin = g.count < 5 || (st?.nBooks ?? 1) < 2;
          return (
            <div
              key={`${g.dimension}:${g.method}:${g.key}`}
              onClick={() => onInspect(g)}
              title="Show the scenes behind this number"
              className={
                'flex cursor-pointer items-center gap-3 rounded px-1 -mx-1 hover:bg-surface-2 ' +
                (inspected === g ? 'bg-surface-2' : '')
              }
            >
              <div className="w-64 shrink-0 truncate text-right text-xs text-ink" title={label}>
                {label}
              </div>
              <div className="relative h-5 flex-1 rounded bg-surface-2">
                {midpointVisible && (
                  <div
                    className="absolute inset-y-0 w-px bg-[var(--border-strong)]"
                    style={{ left: `${pct(0.5)}%` }}
                    title="0.5 — neutral"
                  />
                )}
                {st && st.ci95 > 0 && (
                  <div
                    className="absolute top-1/2 h-px -translate-y-1/2"
                    style={{
                      left: `${pct(mean - st.ci95)}%`,
                      width: `${Math.max(0, pct(mean + st.ci95) - pct(mean - st.ci95))}%`,
                      backgroundColor: c,
                      opacity: 0.55,
                    }}
                  />
                )}
                <div
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${pct(mean)}%`, backgroundColor: c, opacity: thin ? 0.45 : 1 }}
                  title={
                    `${label}\nmean ${fmt(mean)}` +
                    (st
                      ? `\nmedian ${fmt(st.median)}  sd ${fmt(st.sd)}` +
                        `\n95% CI ±${fmt(st.ci95)}` +
                        `\n${g.count} scene(s) across ${st.nBooks} book(s)`
                      : `\n${g.count} scene(s)`)
                  }
                />
              </div>
              <div className="w-32 shrink-0 text-right text-xs tabular-nums text-ink">
                {fmt(mean)}
                <span className={'ml-1 ' + (thin ? 'text-warn' : 'text-muted')}>
                  n={g.count}
                  {st && st.nBooks > 1 ? `/${st.nBooks}b` : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-1 flex justify-between pl-[17rem] pr-32 text-[10px] tabular-nums text-muted">
        {ticks.map((t, i) => (
          <span key={i}>{t.toFixed(2)}</span>
        ))}
      </div>

      {truncated && (
        <Note>
          Showing the {head} highest and {MAX_ROWS - head} lowest of {all.length} groups.{' '}
          <button type="button" onClick={() => setShowAll(true)} className="text-accent hover:underline">
            Show all {all.length}
          </button>
        </Note>
      )}
      {hiddenCount === 0 && all.length > MAX_ROWS && (
        <Note>Showing all {all.length} groups — the list is long; sorting by score puts the extremes at the ends.</Note>
      )}
      <SpreadNote groups={groups} />
    </div>
  );
}

/**
 * The warnings that stop a mean being read as more than it is. All three are
 * real cases from this corpus, not hypotheticals.
 */
function SpreadNote({ groups }: { groups: AnalyzeGroup[] }) {
  const withStats = groups.filter((g) => g.stats);
  if (withStats.length === 0) return null;

  const thin = withStats.filter((g) => g.count < 5).length;
  // A mean far from its median means a skewed group: one book here reads
  // mean 0.577 against a median of 1.000.
  const skewed = withStats.filter((g) => Math.abs((g.mean ?? 0) - g.stats!.median) > 0.15).length;
  // A near-binary instrument's "mean" is a proportion of positive words, not a
  // level, and does not belong on the same axis as a graded one without saying so.
  const railed = withStats.filter((g) => g.stats!.railShare > 0.4).length;

  if (!thin && !skewed && !railed) return null;
  return (
    <Note>
      <span className="text-warn">Read with care:</span>{' '}
      {[
        thin && `${thin} group(s) rest on fewer than 5 scenes`,
        skewed && `${skewed} are skewed enough that the mean sits far from the median`,
        railed &&
          `${railed} come from a near-binary instrument, where the mean is closer to “share of positive words” than to a level`,
      ]
        .filter(Boolean)
        .join('; ')}
      . Hover a dot for its median, spread and page count.
    </Note>
  );
}

// ---------------------------------------------------------------------------
// Arc — score across the book
// ---------------------------------------------------------------------------

const PAD = { top: 14, right: 14, bottom: 34, left: 40 };
const VIEW_W = 900;
const VIEW_H = 340;

/**
 * A line per group, over position in the book.
 *
 * Two things this refuses to draw, because the first version drew both and they
 * were nonsense rather than merely cluttered:
 *
 * **Groups that pool several books.** Grouping by method or section puts pages
 * from 72 different books in one group; sorted by page number and joined, that
 * is a polyline travelling 45 score-units inside a 1-unit-tall plot — a solid
 * scribble. A line is only a line when its points come from one book.
 *
 * **More than a handful of lines.** At 72 books the median vertical gap between
 * adjacent lines is 1.3px against a 2px stroke: they are physically merged.
 *
 * Position is measured against the **book's** page span, taken from the server,
 * not against the span of the points in this line. Coverage differs per
 * dictionary, so normalising per line put the same physical page up to 17
 * percentage points apart across instruments — inventing a lead/lag that was
 * purely an artefact of which dictionary matched a word on page 1.
 */
function ArcChart({
  result,
  onInspect,
  instrumentOrder,
}: {
  result: AnalyzeResult;
  onInspect: (g: AnalyzeGroup) => void;
  instrumentOrder: string[];
}) {
  const [smooth, setSmooth] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const groups = result.groups.filter((g) => (g.points?.length ?? 0) > 0);
  const vary = varying(groups);
  const color = colorer(groups, vary, instrumentOrder);

  // A group is plottable as an arc only if its points come from one book.
  const pooled = groups.filter((g) => new Set(g.points!.map((p) => p.book_title)).size > 1);
  const plottable = groups.filter((g) => new Set(g.points!.map((p) => p.book_title)).size === 1);

  if (plottable.length === 0) {
    return (
      <p className="text-sm text-warn">
        These groups each pool scenes from several books, so there is no single sequence to draw a line
        along. Group by <strong className="text-ink">page</strong> or <strong className="text-ink">book</strong> to
        plot arcs, or switch to <strong className="text-ink">Compare groups</strong>.
      </p>
    );
  }

  const shown = showAll ? plottable : plottable.slice(0, MAX_LINES);

  const lines = shown.map((g, i) => {
    const pts = [...g.points!].sort((a, b) => a.page_number - b.page_number);
    const book = pts[0].book_title;
    // With exactly one section applied, position runs across that section
    // rather than across the book — 0% is where the section starts. With
    // several, the sections overlap on one axis and the book is the only
    // denominator they share.
    const sectionSpan =
      result.sections?.length === 1 ? result.sectionRanges?.[result.sections[0].label]?.[book] : undefined;
    const span = sectionSpan ?? result.bookPageSpans?.[book];
    const first = span?.first ?? pts[0].page_number;
    const last = span?.last ?? pts[pts.length - 1].page_number;
    const width = last - first || 1;

    const raw = pts.map((p) => ({
      x: ((p.page_number - first) / width) * 100,
      y: p.score,
      page: p.page_number,
      book: p.book_title,
    }));

    // Page-to-page noise in this corpus has a median absolute step of 0.097 —
    // the same size as the entire corpus-level arc it is meant to reveal. A
    // 3-point rolling mean is the difference between a shape and a sawtooth.
    const smoothed = smooth
      ? raw.map((p, j) => {
          const w = raw.slice(Math.max(0, j - 1), Math.min(raw.length, j + 2));
          return { ...p, y: w.reduce((s, q) => s + q.y, 0) / w.length };
        })
      : raw;

    return { key: labelFor(g, vary), color: color(g, i), raw, points: smoothed, group: g, book };
  });

  /**
   * Colour carries the instrument, so when books vary too it has nothing left to
   * say about them — two books of the same dictionary were drawn identically.
   * Dash pattern carries the book in that case, which keeps colour meaning one
   * thing and still separates four lines from two dictionaries.
   */
  // With a section applied the arc covers only that stretch, so "position in
  // book" is the wrong denominator to name even though the geometry is the same:
  // 0% is the start of the section, not of the book.
  // Only a single section gives the axis a well-defined 0–100%; several would
  // each need their own, so the label stays honest about which it is showing.
  const sectioned = result.sections?.length === 1;
  const axisLabel = sectioned ? `Position in “${result.sections[0].label}”` : 'Position in book';

  const bookOrder = [...new Set(lines.map((l) => l.book))].sort();
  const DASHES = [undefined, '6 3', '2 3', '9 3 2 3', '1 3'];
  const dashFor = (book: string) =>
    vary.methods && bookOrder.length > 1 ? DASHES[bookOrder.indexOf(book) % DASHES.length] : undefined;

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + (x / 100) * plotW;
  const sy = (y: number) => PAD.top + (1 - y) * plotH;
  const tip = useTooltip();

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Chip active={smooth} onClick={() => setSmooth(!smooth)} title="3-scene rolling mean">
          {smooth ? 'Smoothed' : 'Raw scenes'}
        </Chip>
        <span>
          x = {sectioned ? 'position through the section' : 'position in book'} (%) · click a line to open its
          scenes
        </span>
      </div>

      <div className="relative overflow-x-auto" onMouseLeave={tip.hide}>
        {tip.node}
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-auto w-full min-w-[520px]" role="img" aria-label="Score across the book">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={sy(t)}
                y2={sy(t)}
                stroke={t === 0.5 ? 'var(--border-strong)' : 'var(--border)'}
                strokeDasharray={t === 0.5 ? '4 4' : undefined}
              />
              <text x={PAD.left - 8} y={sy(t) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px] tabular-nums">
                {t.toFixed(2)}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((t) => (
            <text key={t} x={sx(t)} y={PAD.top + plotH + 16} textAnchor="middle" className="fill-[var(--muted)] text-[11px] tabular-nums">
              {t}%
            </text>
          ))}
          <text x={PAD.left + plotW / 2} y={VIEW_H - 4} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">
            {axisLabel}
          </text>

          {lines.map((line) => (
            <g
              key={line.key}
              onClick={() => onInspect(line.group)}
              style={{ cursor: 'pointer' }}
            >
              {line.points.length > 1 && (
                <path
                  d={line.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x)},${sy(p.y)}`).join(' ')}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeDasharray={dashFor(line.book)}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
              )}
              {/* Hit targets follow the drawn line, not the raw scatter.
                  Smoothing moves the line away from the dots it came from, so
                  targeting the dots meant hovering empty space to read the
                  line, and hovering the line itself did nothing. The invisible
                  radius is generous because a 2px vertex is hard to hit and
                  identifying it is the whole point. */}
              {line.points.map((p, i) => {
                const raw = line.raw[i];
                return (
                  <circle
                    key={i}
                    cx={sx(p.x)}
                    cy={sy(p.y)}
                    r={9}
                    fill="transparent"
                    onMouseMove={(e) =>
                      tip.show(
                        e,
                        [
                          line.key,
                          `scene ${p.page} · ${Math.round(p.x)}% through`,
                          smooth
                            ? `${fmt(p.y)} smoothed · ${fmt(raw.y)} raw`
                            : `score ${fmt(p.y)}`,
                        ],
                        line.color,
                        e.currentTarget.closest('.relative'),
                      )
                    }
                    onMouseLeave={tip.hide}
                  />
                );
              })}
              {/* The raw scatter behind the line stays visible but inert. */}
              {line.raw.map((p, i) => (
                <circle key={`d${i}`} cx={sx(p.x)} cy={sy(p.y)} r={2} fill={line.color} opacity={smooth ? 0.28 : 0.9} pointerEvents="none" />
              ))}
              {/* A visible vertex on the line, so the hover has something to aim at. */}
              {smooth &&
                line.points.map((p, i) => (
                  <circle key={`v${i}`} cx={sx(p.x)} cy={sy(p.y)} r={2.5} fill={line.color} opacity={0.85} pointerEvents="none" />
                ))}
            </g>
          ))}
        </svg>
      </div>

      <Legend items={lines.map((l) => ({ key: l.key, color: l.color, dash: dashFor(l.book) }))} />

      {plottable.length > shown.length && (
        <Note>
          Showing {shown.length} of {plottable.length} arcs — past about {MAX_LINES} the lines merge into a band.{' '}
          <button type="button" onClick={() => setShowAll(true)} className="text-accent hover:underline">
            Draw all {plottable.length} anyway
          </button>
        </Note>
      )}
      {pooled.length > 0 && (
        <Note>
          <span className="text-warn">{pooled.length} group(s) not drawn:</span> they pool scenes from several books, so
          they have no single page sequence. Compare them under “Compare groups”.
        </Note>
      )}
      {smooth && <Note>Line is a 3-scene rolling mean; faint dots are the raw scene scores behind it.</Note>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agreement — two instruments, page by page
// ---------------------------------------------------------------------------

/**
 * Do two instruments agree? A scatter, because agreement is bivariate.
 *
 * Every other view here maps one score to one visual length, so two instruments
 * can only be compared by eye across two shapes. Here the same page is one dot,
 * placed by what each instrument said about it: a tight cloud on the diagonal is
 * agreement, a cloud parallel to it is constant bias, and a round blob is noise.
 *
 * Only pages BOTH scored are plotted, which matters here — coverage runs from
 * 66% to 90% depending on the dictionary, so "all pages" would mean two
 * different sets of pages.
 */
function AgreementChart({ rows, methods }: { rows: ScoreRow[]; methods: string[] }) {
  const [xm, setXm] = useState(methods[0]);
  const [ym, setYm] = useState(methods[1] ?? methods[0]);

  const pairs = useMemo(() => {
    const byPage = new Map<number, { scores: Record<string, number>; book: string; page: number }>();
    for (const r of rows) {
      const e = byPage.get(r.page_id) ?? { scores: {}, book: r.book_title, page: r.page_number };
      e.scores[r.method_name] = r.score;
      byPage.set(r.page_id, e);
    }
    const out: Array<{ x: number; y: number; book: string; page: number }> = [];
    for (const e of byPage.values()) {
      if (e.scores[xm] !== undefined && e.scores[ym] !== undefined) {
        out.push({ x: e.scores[xm], y: e.scores[ym], book: e.book, page: e.page });
      }
    }
    return out;
  }, [rows, xm, ym]);

  const stats = useMemo(() => {
    const n = pairs.length;
    if (n < 2) return null;
    const mx = pairs.reduce((s, p) => s + p.x, 0) / n;
    const my = pairs.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0, sxx = 0, syy = 0, disagree = 0;
    for (const p of pairs) {
      sxy += (p.x - mx) * (p.y - my);
      sxx += (p.x - mx) ** 2;
      syy += (p.y - my) ** 2;
      // Do they even agree on which side of neutral the page falls?
      if ((p.x > 0.5 && p.y < 0.5) || (p.x < 0.5 && p.y > 0.5)) disagree++;
    }
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    return { n, r, meanDiff: my - mx, disagreeShare: disagree / n };
  }, [pairs]);

  const tip = useTooltip();
  const S = 340;
  const P = 34;
  const sx = (v: number) => P + v * (S - P - 10);
  const sy = (v: number) => S - P - v * (S - P - 10);

  const select = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus:border-accent focus:outline-none"
    >
      {methods.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>x</span>
        {select(xm, setXm)}
        <span>y</span>
        {select(ym, setYm)}
        {stats && (
          <span className="tabular-nums">
            r = <strong className="text-ink">{stats.r.toFixed(3)}</strong> over {stats.n} shared scene(s) ·
            mean difference {stats.meanDiff >= 0 ? '+' : ''}{fmt(stats.meanDiff)} ·
            disagree on direction {(stats.disagreeShare * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {pairs.length < 2 ? (
        <p className="text-sm text-warn">
          These two instruments share fewer than two scored scenes, so there is nothing to compare. A scene with no
          dictionary matches gets no score, and coverage differs between dictionaries.
        </p>
      ) : (
        <div className="relative overflow-x-auto" onMouseLeave={tip.hide}>
          {tip.node}
          <svg viewBox={`0 0 ${S} ${S}`} className="h-auto w-full max-w-[420px]" role="img" aria-label="Instrument agreement">
            <rect x={P} y={10} width={S - P - 10} height={S - P - 10} fill="var(--surface-2)" opacity={0.5} />
            {/* y = x. Dots on it agree; a cloud parallel to it is constant bias. */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="var(--border-strong)" strokeDasharray="4 4" />
            {[0, 0.5, 1].map((t) => (
              <g key={t}>
                <text x={sx(t)} y={S - 12} textAnchor="middle" className="fill-[var(--muted)] text-[10px] tabular-nums">{t}</text>
                <text x={P - 6} y={sy(t) + 3} textAnchor="end" className="fill-[var(--muted)] text-[10px] tabular-nums">{t}</text>
              </g>
            ))}
            {/* Low opacity because pages pile up on identical values — the
                density of the cloud is the information. */}
            {pairs.map((p, i) => (
              <circle
                key={i}
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={4}
                fill={PALETTE[0]}
                opacity={0.28}
                onMouseMove={(e) =>
                  tip.show(
                    e,
                    [`${p.book} · scene ${p.page}`, `${xm}: ${fmt(p.x)}`, `${ym}: ${fmt(p.y)}`],
                    PALETTE[0],
                    e.currentTarget.closest('.relative'),
                  )
                }
                onMouseLeave={tip.hide}
              />
            ))}
            <text x={(S + P) / 2} y={S - 1} textAnchor="middle" className="fill-[var(--muted)] text-[10px]">{xm}</text>
          </svg>
        </div>
      )}

      <Note>
        Each dot is one page both instruments scored. On the dashed line they agree; a cloud parallel to it is a
        constant offset; a round blob is noise.
      </Note>
    </div>
  );
}

function Legend({ items }: { items: Array<{ key: string; color: string; dash?: string }> }) {
  if (items.length <= 1) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5 text-xs text-muted" title={it.key}>
          {/* Drawn as the line itself, dashes and all, so the swatch matches
              what is on the chart rather than only its colour. */}
          <svg width="20" height="8" className="shrink-0" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="20"
              y2="4"
              stroke={it.color}
              strokeWidth="2.5"
              strokeDasharray={it.dash}
              strokeLinecap="round"
            />
          </svg>
          <span className="max-w-[16rem] truncate">{it.key}</span>
        </span>
      ))}
    </div>
  );
}
