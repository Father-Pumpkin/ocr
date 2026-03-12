import { listPdfsInFolder, type DriveFile } from '../google-drive.js';
import { getAllBooks, getBookByDriveId, type BookRow } from '../database.js';

export async function listBooks(): Promise<string> {
  let driveFiles: DriveFile[];

  try {
    driveFiles = await listPdfsInFolder();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error connecting to Google Drive: ${message}`;
  }

  if (driveFiles.length === 0) {
    return 'No PDF files found in the configured Google Drive folder.';
  }

  const dbBooks = getAllBooks();
  const dbByDriveId = new Map<string, BookRow>(
    dbBooks.map((b) => [b.drive_file_id, b])
  );

  const lines: string[] = [
    `Found ${driveFiles.length} PDF(s) in Google Drive folder:\n`,
  ];

  for (const file of driveFiles) {
    const db = dbByDriveId.get(file.id);
    const sizeMb = file.size
      ? ` (${(parseInt(file.size, 10) / 1_048_576).toFixed(1)} MB)`
      : '';

    if (db) {
      const pageInfo = db.page_count != null ? `, ${db.page_count} pages` : '';
      lines.push(
        `• ${file.name}${sizeMb}\n` +
        `  Drive ID: ${file.id}\n` +
        `  Status: ${db.status}${pageInfo}\n`
      );
    } else {
      lines.push(
        `• ${file.name}${sizeMb}\n` +
        `  Drive ID: ${file.id}\n` +
        `  Status: not yet transcribed\n`
      );
    }
  }

  return lines.join('\n');
}
