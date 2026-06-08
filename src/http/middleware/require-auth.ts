/**
 * Express middleware that gates every API route behind a valid session.
 *
 * When auth is disabled (local dev without AUTH_ENABLED=1) it transparently
 * attaches a local identity so the existing dev workflow is unchanged. When
 * enabled, requests without a valid session cookie get a 401 with
 * `authRequired: true`, which the frontend uses to show the sign-in screen.
 */
import type { Request, Response, NextFunction } from 'express';
import { authEnabled, readCookie, verifySessionToken, SESSION_COOKIE } from '../session.js';

export interface AuthedRequest extends Request {
  user?: { email: string };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) {
    (req as AuthedRequest).user = { email: process.env.APP_USER_ID || 'local@dev' };
    next();
    return;
  }

  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? verifySessionToken(token) : null;
  if (!session) {
    res.status(401).json({ error: 'Authentication required', authRequired: true });
    return;
  }

  (req as AuthedRequest).user = { email: session.email };
  next();
}
