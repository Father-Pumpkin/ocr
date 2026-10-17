import { Router, type Request, type Response } from 'express';
import {
  listLibrary,
  listTags,
  setBookHiddenData,
  deleteBookData,
  transcribeDriveBookData,
  uploadBookData,
  NotFoundError,
  BookConflictError,
  AuthRequiredError,
} from '../../core/book-service.js';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from '../../core/ocr.js';
import { requireMember, type AuthedRequest } from '../middleware/require-auth.js';
import { LIMITS } from '../middleware/rate-limit.js';

export const libraryRouter = Router();

const isMember = (req: Request): boolean => (req as AuthedRequest).user?.role === 'member';

function handleError(err: unknown, res: Response): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof BookConflictError) {
    res.status(409).json({ error: err.message });
  } else if (err instanceof AuthRequiredError) {
    res.status(401).json({ error: err.message, authRequired: true });
  } else {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Express 5 types route params as string | string[]; collapse to a string. */
function driveId(req: Request): string {
  const v = req.params.driveId;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

// Members see hidden books (marked, so they can unhide them); guests don't.
libraryRouter.get('/library', async (req, res) => {
  try {
    const books = await listLibrary({ includeHidden: isMember(req) });
    res.json({ books });
  } catch (err) {
    handleError(err, res);
  }
});

// Library management is keyed by drive_file_id rather than title: an
// untranscribed Drive book has no DB row (and so no stable name) yet, and an
// uploaded book carries a synthetic `upload:` id in the same column.

// POST /api/library/books/:driveId/hidden — { hidden: boolean }
libraryRouter.post('/library/books/:driveId/hidden', requireMember, async (req, res) => {
  try {
    const book = await setBookHiddenData(driveId(req), Boolean(req.body?.hidden));
    res.json({ book });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/library/books/:driveId — permanently delete a book's data
libraryRouter.delete('/library/books/:driveId', requireMember, async (req, res) => {
  try {
    res.json(await deleteBookData(driveId(req)));
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/library/books/:driveId/transcribe — batch-transcribe a Drive book
libraryRouter.post('/library/books/:driveId/transcribe', requireMember, LIMITS.SCORING, async (req, res) => {
  try {
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    res.json(await transcribeDriveBookData(driveId(req), model));
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/library/upload — { fileName, title?, pdfBase64, model? }
// JSON rather than multipart: the Batch API caps a PDF at 32 MB, which fits
// inside the app's 50 MB JSON limit once base64-encoded.
libraryRouter.post('/library/upload', requireMember, LIMITS.SCORING, async (req, res) => {
  try {
    const { fileName, title, pdfBase64, model } = req.body ?? {};
    if (typeof pdfBase64 !== 'string' || !pdfBase64) {
      res.status(400).json({ error: 'pdfBase64 (a base64 string) is required.' });
      return;
    }
    const result = await uploadBookData({
      fileName: typeof fileName === 'string' && fileName ? fileName : 'upload.pdf',
      title: typeof title === 'string' ? title : undefined,
      pdf: Buffer.from(pdfBase64, 'base64'),
      model: typeof model === 'string' ? model : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/tags — distinct tags across the library, for the tag picker
libraryRouter.get('/tags', async (_req, res) => {
  try {
    res.json({ tags: await listTags() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/models — OCR models available for (re-)transcription
libraryRouter.get('/models', (_req, res) => {
  res.json({ models: AVAILABLE_MODELS, default: DEFAULT_MODEL });
});
