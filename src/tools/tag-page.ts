import { getBookByName, setPageTags } from '../database.js';

interface TagPageArgs {
  book_name: string;
  page_number: number;
  tags: string[];
}

export function tagPage(args: TagPageArgs): { text: string; tags: string[] } {
  const { book_name, page_number, tags } = args;

  const book = getBookByName(book_name);
  if (!book) {
    return {
      text: `Book not found: "${book_name}"\nMake sure the book has been transcribed first.`,
      tags: [],
    };
  }

  const updated = setPageTags(book.id, page_number, tags);
  if (!updated) {
    return {
      text: `Page ${page_number} not found in "${book.title}".`,
      tags: [],
    };
  }

  const tagList = tags.length > 0 ? tags.map((t) => `"${t}"`).join(', ') : 'none';
  return {
    text: `Tags for page ${page_number} of "${book.title}" updated to: ${tagList}.`,
    tags,
  };
}
