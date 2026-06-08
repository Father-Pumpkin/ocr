#!/usr/bin/env node
/** Quick check that the saved Drive token can list the books folder. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { listPdfsInFolder } = await import('../src/core/google-drive.js');
const log = (m: string) => process.stderr.write(m + '\n');

try {
  const files = await listPdfsInFolder({ interactive: false });
  log(`Drive OK — ${files.length} PDF(s) visible in the folder.`);
  process.exit(0);
} catch (err) {
  log('Drive FAIL — ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
