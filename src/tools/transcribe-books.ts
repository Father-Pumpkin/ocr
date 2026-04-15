import { listPdfsInFolder, downloadPdf, AuthRequiredError, type DriveFile } from '../google-drive.js';
import {
  upsertBook,
  updateBookStatus,
  createBatchJob,
} from '../database.js';
import {
  transcribeBookPdf,
  createOcrBatch,
  type BatchBookRequest,
} from '../ocr.js';

interface TranscribeBooksArgs {
  book_names: string[];  // empty = all books
  use_batch?: boolean;
  overwrite?: boolean;
  model?: string;
}

export async function transcribeBooks(args: TranscribeBooksArgs): Promise<string> {
  const { book_names, use_batch = false, overwrite = false, model } = args;

  // 1. Fetch the file list from Drive
  let driveFiles: DriveFile[];
  try {
    driveFiles = await listPdfsInFolder();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (driveFiles.length === 0) {
    return 'No PDF files found in the configured Google Drive folder.';
  }

  // 2. Filter to requested books (or all if none specified)
  let targets: DriveFile[];
  if (book_names.length === 0) {
    targets = driveFiles;
  } else {
    targets = driveFiles.filter((f) =>
      book_names.some(
        (name) =>
          f.name === name ||
          f.name.replace(/\.pdf$/i, '') === name ||
          f.name.toLowerCase() === name.toLowerCase()
      )
    );

    const notFound = book_names.filter(
      (name) =>
        !driveFiles.some(
          (f) =>
            f.name === name ||
            f.name.replace(/\.pdf$/i, '') === name ||
            f.name.toLowerCase() === name.toLowerCase()
        )
    );

    if (notFound.length > 0) {
      return (
        `The following book(s) were not found in the Drive folder:\n` +
        notFound.map((n) => `  • ${n}`).join('\n') +
        `\n\nAvailable books:\n` +
        driveFiles.map((f) => `  • ${f.name}`).join('\n')
      );
    }
  }

  if (targets.length === 0) {
    return 'No matching books found.';
  }

  // 3. Single-request mode
  if (!use_batch) {
    const results: string[] = [];

    for (const file of targets) {
      const title = file.name.replace(/\.pdf$/i, '');
      process.stderr.write(`[OCR MCP] Processing "${title}"...\n`);

      try {
        const book = await upsertBook(file.id, file.name, title);

        process.stderr.write(`[OCR MCP] Downloading PDF from Drive...\n`);
        const pdfBuffer = await downloadPdf(file.id);

        const { transcribed, skipped, pageCount } = await transcribeBookPdf(
          book.id,
          title,
          pdfBuffer,
          overwrite,
          model
        );

        results.push(
          `✓ "${title}": ${pageCount} page(s) found, ${transcribed} transcribed, ${skipped} skipped.`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push(`✗ "${title}": Error — ${message}`);
        process.stderr.write(`[OCR MCP] Error processing "${title}": ${message}\n`);
      }
    }

    return results.join('\n');
  }

  // 4. Batch API mode
  process.stderr.write(`[OCR MCP] Preparing batch requests for ${targets.length} book(s)...\n`);

  const batchRequests: BatchBookRequest[] = [];
  const bookIds: number[] = [];

  for (const file of targets) {
    const title = file.name.replace(/\.pdf$/i, '');

    try {
      const book = await upsertBook(file.id, file.name, title);
      bookIds.push(book.id);
      await updateBookStatus(book.id, 'transcribing');

      process.stderr.write(`[OCR MCP] Downloading "${title}"...\n`);
      const pdfBuffer = await downloadPdf(file.id);
      const pdfBase64 = pdfBuffer.toString('base64');

      batchRequests.push({ bookId: book.id, bookTitle: title, pdfBase64 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[OCR MCP] Error preparing "${title}": ${message}\n`);
    }
  }

  if (batchRequests.length === 0) {
    return 'No books to submit for batch transcription.';
  }

  try {
    const batchId = await createOcrBatch(batchRequests, model);
    await createBatchJob(batchId, bookIds);

    return (
      `Batch created successfully!\n` +
      `Batch ID: ${batchId}\n` +
      `Books submitted: ${batchRequests.length}\n` +
      `Books: ${targets.map((f) => f.name).join(', ')}\n\n` +
      `Use check_batch with batch_id="${batchId}" to poll status and retrieve results.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error creating batch: ${message}`;
  }
}
