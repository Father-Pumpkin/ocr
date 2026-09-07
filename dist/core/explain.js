/**
 * Why did this page get that score?
 *
 * A bag-of-words score is the mean of whatever dictionary terms happened to
 * appear on the page, and until you can see *which* terms those were the number
 * is unfalsifiable. It matters more here than it would elsewhere: the median
 * page in this corpus matches a handful of terms, and a large minority of scores
 * rest on one or two words. A reader who can see the words can tell a real
 * reading from an accident in a second; a reader who can't has to trust it.
 *
 * This recomputes from the stored transcription and the lexicon tables rather
 * than reading a cached explanation, so it works for scores written before any
 * of this existed and cannot drift from what the scorer would do today — it
 * applies the same tokenizer and the same negation rule.
 *
 * LLM methods keep their own rationale; there is nothing to recompute, so the
 * stored sentence is returned as-is.
 */
import { getBookByName, getPages, getMethodByName, getDimensionByName, getLexiconTerms, getPageSentiment, } from './database.js';
import { parseMethodConfig, tokenize, NEGATORS, NEGATION_WINDOW } from './scoring.js';
export class ExplainError extends Error {
}
export async function explainPageScore(opts) {
    const book = await getBookByName(opts.book);
    if (!book)
        throw new ExplainError(`No book called "${opts.book}".`);
    const pages = await getPages(book.id, opts.pageNumber, opts.pageNumber);
    const page = pages[0];
    if (!page)
        throw new ExplainError(`${opts.book} has no page ${opts.pageNumber}.`);
    const method = await getMethodByName(opts.method);
    if (!method)
        throw new ExplainError(`No scoring method called "${opts.method}".`);
    const dimension = await getDimensionByName(opts.dimension);
    if (!dimension)
        throw new ExplainError(`No dimension called "${opts.dimension}".`);
    const stored = (await getPageSentiment(page.id)).find((r) => r.dimension_id === dimension.id && r.method_id === method.id);
    const base = {
        book: book.title,
        pageNumber: page.page_number,
        method: method.name,
        methodKind: method.kind,
        dimension: dimension.name,
        storedScore: stored ? stored.score : null,
        text: page.transcription ?? '',
        rationale: stored?.rationale ?? null,
    };
    if (method.kind !== 'lexicon') {
        return {
            ...base,
            recomputedScore: null,
            matched: [],
            tokenCount: tokenize(base.text).length,
            matchCount: 0,
            note: 'Scored by Claude, not a dictionary — the model’s own rationale is shown instead.',
        };
    }
    const lexiconId = parseMethodConfig(method).lexicon_id;
    if (!lexiconId) {
        return { ...base, recomputedScore: null, matched: [], tokenCount: 0, matchCount: 0,
            note: 'This dictionary method has no lexicon attached.' };
    }
    const terms = new Map((await getLexiconTerms(lexiconId, dimension.id)).map((r) => [r.term, r.value]));
    if (terms.size === 0) {
        return { ...base, recomputedScore: null, matched: [], tokenCount: 0, matchCount: 0,
            note: `This dictionary has no terms for “${dimension.name}”, so it cannot score this page.` };
    }
    const tokens = tokenize(base.text);
    const negation = opts.negation ?? false;
    const byTerm = new Map();
    let sum = 0;
    let matchCount = 0;
    for (let i = 0; i < tokens.length; i++) {
        const value = terms.get(tokens[i]);
        if (value === undefined)
            continue;
        // Same negation rule as the scorer: a negator within the preceding window
        // flips the term's value.
        let negated = false;
        if (negation) {
            for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
                if (NEGATORS.has(tokens[j])) {
                    negated = true;
                    break;
                }
            }
        }
        const effective = negated ? 1 - value : value;
        sum += effective;
        matchCount++;
        const existing = byTerm.get(tokens[i]);
        if (existing)
            existing.positions.push(i);
        else
            byTerm.set(tokens[i], { term: tokens[i], value, effective, negated, positions: [i] });
    }
    // Ordered by how far each term pulled the page away from neutral, times how
    // often it appeared — which is the order "what drove this score" asks for.
    const matched = [...byTerm.values()].sort((a, b) => Math.abs(b.effective - 0.5) * b.positions.length - Math.abs(a.effective - 0.5) * a.positions.length);
    return {
        ...base,
        recomputedScore: matchCount ? Math.min(1, Math.max(0, sum / matchCount)) : null,
        matched,
        tokenCount: tokens.length,
        matchCount,
        note: matchCount === 0
            ? 'No word on this page appears in this dictionary, so it has no reading here — that is why the page has no score.'
            : null,
    };
}
