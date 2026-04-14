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
export async function authenticate() {
    if (authenticatedClient)
        return authenticatedClient;
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
            process.stderr.write(`[OCR MCP] Stored token invalid, re-authenticating: ${err}\n`);
            fs.unlinkSync(tokenPath);
        }
    }
    // No valid token — run the browser OAuth flow
    try {
        await runLocalOAuthServer(oAuth2Client);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AuthRequiredError(`Google authorization failed or timed out: ${message}\n\n` +
            `Run the clear_auth tool and try again to start a fresh login.`);
    }
    authenticatedClient = oAuth2Client;
    return authenticatedClient;
}
export async function listPdfsInFolder() {
    const auth = await authenticate();
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
export async function downloadPdf(fileId) {
    const auth = await authenticate();
    const drive = google.drive({ version: 'v3', auth });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Download timed out after 2 minutes (file: ${fileId})`)), DOWNLOAD_TIMEOUT_MS));
    const download = drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    const response = await Promise.race([download, timeout]);
    return Buffer.from(response.data);
}
