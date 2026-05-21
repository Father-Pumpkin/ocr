import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import os from 'node:os';
import fs from 'node:fs';

// Load .env from project root (one level up from electron/ when running via electron-vite dev)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

// Resolve relative path env vars to absolute (same pattern as the MCP server)
for (const key of ['DATABASE_PATH', 'CREDENTIALS_PATH']) {
  const val = process.env[key];
  if (val && !path.isAbsolute(val)) process.env[key] = path.resolve(projectRoot, val);
}

// Ensure expected dirs exist before any DB or auth code touches them
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

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'OCR Tool',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Surface renderer load failures to stderr so they don't disappear silently
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write(`[OCR App] did-fail-load: code=${code} desc=${desc} url=${url}\n`);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function main(): Promise<void> {
  ensureDirectories();

  // Start the HTTP API before the window so the first fetch isn't racy
  const { createHttpServer } = await import('../src/http/server.js');
  await createHttpServer(API_PORT);

  await app.whenReady();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

main().catch((err) => {
  process.stderr.write(`[OCR App] Fatal error: ${err}\n`);
  app.quit();
});
