import { google, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import express from 'express';
import open from 'open';
import path from 'path';
import fs from 'fs';
import http from 'http';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function getTokenPath(): string {
  const credDir = path.resolve(
    process.cwd(),
    process.env.CREDENTIALS_PATH ?? './credentials'
  );
  if (!fs.existsSync(credDir)) {
    fs.mkdirSync(credDir, { recursive: true });
  }
  return path.join(credDir, 'oauth-token.json');
}

function createOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/oauth/callback';

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in your .env file.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function runLocalOAuthServer(oAuth2Client: OAuth2Client): Promise<void> {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/oauth/callback';
  const url = new URL(redirectUri);
  const port = parseInt(url.port || '3000', 10);

  return new Promise((resolve, reject) => {
    const app = express();
    let server: http.Server;

    app.get('/oauth/callback', async (req, res) => {
      const code = req.query.code as string | undefined;
      if (!code) {
        res.status(400).send('No authorization code received.');
        server.close();
        reject(new Error('No authorization code received from Google.'));
        return;
      }

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Persist token
        fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));

        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem;">
            <h2>Authorization successful!</h2>
            <p>You can close this window and return to Claude Desktop.</p>
          </body></html>
        `);
        server.close();
        resolve();
      } catch (err) {
        res.status(500).send('Failed to exchange authorization code.');
        server.close();
        reject(err);
      }
    });

    server = app.listen(port, () => {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });

      process.stderr.write(`\n[OCR MCP] Opening browser for Google OAuth authorization...\n`);
      process.stderr.write(`[OCR MCP] If your browser does not open, visit:\n  ${authUrl}\n\n`);

      open(authUrl).catch(() => {
        process.stderr.write(`[OCR MCP] Could not open browser automatically. Please visit the URL above.\n`);
      });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}

let authenticatedClient: OAuth2Client | null = null;

export async function authenticate(): Promise<OAuth2Client> {
  if (authenticatedClient) return authenticatedClient;

  const oAuth2Client = createOAuth2Client();
  const tokenPath = getTokenPath();

  if (fs.existsSync(tokenPath)) {
    try {
      const raw = fs.readFileSync(tokenPath, 'utf-8');
      const tokens = JSON.parse(raw);
      oAuth2Client.setCredentials(tokens);

      // Refresh if the access token is expired or close to expiry
      if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60_000) {
        process.stderr.write('[OCR MCP] Refreshing expired Google OAuth token...\n');
        const { credentials } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(credentials);
        fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));
      }

      authenticatedClient = oAuth2Client;
      return authenticatedClient;
    } catch (err) {
      process.stderr.write(`[OCR MCP] Stored token invalid, re-authenticating: ${err}\n`);
    }
  }

  // First-time (or invalid token) — run the OAuth flow
  await runLocalOAuthServer(oAuth2Client);
  authenticatedClient = oAuth2Client;
  return authenticatedClient;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

export async function listPdfsInFolder(): Promise<DriveFile[]> {
  const auth = await authenticate();
  const drive = google.drive({ version: 'v3', auth });

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID must be set in your .env file.');
  }

  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const data = response.data as drive_v3.Schema$FileList;
    if (data.files) {
      for (const f of data.files) {
        files.push({
          id: f.id!,
          name: f.name!,
          mimeType: f.mimeType!,
          size: f.size ?? undefined,
        });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function downloadPdf(fileId: string): Promise<Buffer> {
  const auth = await authenticate();
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(response.data as ArrayBuffer);
}
