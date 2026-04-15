#!/usr/bin/env node
// Redirect console.log to stderr — MCP stdio transport uses stdout exclusively
// for JSON, so any library that writes to console.log would break the protocol.
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

// Resolve relative path env vars to absolute paths using process.cwd()
for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
  const val = process.env[key];
  if (val && !path.isAbsolute(val)) process.env[key] = path.resolve(process.cwd(), val);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import fs from 'fs';

import { getAdapter, getInProgressBatchJobs, getAllBooks, getBookByName, getPages, getAllDimensions, getDimensionByName, createDimension, updateDimension, deleteDimension } from './database.js';
import { listPdfsInFolder, clearAuth } from './google-drive.js';
import { listBooks } from './tools/list-books.js';
import { transcribeBooks } from './tools/transcribe-books.js';
import { batchTranscribe } from './tools/batch-transcribe.js';
import { getTranscription } from './tools/get-transcription.js';
import { updatePage } from './tools/update-page.js';
import { tagPage } from './tools/tag-page.js';
import { getPageImageTool } from './tools/get-page-image.js';
import { insertPage } from './tools/insert-page.js';
import { deletePageTool } from './tools/delete-page.js';
import { retranscribePage } from './tools/retranscribe-page.js';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from './ocr.js';
import { checkAndProcessBatch } from './ocr.js';

// ---------------------------------------------------------------------------
// Startup: ensure required directories exist
// ---------------------------------------------------------------------------

function ensureDirectories(): void {
  const credentialsPath = process.env.CREDENTIALS_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'credentials');
  const dirs: string[] = [credentialsPath];

  // Only create SQLite data directory when not using Postgres
  if (!process.env.DB_HOST && !process.env.DATABASE_URL) {
    const dbPath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
    dirs.push(path.dirname(dbPath));
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      process.stderr.write(`[OCR MCP] Created directory: ${dir}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resume any in-progress batch jobs from a previous session
// ---------------------------------------------------------------------------

async function resumeInProgressBatches(): Promise<void> {
  const jobs = await getInProgressBatchJobs();
  if (jobs.length === 0) return;
  process.stderr.write(`[OCR MCP] Resuming ${jobs.length} in-progress batch job(s)...\n`);
  for (const job of jobs) {
    try {
      const { summary } = await checkAndProcessBatch(job.batch_id);
      process.stderr.write(`[OCR MCP] Batch ${job.batch_id}: ${summary}\n`);
    } catch (err) {
      process.stderr.write(`[OCR MCP] Error resuming batch ${job.batch_id}: ${err}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'ocr-mcp-server',
  version: '1.0.0',
});

// ---- Tool: list_books -------------------------------------------------------

server.tool(
  'list_books',
  'Lists all PDF files in the configured Google Drive folder, showing transcription status for each.',
  {},
  async () => {
    try {
      const result = await listBooks();
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: transcribe_books -------------------------------------------------

server.tool(
  'transcribe_books',
  'Downloads PDFs from Google Drive and transcribes each page using Claude vision OCR. Supports single-request and Batch API modes.',
  {
    book_names: z
      .array(z.string())
      .describe(
        'List of book filenames to transcribe (must match names from list_books). Pass an empty array to transcribe ALL books.'
      ),
    use_batch: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'If true, uses the Anthropic Batch API (cheaper, async). Returns a batch_id to check later with check_batch.'
      ),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, re-transcribes pages that already have transcriptions.'),
    model: z
      .enum(AVAILABLE_MODELS)
      .optional()
      .default(DEFAULT_MODEL)
      .describe('Claude model to use. Sonnet (default) is recommended. Haiku is faster/cheaper. Opus is most accurate.'),
  },
  async ({ book_names, use_batch, overwrite, model }) => {
    try {
      const result = await transcribeBooks({ book_names, use_batch, overwrite, model });
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: batch_transcribe -------------------------------------------------

server.tool(
  'batch_transcribe',
  'Submits books to the Anthropic Batch API for async transcription (50% cheaper, ~1hr turnaround). ' +
  'Defaults to all unprocessed books if no list is given. Always call with dry_run: true first to ' +
  'show the user what would be submitted and get confirmation before actually running.',
  {
    book_names: z
      .array(z.string())
      .default([])
      .describe('Books to transcribe. Pass an empty array to auto-select all eligible books.'),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, resubmit books that are already complete.'),
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe('Preview what would be submitted without downloading or submitting anything. Use this first to confirm with the user.'),
  },
  async ({ book_names, overwrite, dry_run }) => {
    try {
      const result = await batchTranscribe({ book_names, overwrite, dry_run });
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: check_batch ------------------------------------------------------

server.tool(
  'check_batch',
  'Polls an Anthropic batch job for status. If complete, processes all results and stores transcriptions in the database.',
  {
    batch_id: z.string().describe('The Anthropic batch ID returned by transcribe_books.'),
  },
  async ({ batch_id }) => {
    try {
      const { summary } = await checkAndProcessBatch(batch_id);
      return { content: [{ type: 'text', text: summary }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: get_transcription -------------------------------------------------

server.tool(
  'get_transcription',
  'Retrieves the transcription for a book, optionally filtered to a page range.',
  {
    book_name: z.string().describe('The book filename or title (as shown by list_books).'),
    page_start: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Starting page number (inclusive, 1-based).'),
    page_end: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Ending page number (inclusive, 1-based).'),
    include_illustrations: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, includes [ILLUSTRATION] pages in the output.'),
  },
  async ({ book_name, page_start, page_end, include_illustrations }) => {
    try {
      const result = await getTranscription({ book_name, page_start, page_end, include_illustrations });
      // Include structured page data for the MCP App UI
      const book = await getBookByName(book_name);
      const pages = book ? await getPages(book.id, page_start, page_end) : [];
      return {
        content: [{ type: 'text', text: result }],
        structuredContent: { pages },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: update_page -------------------------------------------------------

server.tool(
  'update_page',
  'Manually corrects the transcription for a specific page. Sets is_edited=true in the database.',
  {
    book_name: z.string().describe('The book filename or title.'),
    page_number: z.number().int().positive().describe('The 1-based page number to update.'),
    transcription: z.string().describe('The corrected transcription text.'),
  },
  async ({ book_name, page_number, transcription }) => {
    try {
      const result = await updatePage({ book_name, page_number, transcription });
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: tag_page ---------------------------------------------------------

server.tool(
  'tag_page',
  'Sets narrative tags on a specific page (e.g. "inciting incident", "climax"). Replaces all existing tags with the supplied list.',
  {
    book_name: z.string().describe('The book filename or title.'),
    page_number: z.number().int().positive().describe('The 1-based page number.'),
    tags: z
      .array(z.string())
      .describe('Complete list of tags to apply. Pass an empty array to clear all tags.'),
  },
  async ({ book_name, page_number, tags }) => {
    try {
      const result = await tagPage({ book_name, page_number, tags });
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: { tags: result.tags },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: list_dimensions --------------------------------------------------

server.tool(
  'list_dimensions',
  'Lists all researcher-defined sentiment dimensions available for analysis.',
  {},
  async () => {
    try {
      const dimensions = await getAllDimensions();
      if (dimensions.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No dimensions defined yet. Use create_dimension to add one.',
          }],
        };
      }
      const header = 'Name                 | Description                                      | Min Label  | Max Label\n' +
                     '---------------------|--------------------------------------------------|------------|----------';
      const rows = dimensions.map((d) => {
        const name = d.name.padEnd(20);
        const desc = d.description.length > 48 ? d.description.slice(0, 45) + '...' : d.description.padEnd(48);
        const min = d.min_label.padEnd(10);
        const max = d.max_label;
        return `${name} | ${desc} | ${min} | ${max}`;
      });
      return {
        content: [{ type: 'text', text: [header, ...rows].join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: create_dimension -------------------------------------------------

server.tool(
  'create_dimension',
  'Creates a new sentiment dimension for analysis. The description is used to prompt Claude when scoring pages, so be precise about what to look for.',
  {
    name: z.string().describe('Short identifier, e.g. "affirmativeness". Used as the dimension key.'),
    description: z.string().describe('What Claude should look for when scoring this dimension. Be specific about what constitutes a high vs low score.'),
    min_label: z.string().optional().default('Low').describe('Label for the low end of the scale (0.0).'),
    max_label: z.string().optional().default('High').describe('Label for the high end of the scale (1.0).'),
  },
  async ({ name, description, min_label, max_label }) => {
    try {
      const dimension = await createDimension(name, description, min_label, max_label);
      return {
        content: [{
          type: 'text',
          text: `Created dimension "${dimension.name}" (id: ${dimension.id})\n` +
                `Description: ${dimension.description}\n` +
                `Scale: ${dimension.min_label} (0.0) → ${dimension.max_label} (1.0)`,
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: update_dimension -------------------------------------------------

server.tool(
  'update_dimension',
  'Updates an existing sentiment dimension. Useful for refining descriptions as research questions evolve. Existing scores are preserved but may no longer reflect the updated description.',
  {
    name: z.string().describe('The dimension name to update.'),
    description: z.string().optional().describe('New description for the dimension.'),
    min_label: z.string().optional().describe('New label for the low end (0.0).'),
    max_label: z.string().optional().describe('New label for the high end (1.0).'),
  },
  async ({ name, description, min_label, max_label }) => {
    try {
      const existing = await getDimensionByName(name);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Error: Dimension "${name}" not found.` }],
          isError: true,
        };
      }
      const updated = await updateDimension(existing.id, { description, minLabel: min_label, maxLabel: max_label });
      if (!updated) {
        return {
          content: [{ type: 'text', text: `Error: Dimension "${name}" could not be updated.` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Updated dimension "${updated.name}" (id: ${updated.id})\n` +
                `Description: ${updated.description}\n` +
                `Scale: ${updated.min_label} (0.0) → ${updated.max_label} (1.0)`,
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: delete_dimension -------------------------------------------------

server.tool(
  'delete_dimension',
  'Deletes a sentiment dimension and all associated scores. This cannot be undone.',
  {
    name: z.string().describe('The dimension name to delete.'),
  },
  async ({ name }) => {
    try {
      const existing = await getDimensionByName(name);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Error: Dimension "${name}" not found.` }],
          isError: true,
        };
      }
      const deleted = await deleteDimension(existing.id);
      if (!deleted) {
        return {
          content: [{ type: 'text', text: `Error: Dimension "${name}" could not be deleted.` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Deleted dimension "${name}" (id: ${existing.id}) and all associated page sentiment scores.`,
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: get_page_image ---------------------------------------------------

server.tool(
  'get_page_image',
  'Returns a rendered image of a specific book page as base64 JPEG. Caches locally so Drive is only hit once per book.',
  {
    book_name: z.string().describe('The book filename or title.'),
    page_number: z.number().int().positive().describe('The 1-based page number.'),
  },
  async ({ book_name, page_number }) => {
    try {
      const { imageData, driveUrl } = await getPageImageTool(book_name, page_number);
      const sc: Record<string, unknown> = { driveUrl };
      if (imageData) sc.imageData = imageData;
      return {
        content: [{ type: 'text', text: imageData ? `Page ${page_number} image rendered.` : `Page ${page_number} has no associated PDF image.` }],
        structuredContent: sc,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: insert_page ------------------------------------------------------

server.tool(
  'insert_page',
  'Inserts a new blank page after the specified page number, renumbering all subsequent pages.',
  {
    book_name: z.string().describe('The book filename or title.'),
    after_page_number: z
      .number()
      .int()
      .min(0)
      .describe('Insert after this page number. Use 0 to insert before the first page.'),
  },
  async ({ book_name, after_page_number }) => {
    try {
      const result = await insertPage({ book_name, after_page_number });
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: { page_number: result.page_number },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: retranscribe_page ------------------------------------------------

server.tool(
  'retranscribe_page',
  'Re-transcribes a single page using its cached image and the specified model. Use this to improve a poor transcription without re-running the whole book.',
  {
    book_name: z.string().describe('The book filename or title.'),
    page_number: z.number().int().positive().describe('The 1-based page number to re-transcribe.'),
    model: z
      .enum(AVAILABLE_MODELS)
      .optional()
      .default(DEFAULT_MODEL)
      .describe('Claude model to use. Sonnet (default) is recommended. Opus is most accurate.'),
  },
  async ({ book_name, page_number, model }) => {
    try {
      const result = await retranscribePage({ book_name, page_number, model });
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: delete_page ------------------------------------------------------

server.tool(
  'delete_page',
  'Deletes a page from a book and renumbers all subsequent pages. Also removes any cached image for that page.',
  {
    book_name: z.string().describe('The book filename or title.'),
    page_number: z.number().int().positive().describe('The 1-based page number to delete.'),
  },
  async ({ book_name, page_number }) => {
    try {
      const result = await deletePageTool({ book_name, page_number });
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: clear_auth -------------------------------------------------------

server.tool(
  'clear_auth',
  'Clears the stored Google credentials and any pending device flow, so the next Drive operation will start a fresh authorization. Use this if you authorized with the wrong Google account or if Drive access is failing.',
  {},
  async () => {
    try {
      clearAuth();
      return {
        content: [{
          type: 'text',
          text: 'Google auth cleared. The next Drive operation will open a new browser window for authorization.',
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }
);

// ---- Tool: view_transcriptions (MCP App entry point) ------------------------

const VIEWER_RESOURCE_URI = 'ui://transcription-viewer/app.html';

registerAppTool(
  server,
  'view_transcriptions',
  {
    title: 'Transcription Viewer',
    description: 'Opens the interactive transcription viewer for browsing and editing book transcriptions.',
    inputSchema: {},
    _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI } },
  },
  async () => {
    const [dbBooks, driveFiles] = await Promise.all([
      getAllBooks(),
      listPdfsInFolder().catch(() => []),
    ]);

    const dbByDriveId = new Map(dbBooks.map((b) => [b.drive_file_id, b]));

    // All Drive files, with DB data merged in; unknown Drive files get status 'pending'
    const books = driveFiles.length > 0
      ? driveFiles.map((file) => dbByDriveId.get(file.id) ?? {
          id: -1,
          title: file.name.replace(/\.pdf$/i, ''),
          drive_file_id: file.id,
          drive_file_name: file.name,
          page_count: null,
          status: 'pending',
          created_by: null,
          created_at: '',
          updated_at: '',
        })
      : dbBooks; // fallback to DB-only if Drive unavailable

    return {
      content: [{ type: 'text', text: `Library: ${books.length} book(s) available.` }],
      structuredContent: { books },
    };
  }
);

// ---- Resource: transcription viewer (MCP App UI) ----------------------------

registerAppResource(
  server,
  'transcription-viewer',
  VIEWER_RESOURCE_URI,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const htmlPath = path.join(PROJECT_ROOT, 'ui', 'dist', 'mcp-app.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return { contents: [{ uri: VIEWER_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDirectories();

  // Initialize the adapter (creates tables / runs migrations)
  try {
    await getAdapter();
    process.stderr.write('[OCR MCP] Database initialised.\n');
  } catch (err) {
    process.stderr.write(`[OCR MCP] Failed to initialise database: ${err}\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[OCR MCP] Server running on stdio transport.\n');

  // Fire-and-forget: resume any batches that were in-progress when server last stopped
  resumeInProgressBatches().catch((err) =>
    process.stderr.write(`[OCR MCP] Error resuming in-progress batches: ${err}\n`)
  );
}

main().catch((err) => {
  process.stderr.write(`[OCR MCP] Fatal error: ${err}\n`);
  process.exit(1);
});
