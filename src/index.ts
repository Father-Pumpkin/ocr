import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
// Resolve relative path env vars to absolute paths using project root
for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
  const val = process.env[key];
  if (val && !path.isAbsolute(val)) process.env[key] = path.resolve(PROJECT_ROOT, val);
}
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';

import { getDatabase } from './database.js';
import { listBooks } from './tools/list-books.js';
import { transcribeBooks } from './tools/transcribe-books.js';
import { getTranscription } from './tools/get-transcription.js';
import { updatePage } from './tools/update-page.js';
import { tagPage } from './tools/tag-page.js';
import { checkAndProcessBatch } from './ocr.js';
import { getAllBooks, getBookByName, getPages } from './database.js';

// ---------------------------------------------------------------------------
// Startup: ensure required directories exist and DB is initialised
// ---------------------------------------------------------------------------

function ensureDirectories(): void {
  const dirs = [
    path.resolve(PROJECT_ROOT, process.env.CREDENTIALS_PATH ?? './credentials'),
    path.resolve(PROJECT_ROOT, path.dirname(process.env.DATABASE_PATH ?? './data/books.db')),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      process.stderr.write(`[OCR MCP] Created directory: ${dir}\n`);
    }
  }
}

ensureDirectories();

// Initialise the database (creates tables if not present)
try {
  getDatabase();
  process.stderr.write('[OCR MCP] Database initialised.\n');
} catch (err) {
  process.stderr.write(`[OCR MCP] Failed to initialise database: ${err}\n`);
  process.exit(1);
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
  },
  async ({ book_names, use_batch, overwrite }) => {
    try {
      const result = await transcribeBooks({ book_names, use_batch, overwrite });
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
      const { status, processedCount, summary } = await checkAndProcessBatch(batch_id);
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
      const result = getTranscription({ book_name, page_start, page_end, include_illustrations });
      // Include structured page data for the MCP App UI
      const book = getBookByName(book_name);
      const pages = book ? getPages(book.id, page_start, page_end) : [];
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
      const result = updatePage({ book_name, page_number, transcription });
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
      const result = tagPage({ book_name, page_number, tags });
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
    const books = getAllBooks();
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[OCR MCP] Server running on stdio transport.\n');
}

main().catch((err) => {
  process.stderr.write(`[OCR MCP] Fatal error: ${err}\n`);
  process.exit(1);
});
