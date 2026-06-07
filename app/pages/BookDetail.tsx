import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { BookRow, PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState } from '../components/ui';

function snippet(page: PageRow): string {
  if (page.has_illustration) return '[illustration]';
  const t = (page.transcription ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

export function BookDetail() {
  const { name = '' } = useParams();
  const [book, setBook] = useState<BookRow | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setPages(null);
    setError(null);
    setNotFound(false);
    api.getBookPages(name)
      .then((d) => {
        setBook(d.book);
        setPages(d.pages);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e.message ?? String(e));
      });
  }, [name]);

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-700">
          ← Library
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{book?.title ?? name}</h1>
      </div>

      {error && <ErrorBox message={error} />}
      {notFound && (
        <EmptyState>
          This book hasn't been transcribed yet. Run a transcription from Claude Desktop, then
          refresh.
        </EmptyState>
      )}
      {!error && !notFound && !pages && <Loading label="Loading pages…" />}

      {pages && pages.length === 0 && <EmptyState>No pages stored for this book.</EmptyState>}

      {pages && pages.length > 0 && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {pages.map((p) => {
            const tags = parseTags(p.tags);
            return (
              <li key={p.id} className="hover:bg-slate-50">
                <Link
                  to={`/book/${encodeURIComponent(name)}/page/${p.page_number}`}
                  className="flex items-center gap-4 px-4 py-3"
                >
                  <span className="w-10 shrink-0 text-sm font-medium text-slate-400">
                    {p.page_number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                    {snippet(p)}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {p.is_edited && (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                        edited
                      </span>
                    )}
                    {tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
