/**
 * Session + access-control primitives for the web app.
 *
 * Sessions are stateless: a signed (HMAC-SHA256) token carrying the user's
 * email + expiry, stored in an httpOnly cookie. No server-side session store,
 * so it works on any host (including scale-to-zero / multi-instance).
 *
 * Auth is enforced when NODE_ENV=production, or locally when AUTH_ENABLED=1.
 *
 * There are two tiers. Any verified Google account can sign in and read; only
 * emails on the allowlist ("members") can change anything or spend API budget.
 * The token deliberately carries only the email, never the role — see
 * roleForEmail() for why.
 */
import crypto from 'node:crypto';
const SESSION_COOKIE = 'ocr_session';
const STATE_COOKIE = 'ocr_oauth_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export function isProd() {
    return process.env.NODE_ENV === 'production';
}
/** Whether the login gate is active. On in prod; opt-in locally via AUTH_ENABLED=1. */
export function authEnabled() {
    return isProd() || process.env.AUTH_ENABLED === '1';
}
function sessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (secret)
        return secret;
    if (authEnabled()) {
        throw new Error('SESSION_SECRET must be set when auth is enabled (production or AUTH_ENABLED=1).');
    }
    return 'dev-insecure-session-secret'; // local-only fallback; never used when auth is on
}
/** Public origin of the app, used to build the OAuth callback URL. No trailing slash. */
export function baseUrl() {
    return (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}
// Allowlisted accounts get write + AI access. ALLOWED_EMAILS (comma-separated)
// overrides this when set, so access can change without a code change / redeploy.
// Everyone else who signs in is a guest, not rejected.
const DEFAULT_ALLOWED_EMAILS = ['mitchellornesmith@gmail.com', 'jamesahs@umich.edu'];
export function allowedEmails() {
    const fromEnv = (process.env.ALLOWED_EMAILS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_EMAILS.map((e) => e.toLowerCase());
}
export function isEmailAllowed(email) {
    return allowedEmails().includes(email.trim().toLowerCase());
}
/**
 * The tier an email belongs to *right now*. Called per request rather than
 * stored in the session token: tokens live for seven days, so a baked-in role
 * would keep a removed account privileged for up to a week. Deriving it means
 * editing ALLOWED_EMAILS takes effect on the very next request.
 */
export function roleForEmail(email) {
    return isEmailAllowed(email) ? 'member' : 'guest';
}
// --- Token sign / verify ---------------------------------------------------
function b64url(input) {
    return Buffer.from(input).toString('base64url');
}
function sign(data, secret) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
export function createSessionToken(email, ttlMs = SESSION_TTL_MS) {
    const secret = sessionSecret();
    const payload = b64url(JSON.stringify({ email, exp: Date.now() + ttlMs }));
    return `${payload}.${sign(payload, secret)}`;
}
export function verifySessionToken(token) {
    const secret = sessionSecret();
    const dot = token.lastIndexOf('.');
    if (dot <= 0)
        return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = sign(payload, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return null;
    try {
        const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof obj?.email !== 'string' || typeof obj?.exp !== 'number')
            return null;
        if (Date.now() > obj.exp)
            return null;
        return { email: obj.email };
    }
    catch {
        return null;
    }
}
// --- Cookies ---------------------------------------------------------------
export function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header)
        return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1)
            continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}
function buildCookie(name, value, maxAgeSec) {
    const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (isProd())
        attrs.push('Secure');
    return attrs.join('; ');
}
export function sessionCookie(token) {
    return buildCookie(SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
}
export function clearSessionCookie() {
    return buildCookie(SESSION_COOKIE, '', 0);
}
export function stateCookie(state) {
    return buildCookie(STATE_COOKIE, state, 600); // 10 minutes
}
export function clearStateCookie() {
    return buildCookie(STATE_COOKIE, '', 0);
}
export { SESSION_COOKIE, STATE_COOKIE };
