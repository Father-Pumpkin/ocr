#!/usr/bin/env node
/** Read-only: list the distinct tags getAllTags() returns from the live DB. */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { getAllTags } = await import('../src/core/database.js');
const tags = await getAllTags();
process.stderr.write(`${tags.length} distinct tag(s):\n${tags.map((t) => `  • ${t}`).join('\n')}\n`);
process.exit(0);
