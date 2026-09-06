import { Router } from 'express';
import { getDriveAuthStatus, startDriveConnect, clearAuth } from '../../core/book-service.js';
import { requireMember } from '../middleware/require-auth.js';

/**
 * Google Drive connection management. Member-only end to end: connecting
 * authorizes access to the owner's Google account, and the status tells a guest
 * nothing they need. Gated per route rather than at the mount, because
 * `app.use(path, mw, router)` would apply the middleware to every request under
 * the prefix, including the public reads mounted after it.
 */
export const authRouter = Router();

// GET /api/auth/drive/status — non-blocking; never opens a browser
authRouter.get('/auth/drive/status', requireMember, async (_req, res) => {
  try {
    const status = await getDriveAuthStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/auth/drive/connect — kicks off the browser OAuth flow in the
// background and returns immediately. Poll /status to observe completion.
authRouter.post('/auth/drive/connect', requireMember, (_req, res) => {
  try {
    const { started } = startDriveConnect();
    res.json({ started });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/auth/drive/disconnect — clears the stored token
authRouter.post('/auth/drive/disconnect', requireMember, (_req, res) => {
  try {
    clearAuth();
    res.json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
