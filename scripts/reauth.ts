#!/usr/bin/env node
/**
 * Re-authenticate Google Drive.
 *
 * Clears any stored (stale) token, then runs the browser OAuth flow and
 * confirms Drive access. Useful when the refresh token has been revoked or
 * expired ("unauthorized_client" on refresh).
 *
 *   npm run reauth
 *
 * Honours the same env as the server (.env + CREDENTIALS_PATH).
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const cp = process.env.CREDENTIALS_PATH;
if (cp && !path.isAbsolute(cp)) process.env.CREDENTIALS_PATH = path.resolve(process.cwd(), cp);

const { clearAuth, authenticate, listPdfsInFolder } = await import('../src/core/google-drive.js');

async function main(): Promise<void> {
  process.stderr.write('[reauth] Clearing any stored token...\n');
  clearAuth();

  process.stderr.write('[reauth] Opening browser for Google authorization...\n');
  await authenticate();

  const files = await listPdfsInFolder();
  process.stderr.write(`[reauth] ✓ Drive connected. ${files.length} PDF(s) visible in the folder.\n`);
}

main().catch((err) => {
  process.stderr.write(`[reauth] ✗ Failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
