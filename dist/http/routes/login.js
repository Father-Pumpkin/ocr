/**
 * "Sign in with Google" login flow. Reuses the same Google OAuth client as
 * Drive (GOOGLE_CLIENT_ID/SECRET) but with login scopes and its own redirect
 * URI. On success, only emails in ALLOWED_EMAILS get a session cookie.
 *
 * Mounted at /api/auth (BEFORE the requireAuth gate) so these routes stay public:
 *   GET  /api/auth/google/login     -> redirect to Google consent
 *   GET  /api/auth/google/callback  -> exchange code, allowlist check, set session
 *   POST /api/auth/logout           -> clear session
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { baseUrl, isEmailAllowed, createSessionToken, sessionCookie, clearSessionCookie, stateCookie, clearStateCookie, readCookie, STATE_COOKIE, } from '../session.js';
export const loginRouter = Router();
function loginRedirectUri() {
    return `${baseUrl()}/api/auth/google/callback`;
}
function loginClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for login.');
    }
    return new google.auth.OAuth2(clientId, clientSecret, loginRedirectUri());
}
// GET /api/auth/google/login
loginRouter.get('/google/login', (_req, res) => {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        const url = loginClient().generateAuthUrl({
            scope: ['openid', 'email', 'profile'],
            state,
            prompt: 'select_account',
        });
        res.setHeader('Set-Cookie', stateCookie(state));
        res.redirect(url);
    }
    catch (err) {
        res.status(500).send(errorPage('Login is not configured on the server.', err));
    }
});
// GET /api/auth/google/callback
loginRouter.get('/google/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const expected = readCookie(req, STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) {
        res.status(400).send(errorPage('Sign-in failed: the request was invalid or expired. Please try again.'));
        return;
    }
    try {
        const client = loginClient();
        const { tokens } = await client.getToken(code);
        if (!tokens.id_token)
            throw new Error('Google did not return an ID token.');
        const ticket = await client.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const email = payload?.email;
        if (!email || !payload?.email_verified) {
            res.setHeader('Set-Cookie', clearStateCookie());
            res.status(403).send(errorPage('Your Google account did not return a verified email address.'));
            return;
        }
        if (!isEmailAllowed(email)) {
            res.setHeader('Set-Cookie', clearStateCookie());
            res.status(403).send(errorPage(`${email} is not on the allowlist for this app.`));
            return;
        }
        res.setHeader('Set-Cookie', [sessionCookie(createSessionToken(email)), clearStateCookie()]);
        res.redirect('/');
    }
    catch (err) {
        res.status(500).send(errorPage('Sign-in failed while talking to Google. Please try again.', err));
    }
});
// POST /api/auth/logout
loginRouter.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
});
function errorPage(message, err) {
    const detail = err && process.env.NODE_ENV !== 'production'
        ? `<pre style="color:#991b1b;white-space:pre-wrap;font-size:.8rem">${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`
        : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>OCR Tool</title></head>
  <body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#0f172a;line-height:1.5">
    <h2 style="margin-bottom:.5rem">OCR Tool</h2>
    <p>${escapeHtml(message)}</p>${detail}
    <p style="margin-top:1.5rem"><a href="/" style="color:#2563eb;text-decoration:none">&larr; Back to sign in</a></p>
  </body></html>`;
}
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
