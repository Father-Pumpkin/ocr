import { getBookByName, insertPageAfter } from '../database.js';
export async function insertPage(args) {
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
