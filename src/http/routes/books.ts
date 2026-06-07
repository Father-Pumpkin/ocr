import { Router, type Request, type Response } from 'express';
import {
  getBookPagesData,
  getPageImageData,
  updatePageText,
  setPageTagsData,
  retranscribePageData,
  insertPageData,
  deletePageData,
  NotFoundError,
  AuthRequiredError,
} from '../../core/book-service.js';

export const booksRouter = Router();

/** Maps thrown errors to HTTP responses consistently across routes. */
function handleError(err: unknown, res: Response): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof AuthRequiredError) {
    res.status(401).json({ error: err.message, authRequired: true });
  } else {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

/** Express 5 types route params as string | string[]; collapse to a string. */
function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function bookName(req: Request): string {
  return str(req.params.name);
}

function pageNum(req: Request): number {
  return Number.parseInt(str(req.params.n), 10);
}

// GET /api/books/:name/pages — book row + all its pages
booksRouter.get('/books/:name/pages', async (req, res) => {
  try {
    const { book, pages } = await getBookPagesData(bookName(req));
    if (!book) throw new NotFoundError(`Book not found: "${bookName(req)}"`);
    res.json({ book, pages });
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/books/:name/pages/:n/image — raw JPEG bytes (404 if no scan)
booksRouter.get('/books/:name/pages/:n/image', async (req, res) => {
  try {
    const { imageData } = await getPageImageData(bookName(req), pageNum(req));
    if (!imageData) {
      res.status(404).json({ error: 'No image for this page.' });
      return;
    }
    const buf = Buffer.from(imageData, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  } catch (err) {
    handleError(err, res);
  }
});

// PATCH /api/books/:name/pages/:n — update transcription and/or tags
booksRouter.patch('/books/:name/pages/:n', async (req, res) => {
  try {
    const { transcription, tags } = req.body ?? {};
    if (transcription === undefined && tags === undefined) {
      res.status(400).json({ error: 'Provide transcription and/or tags.' });
      return;
    }
    let page;
    if (transcription !== undefined) {
      page = await updatePageText(bookName(req), pageNum(req), String(transcription));
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        res.status(400).json({ error: 'tags must be an array of strings.' });
        return;
      }
      page = await setPageTagsData(bookName(req), pageNum(req), tags.map(String));
    }
    res.json({ page });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/books/:name/pages/:n/retranscribe — re-run OCR on one page
booksRouter.post('/books/:name/pages/:n/retranscribe', async (req, res) => {
  try {
    const model = req.body?.model as string | undefined;
    const page = await retranscribePageData(bookName(req), pageNum(req), model);
    res.json({ page });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/books/:name/pages — insert a blank page after { afterPageNumber }
booksRouter.post('/books/:name/pages', async (req, res) => {
  try {
    const after = Number.parseInt(String(req.body?.afterPageNumber ?? ''), 10);
    if (Number.isNaN(after)) {
      res.status(400).json({ error: 'afterPageNumber (integer ≥ 0) is required.' });
      return;
    }
    const page = await insertPageData(bookName(req), after);
    res.status(201).json({ page });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/books/:name/pages/:n — delete a page and renumber
booksRouter.delete('/books/:name/pages/:n', async (req, res) => {
  try {
    await deletePageData(bookName(req), pageNum(req));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});
