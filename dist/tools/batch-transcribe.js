import { listPdfsInFolder, downloadPdf, AuthRequiredError } from '../google-drive.js';
import { getAllBooks, getInProgressBatchJobs, upsertBook, updateBookStatus, createBatchJob } from '../database.js';
import { createOcrBatch } from '../ocr.js';
export async function batchTranscribe(args) {
    const { book_names, overwrite = false, dry_run = false } = args;
    // 1. Collect Drive files + DB state in parallel
    let driveFiles;
    try {
        driveFiles = await listPdfsInFolder();
    }
    catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    if (driveFiles.length === 0) {
        return 'No PDF files found in the configured Google Drive folder.';
    }
    const [dbBooks, inProgressJobs] = await Promise.all([
        getAllBooks(),
        getInProgressBatchJobs(),
    ]);
    // Build lookup maps
    const dbByDriveId = new Map(dbBooks.map((b) => [b.drive_file_id, b]));
    // Book IDs already claimed by an in-progress batch
    const inProgressBookIds = new Set(inProgressJobs.flatMap((job) => JSON.parse(job.book_ids)));
    // 2. Determine target set
    let candidates;
    if (book_names.length > 0) {
        candidates = driveFiles.filter((f) => book_names.some((name) => f.name === name ||
            f.name.replace(/\.pdf$/i, '') === name ||
            f.name.toLowerCase() === name.toLowerCase()));
        const notFound = book_names.filter((name) => !driveFiles.some((f) => f.name === name ||
            f.name.replace(/\.pdf$/i, '') === name ||
            f.name.toLowerCase() === name.toLowerCase()));
        if (notFound.length > 0) {
            return (`The following book(s) were not found in the Drive folder:\n` +
                notFound.map((n) => `  • ${n}`).join('\n') +
                `\n\nAvailable books:\n` +
                driveFiles.map((f) => `  • ${f.name}`).join('\n'));
        }
    }
    else {
        candidates = driveFiles;
    }
    // 3. Classify each candidate
    const toQueue = [];
    const skippedComplete = [];
    const skippedInProgress = [];
    for (const file of candidates) {
        const db = dbByDriveId.get(file.id);
        // Skip if already in an active batch
        if (db && inProgressBookIds.has(db.id)) {
            skippedInProgress.push(file.name.replace(/\.pdf$/i, ''));
            continue;
        }
        // Skip if already complete (unless overwrite)
        if (!overwrite && db?.status === 'complete') {
            skippedComplete.push(file.name.replace(/\.pdf$/i, ''));
            continue;
        }
        toQueue.push(file);
    }
    // 4. Build dry-run preview
    const lines = [];
    if (dry_run) {
        if (toQueue.length === 0) {
            lines.push('No books eligible for batch transcription.');
        }
        else {
            lines.push(`${toQueue.length} book(s) would be submitted:`);
            for (const file of toQueue) {
                const db = dbByDriveId.get(file.id);
                const sizeMb = file.size
                    ? ` — ${(parseInt(file.size, 10) / 1_048_576).toFixed(1)} MB`
                    : '';
                const status = db ? ` (${db.status})` : ' (not yet transcribed)';
                lines.push(`  • ${file.name.replace(/\.pdf$/i, '')}${sizeMb}${status}`);
            }
        }
        if (skippedInProgress.length > 0) {
            lines.push(`\nAlready in an active batch (${skippedInProgress.length}):`);
            skippedInProgress.forEach((n) => lines.push(`  • ${n}`));
        }
        if (skippedComplete.length > 0) {
            lines.push(`\nAlready complete — skipped (${skippedComplete.length}):`);
            skippedComplete.forEach((n) => lines.push(`  • ${n}`));
            lines.push(`Pass overwrite: true to reprocess these.`);
        }
        if (toQueue.length > 0) {
            lines.push(`\nCall batch_transcribe again (without dry_run) to submit.`);
        }
        return lines.join('\n');
    }
    // 5. Nothing to do?
    if (toQueue.length === 0) {
        const reasons = [];
        if (skippedInProgress.length > 0)
            reasons.push(`${skippedInProgress.length} already in an active batch`);
        if (skippedComplete.length > 0)
            reasons.push(`${skippedComplete.length} already complete`);
        return `No books to submit. ${reasons.join(', ')}.`;
    }
    // 6. Download PDFs and build batch requests
    const batchRequests = [];
    const bookIds = [];
    const downloadErrors = [];
    for (const file of toQueue) {
        const title = file.name.replace(/\.pdf$/i, '');
        try {
            const book = await upsertBook(file.id, file.name, title);
            await updateBookStatus(book.id, 'transcribing');
            bookIds.push(book.id);
            process.stderr.write(`[OCR MCP] Downloading "${title}"...\n`);
            const pdfBuffer = await downloadPdf(file.id);
            batchRequests.push({ bookId: book.id, bookTitle: title, pdfBase64: pdfBuffer.toString('base64') });
        }
        catch (err) {
            if (err instanceof AuthRequiredError)
                return err.message;
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[OCR MCP] Error preparing "${title}": ${message}\n`);
            downloadErrors.push(`${title}: ${message}`);
        }
    }
    if (batchRequests.length === 0) {
        return `All downloads failed:\n${downloadErrors.map((e) => `  • ${e}`).join('\n')}`;
    }
    // 7. Submit batch
    let batchId;
    try {
        batchId = await createOcrBatch(batchRequests);
        await createBatchJob(batchId, bookIds);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error submitting batch: ${message}`;
    }
    lines.push(`Batch submitted.`, `Batch ID: ${batchId}`, ``, `Queued (${batchRequests.length}):`, ...batchRequests.map((r) => `  • ${r.bookTitle}`));
    if (skippedInProgress.length > 0) {
        lines.push(``, `Already in active batch — skipped (${skippedInProgress.length}):`, ...skippedInProgress.map((n) => `  • ${n}`));
    }
    if (skippedComplete.length > 0) {
        lines.push(``, `Already complete — skipped (${skippedComplete.length}):`, ...skippedComplete.map((n) => `  • ${n}`));
    }
    if (downloadErrors.length > 0) {
        lines.push(``, `Download errors:`, ...downloadErrors.map((e) => `  • ${e}`));
    }
    lines.push(``, `Use check_batch with batch_id="${batchId}" to poll for results.`);
    return lines.join('\n');
}
