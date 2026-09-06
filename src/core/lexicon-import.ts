/**
 * Generic, mapping-driven lexicon import — runs *any* lexicon. The caller points
 * at a file and declares which column is the term, which value column(s) map to
 * which dimension(s), and the native scale; we normalize every value to 0–1 and
 * store it. Four shapes, all seen in the wild among the dictionaries this
 * project targets:
 *   - **delimited** (CSV/TSV), with or without a header row. SO-CAL's Spanish
 *     files are bare `word<TAB>score` with no header, so a header cannot be
 *     assumed — guessing wrong silently eats a term and names the columns after
 *     it. `hasHeader` forces the call; otherwise it is detected.
 *   - **labelled** values rather than numeric ones: Linguakit's `lex_es` is
 *     `word<TAB>POSITIVE|NEGATIVE`. `labelValues` maps those strings to numbers
 *     before normalization; without it every row parses as NaN and the import
 *     silently yields nothing.
 *   - **JSON**, an array of row-objects or a `{ term: value }` map.
 *   - **word lists** — one term per line, no values — which is how iSOL is
 *     published: a positive file and a negative file, imported at a fixed value
 *     each under one lexicon name.
 *
 * The source can be a path on disk (the MCP tool) or raw text uploaded through
 * the web app; `previewLexicon` parses just the header plus a few rows so the
 * upload UI can offer real column names to map before committing an import.
 *
 * v1 limitations: simple delimiter split (no quoted-field handling — use clean
 * TSV/JSON for messy data); unigram terms (multi-word entries won't match).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createLexicon,
  getLexiconByName,
  getAllDimensions,
  createDimension,
  insertLexiconTerms,
} from './database.js';
import { normalizeToken } from './scoring.js';

export interface LexiconImportInput {
  name: string;
  /** Read the lexicon from disk. Provide this or `content`. */
  filePath?: string;
  /** Raw lexicon text (an uploaded file). Provide this or `filePath`. */
  content?: string;
  /** Original filename — only used to infer the format when `content` is given. */
  fileName?: string;
  /** Column holding the word/term (delimited + JSON-array forms). */
  termColumn: string;
  /**
   * Map each value column → the dimension (construct) it measures. Leave empty
   * for a word list and supply `fixedValue` + `dimension` instead.
   */
  valueColumns: Record<string, string>;
  /**
   * Word-list mode: every term in the file takes this value on `dimension`.
   * Import a positive list at the scale maximum and a negative list at the
   * minimum, under the same lexicon name, to reassemble a polarity lexicon.
   */
  fixedValue?: number;
  /** Word-list mode: the dimension the fixed value applies to. */
  dimension?: string;
  /** Append to an existing lexicon instead of refusing the name (second word list). */
  appendToExisting?: boolean;
  scaleMin: number;
  scaleMax: number;
  /** Override the delimiter; default inferred from extension (.tsv → tab, else comma). */
  delimiter?: string;
  /**
   * Whether the first row names the columns. Omit to detect: a first row whose
   * value cell is numeric, or repeats a label seen further down, is data.
   */
  hasHeader?: boolean;
  /**
   * Map non-numeric value cells to numbers, e.g. {"POSITIVE": 1, "NEGATIVE": -1}.
   * Matched case-insensitively after trimming. Cells that are already numeric
   * are used as-is, so a mixed file still works.
   */
  labelValues?: Record<string, number>;
  note?: string;
}

export interface LexiconImportResult {
  lexiconId: number;
  name: string;
  totalRows: number;
  inserted: number;
  perDimension: Record<string, number>;
  scale: [number, number];
}

/**
 * Split one row. A single-space delimiter is treated as "any run of whitespace",
 * because the space-separated dictionaries in the wild (SO-CAL's
 * google_translated build) also carry trailing spaces on most lines — splitting
 * literally would produce a phantom empty column and, worse, shift the value
 * cell whenever two spaces appeared.
 */
function splitLine(line: string, delimiter: string): string[] {
  const trimmed = line.trim();
  if (delimiter === ' ') return trimmed.split(/\s+/);
  return trimmed.split(delimiter).map((c) => c.trim());
}

/**
 * Strip a UTF-8 byte-order mark. Linguakit's lex_es carries one, and left in
 * place it would either become a phantom first row or fuse onto the first term.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode a lexicon file, falling back to Latin-1 when it isn't valid UTF-8.
 *
 * These dictionaries predate the assumption that everything is UTF-8 — iSOL is
 * ISO-8859-1 — and decoding Latin-1 bytes as UTF-8 replaces every accented
 * character with U+FFFD. In Spanish that silently destroys a large slice of the
 * vocabulary, which is exactly the damage already baked into most SO-CAL builds;
 * there is no reason to inflict it ourselves.
 */
export function decodeLexiconBytes(bytes: Buffer): string {
  const strict = new TextDecoder('utf-8', { fatal: true });
  try {
    return stripBom(strict.decode(bytes));
  } catch {
    return stripBom(new TextDecoder('latin1').decode(bytes));
  }
}

/** Format of a lexicon source, inferred from its extension. */
type LexiconFormat = 'json' | 'delimited';

function formatOf(fileName: string): LexiconFormat {
  return path.extname(fileName).toLowerCase() === '.json' ? 'json' : 'delimited';
}

function defaultDelimiter(fileName: string): string {
  return path.extname(fileName).toLowerCase() === '.tsv' ? '\t' : ',';
}

// Ordered by how strong a signal each is: a tab or a comma is almost certainly
// deliberate, a space could just be a multi-word term. `.txt` is used for
// tab-, comma- AND space-separated dictionaries, so the extension settles nothing.
const DELIMITER_CANDIDATES = ['\t', ',', ';', '|', ' '];

/**
 * Work out what separates the columns by trying each candidate and keeping the
 * one that yields a consistent two-or-more-column table. Returns null when
 * nothing does, which means the file is a bare word list.
 *
 * Needed because the dictionaries this project targets disagree: Linguakit is
 * tab-separated, AFINN-es comma, and SO-CAL's google_translated build
 * space-separated — all of them plausible `.txt`/`.tsv`/`.csv` names.
 */
function detectDelimiter(lines: string[]): string | null {
  const sample = lines.slice(0, 30);
  if (sample.length === 0) return null;
  let best: { delimiter: string; consistency: number; columns: number } | null = null;

  for (const candidate of DELIMITER_CANDIDATES) {
    const widths = sample.map((l) => splitLine(l, candidate).length);
    const modal = widths
      .slice()
      .sort((a, b) => widths.filter((w) => w === b).length - widths.filter((w) => w === a).length)[0];
    if (modal === undefined || modal < 2) continue;
    const consistency = widths.filter((w) => w === modal).length / widths.length;
    // Most rows must agree, or the "delimiter" is really punctuation inside terms.
    if (consistency < 0.9) continue;
    if (!best || consistency > best.consistency) {
      best = { delimiter: candidate, consistency, columns: modal };
    }
  }
  return best?.delimiter ?? null;
}

/** Resolve the raw text + filename for either source form, validating the input. */
function readSource(input: { filePath?: string; content?: string; fileName?: string }): {
  raw: string;
  fileName: string;
} {
  if (typeof input.content === 'string') {
    if (!input.content.trim()) throw new Error('The uploaded lexicon file is empty.');
    return { raw: stripBom(input.content), fileName: input.fileName ?? 'lexicon.csv' };
  }
  if (!input.filePath) {
    throw new Error('Provide either filePath or content for the lexicon.');
  }
  if (!fs.existsSync(input.filePath)) {
    throw new Error(`Lexicon file not found: ${input.filePath}`);
  }
  return { raw: decodeLexiconBytes(fs.readFileSync(input.filePath)), fileName: input.filePath };
}

export interface LexiconPreview {
  format: LexiconFormat;
  /** True when the file is a bare word list: one term per line, no value column. */
  isWordList: boolean;
  /** Column names available to map (['term','value'] for a JSON {term:value} map). */
  columns: string[];
  /** Up to 5 parsed rows keyed by column — shown so the user can eyeball the mapping. */
  sampleRows: Array<Record<string, string>>;
  /** Data-row count (excludes the header for delimited files). */
  rowCount: number;
  /** Columns that parse as numbers throughout the sample — the likely value columns. */
  numericColumns: string[];
  /** True when the first row was read as data rather than column names. */
  headerless: boolean;
  /**
   * Value columns holding a small set of repeated words rather than numbers,
   * with the distinct labels found. These need a label→number mapping to import.
   */
  labelColumns: Array<{ column: string; labels: string[] }>;
  /** Min/max across the sampled numeric cells, so the native scale can be pre-filled. */
  observedRange: { min: number; max: number } | null;
  delimiter?: string;
}

const PREVIEW_ROWS = 5;

/**
 * Parse a lexicon's structure without importing it: which columns exist, what a
 * few rows look like, and the numeric range — everything the upload UI needs to
 * let the user map columns to dimensions and confirm the native scale.
 */
export function previewLexicon(input: {
  filePath?: string;
  content?: string;
  fileName?: string;
  delimiter?: string;
  /** Force the header decision instead of letting it be detected. */
  hasHeader?: boolean;
}): LexiconPreview {
  const { raw, fileName } = readSource(input);
  const format = formatOf(fileName);
  const sampleRows: Array<Record<string, string>> = [];
  let columns: string[] = [];
  let rowCount = 0;
  let delimiter: string | undefined;
  let headerless = false;
  let labelColumns: Array<{ column: string; labels: string[] }> = [];
  // Every data row of a delimited file, for whole-file range detection.
  let allRows: string[][] = [];

  if (format === 'json') {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const rows = parsed as Array<Record<string, unknown>>;
      rowCount = rows.length;
      columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r ?? {})))];
      for (const r of rows.slice(0, PREVIEW_ROWS)) {
        sampleRows.push(Object.fromEntries(columns.map((c) => [c, String(r?.[c] ?? '')])));
      }
    } else if (parsed && typeof parsed === 'object') {
      // A { term: value } map has no headers of its own; name them for the UI.
      const entries = Object.entries(parsed as Record<string, unknown>);
      rowCount = entries.length;
      columns = ['term', 'value'];
      for (const [k, v] of entries.slice(0, PREVIEW_ROWS)) {
        sampleRows.push({ term: k, value: String(v) });
      }
    } else {
      throw new Error('Unsupported JSON lexicon shape (expected an array of rows or a {term:value} map).');
    }
  } else {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('The lexicon file has no content.');
    }
    // Bind a const: `delimiter` is a function-scope `let`, so TypeScript widens
    // it back to `string | undefined` inside the closures below.
    const detected = input.delimiter ?? detectDelimiter(lines);
    const delim = detected ?? defaultDelimiter(fileName);
    delimiter = delim;
    // Nothing splits the rows consistently → a bare word list, not a table.
    if (detected === null) {
      return {
        format,
        isWordList: true,
        columns: ['term'],
        sampleRows: lines.slice(0, PREVIEW_ROWS).map((l) => ({ term: l.trim() })),
        rowCount: lines.length,
        numericColumns: [],
        headerless: true,
        labelColumns: [],
        observedRange: null,
        delimiter,
      };
    }
    const fullParsed = lines.map((l) => splitLine(l, delim));
    const parsed = fullParsed.slice(0, 40);
    headerless = input.hasHeader === undefined ? !detectHasHeader(parsed) : !input.hasHeader;
    if (!headerless && lines.length < 2) {
      throw new Error('A delimited lexicon with a header row needs at least one data row below it.');
    }
    if (headerless) {
      const width = Math.max(...parsed.map((r) => r.length));
      columns = syntheticColumns(width);
      rowCount = lines.length;
      for (const cells of parsed.slice(0, PREVIEW_ROWS)) {
        sampleRows.push(Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])));
      }
    } else {
      columns = parsed[0] ?? [];
      rowCount = lines.length - 1;
      for (const cells of parsed.slice(1, 1 + PREVIEW_ROWS)) {
        sampleRows.push(Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])));
      }
    }
    allRows = headerless ? fullParsed : fullParsed.slice(1);
    // Labels are judged over a wider window than the preview rows: five rows of
    // POSITIVE tells you nothing, forty tells you it is a category.
    const body = headerless ? parsed : parsed.slice(1);
    labelColumns = columns
      .map((c, i) => {
        const values = body.map((r) => (r[i] ?? '').trim()).filter(Boolean);
        if (values.length === 0 || values.some(isNumeric)) return null;
        const distinct = [...new Set(values.map((v) => v.toUpperCase()))];
        // A category column repeats a handful of values; a term column doesn't.
        return distinct.length > 0 && distinct.length <= 8 && distinct.length < values.length / 2
          ? { column: c, labels: distinct.sort() }
          : null;
      })
      .filter(Boolean) as Array<{ column: string; labels: string[] }>;
  }

  const numericColumns = columns.filter(
    (c) => sampleRows.length > 0 && sampleRows.every((r) => r[c] !== '' && !Number.isNaN(Number(r[c]))),
  );

  // Scan the WHOLE file for the numeric range, not just the preview rows. This
  // becomes the default native scale, and everything is normalized against it —
  // inferring −2..1 from the first five rows of a −5..5 dictionary would skew
  // every score in the corpus, silently.
  const values = allRows.length
    ? allRows.flatMap((r) =>
        numericColumns
          .map((c) => Number(r[columns.indexOf(c)] ?? ''))
          .filter((n) => !Number.isNaN(n)),
      )
    : sampleRows.flatMap((r) => numericColumns.map((c) => Number(r[c])));
  const observedRange = values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;

  return {
    format,
    isWordList: false,
    columns,
    sampleRows,
    rowCount,
    numericColumns,
    headerless,
    labelColumns,
    observedRange,
    delimiter,
  };
}

/** A file whose lines carry no delimiter is a word list, not a table. */
function isWordListLines(lines: string[], delimiter: string): boolean {
  return lines.slice(0, 20).every((l) => !l.includes(delimiter));
}

const isNumeric = (v: string): boolean => v !== '' && !Number.isNaN(Number(v));

/**
 * Does the first row name the columns, or is it already data?
 *
 * Two tells, both taken from real dictionaries: a numeric value cell (SO-CAL's
 * `magnífico<TAB>5` — no header calls a column "5"), or a value cell that
 * recurs down the file, which means it is a category rather than a column name
 * (Linguakit's `POSITIVE`). Anything else is treated as a header, which is the
 * safer default: a mis-detected header costs one term, a mis-detected data row
 * corrupts every column name.
 */
function detectHasHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (!first || first.length < 2) return true;
  const firstValue = first[1] ?? '';
  if (isNumeric(firstValue)) return false;

  const rest = rows.slice(1);
  if (rest.length === 0) return true;
  const repeats = rest.filter((r) => (r[1] ?? '').toLowerCase() === firstValue.toLowerCase()).length;
  return repeats / rest.length < 0.2;
}

/** Names for the columns of a headerless table: term, value, then positional. */
function syntheticColumns(width: number): string[] {
  return Array.from({ length: width }, (_, i) => (i === 0 ? 'term' : i === 1 ? 'value' : `column${i + 1}`));
}

async function resolveOrCreateDimensions(names: Set<string>): Promise<Map<string, number>> {
  const all = await getAllDimensions();
  const byName = new Map(all.map((d) => [d.name, d.id]));
  const out = new Map<string, number>();
  for (const name of names) {
    let id = byName.get(name);
    if (id === undefined) {
      const created = await createDimension(
        name,
        `Lexicon-defined construct "${name}" (scored by dictionary lookup, not an LLM prompt).`,
        'Low',
        'High',
      );
      id = created.id;
    }
    out.set(name, id);
  }
  return out;
}

export async function importLexicon(input: LexiconImportInput): Promise<LexiconImportResult> {
  const { name, termColumn, valueColumns, scaleMin, scaleMax } = input;

  const wordListMode = input.fixedValue !== undefined;
  if (!wordListMode && Object.keys(valueColumns).length === 0) {
    throw new Error('valueColumns is required: map at least one column → dimension.');
  }
  if (wordListMode && !input.dimension) {
    throw new Error('A word list needs a dimension for its fixed value to apply to.');
  }
  if (scaleMin === scaleMax) {
    throw new Error('scaleMin and scaleMax must differ.');
  }
  const { raw, fileName } = readSource(input);

  // Polarity lexicons arrive as two files (positive, negative) that belong to
  // one instrument, so a second import may legitimately extend the first.
  const existing = await getLexiconByName(name);
  if (existing && !input.appendToExisting) {
    throw new Error(`A lexicon named "${name}" already exists. Choose another name or delete it first.`);
  }

  const dimensionNames = wordListMode ? new Set([input.dimension!]) : new Set(Object.values(valueColumns));
  const dimByName = await resolveOrCreateDimensions(dimensionNames);
  const lex = existing ?? (await createLexicon(name, scaleMin, scaleMax, input.note ?? null));
  const normalize = (v: number): number => Math.min(1, Math.max(0, (v - scaleMin) / (scaleMax - scaleMin)));

  const terms: Array<{ lexiconId: number; dimensionId: number; term: string; value: number }> = [];
  const perDimension: Record<string, number> = {};
  let totalRows = 0;

  // Case-insensitive lookup for labelled values (POSITIVE -> 1, and so on).
  const labelMap = new Map(
    Object.entries(input.labelValues ?? {}).map(([k, v]) => [k.trim().toUpperCase(), v]),
  );

  const add = (term: string, dim: string, rawValue: unknown): void => {
    if (rawValue === undefined || rawValue === null || rawValue === '') return;
    const raw = String(rawValue).trim();
    const mapped = labelMap.get(raw.toUpperCase());
    const num = mapped !== undefined ? mapped : Number(raw);
    if (Number.isNaN(num)) return;
    terms.push({ lexiconId: lex.id, dimensionId: dimByName.get(dim)!, term, value: normalize(num) });
    perDimension[dim] = (perDimension[dim] ?? 0) + 1;
  };

  if (wordListMode) {
    const dim = input.dimension!;
    for (const line of raw.split(/\r?\n/)) {
      const term = normalizeToken(line);
      if (!term || term.startsWith('#') || term.startsWith(';')) continue;
      totalRows++;
      add(term, dim, input.fixedValue);
    }
  } else if (formatOf(fileName) === 'json') {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const rec of parsed as Array<Record<string, unknown>>) {
        totalRows++;
        const term = normalizeToken(String(rec[termColumn] ?? ''));
        if (!term) continue;
        for (const [col, dim] of Object.entries(valueColumns)) add(term, dim, rec[col]);
      }
    } else if (parsed && typeof parsed === 'object') {
      const dims = Object.values(valueColumns);
      if (dims.length !== 1) {
        throw new Error('A JSON { term: value } map must map to exactly one dimension.');
      }
      const dim = dims[0];
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        totalRows++;
        const term = normalizeToken(k);
        if (term) add(term, dim, v);
      }
    } else {
      throw new Error('Unsupported JSON lexicon shape (expected an array of rows or a {term:value} map).');
    }
  } else {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('The lexicon file has no content.');
    }
    // Detect exactly as the preview did, so an import matches what was shown.
    const delimiter = input.delimiter ?? detectDelimiter(lines) ?? defaultDelimiter(fileName);
    const parsed = lines.map((l) => splitLine(l, delimiter));
    const headerless =
      input.hasHeader === undefined ? !detectHasHeader(parsed.slice(0, 40)) : !input.hasHeader;
    const header = headerless ? syntheticColumns(Math.max(...parsed.map((r) => r.length))) : parsed[0];
    const body = headerless ? parsed : parsed.slice(1);
    if (body.length === 0) {
      throw new Error('Delimited lexicon needs at least one data row.');
    }
    const where = headerless ? 'this headerless file' : `header: ${header.join(', ')}`;
    const termIdx = header.indexOf(termColumn);
    if (termIdx < 0) {
      throw new Error(`Term column "${termColumn}" not found in ${where}`);
    }
    const valueCols = Object.entries(valueColumns).map(([col, dim]) => {
      const idx = header.indexOf(col);
      if (idx < 0) throw new Error(`Value column "${col}" not found in ${where}`);
      return { idx, dim };
    });
    for (const cells of body) {
      totalRows++;
      const term = normalizeToken(cells[termIdx] ?? '');
      if (!term) continue;
      for (const { idx, dim } of valueCols) add(term, dim, cells[idx]);
    }
  }

  const inserted = await insertLexiconTerms(terms);
  return { lexiconId: lex.id, name, totalRows, inserted, perDimension, scale: [scaleMin, scaleMax] };
}
