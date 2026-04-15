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

Each image shows a TWO-PAGE SPREAD of an open book. The LEFT physical page is on the left side of the image and the RIGHT physical page is on the right side, with the book's spine running vertically through the centre. Treat each physical page as a completely separate unit — transcribe the left page's text in full before moving to the right page. Never read across the spine as though text continues from one side to the other.

Transcribe the text EXACTLY as it is printed. Do not correct spelling, punctuation, accents, capitalisation, or grammar — even if something appears to be an error. Preserve the author's original wording verbatim.

Additional rules:
- Transcribe ONLY the printed story text intended to be read by the audience
- DO NOT transcribe text that appears inside illustrations (signs, chalkboards, posters, labels, or any text that is part of the artwork)
- Preserve line breaks exactly as they appear on each physical page
- If a spread contains no story text (blank pages, endpapers, or a fully illustration-only spread), output exactly: [ILLUSTRATION]
- Do not add commentary, translations, headings, or notes of any kind`;

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

  const errorSummary = errors.length > 0 ? `\nErrors:\n${errors.join('\n')}` : '';

  return {
    status: 'complete',
    processedCount,
    summary: `Batch complete. Processed ${processedCount} page(s).${errorSummary}`,
  };
}
