import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { BookRow } from '../types';
import { StatusBadge, Loading, ErrorBox, EmptyState } from '../components/ui';

export function Library() {
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getLibrary()
      .then((d) => setBooks(d.books))
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  if (error) return <ErrorBox message={`Couldn't load library: ${error}`} />;
  if (!books) return <Loading label="Loading library…" />;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Library</h1>
        <span className="text-sm text-slate-500">
          {books.length} book{books.length === 1 ? '' : 's'}
        </span>
      </div>

      {books.length === 0 ? (
        <EmptyState>No books found in the configured Drive folder.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {books.map((b) => {
            const isPending = b.id < 0;
            const row = (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="font-medium">{b.title}</span>
                <span className="flex items-center gap-3 text-xs text-slate-500">
                  {b.page_count != null && <span>{b.page_count} pages</span>}
                  {b.ocr_quality === 'bad' && (
                    <span title={b.ocr_quality_note ?? ''} className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
                      OCR: bad
                    </span>
                  )}
                  {b.ocr_quality === 'suspect' && (
                    <span title={b.ocr_quality_note ?? ''} className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">
                      OCR: check
                    </span>
                  )}
                  <StatusBadge status={b.status} />
                </span>
              </div>
            );
            return (
              <li key={b.drive_file_id} className="hover:bg-slate-50">
                {isPending ? (
                  <div className="cursor-default opacity-70" title="Not transcribed yet">
                    {row}
                  </div>
                ) : (
                  <Link to={`/book/${encodeURIComponent(b.title)}`} className="block">
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
