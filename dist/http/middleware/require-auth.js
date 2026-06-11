import { authEnabled, readCookie, verifySessionToken, SESSION_COOKIE } from '../session.js';
export function requireAuth(req, res, next) {
    if (!authEnabled()) {
        req.user = { email: process.env.APP_USER_ID || 'local@dev' };
        next();
        return;
    }
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? verifySessionToken(token) : null;
    if (!session) {
        res.status(401).json({ error: 'Authentication required', authRequired: true });
        return;
    }
    req.user = { email: session.email };
    next();
}
