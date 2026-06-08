import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Button, ErrorBox, Label } from './ui';

/** Pre-fill the two sides by splitting on the first blank line, if any. */
function splitOnBlankLine(text: string): { left: string; right: string } {
  const m = text.match(/\n\s*\n/);
  if (!m || m.index === undefined) return { left: text.trim(), right: '' };
  return { left: text.slice(0, m.index).trim(), right: text.slice(m.index + m[0].length).trim() };
}

export function SplitDialog({
  bookName,
  pageNumber,
  imageSrc,
  initialText,
  onClose,
  onDone,
}: {
  bookName: string;
  pageNumber: number;
  imageSrc: string;
  initialText: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const initial = splitOnBlankLine(initialText);
  const [ratio, setRatio] = useState(0.5);
  const [leftText, setLeftText] = useState(initial.left);
  const [rightText, setRightText] = useState(initial.right);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSplit() {
    setBusy(true);
    setError(null);
    try {
      await api.splitPage(bookName, pageNumber, { leftText, rightText, ratio });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-border bg-surface p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-xl font-semibold text-ink">Split page across the gutter</h2>
        <p className="mt-1 text-sm text-muted">
          Page {pageNumber} becomes two pages — everything left of the line, then everything right of it. Drag the split
          to the gutter, then edit each side's text.
        </p>

        <div className="relative mt-4 overflow-hidden rounded-lg border border-border bg-surface-2">
          <img src={imageSrc} alt="" className="block w-full" />
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
            style={{ left: `${ratio * 100}%` }}
          />
        </div>

        <div className="mt-3">
          <Label>Split position</Label>
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.01}
            value={ratio}
            onChange={(e) => setRatio(Number(e.target.value))}
            className="mt-1.5 w-full accent-[var(--accent)]"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Left page</Label>
            <textarea
              value={leftText}
              onChange={(e) => setLeftText(e.target.value)}
              spellCheck={false}
              className="mt-1.5 h-40 w-full resize-y rounded-lg border border-border bg-surface p-3 font-mono text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <Label>Right page</Label>
            <textarea
              value={rightText}
              onChange={(e) => setRightText(e.target.value)}
              spellCheck={false}
              className="mt-1.5 h-40 w-full resize-y rounded-lg border border-border bg-surface p-3 font-mono text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorBox message={error} />
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSplit} disabled={busy}>
            {busy ? 'Splitting…' : 'Split into two pages'}
          </Button>
        </div>
      </div>
    </div>
  );
}
