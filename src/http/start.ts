#!/usr/bin/env node
/**
 * Standalone entry for the local HTTP backend.
 *
 * Mirrors the setup at the top of src/index.ts (env load, path resolution,
 * dir creation) so the web app's backend gets the same configuration as the
 * MCP server. Runs the Express server in the foreground; Ctrl+C to stop.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
  const val = process.env[key];
  if (val && !path.isAbsolute(val)) process.env[key] = path.resolve(process.cwd(), val);
}

function ensureDirectories(): void {
  const credentialsPath = process.env.CREDENTIALS_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'credentials');
  const dirs: string[] = [credentialsPath];
  if (!process.env.DB_HOST && !process.env.DATABASE_URL) {
    const dbPath = process.env.DATABASE_PATH ?? path.join(os.homedir(), '.ocr-mcp', 'books.db');
    dirs.push(path.dirname(dbPath));
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

const API_PORT = Number(process.env.OCR_API_PORT ?? 5180);

async function main(): Promise<void> {
  ensureDirectories();
  const { createHttpServer } = await import('./server.js');
  await createHttpServer(API_PORT);
}

main().catch((err) => {
  process.stderr.write(`[OCR HTTP] Fatal error: ${err}\n`);
  process.exit(1);
});
