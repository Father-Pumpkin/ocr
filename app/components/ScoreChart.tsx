import { useMemo, useState } from 'react';
import type { AnalyzeResult, AnalyzeGroup } from '../types';

/**
 * The results, drawn.
 *
 * Inline SVG rather than a charting library: the whole thing is a few hundred
 * lines, it inherits the theme's CSS variables so it follows light/dark for
 * free, and it keeps the app's only client dependency list at React + Router.
 *
 * Two shapes, matching the two shapes the analysis itself comes in:
 *
 *   - **series** (a score per page) → a line per group. This is the narrative
 *     arc: how a book's sentiment moves as it goes along.
 *   - **mean** (one number per group) → bars, ordered as the server returned
 *     them, which for sections is the order they were defined rather than
 *     alphabetical.
 *
 * The x-axis of a multi-book series is the thing most likely to mislead. Books
 * run from 10 to 51 pages, so plotting several against absolute page number
 * lines up page 12 of a 15-page book with page 12 of a 51-page one and invites a
 * comparison that isn't there. When more than one book is on screen the default
 * is therefore *position in book*, with absolute pages a click away.
 */

/** Distinguishable at a glance, and legible on both the light and dark grounds. */
const SERIES_COLORS = [
  '#bf5e38', // terracotta — the app's own accent
  '#3d7f8c', // teal
  '#9c6f2b', // gold
  '#6b5b95', // violet
  '#4f7942', // fern
  '#a8435f', // rose
  '#2f6690', // steel
  '#8a6d3b', // bronze
];

const PAD = { top: 16, right: 16, bottom: 40, left: 44 };
const VIEW_W = 900;
const VIEW_H = 380;

type XMode = 'page' | 'position';

interface Point {
  x: number;
  y: number;
  label: string;
}

interface Line {
  key: string;
  color: string;
  points: Point[];
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.round(v * 1000) / 1000);
  }
  return out;
}

/** Truncate a long book title so the legend doesn't eat the chart. */
function short(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What to call a line or bar.
 *
 * The group key alone is not enough. Grouping by page with several instruments
 * overlaid gives every group the same key — the book title — and a legend
 * reading "La boda" five times identifies nothing. Method and dimension are
 * appended only when they actually vary, so the common single-instrument case
 * stays uncluttered.
 */
function labelFor(
  g: AnalyzeGroup,
  opts: { manyMethods: boolean; manyDimensions: boolean },
): string {
  const parts = [g.key];
  if (opts.manyMethods) parts.push(g.method);
  if (opts.manyDimensions) parts.push(g.dimension);
  return parts.join(' · ');
}

/** Whether method / dimension vary across the groups being drawn. */
function varying(groups: AnalyzeGroup[]) {
  return {
    manyMethods: new Set(groups.map((g) => g.method)).size > 1,
    manyDimensions: new Set(groups.map((g) => g.dimension)).size > 1,
  };
}

export function ScoreChart({ result }: { result: AnalyzeResult }) {
  const isSeries = result.aggregate === 'series';
  const seriesGroups = result.groups.filter((g) => (g.points?.length ?? 0) > 0);
  const multiBook = new Set(
    seriesGroups.flatMap((g) => (g.points ?? []).map((p) => p.book_title)),
  ).size > 1;

  const [xMode, setXMode] = useState<XMode>(multiBook ? 'position' : 'page');

  if (isSeries && seriesGroups.length === 0) {
    return <p className="mt-4 text-sm text-muted">No per-page scores to plot in this selection.</p>;
  }
  if (!isSeries && result.groups.length === 0) {
    return <p className="mt-4 text-sm text-muted">Nothing to plot in this selection.</p>;
  }

  return isSeries ? (
    <LineChart groups={seriesGroups} xMode={xMode} onXMode={setXMode} multiBook={multiBook} />
  ) : (
    <BarChart groups={result.groups} />
  );
}

function LineChart({
  groups,
  xMode,
  onXMode,
  multiBook,
}: {
  groups: AnalyzeGroup[];
  xMode: XMode;
  onXMode: (m: XMode) => void;
  multiBook: boolean;
}) {
  const vary = useMemo(() => varying(groups), [groups]);
  const lines: Line[] = useMemo(
    () =>
      groups.map((g, i) => {
        const pts = [...(g.points ?? [])].sort((a, b) => a.page_number - b.page_number);
        // Position is measured within each line's own page span, so two books of
        // different lengths both run 0–100% and their arcs can be laid over
        // each other honestly.
        const first = pts[0]?.page_number ?? 0;
        const last = pts[pts.length - 1]?.page_number ?? 0;
        const span = last - first;
        return {
          key: labelFor(g, vary),
          color: SERIES_COLORS[i % SERIES_COLORS.length],
          points: pts.map((p) => ({
            x:
              xMode === 'page'
                ? p.page_number
                : span === 0
                  ? 0
                  : ((p.page_number - first) / span) * 100,
            y: p.score,
            label: `${p.book_title} · p${p.page_number} · ${g.method} · ${p.score.toFixed(3)}`,
          })),
        };
      }),
    [groups, xMode, vary],
  );

  const xs = lines.flatMap((l) => l.points.map((p) => p.x));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  // Scores are a fixed 0–1 scale, so the y-axis is pinned rather than fitted —
  // an auto-fitted axis would make a flat series look dramatic.
  const sx = (x: number) => PAD.left + ((x - xMin) / xSpan) * plotW;
  const sy = (y: number) => PAD.top + (1 - y) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = niceTicks(xMin, xMax, 6);

  return (
    <div className="mt-4">
      {multiBook && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          <span>x-axis</span>
          {(['position', 'page'] as XMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onXMode(m)}
              className={
                'rounded-full border px-2 py-0.5 ' +
                (xMode === m
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-muted hover:text-ink')
              }
            >
              {m === 'position' ? 'Position in book (%)' : 'Page number'}
            </button>
          ))}
          {xMode === 'page' && (
            <span className="text-warn">
              Books differ in length — page numbers don’t line up between them.
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full min-w-[520px]"
          role="img"
          aria-label="Sentiment score by page"
        >
          <Grid xTicks={xTicks} yTicks={yTicks} sx={sx} sy={sy} plotW={plotW} plotH={plotH} />
          <text
            x={PAD.left + plotW / 2}
            y={VIEW_H - 6}
            textAnchor="middle"
            className="fill-[var(--muted)] text-[11px]"
          >
            {xMode === 'position' ? 'Position in book (%)' : 'Page'}
          </text>

          {lines.map((line) => (
            <g key={line.key}>
              {line.points.length > 1 && (
                <path
                  d={line.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x)},${sy(p.y)}`).join(' ')}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
              )}
              {line.points.map((p, i) => (
                <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2.5} fill={line.color}>
                  <title>{p.label}</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      </div>

      <Legend items={lines.map((l) => ({ key: l.key, color: l.color }))} />
    </div>
  );
}

function BarChart({ groups }: { groups: AnalyzeGroup[] }) {
  const vary = varying(groups);
  const bars = groups
    .map((g, i) => ({
      key: labelFor(g, vary),
      // A 'series' analysis carries no stored mean; derive one so switching to
      // the chart never blanks out just because of how the data was requested.
      value:
        g.mean ??
        (g.points && g.points.length
          ? g.points.reduce((s, p) => s + p.score, 0) / g.points.length
          : null),
      count: g.count,
      method: g.method,
      dimension: g.dimension,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }))
    .filter((b): b is typeof b & { value: number } => b.value !== null);

  if (bars.length === 0) {
    return <p className="mt-4 text-sm text-muted">Nothing to plot in this selection.</p>;
  }

  return (
    <div className="mt-4 space-y-2">
      {bars.map((b) => (
        <div key={`${b.dimension}:${b.method}:${b.key}`} className="flex items-center gap-3">
          <div className="w-64 shrink-0 truncate text-sm text-ink" title={b.key}>
            {b.key}
          </div>
          <div className="relative h-6 flex-1 overflow-hidden rounded bg-surface-2">
            {/* Midpoint marker: 0.5 is neutral on a normalized scale, so where a
                bar sits relative to it is the thing worth seeing. */}
            <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border-strong)]" />
            <div
              className="h-full rounded-r"
              style={{ width: `${b.value * 100}%`, backgroundColor: b.color, opacity: 0.85 }}
              title={`${b.key} — ${b.value.toFixed(3)} over ${b.count} page(s)`}
            />
          </div>
          <div className="w-28 shrink-0 text-right text-sm tabular-nums text-ink">
            {b.value.toFixed(3)}
            <span className="ml-1 text-xs text-muted">n={b.count}</span>
          </div>
        </div>
      ))}
      <p className="pt-1 text-xs text-muted">
        Scores are normalized 0–1; the hairline marks the 0.5 midpoint.
      </p>
    </div>
  );
}

function Grid({
  xTicks,
  yTicks,
  sx,
  sy,
  plotW,
  plotH,
}: {
  xTicks: number[];
  yTicks: number[];
  sx: (x: number) => number;
  sy: (y: number) => number;
  plotW: number;
  plotH: number;
}) {
  return (
    <g>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={sy(t)}
            y2={sy(t)}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={sy(t) + 4}
            textAnchor="end"
            className="fill-[var(--muted)] text-[11px] tabular-nums"
          >
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text
          key={`x${t}`}
          x={sx(t)}
          y={PAD.top + plotH + 16}
          textAnchor="middle"
          className="fill-[var(--muted)] text-[11px] tabular-nums"
        >
          {t}
        </text>
      ))}
      <line
        x1={PAD.left}
        x2={PAD.left + plotW}
        y1={sy(0.5)}
        y2={sy(0.5)}
        stroke="var(--border-strong)"
        strokeDasharray="4 4"
        strokeWidth={1}
      />
    </g>
  );
}

function Legend({ items }: { items: Array<{ key: string; color: string }> }) {
  if (items.length <= 1) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5 text-xs text-muted" title={it.key}>
          <span className="h-2 w-4 rounded-sm" style={{ backgroundColor: it.color }} />
          {short(it.key)}
        </span>
      ))}
    </div>
  );
}
