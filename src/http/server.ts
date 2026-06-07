import express, { type Express } from 'express';
import { libraryRouter } from './routes/library.js';
import { booksRouter } from './routes/books.js';

/**
 * Starts the local HTTP API server that the web app (and any future CLI
 * consumer) calls. Routes are mounted under /api and delegate to the shared
 * book-service facade — same business logic the MCP server uses.
 */
export async function createHttpServer(port: number): Promise<Express> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', libraryRouter);
  app.use('/api', booksRouter);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.on('error', reject);
  });

  process.stderr.write(`[OCR HTTP] Listening on http://localhost:${port}\n`);
  return app;
}
