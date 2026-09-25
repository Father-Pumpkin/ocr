import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import qs from 'qs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { libraryRouter } from './routes/library.js';
import { booksRouter } from './routes/books.js';
import { analysisRouter } from './routes/analysis.js';
import { authRouter } from './routes/auth.js';
import { loginRouter } from './routes/login.js';
import { requireAuth, type AuthedRequest } from './middleware/require-auth.js';
import { LIMITS } from './middleware/rate-limit.js';
import { basePath, isProd } from './session.js';
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

export async function createHttpServer(port: number): Promise<Express> {
  const app = express();
  app.disable('x-powered-by');

  // Behind Render's proxy, req.ip is the proxy unless we say how many hops to
  // trust. The IP-keyed login limiter is meaningless without this. Trust exactly
  // one hop rather than `true`, which would let a client forge X-Forwarded-For.
  // Mounted behind another site's proxy (see DEPLOY.md) there is one more hop,
  // and trusting too few would lump every visitor under the proxy's IP:
  // TRUST_PROXY_HOPS sets the count.
  if (isProd()) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // Express's default query parser is qs with arrayLimit: 20 — past twenty
  // repeats of the same key it stops building an array and returns an object
  // keyed by index instead. Every list-valued filter here (?books=…&books=…,
  // methods, tags, dimensions, sections) then stringified to "[object Object]",
  // matched nothing, and returned an empty result with a 200. Selecting 21 of
  // the 72 books was enough to trigger it, silently.
  app.set('query parser', (str: string) => qs.parse(str, { arrayLimit: 5000 }));

  app.use(express.json({ limit: '50mb' }));

  // Everything is mounted under the base path ('' at a domain root, e.g.
  // '/projects/feeling-narrative' behind another site). Routes inside see paths
  // relative to it, so nothing below needs to know where it's mounted.
  const base = basePath();
  const site = express.Router();

  // --- Public routes (no session required) ---
  site.get('/api/health', (_req, res) => res.json({ ok: true }));
  // Keyed by IP: there is no session yet on the way in.
  site.use('/api/auth', LIMITS.LOGIN, loginRouter); // /google/login, /google/callback, /logout

  // --- Gate: everything below requires a valid session (guest or member) ---
  site.use('/api', requireAuth);
  // After requireAuth, so the limiter can key on the session rather than an IP
  // shared by a whole institution. Individual routes add tighter limits on top.
  site.use('/api', LIMITS.READS);
  site.get('/api/me', (req, res) => {
    const user = (req as AuthedRequest).user;
    res.json({ email: user?.email ?? null, role: user?.role ?? 'guest' });
  });
  // NB: `site.use('/api', requireMember, authRouter)` would apply requireMember to
  // every /api request, not just this router's — Express treats the path as a
  // prefix for the whole chain. The Drive routes gate themselves instead.
  site.use('/api', authRouter);
  site.use('/api', libraryRouter);
  site.use('/api', booksRouter);
  site.use('/api', analysisRouter);

  // --- Serve the built web app (prod, or any time a build is present) ---
  if (isProd() || fs.existsSync(APP_DIST)) {
    // index.html is served with its <base href> set to the mount point: the
    // build uses relative asset URLs and the client reads its router basename
    // from document.baseURI, so this one line is what places the app.
    const sendIndex = (_req: Request, res: Response) => {
      const html = fs
        .readFileSync(path.join(APP_DIST, 'index.html'), 'utf8')
        .replace('<base href="/" />', `<base href="${base}/" />`);
      res.type('html').setHeader('Cache-Control', 'no-cache').send(html);
    };
    site.get('/', sendIndex);
    site.use(express.static(APP_DIST, { index: false }));
    site.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) return next();
      sendIndex(req, res);
    });
  }

  if (base) {
    app.use(base, site);
    // Hitting the service's own origin directly lands on the app.
    app.get('/', (_req, res) => res.redirect(`${base}/`));
  } else {
    app.use(site);
  }

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.on('error', reject);
  });

  process.stderr.write(`[OCR HTTP] Listening on http://localhost:${port}${base}/\n`);

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
async function seedLexicons(): Promise<void> {
  try {
    const outcomes = await seedLexiconsFromDisk();
    const imported = outcomes.filter((o) => o.status === 'imported');
    const failed = outcomes.filter((o) => o.status === 'failed');
    if (imported.length) {
      process.stderr.write(
        `[OCR HTTP] Seeded ${imported.length} lexicon file(s): ` +
          imported.map((o) => `${o.lexicon}/${o.file} (${o.terms} terms)`).join(', ') + '\n',
      );
    }
    for (const f of failed) {
      process.stderr.write(`[OCR HTTP] Could not seed ${f.file}: ${f.reason}\n`);
    }
  } catch (err) {
    process.stderr.write(`[OCR HTTP] Lexicon seeding failed: ${err}\n`);
  }
}

// Batches take roughly an hour, so checking every few minutes is plenty; the
// point is that results land without anyone having to press a button.
const BATCH_POLL_MS = 5 * 60 * 1000;

function startBatchPoller(): void {
  const tick = async (): Promise<void> => {
    try {
      const done = (await processPendingSentimentBatches()).filter((r) => r.processedCount > 0);
      for (const r of done) {
        process.stderr.write(`[OCR HTTP] Sentiment batch ${r.batchId}: stored ${r.processedCount} score(s).\n`);
      }
    } catch (err) {
      process.stderr.write(`[OCR HTTP] Batch poll failed: ${err}\n`);
    }
  };
  // unref so a pending timer never keeps the process alive on shutdown.
  const timer = setInterval(() => void tick(), BATCH_POLL_MS);
  timer.unref?.();
  void tick();
}
