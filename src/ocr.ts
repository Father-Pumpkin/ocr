import Anthropic from '@anthropic-ai/sdk';
import {
  upsertPage,
  updateBookStatus,
  hasExistingTranscription,
  createBatchJob,
  getBatchJob,
  updateBatchJobStatus,
} from './database.js';

const MODEL = 'claude-haiku-4-5-20251001';
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

const SYSTEM_PROMPT = `You are transcribing pages from a scanned Spanish children's book PDF.
For EACH page in the PDF, output a block in this exact format:

[PAGE N]
<transcription>

Rules:
- Replace N with the page number (1-based)
- Transcribe ONLY the printed story text intended to be read by the audience
- DO NOT transcribe text that appears within illustrations (e.g., text on chalkboards, signs, posters, or other objects in the artwork)
- Preserve line breaks exactly as they appear on the page
- If a page contains no story text (blank page, endpaper, illustration-only page), output exactly: [ILLUSTRATION]
- Do not add any commentary, headings, or notes`;

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
// Single-request OCR
// ---------------------------------------------------------------------------

export async function transcribeBookPdf(
  bookId: number,
  bookTitle: string,
  pdfBuffer: Buffer,
  overwrite: boolean
): Promise<{ transcribed: number; skipped: number; pageCount: number }> {
  const client = getAnthropicClient();

  await updateBookStatus(bookId, 'transcribing');

  const pdfBase64 = pdfBuffer.toString('base64');

  process.stderr.write(`[OCR MCP] Sending PDF to Claude for transcription...\n`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
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

export async function createOcrBatch(requests: BatchBookRequest[]): Promise<string> {
  const client = getAnthropicClient();

  const batchRequests = requests.map((req) => ({
    custom_id: `book-${req.bookId}`,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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
    `[OCR MCP] Creating Anthropic batch with ${batchRequests.length} book(s)...\n`
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

      // custom_id format: "book-{bookId}"
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
