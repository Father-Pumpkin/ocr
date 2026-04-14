import { getBookByName, insertPageAfter } from '../database.js';

interface InsertPageArgs {
  book_name: string;
  after_page_number: number;
}

export async function insertPage(args: InsertPageArgs): Promise<{ text: string; page_number: number }> {
  const { book_name, after_page_number } = args;

  const book = await getBookByName(book_name);
  if (!book) {
    throw new Error(`Book not found: "${book_name}"`);
  }

  const newPage = await insertPageAfter(book.id, after_page_number);

  return {
    text: `Inserted blank page ${newPage.page_number} in "${book.title}" (after page ${after_page_number}). All subsequent pages have been renumbered.`,
    page_number: newPage.page_number,
  };
}
