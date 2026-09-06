import { authEnabled, readCookie, verifySessionToken, roleForEmail, SESSION_COOKIE, } from '../session.js';
/** Resolve the caller from the session cookie, or null if there isn't a valid one. */
function currentUser(req) {
    if (!authEnabled()) {
        const email = process.env.APP_USER_ID || 'local@dev';
        return { email, role: 'member' };
    }
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? verifySessionToken(token) : null;
    if (!session)
        return null;
    return { email: session.email, role: roleForEmail(session.email) };
}
/** Requires a signed-in user of any tier. */
export function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) {
        res.status(401).json({ error: 'Authentication required', authRequired: true });
        return;
    }
    req.user = user;
    next();
}
/**
 * Requires an allowlisted user. Mount AFTER requireAuth on the routes that
 * write, spend, or touch Drive. Returns 403 with `memberRequired` so the client
 * can tell "you need to sign in" apart from "your account can't do this".
 */
export function requireMember(req, res, next) {
    const user = req.user ?? currentUser(req);
    if (!user) {
        res.status(401).json({ error: 'Authentication required', authRequired: true });
        return;
    }
    req.user = user;
    if (user.role !== 'member') {
        res.status(403).json({
            error: 'This action is limited to approved accounts. You can browse the library and build comparisons from ' +
                'the pre-computed scores, but editing and running new analyses are restricted.',
            memberRequired: true,
        });
        return;
    }
    next();
}
