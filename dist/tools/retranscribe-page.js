import { getBookByName, updatePageTranscription } from '../database.js';
import { getPageImageTool } from './get-page-image.js';
import { transcribeSinglePageImage, DEFAULT_MODEL } from '../ocr.js';
export async function retranscribePage(args) {
    const { book_name, page_number, model = DEFAULT_MODEL } = args;
    const book = await getBookByName(book_name);
    if (!book)
        throw new Error(`Book not found: "${book_name}"`);
    const { imageData } = await getPageImageTool(book_name, page_number);
    if (!imageData) {
        throw new Error(`Page ${page_number} has no associated image. It may have been manually inserted and has no scan.`);
    }
    process.stderr.write(`[OCR MCP] Re-transcribing "${book_name}" page ${page_number} with ${model}...\n`);
    const transcription = await transcribeSinglePageImage(imageData, model);
    await updatePageTranscription(book.id, page_number, transcription);
    return {
        text: `Page ${page_number} of "${book.title}" re-transcribed with ${model}.`,
        transcription,
    };
}
