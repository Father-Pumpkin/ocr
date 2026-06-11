import { google } from 'googleapis';
import express from 'express';
import open from 'open';
import path from 'path';
import fs from 'fs';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
/**
 * Thrown when Google Drive access requires (re-)authorization.
 * Tools should catch this and return the message as a normal (non-error)
 * response so Claude relays the instructions to the user verbatim.
 */
export class AuthRequiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthRequiredError';
    }
}
// ---------------------------------------------------------------------------
// Credential paths
// ---------------------------------------------------------------------------
function getCredDir() {
    const credDir = path.resolve(process.cwd(), process.env.CREDENTIALS_PATH ?? './credentials');
    if (!fs.existsSync(credDir))
        fs.mkdirSync(credDir, { recursive: true });
    return credDir;
}
function getTokenPath() {
    return path.join(getCredDir(), 'oauth-token.json');
}
// ---------------------------------------------------------------------------
// OAuth2 client
// ---------------------------------------------------------------------------
function getRedirectUri() {
    return process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/oauth/callback';
}
function createOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in your .env file.');
    }
    return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}
/**
 * Reads a Drive OAuth token from the GOOGLE_DRIVE_TOKEN env var (hosted deploys
 * where the browser flow + token file aren't available). Returns null if unset
 * or invalid so callers fall back to the local token file.
 */
function readEnvToken() {
    const raw = process.env.GOOGLE_DRIVE_TOKEN;
    if (!raw || !raw.trim())
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        process.stderr.write('[OCR MCP] GOOGLE_DRIVE_TOKEN is set but not valid JSON; ignoring.\n');
        return null;
    }
}
// ---------------------------------------------------------------------------
// Local OAuth callback server
// ---------------------------------------------------------------------------
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
async function runLocalOAuthServer(oAuth2Client) {
    const url = new URL(getRedirectUri());
    const port = parseInt(url.port || '3000', 10);
    return new Promise((resolve, reject) => {
        const app = express();
        let server;
        let settled = false;
        function finish(err) {
            if (settled)
                return;
            settled = true;
            server.close();
            if (err)
                reject(err);
            else
                resolve();
        }
        const timeout = setTimeout(() => {
            finish(new Error('Google OAuth timed out after 3 minutes. Use the clear_auth tool to reset and try again.'));
        }, OAUTH_TIMEOUT_MS);
        app.get('/oauth/callback', async (req, res) => {
            const code = req.query.code;
            if (!code) {
                res.status(400).send('No authorization code received.');
                clearTimeout(timeout);
                finish(new Error('No authorization code received from Google.'));
                return;
            }
            try {
                const { tokens } = await oAuth2Client.getToken(code);
                oAuth2Client.setCredentials(tokens);
                fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
                res.send(`
          <html><body style="font-family:sans-serif;padding:2rem;">
            <h2>Authorization successful!</h2>
            <p>You can close this window and return to Claude Desktop.</p>
          </body></html>
        `);
                clearTimeout(timeout);
                finish();
            }
            catch (err) {
                res.status(500).send('Failed to exchange authorization code.');
                clearTimeout(timeout);
                finish(err instanceof Error ? err : new Error(String(err)));
            }
        });
        server = app.listen(port, () => {
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'select_account', // always show account picker
            });
            process.stderr.write(`\n[OCR MCP] Opening browser for Google OAuth...\n`);
            process.stderr.write(`[OCR MCP] If browser doesn't open, visit:\n  ${authUrl}\n\n`);
            open(authUrl).catch(() => {
                process.stderr.write(`[OCR MCP] Could not open browser automatically.\n`);
            });
        });
        server.on('error', (err) => {
            clearTimeout(timeout);
            finish(new Error(`Failed to start OAuth callback server on port ${port}: ${err.message}`));
        });
    });
}
// ---------------------------------------------------------------------------
// Public auth interface
// ---------------------------------------------------------------------------
let authenticatedClient = null;
// Tracks an in-progress interactive connect (browser OAuth) so the web UI can
// poll status without launching duplicate flows.
let connectInFlight = null;
let lastConnectError = null;
/**
 * Clears the stored OAuth token and resets the in-memory client, forcing
 * re-authentication on the next Drive call. Use the clear_auth MCP tool.
 */
export function clearAuth() {
    authenticatedClient = null;
    const tokenPath = getTokenPath();
    if (fs.existsSync(tokenPath))
        fs.unlinkSync(tokenPath);
}
export async function authenticate(opts = {}) {
    const interactive = opts.interactive ?? true;
    if (authenticatedClient)
        return authenticatedClient;
    // Hosted deploys: use a token provided via env. The OAuth2 client refreshes
    // the access token automatically using the refresh_token in the stored JSON.
    const envTok = readEnvToken();
    if (envTok) {
        const client = createOAuth2Client();
        client.setCredentials(envTok);
        authenticatedClient = client;
        return authenticatedClient;
    }
    const oAuth2Client = createOAuth2Client();
    const tokenPath = getTokenPath();
    if (fs.existsSync(tokenPath)) {
        try {
            const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
            oAuth2Client.setCredentials(tokens);
            if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60_000) {
                process.stderr.write('[OCR MCP] Refreshing expired Google OAuth token...\n');
                const { credentials } = await oAuth2Client.refreshAccessToken();
                oAuth2Client.setCredentials(credentials);
                fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));
            }
            authenticatedClient = oAuth2Client;
            return authenticatedClient;
        }
        catch (err) {
            // Token present but unusable (e.g. refresh token revoked). In
            // non-interactive mode (web status/library) never open a browser —
            // surface it so the UI can prompt for an explicit reconnect.
            if (!interactive) {
                throw new AuthRequiredError(`Google Drive token is invalid or expired: ${err instanceof Error ? err.message : String(err)}`);
            }
            process.stderr.write(`[OCR MCP] Stored token invalid, re-authenticating: ${err}\n`);
            fs.unlinkSync(tokenPath);
        }
    }
    else if (!interactive) {
        throw new AuthRequiredError('Google Drive is not connected.');
    }
    // No valid token — run the browser OAuth flow (interactive callers only)
    try {
        await runLocalOAuthServer(oAuth2Client);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AuthRequiredError(`Google authorization failed or timed out: ${message}`);
    }
    authenticatedClient = oAuth2Client;
    return authenticatedClient;
}
/**
 * Starts an interactive Drive connect (browser OAuth) in the background without
 * blocking the caller. The web UI calls this, then polls getDriveAuthStatus().
 * Returns { started: false } if a connect is already in flight.
 */
export function startDriveConnect() {
    if (process.env.NODE_ENV === 'production') {
        lastConnectError =
            'In the hosted app, connect Drive by setting the GOOGLE_DRIVE_TOKEN secret — the browser flow only runs locally.';
        return { started: false };
    }
    if (connectInFlight)
        return { started: false };
    lastConnectError = null;
    clearAuth(); // force a fresh login + account picker
    connectInFlight = authenticate({ interactive: true })
        .then(() => undefined)
        .catch((err) => {
        lastConnectError = err instanceof Error ? err.message : String(err);
    })
        .finally(() => {
        connectInFlight = null;
    });
    return { started: true };
}
/**
 * Non-interactive Drive auth status for the web UI. Never opens a browser.
 */
export async function getDriveAuthStatus() {
    // The interactive browser OAuth flow only works locally; the hosted app
    // connects Drive via the GOOGLE_DRIVE_TOKEN secret instead, so the UI
    // shouldn't show a (non-functional) Connect button there.
    const connectable = process.env.NODE_ENV !== 'production';
    if (connectInFlight)
        return { connected: false, connecting: true, connectable };
    try {
        await authenticate({ interactive: false });
        return { connected: true, connecting: false, connectable };
    }
    catch (err) {
        return {
            connected: false,
            connecting: false,
            connectable,
            reason: lastConnectError ?? (err instanceof Error ? err.message : String(err)),
        };
    }
}
export async function listPdfsInFolder(opts = {}) {
    const auth = await authenticate(opts);
    const drive = google.drive({ version: 'v3', auth });
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
        throw new Error('GOOGLE_DRIVE_FOLDER_ID must be set in your .env file.');
    }
    const files = [];
    let pageToken;
    do {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size)',
            pageSize: 100,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        const data = response.data;
        if (data.files) {
            for (const f of data.files) {
                files.push({
                    id: f.id,
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size ?? undefined,
                });
            }
        }
        pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return files.sort((a, b) => a.name.localeCompare(b.name));
}
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes per file
export async function downloadPdf(fileId, opts = {}) {
    const auth = await authenticate(opts);
    const drive = google.drive({ version: 'v3', auth });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Download timed out after 2 minutes (file: ${fileId})`)), DOWNLOAD_TIMEOUT_MS));
    const download = drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    const response = await Promise.race([download, timeout]);
    return Buffer.from(response.data);
}
