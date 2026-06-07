import Anthropic from '@anthropic-ai/sdk';
import {
  upsertPage,
  updateBookStatus,
  hasExistingTranscription,
  createBatchJob,
  getBatchJob,
  updateBatchJobStatus,
} from './database.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const AVAILABLE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const;
export type OcrModel = typeof AVAILABLE_MODELS[number];

const MAX_TOKENS = 8192;

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY must be set in your .env file.');
  }
  return new Anthropic({ apiKey });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SHARED_PREAMBLE = `You are transcribing pages from a scanned Spanish children's book.

LAYOUT — TWO-PAGE SPREAD WITH A CENTRAL GUTTER
Each image is a photograph of an open book, so it shows a TWO-PAGE SPREAD: a LEFT physical page and a RIGHT physical page, divided by the book's GUTTER (the binding/spine) running vertically down the centre. Near the gutter the paper curves inward and is often shadowed or slightly warped, so characters there can look compressed or distorted.
- Treat the left and right pages as two completely separate columns. Transcribe ALL of the left page first, then ALL of the right page.
- NEVER read across the gutter as if a line continues from the left page onto the right page. The last word of a line on the left page does NOT join the first word of the corresponding line on the right page.
- Do not let the gutter's curve or shadow make you drop, duplicate, merge, or invent characters. If a word runs into the binding, read it as carefully as you can and transcribe it on the page it belongs to.

CAPITALIZATION — REPRODUCE IT EXACTLY
Transcribe the case of every letter EXACTLY as printed, character by character. This is critical and a frequent source of errors:
- If a word, line, or block is printed in ALL CAPITALS, transcribe it in ALL CAPITALS. Do NOT convert it to lowercase or Title Case.
- If text is lowercase, keep it lowercase — even at the start of a sentence or line, if that is how it is printed.
- Do NOT apply "standard" capitalization rules. Only capitalize what is actually capitalized in the image.
- Preserve the case of accented and special characters exactly: Á É Í Ó Ú Ü Ñ / á é í ó ú ü ñ, and ¿ ¡.

VERBATIM TRANSCRIPTION
Transcribe the text EXACTLY as printed. Do not correct spelling, punctuation, accents, capitalization, or grammar — even if something appears to be an error. Preserve the author's original wording verbatim, and keep line breaks exactly as they appear on each physical page.

WHAT TO INCLUDE / EXCLUDE
- Transcribe ONLY the printed story text intended to be read by the audience.
- DO NOT transcribe text that appears inside illustrations (signs, chalkboards, posters, labels, or any text that is part of the artwork).
- If a spread contains no story text (blank pages, endpapers, or a fully illustration-only spread), output exactly: [ILLUSTRATION]
- Do not add commentary, translations, headings, or notes of any kind.`;

// Used for whole-book PDF transcription — requires [PAGE N] block format
const BOOK_SYSTEM_PROMPT = `${SHARED_PREAMBLE}

For EACH PDF page output a block in this exact format:

[PAGE N]
<transcription>

Replace N with the 1-based PDF page number. Output one block per PDF page.`;

// Used for single-page image re-transcription — just return the text
const PAGE_SYSTEM_PROMPT = `${SHARED_PREAMBLE}

Output only the transcribed text, with no extra formatting or labels. If the spread has no story text, output exactly: [ILLUSTRATION]`;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parsePdfTranscription(text: string): Array<{ pageNumber: number; transcription: string }> {
  const results: Array<{ pageNumber: number; transcription: string }> = [];
  const regex = /\[PAGE (\d+)\]\s*([\s\S]*?)(?=\[PAGE \d+\]|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const pageNumber = parseInt(match[1], 10);
    const transcription = match[2].trim() || '[ILLUSTRATION]';
    results.push({ pageNumber, transcription });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Single-page image re-transcription
// ---------------------------------------------------------------------------

export async function transcribeSinglePageImage(
  imageBase64: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: PAGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
          },
          { type: 'text', text: 'Transcribe this page.' },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock ? (textBlock as { type: 'text'; text: string }).text.trim() : '';
  return text || '[ILLUSTRATION]';
}

// ---------------------------------------------------------------------------
// Quality check — a cheap, text-only proofreader pass
// ---------------------------------------------------------------------------

const VERIFY_MODEL = 'claude-sonnet-4-6';

const VERIFY_SYSTEM_PROMPT = `You are proofreading OCR output from a scanned Spanish children's book. You are given ONLY the transcribed text (not the image). Decide whether it reads like a plausible passage from a published Spanish children's book, or whether it contains OCR errors: garbled words, nonsense character sequences, scrambled or broken grammar, or fragments that no published book would contain.

Children's books legitimately contain very short lines, playful or invented words, onomatopoeia, repetition, and simple vocabulary — do NOT flag those. The single token "[ILLUSTRATION]" is valid. Only flag text that is clearly garbled or incoherent as an OCR failure.

Respond with ONLY a JSON object and nothing else:
{"ok": true} if it reads as plausible published text, or
{"ok": false, "reason": "<one short, specific English sentence>"} if it looks like an OCR error.`;

export interface VerifyResult {
  ok: boolean;
  reason: string;
}

// The non-batch Messages API is rate-limited per minute (tier-dependent). Pace
// the verifier so a bulk grade stays under the limit. A single call after idle
// waits 0ms; sustained calls are spaced ~43/min, leaving headroom under 50/min.
const VERIFY_MIN_INTERVAL_MS = 1400;
let verifyNextSlot = 0;
async function throttleVerify(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, verifyNextSlot);
  verifyNextSlot = slot + VERIFY_MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * Text-only plausibility check on a page's transcription. Cheap (no image).
 * Returns ok:true (with empty reason) for illustration/empty pages and on any
 * parse failure — we never flag on uncertainty.
 */
export async function verifyTranscription(text: string): Promise<VerifyResult> {
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed === '[ILLUSTRATION]') return { ok: true, reason: '' };

  await throttleVerify();
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: VERIFY_MODEL,
    max_tokens: 256,
    system: VERIFY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: trimmed }],
  });

  const block = response.content.find((b) => b.type === 'text');
  const raw = block ? (block as { type: 'text'; text: string }).text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: true, reason: '' };
  try {
    const parsed = JSON.parse(match[0]) as { ok?: boolean; reason?: string };
    if (parsed.ok === false) return { ok: false, reason: parsed.reason?.trim() || 'Possible OCR error.' };
    return { ok: true, reason: '' };
  } catch {
    return { ok: true, reason: '' };
  }
}

// ---------------------------------------------------------------------------
// Title recasing — proper Spanish sentence case
// ---------------------------------------------------------------------------

const TITLE_CASE_SYSTEM_PROMPT = `You recase Spanish book titles to Spanish title case. Capitalize the first word and every CONTENT word — nouns, verbs, adjectives, adverbs, pronouns, and proper nouns. Keep FUNCTION words lowercase: articles (el, la, los, las, un, una, unos, unas), prepositions (de, a, en, con, por, para, sin, sobre, entre, hacia, hasta, desde, tras), and conjunctions (y, e, o, u, ni, que, pero) — EXCEPT when a function word is the first word of the title, which is always capitalized. Preserve accents, ñ, and punctuation (¿ ¡) exactly.

Examples:
- "el día de todo al revés" → "El Día de Todo al Revés"
- "aitor tiene dos mamás" → "Aitor Tiene Dos Mamás"
- "cebollino y pimentón" → "Cebollino y Pimentón"

You are given the book title and optionally the OCR text of its title page.

Respond with ONLY a JSON object and nothing else:
{"title": "<the recased title>", "pageText": <the title-page text with ONLY the book's title recased the same way and every other character left exactly as given, OR null if the page text does not contain the title>}`;

export async function recaseTitle(
  title: string,
  pageText: string | null,
): Promise<{ title: string; pageText: string | null }> {
  await throttleVerify();
  const client = getAnthropicClient();
  const user = pageText
    ? `Title: ${title}\n\nTitle-page OCR text:\n${pageText}`
    : `Title: ${title}\n\n(No title-page text provided.)`;
  const response = await client.messages.create({
    model: VERIFY_MODEL,
    max_tokens: 1024,
    system: TITLE_CASE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
  });
  const block = response.content.find((b) => b.type === 'text');
  const raw = block ? (block as { type: 'text'; text: string }).text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { title, pageText: null };
  try {
    const parsed = JSON.parse(match[0]) as { title?: string; pageText?: string | null };
    return { title: (parsed.title ?? title).trim() || title, pageText: parsed.pageText ?? null };
  } catch {
    return { title, pageText: null };
  }
}

// ---------------------------------------------------------------------------
// Single-request OCR (whole book)
// ---------------------------------------------------------------------------

export async function transcribeBookPdf(
  bookId: number,
  bookTitle: string,
  pdfBuffer: Buffer,
  overwrite: boolean,
  model: string = DEFAULT_MODEL
): Promise<{ transcribed: number; skipped: number; pageCount: number }> {
  const client = getAnthropicClient();

  await updateBookStatus(bookId, 'transcribing');

  const pdfBase64 = pdfBuffer.toString('base64');

  process.stderr.write(`[OCR MCP] Sending PDF to Claude (${model}) for transcription...\n`);

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: BOOK_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          } as unknown as Anthropic.TextBlockParam,
          { type: 'text', text: 'Transcribe all pages of this book.' },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock ? (textBlock as { type: 'text'; text: string }).text : '';

  const pages = parsePdfTranscription(text);

  let transcribed = 0;
  let skipped = 0;

  for (const { pageNumber, transcription } of pages) {
    if (!overwrite && await hasExistingTranscription(bookId, pageNumber)) {
      process.stderr.write(
        `[OCR MCP] Skipping ${bookTitle} page ${pageNumber} (already transcribed)\n`
      );
      skipped++;
      continue;
    }
    await upsertPage(bookId, pageNumber, transcription);
    process.stderr.write(`[OCR MCP] Stored ${bookTitle} page ${pageNumber}\n`);
    transcribed++;
  }

  await updateBookStatus(bookId, 'complete', pages.length);

  // Auto quality-check the freshly transcribed book (best-effort; dynamic import
  // avoids a static cycle with quality.ts → ocr.ts).
  try {
    const { verifyBookById } = await import('./quality.js');
    await verifyBookById(bookId);
  } catch (err) {
    process.stderr.write(`[OCR MCP] Quality check failed for book ${bookId}: ${err}\n`);
  }

  return { transcribed, skipped, pageCount: pages.length };
}

// ---------------------------------------------------------------------------
// Batch API OCR (one request per book)
// ---------------------------------------------------------------------------

export interface BatchBookRequest {
  bookId: number;
  bookTitle: string;
  pdfBase64: string;
}

export async function createOcrBatch(
  requests: BatchBookRequest[],
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = getAnthropicClient();

  const batchRequests = requests.map((req) => ({
    custom_id: `book-${req.bookId}`,
    params: {
      model,
      max_tokens: MAX_TOKENS,
      system: BOOK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: req.pdfBase64,
              },
            } as unknown as Anthropic.TextBlockParam,
            { type: 'text' as const, text: 'Transcribe all pages of this book.' },
          ],
        },
      ],
    },
  }));

  process.stderr.write(
    `[OCR MCP] Creating Anthropic batch with ${batchRequests.length} book(s) using ${model}...\n`
  );

  const batch = await client.messages.batches.create({ requests: batchRequests });

  process.stderr.write(`[OCR MCP] Batch created: ${batch.id}\n`);

  return batch.id;
}

export async function checkAndProcessBatch(batchId: string): Promise<{
  status: string;
  processedCount: number;
  summary: string;
}> {
  const client = getAnthropicClient();

  const batchJob = await getBatchJob(batchId);
  if (!batchJob) {
    throw new Error(`No batch job found with ID: ${batchId}`);
  }

  const batch = await client.messages.batches.retrieve(batchId);
  const apiStatus = batch.processing_status;

  process.stderr.write(`[OCR MCP] Batch ${batchId} status: ${apiStatus}\n`);

  if (apiStatus !== 'ended') {
    const counts = batch.request_counts;
    return {
      status: apiStatus,
      processedCount: 0,
      summary: `Batch is still processing. Requests: ${counts.processing} processing, ${counts.succeeded} succeeded, ${counts.errored} errored, ${counts.canceled} canceled, ${counts.expired} expired.`,
    };
  }

  let processedCount = 0;
  const errors: string[] = [];

  for await (const result of await client.messages.batches.results(batchId)) {
    const customId = result.custom_id;

    if (result.result.type === 'succeeded') {
      const msg = result.result.message;
      const textBlock = msg.content.find((b) => b.type === 'text');
      const text = textBlock ? (textBlock as { type: 'text'; text: string }).text : '';

      const match = customId.match(/^book-(\d+)$/);
      if (match) {
        const bookId = parseInt(match[1], 10);
        const pages = parsePdfTranscription(text);
        for (const { pageNumber, transcription } of pages) {
          await upsertPage(bookId, pageNumber, transcription, customId);
          processedCount++;
        }
        await updateBookStatus(bookId, 'complete', pages.length);
      } else {
        errors.push(`Could not parse custom_id: ${customId}`);
      }
    } else if (result.result.type === 'errored') {
      errors.push(`Error for ${customId}: ${result.result.error.type}`);
    } else {
      errors.push(`Unexpected result type for ${customId}`);
    }
  }

  const bookIds: number[] = JSON.parse(batchJob.book_ids);
  for (const bookId of bookIds) {
    await updateBookStatus(bookId, 'complete');
  }

  await updateBatchJobStatus(batchId, 'complete');

  // Auto quality-check each book from the batch (best-effort).
  try {
    const { verifyBookById } = await import('./quality.js');
    for (const bookId of bookIds) await verifyBookById(bookId);
  } catch (err) {
    process.stderr.write(`[OCR MCP] Quality check failed after batch ${batchId}: ${err}\n`);
  }

  const errorSummary = errors.length > 0 ? `\nErrors:\n${errors.join('\n')}` : '';

  return {
    status: 'complete',
    processedCount,
    summary: `Batch complete. Processed ${processedCount} page(s).${errorSummary}`,
  };
}
