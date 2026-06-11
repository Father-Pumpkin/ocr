/**
 * Pluggable scoring methods (instruments). A `Scorer` turns a page's text into a
 * 0–1 score on a dimension; methods differ only in how. Two kinds today:
 *   - LlmScorer    — Claude reads the text against a prompt (the method's own
 *                    prompt, or the dimension's description). One API call.
 *   - LexiconScorer — local, deterministic: tokenize the Spanish text, match a
 *                    word→value dictionary, average. No API.
 *
 * The tokenizer/normalizer live here and are shared with the lexicon importer so
 * stored terms and matched tokens are canonicalized identically.
 */
import { getLexiconTerms } from './database.js';
import { scoreTranscription, DEFAULT_MODEL } from './ocr.js';
export function parseMethodConfig(method) {
    try {
        return JSON.parse(method.config || '{}');
    }
    catch {
        return {};
    }
}
// ---- Text utilities (shared with lexicon-import) ----
/** Canonical form of a lexicon term / matched token: lowercased + trimmed. */
export function normalizeToken(s) {
    return s.toLowerCase().trim();
}
/** Split text into lowercased word tokens (Unicode-aware; accents/ñ preserved). */
export function tokenize(text) {
    return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// Common Spanish negators — within a small window, flip a matched term's value.
const NEGATORS = new Set([
    'no', 'nunca', 'jamás', 'jamas', 'ni', 'tampoco', 'sin', 'nada', 'nadie',
    'ningún', 'ninguna', 'ninguno', 'ningun',
]);
const NEGATION_WINDOW = 3;
// ---- Scorers ----
class LlmScorer {
    model;
    prompt;
    constructor(model, prompt) {
        this.model = model;
        this.prompt = prompt;
    }
    async score(pageText, dimension) {
        const r = await scoreTranscription(pageText, dimension, this.model, this.prompt);
        return r ? { score: r.score, rationale: r.rationale, model: this.model } : null;
    }
}
class LexiconScorer {
    lexiconId;
    negation;
    label;
    // Lazily loaded per dimension: term → normalized 0–1 value.
    cache = new Map();
    constructor(lexiconId, negation, label) {
        this.lexiconId = lexiconId;
        this.negation = negation;
        this.label = label;
    }
    async termsFor(dimensionId) {
        let m = this.cache.get(dimensionId);
        if (!m) {
            const rows = await getLexiconTerms(this.lexiconId, dimensionId);
            m = new Map(rows.map((r) => [r.term, r.value]));
            this.cache.set(dimensionId, m);
        }
        return m;
    }
    async score(pageText, dimension) {
        const terms = await this.termsFor(dimension.id);
        if (terms.size === 0)
            return null; // lexicon doesn't cover this dimension
        const tokens = tokenize(pageText);
        if (tokens.length === 0)
            return null;
        let sum = 0;
        let matched = 0;
        for (let i = 0; i < tokens.length; i++) {
            const v = terms.get(tokens[i]);
            if (v === undefined)
                continue;
            let value = v;
            if (this.negation) {
                for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
                    if (NEGATORS.has(tokens[j])) {
                        value = 1 - value;
                        break;
                    }
                }
            }
            sum += value;
            matched++;
        }
        if (matched === 0)
            return null; // no lexicon hits on this page → no signal
        const score = Math.min(1, Math.max(0, sum / matched));
        return {
            score,
            rationale: `matched ${matched}/${tokens.length} token(s)`,
            model: this.label,
        };
    }
}
/**
 * Build the scorer for a method. Throws if a lexicon method is misconfigured.
 * `modelOverride` applies only to LLM methods that don't pin their own model
 * (precedence: method config model > override > default).
 */
export async function getScorer(method, modelOverride) {
    const cfg = parseMethodConfig(method);
    if (method.kind === 'lexicon') {
        if (!cfg.lexicon_id) {
            throw new Error(`Lexicon method "${method.name}" has no lexicon_id in its config.`);
        }
        return new LexiconScorer(cfg.lexicon_id, !!cfg.negation, `lexicon:${method.name}`);
    }
    // Default kind: llm
    return new LlmScorer(cfg.model || modelOverride || DEFAULT_MODEL, cfg.prompt);
}
