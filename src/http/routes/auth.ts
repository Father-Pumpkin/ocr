import { Router } from 'express';
import { getDriveAuthStatus, startDriveConnect, clearAuth } from '../../core/book-service.js';

export const authRouter = Router();

// GET /api/auth/drive/status — non-blocking; never opens a browser
authRouter.get('/auth/drive/status', async (_req, res) => {
  try {
    const status = await getDriveAuthStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/auth/drive/connect — kicks off the browser OAuth flow in the
// background and returns immediately. Poll /status to observe completion.
authRouter.post('/auth/drive/connect', (_req, res) => {
  try {
    const { started } = startDriveConnect();
    res.json({ started });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/auth/drive/disconnect — clears the stored token
authRouter.post('/auth/drive/disconnect', (_req, res) => {
  try {
    clearAuth();
    res.json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
