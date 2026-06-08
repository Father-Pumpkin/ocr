import { getBookByName, setPageImage } from '../core/database.js';

interface SetPageImageArgs {
  book_name: string;
  page_number: number;
  image_base64: string;
}

export async function setPageImageTool(args: SetPageImageArgs): Promise<string> {
  const { book_name, page_number, image_base64 } = args;

  const book = await getBookByName(book_name);
  if (!book) throw new Error(`Book not found: "${book_name}"`);

  await setPageImage(book.id, page_number, image_base64);
  return `Image saved for page ${page_number} of "${book.title}".`;
}
