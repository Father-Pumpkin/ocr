# Lexicons

Drop sentiment dictionary files in here and the backend imports them on startup,
registers a scoring method for each, and they appear as **Bag of words** styles
on the `/analysis` screen. Nothing in this folder except this README is committed
— the dictionaries carry their own licences and are not ours to redistribute.

Re-scan without restarting with `POST /api/analysis/lexicons/seed`. Importing is
idempotent: a lexicon that already exists is left alone, so restarts are safe.

## Quick start — all five, scripted

Every one was checked against the actual published file. Copy the commands,
restart the backend, and all five appear as selectable styles.

```bash
# AFINN (Spanish) — 2,930 terms
mkdir -p lexicons/afinn && curl -sSL -o lexicons/afinn/lexico_afinn.csv \
  https://raw.githubusercontent.com/jboscomendoza/lexicos-nrc-afinn/master/lexico_afinn.csv
```

```bash
# Linguakit — 5,282 terms
mkdir -p lexicons/linguakit && curl -sSL -o lexicons/linguakit/lex_es.tsv \
  https://raw.githubusercontent.com/citiususc/Linguakit/master/sentiment/es/lex_es
```

```bash
# SO-CAL (SFU) — 2,966 terms across four parts of speech
mkdir -p lexicons/so-cal && for p in adj noun verb adv; do curl -sSL -o "lexicons/so-cal/google_translated_${p}_dict_spa.txt" "https://raw.githubusercontent.com/sfu-discourse-lab/SO-CAL/master/Resources/dictionaries/Spanish/google_translated_${p}_dict_spa.txt"; done
```

```bash
# Stony Brook (SBU) — 4,273 terms. Chen & Skiena's data, vendored in an MIT repo,
# which avoids Kaggle's login. Cite Chen & Skiena (2014).
mkdir -p lexicons/sbu && for p in positive negative; do curl -sSL -o "lexicons/sbu/${p}_words_es.txt" "https://raw.githubusercontent.com/bedatadriven/QualMiner/master/data-raw/${p}_words_es.txt"; done
```

```bash
# JAEN (iSOL) — 8,131 terms. Extracts to an isol/ folder holding both lists.
curl -sSL -o /tmp/isol.tar.gz https://sinai.ujaen.es/sites/default/files/recurso/archivo/2019-03/isol.tar_.gz && tar -xzf /tmp/isol.tar.gz -C lexicons/
```

Then, on the Analysis screen, **Pre-compute the whole library** scores every book
with all of them at once — local, instant and free.

## How files are grouped

**A folder = one lexicon**, named after the folder. This is the form to use: it
groups a dictionary published as several files into one instrument, and it is how
the importer recognises which preset applies.

```
lexicons/so-cal/google_translated_adj_dict_spa.txt   \
lexicons/so-cal/google_translated_noun_dict_spa.txt   >  lexicon "so-cal"
lexicons/so-cal/google_translated_verb_dict_spa.txt  /
lexicons/so-cal/google_translated_adv_dict_spa.txt  /

lexicons/isol/positivas.txt   \_  lexicon "isol", positive terms at +1,
lexicons/isol/negativas.txt   /   negative terms at -1
```

A loose file also works (`lexicons/afinn.tsv` → lexicon `afinn`), but the preset
is then matched on the *filename*, which for most published dictionaries doesn't
name the dictionary at all.

## Supported formats

Detected automatically — you shouldn't need to configure any of this:

- **Delimited**, with or without a header row. The separator is detected by
  trying tab, comma, semicolon, pipe and whitespace and keeping whichever splits
  the rows consistently. Headerless files get synthetic column names `term` and
  `value`.
- **Labelled values** — a value column holding `POSITIVE` / `NEGATIVE` rather
  than numbers. Presets supply the mapping; the upload dialog asks for it.
- **JSON** — an array of row objects, or a `{ "term": value }` map.
- **Word lists** — one term per line, no values. Polarity comes from the
  filename: a file containing `positiv` imports at the scale maximum, `negativ`
  at the minimum. Lines starting with `#` or `;` are ignored.
- UTF-8 BOMs and CRLF line endings are stripped.

Everything is normalized to 0–1 from the dictionary's native scale, so different
instruments are directly comparable. Files load into the shared `polarity`
dimension, which is what makes "AFINN vs SO-CAL vs Linguakit vs Claude" a single
chart.

## When the guess is wrong

Put a `<filename>.mapping.json` next to the file; it overrides everything
inferred.

```json
{
  "lexicon": "my-lexicon",
  "termColumn": "palabra",
  "valueColumns": { "valencia": "polarity" },
  "scaleMin": -5,
  "scaleMax": 5,
  "delimiter": "\t",
  "hasHeader": false,
  "labelValues": { "POSITIVE": 1, "NEGATIVE": -1 },
  "negation": true
}
```

For a word list:

```json
{ "lexicon": "my-lexicon", "dimension": "polarity", "fixedValue": 1, "scaleMin": -1, "scaleMax": 1 }
```

## The dictionaries

| Lexicon | Source | Licence | Status |
| --- | --- | --- | --- |
| AFINN (Spanish) | [jboscomendoza/lexicos-nrc-afinn](https://github.com/jboscomendoza/lexicos-nrc-afinn) | Unstated in repo; AFINN itself is ODbL v1.0 | ✅ verified |
| SO-CAL (SFU) | [sfu-discourse-lab/SO-CAL](https://github.com/sfu-discourse-lab/SO-CAL/tree/master/Resources/dictionaries/Spanish) | GPL-3.0 | ✅ verified |
| Linguakit | [citiususc/Linguakit](https://github.com/citiususc/Linguakit/blob/master/sentiment/es/lex_es) | GPL-3.0 | ✅ verified |
| Stony Brook (SBU) | [bedatadriven/QualMiner](https://github.com/bedatadriven/QualMiner/tree/master/data-raw) (mirror) or [Kaggle](https://www.kaggle.com/datasets/rtatman/sentiment-lexicons-for-81-languages) | None stated; cite Chen & Skiena (2014) | ✅ verified |
| JAEN (iSOL) | [SINAI, Universidad de Jaén](https://sinai.ujaen.es/index.php/investigacion/recursos/isol) | None stated; cite Molina-González et al. (2013) | ✅ verified |

### Things worth knowing before you trust the numbers

**SO-CAL's accents are destroyed in every build except `google_translated`.**
The published bytes contain U+FFFD replacement characters where á/é/í/ó/ú/ñ should
be — 344 of them in `ciao+SD_adj` alone, with *zero* surviving accented
characters. Those terms can never match accented Spanish, so the preset uses the
`google_translated_*` build, which is intact (461 accented terms) despite being a
rawer machine translation. It is also space-separated where the others are
tab-separated. In spot checks its scores are the weakest of the three — it read
*"Tenía miedo de la oscuridad y lloraba en silencio"* as positive, which AFINN and
Linguakit both got right.

**The Spanish folder holds 25 files that are competing *builds*, not parts.**
`ciao_*` (built for Spanish), `SD_translated_*` (translated from English SO-CAL),
`google_translated_*`, and the `ciao+SD_*` / `SD+ciao_*` combinations. Load
exactly one build's four part-of-speech files. Never load `int_dict_spa.txt` —
those are intensifiers (`muy`), not polarity terms, and they would corrupt the
scores.

**Linguakit is two-level.** Its values are the words `POSITIVE` / `NEGATIVE`,
mapped here to +1 / −1. It tells you which way a word leans, not how strongly, so
its page scores cluster at the extremes.

**AFINN-es is a machine translation** with manual corrections, and does contain
errors. The repo states no licence of its own. A few terms repeat with different
scores (the last loaded wins), and some entries are multi-word (`mal humor`).

**Don't load `train_es`** from Linguakit — it is classifier training data, not a
dictionary.

**SBU is Chen & Skiena**, *"Building Sentiment Lexicons for All Major Languages"*
(ACL 2014) — the lexicons behind [polyglot](https://github.com/aboSamoor/polyglot/blob/master/docs/Sentiment.rst),
whose data is still served from `polyglot.cs.stonybrook.edu`. Polarity is
three-point (+1 / 0 / −1), so like Linguakit it says which way a word leans, not
how strongly.

**SBU assigns polarity to very common function words**, which is the thing to
watch with it. It was built automatically by graph propagation, and the noise
lands where it hurts most: `en`, `para`, `sin`, `tiempo` and `bajo` are all scored
**negative**, while `como`, `gran`, `bien`, `mayor` and `nuevo` are **positive**.
Those words appear on nearly every page, so an SBU page score partly measures
function-word frequency rather than sentiment. Worth weighting accordingly, and
worth knowing that `sin` is *also* one of the negators the scorer uses to flip a
following term — so it counts twice, in two different directions.

**iSOL is ISO-8859-1, not UTF-8.** The importer detects this and decodes it
correctly; anything else reading those files needs to be told, or every accented
term becomes U+FFFD. Its two files are named `.csv` but are one term per line.

**An AFINN alternative with clearer licence provenance:** `AFINN-es-tidytext.txt`
on the open PR [fnielsen/afinn#24](https://github.com/fnielsen/afinn/pull/24/files)
sits inside the AFINN repo itself, so ODbL plainly applies. It's tab-separated and
headerless where the preset's default is comma-with-header — that's fine, presets
are validated against the file and fall back to detection — but it's smaller
(~2,130 terms vs 2,930), which is why coverage wins by default.

**iSOL is directly downloadable** despite older pointers sending you to
META-SHARE, which is now dead (`metashare.upf.edu` no longer resolves). The
archive above is linked from SINAI's own iSOL page. Only some other SINAI
resources need an email.

**TASS is not a lexicon.** <http://tass.sepln.org/tass_data/download.php> is the
SEPLN workshop's corpus of *human-labelled Spanish tweets*. It's evaluation data,
not a dictionary, so there's nothing here to load it into. It would be the right
resource for a different job — measuring which of these instruments actually
agrees with human judgement — which this app doesn't do today.

## Matching v1

Terms are matched as single lowercased words, accents preserved, with no
stemming — an inflected form in the text only matches if the dictionary lists
that form. Multi-word entries never match. Negation (flipping a term's value
after `no`, `nunca`, `sin`… within three words) is on by default for seeded
dictionaries.
