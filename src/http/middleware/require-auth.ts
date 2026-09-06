/**
 * Express middleware for the app's two access tiers.
 *
 * Any verified Google account can sign in and read the library — that's the
 * public tier. Everything that *changes* something (page edits, scoring runs,
 * dimensions, lexicons, Drive) or *spends money* (anything reaching Claude) is
 * restricted to the allowlist.
 *
 *   requireAuth   — a valid session. Guests pass.
 *   requireMember — a valid session belonging to an allowlisted email.
 *
 * The role is derived from the allowlist on every request rather than being
 * baked into the session token. Sessions last seven days, so a role stored in
 * the token would keep working for a week after someone is removed from the
 * allowlist; deriving it means a removal takes effect on the next request.
 *
 * When auth is disabled (local dev without AUTH_ENABLED=1) both middlewares
 * attach a local member identity, so the existing dev workflow is unchanged.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  authEnabled,
  readCookie,
  verifySessionToken,
  roleForEmail,
  SESSION_COOKIE,
  type Role,
} from '../session.js';

export interface AuthedRequest extends Request {
  user?: { email: string; role: Role };
}

/** Resolve the caller from the session cookie, or null if there isn't a valid one. */
function currentUser(req: Request): { email: string; role: Role } | null {
  if (!authEnabled()) {
    const email = process.env.APP_USER_ID || 'local@dev';
    return { email, role: 'member' };
  }
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? verifySessionToken(token) : null;
  if (!session) return null;
  return { email: session.email, role: roleForEmail(session.email) };
}

/** Requires a signed-in user of any tier. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required', authRequired: true });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}

/**
 * Requires an allowlisted user. Mount AFTER requireAuth on the routes that
 * write, spend, or touch Drive. Returns 403 with `memberRequired` so the client
 * can tell "you need to sign in" apart from "your account can't do this".
 */
export function requireMember(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user ?? currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required', authRequired: true });
    return;
  }
  (req as AuthedRequest).user = user;
  if (user.role !== 'member') {
    res.status(403).json({
      error:
        'This action is limited to approved accounts. You can browse the library and build comparisons from ' +
        'the pre-computed scores, but editing and running new analyses are restricted.',
      memberRequired: true,
    });
    return;
  }
  next();
}
