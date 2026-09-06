import { useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { DimensionRow, LexiconPreview, LexiconSummary } from '../types';
import { Button, ErrorBox, Label, Spinner } from './ui';
import { Upload, X } from './icons';

/**
 * Two-step dictionary import for bag-of-words analysis. Step one reads the file
 * locally and asks the server what's in it; step two maps what the server found
 * onto dimensions and declares the native scale, which is what lets *any*
 * lexicon — AFINN, SO-CAL, JAEN, Linguakit, SBU — be normalized to the same
 * 0–1 range as every other instrument.
 *
 * Two shapes arrive in practice, and the form follows whichever the file is:
 *   - a **table** with a term column and one or more numeric value columns;
 *   - a **word list**, one term per line with no values, which is how polarity
 *     lexicons like iSOL are published. Those come as a pair, so the same
 *     lexicon name can be loaded twice — positives at +1, negatives at −1.
 *
 * When the filename matches a catalogue entry, its known layout, scale and
 * licence are pre-filled and shown, so a recognised dictionary is mostly a
 * matter of confirming.
 *
 * Files are read in the browser and posted as text: they're word lists, small
 * enough that a JSON body is simpler than multipart, and it keeps the API
 * uniform with the rest of the app.
 */

// Lexicons are word lists; anything much larger is probably the wrong file.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Read a dictionary file as text, falling back to Latin-1 when it isn't valid
 * UTF-8. `File.text()` always assumes UTF-8, which turns every accented
 * character of an ISO-8859-1 dictionary (iSOL is one) into U+FFFD — silently
 * destroying a large slice of Spanish vocabulary before it ever reaches the
 * server. Mirrors decodeLexiconBytes() on the backend.
 */
async function readAsText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('latin1').decode(buffer);
  }
}

interface Mapping {
  column: string;
  dimension: string;
  include: boolean;
}

export function LexiconUpload({
  dimensions,
  onClose,
  onImported,
}: {
  dimensions: DimensionRow[];
  onClose: () => void;
  onImported: (lexicon: LexiconSummary) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<LexiconPreview | null>(null);
  const [name, setName] = useState('');
  const [termColumn, setTermColumn] = useState('');
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [scaleMin, setScaleMin] = useState('');
  const [scaleMax, setScaleMax] = useState('');
  // Word-list mode: one dimension, one fixed value for every term in the file.
  const [wordListDimension, setWordListDimension] = useState('polarity');
  const [fixedValue, setFixedValue] = useState('1');
  const [appendToExisting, setAppendToExisting] = useState(false);
  // Header detection is usually right, but SO-CAL and Linguakit ship headerless
  // files, so it has to be correctable by hand.
  const [hasHeader, setHasHeader] = useState(true);
  // Label -> number, for files whose value column holds POSITIVE / NEGATIVE.
  const [labelValues, setLabelValues] = useState<Record<string, string>>({});
  const [negation, setNegation] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — larger than the 20 MB limit.`);
      return;
    }
    setBusy(true);
    try {
      const text = await readAsText(file);
      const p = await api.previewLexicon({ content: text, fileName: file.name });
      setContent(text);
      setFileName(file.name);
      setPreview(p);
      // Sensible defaults from what the file actually contains — the user only
      // has to correct them, not derive them.
      // Prefer the catalogue's known name over the raw filename, so both halves
      // of a polarity pair land under one lexicon without the user thinking about it.
      setName((prev) => prev || p.preset?.id || file.name.replace(/\.[^.]+$/, ''));
      setTermColumn(p.columns.find((c) => !p.numericColumns.includes(c)) ?? p.columns[0] ?? '');
      setMappings(
        (p.numericColumns.length ? p.numericColumns : p.columns).map((column, i) => ({
          column,
          dimension: i === 0 ? 'polarity' : '',
          include: i === 0,
        })),
      );

      setHasHeader(!p.headerless);
      // Pre-fill from the preset when it knows, else guess by the label's own
      // wording, which is POSITIVE/NEGATIVE often enough to be worth offering.
      const presetLabels = p.preset?.format?.labelValues;
      const found = p.labelColumns[0]?.labels ?? [];
      setLabelValues(
        Object.fromEntries(
          found.map((label) => {
            const fromPreset = presetLabels?.[label] ?? presetLabels?.[label.toUpperCase()];
            if (fromPreset !== undefined) return [label, String(fromPreset)];
            const l = label.toUpperCase();
            if (l.startsWith('POS')) return [label, '1'];
            if (l.startsWith('NEG')) return [label, '-1'];
            if (l.startsWith('NEU') || l.startsWith('NON')) return [label, '0'];
            return [label, ''];
          }),
        ),
      );

      const presetScale = p.preset?.format?.scale;
      if (p.isWordList) {
        // Polarity is carried by the filename in every published pair I've seen.
        const lower = file.name.toLowerCase();
        const rule = (p.preset?.format?.polarityFiles ?? [
          { match: 'positiv', value: 1 },
          { match: 'negativ', value: -1 },
        ]).find((r) => lower.includes(r.match));
        setFixedValue(String(rule?.value ?? 1));
        setAppendToExisting(false);
        const [lo, hi] = presetScale ?? [-1, 1];
        setScaleMin(String(lo));
        setScaleMax(String(hi));
      } else if (presetScale) {
        setScaleMin(String(presetScale[0]));
        setScaleMax(String(presetScale[1]));
      } else if (p.observedRange) {
        setScaleMin(String(p.observedRange.min));
        setScaleMax(String(p.observedRange.max));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function setMapping(column: string, patch: Partial<Mapping>) {
    setMappings((prev) => prev.map((m) => (m.column === column ? { ...m, ...patch } : m)));
  }

  /** Re-read the file under an explicit header decision; columns change with it. */
  async function reparse(nextHasHeader: boolean) {
    setHasHeader(nextHasHeader);
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewLexicon({ content, fileName, hasHeader: nextHasHeader });
      setPreview(p);
      setTermColumn(p.columns.find((c) => !p.numericColumns.includes(c)) ?? p.columns[0] ?? '');
      setMappings(
        (p.numericColumns.length ? p.numericColumns : p.columns).map((column, i) => ({
          column,
          dimension: i === 0 ? 'polarity' : '',
          include: i === 0,
        })),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isWordList = !!preview?.isWordList;
  const chosen = mappings.filter((m) => m.include && m.dimension.trim());
  // A value column of words imports as nothing unless the words have numbers.
  const needsLabels = (preview?.labelColumns ?? []).filter((l) =>
    chosen.some((m) => m.column === l.column),
  );
  const labelsIncomplete = needsLabels.some((l) =>
    l.labels.some((lab) => labelValues[lab] === undefined || labelValues[lab] === '' || Number.isNaN(Number(labelValues[lab]))),
  );
  const canSubmit =
    !!preview &&
    !!name.trim() &&
    scaleMin !== '' &&
    scaleMax !== '' &&
    (isWordList
      ? !!wordListDimension.trim() && fixedValue !== '' && !Number.isNaN(Number(fixedValue))
      : !!termColumn && chosen.length > 0 && !labelsIncomplete);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      const { lexicon } = await api.uploadLexicon({
        name: name.trim(),
        fileName,
        content,
        termColumn: isWordList ? 'term' : termColumn,
        valueColumns: isWordList ? {} : Object.fromEntries(chosen.map((m) => [m.column, m.dimension.trim()])),
        fixedValue: isWordList ? Number(fixedValue) : undefined,
        dimension: isWordList ? wordListDimension.trim() : undefined,
        appendToExisting: isWordList ? appendToExisting : undefined,
        scaleMin: Number(scaleMin),
        scaleMax: Number(scaleMax),
        delimiter: preview?.delimiter,
        hasHeader: isWordList ? undefined : hasHeader,
        labelValues: needsLabels.length
          ? Object.fromEntries(
              Object.entries(labelValues)
                .filter(([, v]) => v !== '' && !Number.isNaN(Number(v)))
                .map(([k, v]) => [k, Number(v)]),
            )
          : undefined,
        note: note.trim() || undefined,
        negation,
      });
      onImported(lexicon);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-border bg-surface p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-xl font-semibold text-ink">Upload a dictionary</h2>
            <p className="mt-1 text-sm text-muted">
              Any word→value lexicon: CSV or TSV with a header row, a JSON array of rows, or a JSON{' '}
              <code className="rounded bg-surface-2 px-1 text-xs">{'{ term: value }'}</code> map. Values are
              normalized to 0–1 from the native scale you declare.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}

        <div className="mt-5">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted hover:text-ink">
            <Upload className="h-4 w-4" />
            {fileName ? `${fileName} — choose a different file` : 'Choose a lexicon file (.csv, .tsv, .json)'}
            <input type="file" accept=".csv,.tsv,.txt,.json" className="hidden" onChange={onFile} />
          </label>
        </div>

        {busy && !preview && (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> Reading the file…
          </div>
        )}

        {preview?.preset && (
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 p-3.5 text-sm">
            <p className="font-medium text-ink">Recognised as {preview.preset.id.toUpperCase()}</p>
            <p className="mt-1 text-xs text-muted">{preview.preset.note}</p>
            {preview.preset.sourceUrl && (
              <p className="mt-1.5 text-xs text-muted">
                Source:{' '}
                <a
                  href={preview.preset.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent underline"
                >
                  {preview.preset.sourceUrl}
                </a>
                {preview.preset.licence && ` · ${preview.preset.licence}`}
              </p>
            )}
          </div>
        )}

        {preview && (
          <>
            <p className="mt-4 text-sm text-muted">
              {preview.isWordList
                ? `A word list: ${preview.rowCount.toLocaleString()} term${preview.rowCount === 1 ? '' : 's'}, one per line, no values.`
                : `${preview.rowCount.toLocaleString()} row${preview.rowCount === 1 ? '' : 's'}, ${preview.columns.length} column${preview.columns.length === 1 ? '' : 's'} — first few rows:`}
            </p>
            <div className="mt-2 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-2 text-muted">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-2.5 py-1.5 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((row, i) => (
                    <tr key={i} className="border-t border-border text-ink">
                      {preview.columns.map((c) => (
                        <td key={c} className="whitespace-nowrap px-2.5 py-1.5">
                          {row[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Lexicon name">
                <TextInput value={name} onChange={setName} placeholder="e.g. afinn" />
              </Field>
              {!isWordList && (
                <Field label="Term column">
                  <Select value={termColumn} onChange={setTermColumn} options={preview.columns} />
                </Field>
              )}
            </div>

            {isWordList && (
              <div className="mt-5 space-y-4 rounded-xl border border-border bg-surface-2 p-4">
                <p className="text-sm text-muted">
                  Word lists carry no values of their own, so every term in this file takes the same score. A
                  polarity lexicon is two files: load the positive list at the scale maximum and the negative list
                  at the minimum, both under the same lexicon name.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Dimension">
                    <input
                      list="lexicon-dimension-names"
                      value={wordListDimension}
                      onChange={(e) => setWordListDimension(e.target.value)}
                      placeholder="polarity"
                      className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                  </Field>
                  <Field label="Value for every term in this file">
                    <TextInput value={fixedValue} onChange={setFixedValue} placeholder="1 or -1" />
                  </Field>
                </div>
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={appendToExisting}
                    onChange={(e) => setAppendToExisting(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span>
                    Add to the existing lexicon of this name
                    <span className="block text-xs text-muted">
                      Tick this for the second half of a pair, so both lists become one instrument.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {!isWordList && (
              <label className="mt-4 flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => void reparse(e.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  The first row names the columns
                  <span className="block text-xs text-muted">
                    {preview.headerless
                      ? 'Detected as headerless — the first row looks like data, so columns are named term / value.'
                      : 'Detected a header row. Untick if the first line is actually a term.'}
                  </span>
                </span>
              </label>
            )}

            {!isWordList && needsLabels.length > 0 && (
              <div className="mt-4 rounded-xl border border-warn/40 bg-warn-soft/40 p-4">
                <Label>What are these labels worth?</Label>
                <p className="mt-1 text-xs text-muted">
                  This column holds words rather than numbers. Give each one a value on the native scale below —
                  without it, nothing imports.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {needsLabels.flatMap((l) => l.labels).map((label) => (
                    <span key={label} className="flex items-center gap-1.5">
                      <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink">{label}</code>
                      <span className="text-muted">→</span>
                      <input
                        value={labelValues[label] ?? ''}
                        onChange={(e) => setLabelValues((prev) => ({ ...prev, [label]: e.target.value }))}
                        placeholder="0"
                        className="h-8 w-16 rounded-lg border border-border bg-surface px-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                      />
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className={`mt-5 ${isWordList ? 'hidden' : ''}`}>
              <Label>Value columns → dimensions</Label>
              <p className="mt-1 text-xs text-muted">
                Each value column measures one construct. Name an existing dimension to add to it, or a new one to
                create it.
              </p>
              <div className="mt-2 space-y-2">
                {mappings.map((m) => (
                  <div key={m.column} className="flex flex-wrap items-center gap-2">
                    <label className="flex min-w-40 items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={m.include}
                        onChange={(e) => setMapping(m.column, { include: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="font-mono text-xs">{m.column}</span>
                    </label>
                    <span className="text-muted">→</span>
                    <input
                      list="lexicon-dimension-names"
                      value={m.dimension}
                      disabled={!m.include}
                      onChange={(e) => setMapping(m.column, { dimension: e.target.value })}
                      placeholder="dimension name"
                      className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-40"
                    />
                  </div>
                ))}
              </div>
              <datalist id="lexicon-dimension-names">
                {dimensions.map((d) => (
                  <option key={d.id} value={d.name} />
                ))}
              </datalist>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Native scale minimum">
                <TextInput value={scaleMin} onChange={setScaleMin} placeholder="e.g. -5" />
              </Field>
              <Field label="Native scale maximum">
                <TextInput value={scaleMax} onChange={setScaleMax} placeholder="e.g. 5" />
              </Field>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              The full range the dictionary uses, not the range in the sample above — the minimum maps to 0 and the
              maximum to 1.
            </p>

            <div className="mt-5 space-y-3">
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={negation}
                  onChange={(e) => setNegation(e.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  Handle negation
                  <span className="block text-xs text-muted">
                    Flip a term's value when a Spanish negator (<em>no</em>, <em>nunca</em>, <em>sin</em>…) appears
                    within three words before it.
                  </span>
                </span>
              </label>
              <Field label="Note (optional)">
                <TextInput value={note} onChange={setNote} placeholder="Source, version, licence…" />
              </Field>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={onSubmit} disabled={!canSubmit || busy}>
                {busy ? 'Importing…' : 'Import dictionary'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---- Local form primitives ----------------------------------------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
