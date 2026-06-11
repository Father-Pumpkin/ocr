import { Router } from 'express';
import { listLibrary, listTags } from '../../core/book-service.js';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from '../../core/ocr.js';
export const libraryRouter = Router();
libraryRouter.get('/library', async (_req, res) => {
    try {
        const books = await listLibrary();
        res.json({ books });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
// GET /api/tags — distinct tags across the library, for the tag picker
libraryRouter.get('/tags', async (_req, res) => {
    try {
        res.json({ tags: await listTags() });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// GET /api/models — OCR models available for (re-)transcription
libraryRouter.get('/models', (_req, res) => {
    res.json({ models: AVAILABLE_MODELS, default: DEFAULT_MODEL });
});
