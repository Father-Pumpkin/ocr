/**
 * Generic, mapping-driven lexicon import — runs *any* lexicon. The caller points
 * at a file and declares which column is the term, which value column(s) map to
 * which dimension(s), and the native scale; we normalize every value to 0–1 and
 * store it. Supports delimited (CSV/TSV) with a header row, a JSON array of
 * row-objects, or a JSON `{ term: value }` map (single dimension).
 *
 * v1 limitations: simple delimiter split (no quoted-field handling — use clean
 * TSV/JSON for messy data); unigram terms (multi-word entries won't match).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLexicon, getLexiconByName, getAllDimensions, createDimension, insertLexiconTerms, } from './database.js';
import { normalizeToken } from './scoring.js';
function splitLine(line, delimiter) {
    return line.split(delimiter).map((c) => c.trim());
}
async function resolveOrCreateDimensions(names) {
    const all = await getAllDimensions();
    const byName = new Map(all.map((d) => [d.name, d.id]));
    const out = new Map();
    for (const name of names) {
        let id = byName.get(name);
        if (id === undefined) {
            const created = await createDimension(name, `Lexicon-defined construct "${name}" (scored by dictionary lookup, not an LLM prompt).`, 'Low', 'High');
            id = created.id;
        }
        out.set(name, id);
    }
    return out;
}
export async function importLexicon(input) {
    const { name, filePath, termColumn, valueColumns, scaleMin, scaleMax } = input;
    if (Object.keys(valueColumns).length === 0) {
        throw new Error('valueColumns is required: map at least one column → dimension.');
    }
    if (scaleMin === scaleMax) {
        throw new Error('scaleMin and scaleMax must differ.');
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`Lexicon file not found: ${filePath}`);
    }
    if (await getLexiconByName(name)) {
        throw new Error(`A lexicon named "${name}" already exists. Choose another name or delete it first.`);
    }
    const dimByName = await resolveOrCreateDimensions(new Set(Object.values(valueColumns)));
    const lex = await createLexicon(name, scaleMin, scaleMax, input.note ?? null);
    const normalize = (v) => Math.min(1, Math.max(0, (v - scaleMin) / (scaleMax - scaleMin)));
    const terms = [];
    const perDimension = {};
    let totalRows = 0;
    const add = (term, dim, rawValue) => {
        if (rawValue === undefined || rawValue === null || rawValue === '')
            return;
        const num = Number(rawValue);
        if (Number.isNaN(num))
            return;
        terms.push({ lexiconId: lex.id, dimensionId: dimByName.get(dim), term, value: normalize(num) });
        perDimension[dim] = (perDimension[dim] ?? 0) + 1;
    };
    const raw = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            for (const rec of parsed) {
                totalRows++;
                const term = normalizeToken(String(rec[termColumn] ?? ''));
                if (!term)
                    continue;
                for (const [col, dim] of Object.entries(valueColumns))
                    add(term, dim, rec[col]);
            }
        }
        else if (parsed && typeof parsed === 'object') {
            const dims = Object.values(valueColumns);
            if (dims.length !== 1) {
                throw new Error('A JSON { term: value } map must map to exactly one dimension.');
            }
            const dim = dims[0];
            for (const [k, v] of Object.entries(parsed)) {
                totalRows++;
                const term = normalizeToken(k);
                if (term)
                    add(term, dim, v);
            }
        }
        else {
            throw new Error('Unsupported JSON lexicon shape (expected an array of rows or a {term:value} map).');
        }
    }
    else {
        const delimiter = input.delimiter ?? (ext === '.tsv' ? '\t' : ',');
        const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length < 2) {
            throw new Error('Delimited lexicon needs a header row plus at least one data row.');
        }
        const header = splitLine(lines[0], delimiter);
        const termIdx = header.indexOf(termColumn);
        if (termIdx < 0) {
            throw new Error(`Term column "${termColumn}" not found in header: ${header.join(', ')}`);
        }
        const valueCols = Object.entries(valueColumns).map(([col, dim]) => {
            const idx = header.indexOf(col);
            if (idx < 0)
                throw new Error(`Value column "${col}" not found in header: ${header.join(', ')}`);
            return { idx, dim };
        });
        for (let i = 1; i < lines.length; i++) {
            totalRows++;
            const cells = splitLine(lines[i], delimiter);
            const term = normalizeToken(cells[termIdx] ?? '');
            if (!term)
                continue;
            for (const { idx, dim } of valueCols)
                add(term, dim, cells[idx]);
        }
    }
    const inserted = await insertLexiconTerms(terms);
    return { lexiconId: lex.id, name, totalRows, inserted, perDimension, scale: [scaleMin, scaleMax] };
}
