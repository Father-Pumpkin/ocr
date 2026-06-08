import { getBookByName } from '../core/database.js';
import { writePageImageBase64 } from '../core/image-service.js';

interface SetPageImageArgs {
  book_name: string;
  page_number: number;
  image_base64: string;
}

export async function setPageImageTool(args: SetPageImageArgs): Promise<string> {
  const { book_name, page_number, image_base64 } = args;

  const book = await getBookByName(book_name);
  if (!book) throw new Error(`Book not found: "${book_name}"`);

  const raw = image_base64.replace(/^data:[^;]+;base64,/, '').trim();
  await writePageImageBase64(book.id, page_number, raw);
  return `Image saved for page ${page_number} of "${book.title}".`;
}
