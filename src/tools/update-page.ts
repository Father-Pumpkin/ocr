import { getBookByName, updatePageTranscription } from '../database.js';

interface UpdatePageArgs {
  book_name: string;
  page_number: number;
  transcription: string;
}

export async function updatePage(args: UpdatePageArgs): Promise<string> {
  const { book_name, page_number, transcription } = args;

  if (!transcription || transcription.trim() === '') {
    return 'Transcription text cannot be empty. To mark a page as illustration-only, use "[ILLUSTRATION]".';
  }

  const book = await getBookByName(book_name);
  if (!book) {
    return (
      `Book not found: "${book_name}"\n` +
      `Make sure the book has been transcribed first.`
    );
  }

  const updated = await updatePageTranscription(book.id, page_number, transcription.trim());

  if (!updated) {
    return (
      `Page ${page_number} not found in "${book.title}".\n` +
      `The page may not have been transcribed yet, or the page number is out of range.`
    );
  }

  return (
    `Page ${page_number} of "${book.title}" updated successfully.\n` +
    `New transcription:\n${transcription.trim()}`
  );
}
