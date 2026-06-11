import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { libraryRouter } from './routes/library.js';
import { booksRouter } from './routes/books.js';
import { authRouter } from './routes/auth.js';
import { loginRouter } from './routes/login.js';
import { requireAuth } from './middleware/require-auth.js';
import { isProd } from './session.js';
/**
 * Starts the HTTP API server that the web app calls. Routes under /api delegate
 * to the shared book-service facade — the same business logic the MCP server
 * uses. Login routes are public; everything else under /api is gated behind a
 * valid session (see middleware/require-auth). In production the server also
 * serves the built web app (app/dist) with SPA fallback.
 */
// Built web app lives at <root>/app/dist; this file runs from <root>/dist/http.
const APP_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'dist');
export async function createHttpServer(port) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '50mb' }));
    // --- Public routes (no session required) ---
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.use('/api/auth', loginRouter); // /google/login, /google/callback, /logout
    // --- Gate: everything below requires a valid session ---
    app.use('/api', requireAuth);
    app.get('/api/me', (req, res) => res.json({ email: req.user?.email ?? null }));
    app.use('/api', authRouter); // Drive status/connect/disconnect
    app.use('/api', libraryRouter);
    app.use('/api', booksRouter);
    // --- Serve the built web app (prod, or any time a build is present) ---
    if (isProd() || fs.existsSync(APP_DIST)) {
        app.use(express.static(APP_DIST));
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api'))
                return next();
            res.sendFile(path.join(APP_DIST, 'index.html'));
        });
    }
    await new Promise((resolve, reject) => {
        const server = app.listen(port, () => resolve());
        server.on('error', reject);
    });
    process.stderr.write(`[OCR HTTP] Listening on http://localhost:${port}\n`);
    return app;
}
