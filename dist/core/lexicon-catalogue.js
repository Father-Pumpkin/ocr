/**
 * The bag-of-words dictionaries this project expects to run, and the machinery
 * for loading them without going through the upload dialog every time.
 *
 * None are bundled — they carry their own licences and are not ours to
 * redistribute. What is bundled is knowledge *about* them: where each comes
 * from, how its published files are shaped, and what scale its values use. That
 * turns loading one into "drop the file in `lexicons/` and restart" (or one
 * click in the UI with the mapping pre-filled) instead of a manual column
 * mapping every time.
 *
 * Every preset imports into the same `polarity` dimension by default. That is
 * deliberate: scores are keyed by (page, dimension, method), so five lexicons
 * all measuring `polarity` can be laid directly over each other — which is the
 * whole point of running more than one instrument.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importLexicon, previewLexicon, decodeLexiconBytes } from './lexicon-import.js';
import { getLexiconByName, getAllMethods, createMethod } from './database.js';
import { parseMethodConfig } from './scoring.js';
/** The construct every polarity dictionary loads into, so they stay comparable. */
export const POLARITY_DIMENSION = 'polarity';
export const POLARITY_DIMENSION_DESCRIPTION = 'Word-level sentiment polarity, measured by dictionary lookup. High = positive words dominate the page; ' +
    'low = negative words dominate. Scored by lexicon methods rather than by reading for meaning.';
export const LEXICON_PRESETS = [
    {
        id: 'afinn',
        label: 'AFINN (Spanish)',
        aliases: ['afinn'],
        description: 'A flat word→valence list. Small and fast; a common baseline in sentiment work.',
        source: {
            url: 'https://github.com/jboscomendoza/lexicos-nrc-afinn',
            licence: 'Unstated in the repo — AFINN itself is ODbL v1.0',
            confirmed: true,
        },
        format: {
            kind: 'delimited',
            delimiter: ',',
            termColumn: 'palabra',
            valueColumn: 'puntuacion',
            hasHeader: true,
            scale: [-5, 5],
        },
        formatVerified: true,
        files: ['lexico_afinn.csv'],
        note: "Upstream AFINN has no Spanish list, so this is the Spanish translation used in the R/tidytext " +
            'ecosystem: lexico_afinn.csv, header `palabra,puntuacion,word`, scores −5..5, 2,930 unique terms. ' +
            'Three caveats: the translation is machine-made with manual corrections and does contain errors; the ' +
            'repo states no licence of its own; and a few terms repeat with different scores (the last one loaded ' +
            'wins). Some entries are multi-word ("mal humor") and will not match — v1 matching is single words ' +
            'only. Alternative from the same lineage with clearer licence provenance, since it sits inside the ' +
            'AFINN repo itself (ODbL): AFINN-es-tidytext.txt on the open PR fnielsen/afinn#24 — tab-separated, ' +
            'headerless, but smaller at ~2,130 terms once normalized, so this one is preset for coverage.',
    },
    {
        id: 'so-cal',
        label: 'SO-CAL (SFU)',
        aliases: ['so-cal', 'socal', 'so_cal', 'sfu'],
        description: "Simon Fraser University's Semantic Orientation CALculator dictionaries, published per part of speech.",
        source: {
            url: 'https://github.com/sfu-discourse-lab/SO-CAL/tree/master/Resources/dictionaries/Spanish',
            licence: 'GPL-3.0',
            confirmed: true,
        },
        format: {
            kind: 'delimited',
            delimiter: ' ',
            termColumn: 'term',
            valueColumn: 'value',
            hasHeader: false,
            scale: [-5, 5],
        },
        formatVerified: true,
        files: [
            'google_translated_adj_dict_spa.txt',
            'google_translated_noun_dict_spa.txt',
            'google_translated_verb_dict_spa.txt',
            'google_translated_adv_dict_spa.txt',
        ],
        note: 'Headerless `word<sep>score` files, −5..5, one per part of speech. Two traps in this distribution. ' +
            'First, the Spanish folder holds 25 files that are competing BUILDS of the same dictionary, not parts ' +
            'of one — load exactly one build\u2019s four part-of-speech files, and never int_dict_spa.txt, which is ' +
            'intensifiers ("muy") rather than polarity terms. Second, and decisive here: every build EXCEPT ' +
            'google_translated_* has lost its accents upstream — the published bytes contain U+FFFD replacement ' +
            'characters where á/é/í/ó/ú/ñ should be (344 of them in ciao+SD_adj alone, and zero surviving accented ' +
            'characters). Those terms can never match accented Spanish text, so google_translated_* is the build ' +
            'preset here despite being a rawer machine translation. It is space-separated where the others are ' +
            'tab-separated.',
    },
    {
        id: 'jaen',
        label: 'JAEN (iSOL)',
        aliases: ['jaen', 'isol', 'esol', 'sinai'],
        description: 'Spanish opinion lexicon from the SINAI group at the Universidad de Jaén.',
        source: {
            url: 'https://sinai.ujaen.es/sites/default/files/recurso/archivo/2019-03/isol.tar_.gz',
            licence: 'No licence stated; cite Molina-González et al. (2013)',
            confirmed: true,
        },
        format: {
            kind: 'wordlist',
            scale: [-1, 1],
            polarityFiles: [
                { match: 'positiv', value: 1 },
                { match: 'negativ', value: -1 },
            ],
        },
        formatVerified: true,
        files: ['positivas_mejorada.csv', 'negativas_mejorada.csv'],
        note: 'iSOL is a polarity lexicon: two plain word lists, no scores — 2,509 positive and 5,626 negative, ' +
            'translated from Bing Liu\u2019s English lexicon and manually corrected. Despite the .csv extension they ' +
            'are one term per line. The archive extracts to an isol/ folder holding both, which is already the ' +
            'right shape: the positive file imports at +1 and the negative at −1 under one lexicon. Note the file ' +
            'is ISO-8859-1, not UTF-8 — the importer detects and handles that, but anything else reading it will ' +
            'mangle the accents. Cite Molina-González et al. (2013); no licence is stated.',
    },
    {
        id: 'linguakit',
        label: 'Linguakit',
        aliases: ['linguakit', 'citius'],
        description: "The polarity lexicon behind Linguakit's sentiment module.",
        source: {
            url: 'https://github.com/citiususc/Linguakit/blob/master/sentiment/es/lex_es',
            licence: 'GPL-3.0',
            confirmed: true,
        },
        format: {
            kind: 'delimited',
            delimiter: '\t',
            termColumn: 'term',
            valueColumn: 'value',
            hasHeader: false,
            labelValues: { POSITIVE: 1, NEGATIVE: -1 },
            scale: [-1, 1],
        },
        formatVerified: true,
        files: ['sentiment/es/lex_es'],
        note: 'The Spanish lexicon is sentiment/es/lex_es inside the toolkit — one file, `word<TAB>POSITIVE` or ' +
            '`word<TAB>NEGATIVE`, no header. The values are LABELS rather than numbers, mapped here to +1 / −1, ' +
            'so this is a two-level instrument: it says which way a word leans, not how strongly. The sibling ' +
            'train_es is training data for the toolkit\u2019s classifier, not a dictionary — do not load it.',
    },
    {
        id: 'sbu',
        label: 'Stony Brook (SBU)',
        aliases: ['sbu', 'stony', 'stonybrook', 'chen', 'skiena', 'polyglot'],
        description: 'Chen & Skiena\u2019s multilingual polarity lexicons — the Spanish half of a set covering 136 languages.',
        source: {
            url: 'https://www.kaggle.com/datasets/rtatman/sentiment-lexicons-for-81-languages',
            licence: 'See the Kaggle dataset page; cite Chen & Skiena (2014)',
            confirmed: true,
        },
        format: {
            kind: 'wordlist',
            scale: [-1, 1],
            polarityFiles: [
                { match: 'positive', value: 1 },
                { match: 'negative', value: -1 },
            ],
        },
        formatVerified: false,
        files: ['positive_words_es.txt', 'negative_words_es.txt'],
        note: 'SBU is Chen & Skiena, "Building Sentiment Lexicons for All Major Languages" (ACL 2014), from Stony ' +
            'Brook — the lexicons behind polyglot, whose data still lives on polyglot.cs.stonybrook.edu. Polarity ' +
            'is three-point (+1 / 0 / −1), so like Linguakit this says which way a word leans, not how strongly. ' +
            'The practical download is the Kaggle repackaging as plain word lists: take positive_words_es.txt and ' +
            'negative_words_es.txt into one lexicons/sbu/ folder and both halves load as one instrument. Kaggle ' +
            'needs a login, so this is the one preset whose layout I have not read first-hand — the shape is from ' +
            'the dataset\u2019s documented naming, and the upload dialog will show you the truth either way.',
    },
];
/** Loose match of a lexicon or file name to a preset. */
export function presetFor(name) {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return LEXICON_PRESETS.find((p) => p.aliases.some((a) => n.includes(a.toLowerCase().replace(/[^a-z0-9]/g, ''))));
}
/** Stable method name for a lexicon, so repeat runs reuse one row. */
export function lexiconMethodName(lexiconName) {
    return `lex-${lexiconName}`;
}
/** Register the scoring method for a lexicon, or return the one already bound. */
export async function ensureLexiconMethod(lexiconId, lexiconName, negation = true) {
    const methods = await getAllMethods();
    const bound = methods.find((m) => m.kind === 'lexicon' && parseMethodConfig(m).lexicon_id === lexiconId);
    if (bound)
        return bound;
    return createMethod(lexiconMethodName(lexiconName), 'lexicon', JSON.stringify({ lexicon_id: lexiconId, aggregation: 'mean', negation }));
}
// ---------------------------------------------------------------------------
// Seeding from disk
// ---------------------------------------------------------------------------
/** Where dropped-in dictionary files are looked for. */
export function lexiconDir() {
    return process.env.LEXICON_DIR ?? path.resolve(process.cwd(), 'lexicons');
}
const DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.json']);
function readSidecar(filePath) {
    const sidecar = `${filePath}.mapping.json`;
    if (!fs.existsSync(sidecar))
        return null;
    try {
        return JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * Work out how to import one file: an explicit sidecar wins, otherwise the
 * preset matched from its name, otherwise what the file itself looks like.
 * Returns null when the layout can't be settled without a human.
 */
function planImport(filePath, lexiconName) {
    const fileName = path.basename(filePath);
    // Not readFileSync(..., 'utf8'): iSOL is ISO-8859-1, and decoding it as UTF-8
    // turns every accented term into U+FFFD before the importer ever sees it.
    const content = decodeLexiconBytes(fs.readFileSync(filePath));
    const sidecar = readSidecar(filePath);
    if (sidecar) {
        const scaleMin = sidecar.scaleMin ?? -1;
        const scaleMax = sidecar.scaleMax ?? 1;
        return {
            name: sidecar.lexicon ?? lexiconName,
            content,
            fileName,
            termColumn: sidecar.termColumn ?? 'term',
            valueColumns: sidecar.valueColumns ?? {},
            dimension: sidecar.dimension,
            fixedValue: sidecar.fixedValue,
            scaleMin,
            scaleMax,
            delimiter: sidecar.delimiter,
            hasHeader: sidecar.hasHeader,
            labelValues: sidecar.labelValues,
            note: sidecar.note ?? `Seeded from ${fileName}`,
            appendToExisting: true,
            negation: sidecar.negation ?? true,
        };
    }
    // Match the preset on the lexicon name first. A dictionary published as
    // several files rarely names the dictionary in any of them — SO-CAL's are
    // `google_translated_adj_dict_spa.txt`, Linguakit's is `lex_es` — so it is the
    // containing folder that identifies the instrument.
    const preset = presetFor(lexiconName) ?? presetFor(fileName);
    let spec = preset?.format;
    let preview = previewLexicon({
        content,
        fileName,
        delimiter: spec?.delimiter,
        // A preset that has actually been checked against the published file knows
        // better than detection does.
        hasHeader: preset?.formatVerified ? spec?.hasHeader : undefined,
    });
    // A preset describes how a dictionary is USUALLY published, which is not a
    // promise about the file in front of us — the same lexicon often circulates in
    // several layouts (AFINN as comma+header from one mirror, tab+headerless from
    // another). If the preset's columns aren't actually here, believe the file and
    // fall back to detection, keeping only what the preset knows about the
    // *dictionary* rather than the file: its native scale and any label meanings.
    const specFits = !spec ||
        spec.kind === 'wordlist' ||
        ((!spec.termColumn || preview.columns.includes(spec.termColumn)) &&
            (!spec.valueColumn || preview.columns.includes(spec.valueColumn)));
    if (!specFits) {
        preview = previewLexicon({ content, fileName });
        spec = spec ? { kind: spec.kind, scale: spec.scale, labelValues: spec.labelValues } : undefined;
    }
    if (preview.isWordList) {
        // Polarity is carried by the filename: <something>positive.txt / negative.txt.
        const lower = fileName.toLowerCase();
        const rule = (spec?.polarityFiles ?? [
            { match: 'positiv', value: 1 },
            { match: 'negativ', value: -1 },
        ]).find((r) => lower.includes(r.match));
        if (!rule)
            return null;
        const [scaleMin, scaleMax] = spec?.scale ?? [-1, 1];
        return {
            name: lexiconName,
            content,
            fileName,
            termColumn: 'term',
            valueColumns: {},
            dimension: POLARITY_DIMENSION,
            fixedValue: rule.value,
            scaleMin,
            scaleMax,
            note: `Seeded from ${fileName}${preset ? ` (${preset.label})` : ''}`,
            appendToExisting: true,
            negation: true,
        };
    }
    // A table: use the preset's columns when they're actually present, else fall
    // back to the first non-numeric column as the term and the first numeric one
    // as the value — which is what nearly every published word→score list is. A
    // label column (POSITIVE/NEGATIVE) counts as a value column too, since the
    // preset supplies the numbers those words stand for.
    const labelColumn = preview.labelColumns[0]?.column;
    const termColumn = spec?.termColumn && preview.columns.includes(spec.termColumn)
        ? spec.termColumn
        : preview.columns.find((c) => !preview.numericColumns.includes(c) && c !== labelColumn);
    const valueColumn = spec?.valueColumn && preview.columns.includes(spec.valueColumn)
        ? spec.valueColumn
        : (preview.numericColumns[0] ?? labelColumn);
    if (!termColumn || !valueColumn)
        return null;
    // A labelled file can only be imported if we know what the labels mean.
    const needsLabels = preview.labelColumns.some((l) => l.column === valueColumn);
    if (needsLabels && !spec?.labelValues)
        return null;
    const [scaleMin, scaleMax] = spec?.scale ?? [
        preview.observedRange?.min ?? -1,
        preview.observedRange?.max ?? 1,
    ];
    return {
        name: lexiconName,
        content,
        fileName,
        termColumn,
        valueColumns: { [valueColumn]: POLARITY_DIMENSION },
        scaleMin,
        scaleMax,
        delimiter: preview.delimiter,
        hasHeader: !preview.headerless,
        labelValues: spec?.labelValues,
        note: `Seeded from ${fileName}${preset ? ` (${preset.label})` : ''}`,
        appendToExisting: true,
        negation: true,
    };
}
/**
 * The lexicon name a file belongs to. Files in a subdirectory take that
 * directory's name, so a lexicon published as several files (SO-CAL's four
 * parts of speech, iSOL's two polarity lists) becomes one instrument by
 * putting them in one folder.
 */
function lexiconNameFor(filePath, root) {
    const rel = path.relative(root, filePath);
    const dir = path.dirname(rel);
    if (dir && dir !== '.')
        return dir.split(path.sep)[0];
    const base = path.basename(filePath, path.extname(filePath));
    return presetFor(base)?.id ?? base;
}
function collectFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            collectFiles(full, out);
        else if (DATA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith('.mapping.json')) {
            out.push(full);
        }
    }
    return out;
}
/**
 * Import every dictionary file sitting in the lexicon directory and register a
 * scoring method for each. Idempotent: a lexicon that already has terms is left
 * alone, so this is safe to run on every boot. Never throws — a malformed file
 * is reported and skipped rather than taking the server down.
 */
export async function seedLexiconsFromDisk() {
    const root = lexiconDir();
    if (!fs.existsSync(root))
        return [];
    const outcomes = [];
    const files = collectFiles(root).sort();
    // Group by target lexicon so multi-file instruments import together.
    const byLexicon = new Map();
    for (const file of files) {
        const name = lexiconNameFor(file, root);
        const arr = byLexicon.get(name);
        if (arr)
            arr.push(file);
        else
            byLexicon.set(name, [file]);
    }
    for (const [lexiconName, group] of byLexicon) {
        if (await getLexiconByName(lexiconName)) {
            for (const file of group) {
                outcomes.push({
                    file: path.relative(root, file),
                    lexicon: lexiconName,
                    status: 'skipped',
                    reason: 'already imported',
                });
            }
            continue;
        }
        let imported = null;
        for (const file of group) {
            const rel = path.relative(root, file);
            try {
                const plan = planImport(file, lexiconName);
                if (!plan) {
                    outcomes.push({
                        file: rel,
                        lexicon: lexiconName,
                        status: 'failed',
                        reason: 'Could not work out its layout — add a <file>.mapping.json beside it. ' +
                            'If its values are words rather than numbers, the sidecar needs a labelValues map.',
                    });
                    continue;
                }
                const { negation, ...importInput } = plan;
                imported = await importLexicon(importInput);
                await ensureLexiconMethod(imported.lexiconId, lexiconName, negation);
                outcomes.push({ file: rel, lexicon: lexiconName, status: 'imported', terms: imported.inserted });
            }
            catch (err) {
                outcomes.push({
                    file: rel,
                    lexicon: lexiconName,
                    status: 'failed',
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return outcomes;
}
