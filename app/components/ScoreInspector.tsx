import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { AnalyzeGroup, ScoreRow, ScoreExplanation } from '../types';
import { Spinner } from './ui';

/**
 * The drill-down: from a number on a chart to the words behind it.
 *
 * A bag-of-words score is the mean of whatever dictionary terms happen to appear
 * on a page, and the median page here matches a handful. Without a way to see
 * which terms those were, every number is unfalsifiable — a solid reading and an
 * accident of one word look identical. This makes the chain visible in two
 * clicks: a group's pages, then one page's matched terms and its text.
 *
 * The matched terms are recomputed server-side from the stored transcription and
 * the lexicon tables (see core/explain), not read from a cached explanation, so
 * they work for scores written before any of this existed.
 */
export function ScoreInspector({
  group,
  rows,
  onClose,
}: {
  group: AnalyzeGroup;
  rows: ScoreRow[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<ScoreRow | null>(null);

  // pageIds comes from the server because group membership follows the grouping
  // rule; falling back to method/dimension keeps series groups usable too.
  const pages = useMemo(() => {
    const ids = new Set(group.pageIds ?? []);
    const inGroup = rows.filter(
      (r) =>
        r.method_name === group.method &&
        r.dimension_name === group.dimension &&
        (ids.size === 0 || ids.has(r.page_id)),
    );
    return [...inGroup].sort((a, b) => a.score - b.score);
  }, [group, rows]);

  const lo = pages[0];
  const hi = pages[pages.length - 1];

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-2/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">{group.key}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {group.method} · {group.dimension} · {pages.length} scene(s)
            {group.stats && (
              <>
                {' '}· median {group.stats.median.toFixed(3)} · sd {group.stats.sd.toFixed(3)} ·{' '}
                {group.stats.nBooks} book(s)
              </>
            )}
          </p>
          {lo && hi && lo !== hi && (
            <p className="mt-0.5 text-xs text-muted">
              Range {lo.score.toFixed(3)} ({lo.book_title} p{lo.page_number}) → {hi.score.toFixed(3)} (
              {hi.book_title} p{hi.page_number})
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-xs text-muted hover:text-ink">
          Close
        </button>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="max-h-72 overflow-y-auto rounded border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Book</th>
                <th className="px-2 py-1.5 font-medium">Page</th>
                <th className="px-2 py-1.5 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((r) => (
                <tr
                  key={`${r.page_id}:${r.method_id}`}
                  onClick={() => setSelected(r)}
                  className={
                    'cursor-pointer border-t border-border hover:bg-surface-2 ' +
                    (selected?.page_id === r.page_id ? 'bg-surface-2' : '')
                  }
                >
                  <td className="max-w-[12rem] truncate px-2 py-1 text-ink" title={r.book_title}>
                    {r.book_title}
                  </td>
                  <td className="px-2 py-1 tabular-nums text-muted">{r.page_number}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-ink">{r.score.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          {selected ? (
            <Explanation row={selected} />
          ) : (
            <p className="text-xs text-muted">
              Pick a scene to see the words the dictionary matched on it, and the page’s text.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Explanation({ row }: { row: ScoreRow }) {
  const [data, setData] = useState<ScoreExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setData(null);
    setError(null);
    api
      .explainScore({
        book: row.book_title,
        page: row.page_number,
        method: row.method_name,
        dimension: row.dimension_name,
      })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [row.page_id, row.method_name, row.dimension_name, row.book_title, row.page_number]);

  if (busy) return <Spinner className="h-4 w-4 text-muted" />;
  if (error) return <p className="text-xs text-warn">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <Link
          to={`/book/${encodeURIComponent(data.book)}/page/${data.pageNumber}`}
          className="text-accent hover:underline"
        >
          {data.book} · scene {data.pageNumber} →
        </Link>
        <span className="tabular-nums text-ink">
          {data.storedScore !== null ? data.storedScore.toFixed(3) : '—'}
        </span>
        <span className="text-muted">
          {data.matchCount}/{data.tokenCount} word(s) matched
        </span>
      </div>

      {data.note && <p className="text-xs text-warn">{data.note}</p>}

      {data.matched.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.matched.map((m) => (
            <span
              key={m.term}
              className="rounded border border-border px-1.5 py-0.5 text-xs tabular-nums"
              title={
                m.negated
                  ? `${m.term}: ${m.value.toFixed(2)} in the dictionary, flipped to ${m.effective.toFixed(2)} by a negator`
                  : `${m.term}: ${m.value.toFixed(2)} in the dictionary`
              }
              style={{
                // Terracotta above neutral, steel below — the reader should see
                // which way each word pulled without reading the number.
                color: m.effective >= 0.5 ? 'var(--accent)' : '#3d7f8c',
              }}
            >
              {m.term} {m.effective.toFixed(2)}
              {m.positions.length > 1 && ` ×${m.positions.length}`}
              {m.negated && ' ¬'}
            </span>
          ))}
        </div>
      )}

      {/* The score is a mean of the chips above; showing the arithmetic is the
          point of the panel. */}
      {data.recomputedScore !== null && data.matchCount > 0 && (
        <p className="text-[11px] text-muted">
          Mean of {data.matchCount} matched value(s) = {data.recomputedScore.toFixed(3)}
          {data.storedScore !== null && Math.abs(data.recomputedScore - data.storedScore) > 0.005 && (
            <span className="text-warn">
              {' '}— differs from the stored {data.storedScore.toFixed(3)}, so the text has changed since it was
              scored.
            </span>
          )}
        </p>
      )}

      {data.rationale && data.methodKind !== 'lexicon' && (
        <p className="text-xs text-ink">{data.rationale}</p>
      )}

      {data.text && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 text-[11px] leading-relaxed text-ink">
          {data.text}
        </pre>
      )}
    </div>
  );
}
