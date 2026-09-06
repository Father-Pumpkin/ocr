import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { libraryRouter } from './routes/library.js';
import { booksRouter } from './routes/books.js';
import { analysisRouter } from './routes/analysis.js';
import { authRouter } from './routes/auth.js';
import { loginRouter } from './routes/login.js';
import { requireAuth } from './middleware/require-auth.js';
import { LIMITS } from './middleware/rate-limit.js';
import { isProd } from './session.js';
import { processPendingSentimentBatches, seedLexiconsFromDisk } from '../core/analysis-service.js';
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
    // Behind Render's proxy, req.ip is the proxy unless we say how many hops to
    // trust. The IP-keyed login limiter is meaningless without this. Trust exactly
    // one hop rather than `true`, which would let a client forge X-Forwarded-For.
    if (isProd())
        app.set('trust proxy', 1);
    app.use(express.json({ limit: '50mb' }));
    // --- Public routes (no session required) ---
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    // Keyed by IP: there is no session yet on the way in.
    app.use('/api/auth', LIMITS.LOGIN, loginRouter); // /google/login, /google/callback, /logout
    // --- Gate: everything below requires a valid session (guest or member) ---
    app.use('/api', requireAuth);
    // After requireAuth, so the limiter can key on the session rather than an IP
    // shared by a whole institution. Individual routes add tighter limits on top.
    app.use('/api', LIMITS.READS);
    app.get('/api/me', (req, res) => {
        const user = req.user;
        res.json({ email: user?.email ?? null, role: user?.role ?? 'guest' });
    });
    // NB: `app.use('/api', requireMember, authRouter)` would apply requireMember to
    // every /api request, not just this router's — Express treats the path as a
    // prefix for the whole chain. The Drive routes gate themselves instead.
    app.use('/api', authRouter);
    app.use('/api', libraryRouter);
    app.use('/api', booksRouter);
    app.use('/api', analysisRouter);
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
    // Fire-and-forget startup work — neither should be able to stop the server
    // coming up, so both swallow their own errors.
    void seedLexicons();
    startBatchPoller();
    return app;
}
/**
 * Import any dictionary files sitting in the lexicons folder. Idempotent, so a
 * restart doesn't duplicate anything; a malformed file is reported and skipped.
 */
async function seedLexicons() {
    try {
        const outcomes = await seedLexiconsFromDisk();
        const imported = outcomes.filter((o) => o.status === 'imported');
        const failed = outcomes.filter((o) => o.status === 'failed');
        if (imported.length) {
            process.stderr.write(`[OCR HTTP] Seeded ${imported.length} lexicon file(s): ` +
                imported.map((o) => `${o.lexicon}/${o.file} (${o.terms} terms)`).join(', ') + '\n');
        }
        for (const f of failed) {
            process.stderr.write(`[OCR HTTP] Could not seed ${f.file}: ${f.reason}\n`);
        }
    }
    catch (err) {
        process.stderr.write(`[OCR HTTP] Lexicon seeding failed: ${err}\n`);
    }
}
// Batches take roughly an hour, so checking every few minutes is plenty; the
// point is that results land without anyone having to press a button.
const BATCH_POLL_MS = 5 * 60 * 1000;
function startBatchPoller() {
    const tick = async () => {
        try {
            const done = (await processPendingSentimentBatches()).filter((r) => r.processedCount > 0);
            for (const r of done) {
                process.stderr.write(`[OCR HTTP] Sentiment batch ${r.batchId}: stored ${r.processedCount} score(s).\n`);
            }
        }
        catch (err) {
            process.stderr.write(`[OCR HTTP] Batch poll failed: ${err}\n`);
        }
    };
    // unref so a pending timer never keeps the process alive on shutdown.
    const timer = setInterval(() => void tick(), BATCH_POLL_MS);
    timer.unref?.();
    void tick();
}
