import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { BookRow } from '../types';
import { Loading, ErrorBox, EmptyState, Badge, StatusBadge } from '../components/ui';
import { Search, BookOpen, Alert } from '../components/icons';

type Filter = 'all' | 'flagged' | 'failed';

export function Library() {
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api
      .getLibrary()
      .then((d) => setBooks(d.books))
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  const counts = useMemo(() => {
    const list = books ?? [];
    return {
      all: list.length,
      flagged: list.filter((b) => b.ocr_quality === 'suspect' || b.ocr_quality === 'bad').length,
      failed: list.filter((b) => b.status === 'failed').length,
    };
  }, [books]);

  const filtered = useMemo(() => {
    let list = books ?? [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((b) => b.title.toLowerCase().includes(q));
    if (filter === 'flagged') list = list.filter((b) => b.ocr_quality === 'suspect' || b.ocr_quality === 'bad');
    if (filter === 'failed') list = list.filter((b) => b.status === 'failed');
    return list;
  }, [books, query, filter]);

  if (error) return <ErrorBox message={`Couldn't load library: ${error}`} />;
  if (!books) return <Loading label="Loading library…" />;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
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

      <div className="mb-6 flex flex-wrap gap-2">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All <span className="text-faint">{counts.all}</span>
        </FilterChip>
        <FilterChip active={filter === 'flagged'} onClick={() => setFilter('flagged')} disabled={counts.flagged === 0}>
          Flagged <span className="text-faint">{counts.flagged}</span>
        </FilterChip>
        <FilterChip active={filter === 'failed'} onClick={() => setFilter('failed')} disabled={counts.failed === 0}>
          Failed <span className="text-faint">{counts.failed}</span>
        </FilterChip>
      </div>

      {books.length === 0 ? (
        <EmptyState>No books found in the configured Drive folder.</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No books match.</EmptyState>
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

function FilterChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:opacity-40 ${
        active
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-border bg-surface text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
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
            <Badge tone="danger" title={book.ocr_quality_note ?? 'Most pages look garbled'}>
              <Alert className="h-3 w-3" />
              redo
            </Badge>
          </span>
        )}
        {book.ocr_quality === 'suspect' && (
          <span className="absolute left-2 top-2">
            <Badge tone="warn" title={book.ocr_quality_note ?? 'Some pages look suspect'}>
              <Alert className="h-3 w-3" />
              suspect
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
      <li className="group cursor-default opacity-60" title="Not transcribed yet — run a transcription from Claude Desktop">
        {inner}
      </li>
    );
  }
  return (
    <li>
      <Link
        to={`/book/${encodeURIComponent(book.title)}`}
        className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {inner}
      </Link>
    </li>
  );
}
