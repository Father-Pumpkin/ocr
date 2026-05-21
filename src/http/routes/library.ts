import { Router } from 'express';
import { listLibrary } from '../../core/book-service.js';

export const libraryRouter = Router();

libraryRouter.get('/library', async (_req, res) => {
  try {
    const books = await listLibrary();
    res.json({ books });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
