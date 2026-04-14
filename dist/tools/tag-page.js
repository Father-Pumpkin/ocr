import { getBookByName, setPageTags } from '../database.js';
export async function tagPage(args) {
    const { book_name, page_number, tags } = args;
    const book = await getBookByName(book_name);
    if (!book) {
        return {
            text: `Book not found: "${book_name}"\nMake sure the book has been transcribed first.`,
            tags: [],
        };
    }
    const updated = await setPageTags(book.id, page_number, tags);
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
