import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { BookRow } from '../types';
import { Loading, ErrorBox, EmptyState, Badge, StatusBadge } from '../components/ui';
import { Search, BookOpen, Alert } from '../components/icons';

export function Library() {
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api
      .getLibrary()
      .then((d) => setBooks(d.books))
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!books) return [];
    const q = query.trim().toLowerCase();
    return q ? books.filter((b) => b.title.toLowerCase().includes(q)) : books;
  }, [books, query]);

  if (error) return <ErrorBox message={`Couldn't load library: ${error}`} />;
  if (!books) return <Loading label="Loading library…" />;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">Library</h1>
          <p className="mt-1 text-sm text-muted">
            {books.length} book{books.length === 1 ? '' : 's'} transcribed
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles…"
            className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:w-64"
          />
        </div>
      </div>

      {books.length === 0 ? (
        <EmptyState>No books found in the configured Drive folder.</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No titles match “{query}”.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((b) => (
            <BookCard key={b.drive_file_id} book={b} />
          ))}
        </ul>
      )}
    </div>
  );
}

function BookCard({ book }: { book: BookRow }) {
  const isPending = book.id < 0;
  const [imgOk, setImgOk] = useState(true);

  const inner = (
    <>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-surface-2 shadow-card">
        {imgOk && !isPending ? (
          <img
            src={api.pageImageUrl(book.title, 1)}
            alt=""
            loading="lazy"
            onError={() => setImgOk(false)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <BookOpen className="h-7 w-7 text-faint" />
            <span className="line-clamp-2 font-serif text-sm text-muted">{book.title}</span>
          </div>
        )}
        {book.ocr_quality === 'bad' && (
          <span className="absolute left-2 top-2">
            <Badge tone="danger" title={book.ocr_quality_note ?? ''}>
              <Alert className="h-3 w-3" />
              redo
            </Badge>
          </span>
        )}
        {book.ocr_quality === 'suspect' && (
          <span className="absolute left-2 top-2">
            <Badge tone="warn" title={book.ocr_quality_note ?? ''}>
              <Alert className="h-3 w-3" />
              check
            </Badge>
          </span>
        )}
      </div>
      <div className="mt-2.5 px-0.5">
        <h2 className="line-clamp-2 font-serif text-[0.95rem] font-medium leading-snug text-ink">{book.title}</h2>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted">
          {book.page_count != null && <span>{book.page_count} pages</span>}
          {book.status !== 'complete' && <StatusBadge status={book.status} />}
        </p>
      </div>
    </>
  );

  if (isPending) {
    return (
      <li className="group cursor-default opacity-60" title="Not transcribed yet">
        {inner}
      </li>
    );
  }
  return (
    <li>
      <Link to={`/book/${encodeURIComponent(book.title)}`} className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg">
        {inner}
      </Link>
    </li>
  );
}
