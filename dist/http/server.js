import express from 'express';
import { libraryRouter } from './routes/library.js';
/**
 * Starts the local HTTP API server that the Electron renderer (and any future
 * web/CLI consumer) calls. Routes are mounted under /api and delegate to the
 * shared book-service facade — same business logic the MCP server uses.
 */
export async function createHttpServer(port) {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.use('/api', libraryRouter);
    await new Promise((resolve, reject) => {
        const server = app.listen(port, () => resolve());
        server.on('error', reject);
    });
    process.stderr.write(`[OCR HTTP] Listening on http://localhost:${port}\n`);
    return app;
}
