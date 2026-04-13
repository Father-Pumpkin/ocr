import { getBookByName, getPages } from '../database.js';

interface GetTranscriptionArgs {
  book_name: string;
  page_start?: number;
  page_end?: number;
  include_illustrations?: boolean;
}

export async function getTranscription(args: GetTranscriptionArgs): Promise<string> {
  const {
    book_name,
    page_start,
    page_end,
    include_illustrations = false,
  } = args;

  const book = await getBookByName(book_name);
  if (!book) {
    return (
      `Book not found: "${book_name}"\n` +
      `Make sure the book has been transcribed first with the transcribe_books tool.`
    );
  }

  const pages = await getPages(book.id, page_start, page_end);

  if (pages.length === 0) {
    const rangeText =
      page_start !== undefined || page_end !== undefined
        ? ` in the requested page range`
        : '';
    return `No transcribed pages found${rangeText} for "${book.title}".`;
  }

  // Filter out illustration-only pages if requested
  const filteredPages = include_illustrations
    ? pages
    : pages.filter((p) => !p.has_illustration);

  // Build the page range description
  const firstPage = pages[0].page_number;
  const lastPage = pages[pages.length - 1].page_number;
  const rangeLabel =
    page_start !== undefined || page_end !== undefined
      ? `${page_start ?? firstPage}–${page_end ?? lastPage}`
      : `${firstPage}–${lastPage}`;

  const lines: string[] = [
    `Book: ${book.title}`,
    `Pages: ${rangeLabel}`,
    ``,
  ];

  if (include_illustrations) {
    // Show every page including [ILLUSTRATION] ones
    for (const page of pages) {
      lines.push(`--- Page ${page.page_number} ---`);
      lines.push(page.transcription ?? '[no transcription]');
      lines.push('');
    }
  } else {
    // Only show pages with actual text, but preserve page numbers
    for (const page of pages) {
      if (page.has_illustration) continue;
      lines.push(`--- Page ${page.page_number} ---`);
      lines.push(page.transcription ?? '[no transcription]');
      lines.push('');
    }

    if (filteredPages.length === 0) {
      lines.push(
        '(All pages in this range are illustration-only. Use include_illustrations=true to see them.)'
      );
    }
  }

  return lines.join('\n');
}
