import { getBookByName, deletePage } from '../database.js';

interface DeletePageArgs {
  book_name: string;
  page_number: number;
}

export async function deletePageTool(args: DeletePageArgs): Promise<string> {
  const { book_name, page_number } = args;

  const book = await getBookByName(book_name);
  if (!book) throw new Error(`Book not found: "${book_name}"`);

  const deleted = await deletePage(book.id, page_number);
  if (!deleted) {
    throw new Error(`Page ${page_number} not found in "${book.title}".`);
  }

  return `Deleted page ${page_number} from "${book.title}". All subsequent pages have been renumbered.`;
}
