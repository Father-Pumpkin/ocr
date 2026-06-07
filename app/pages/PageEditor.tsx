import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { BookRow, PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState } from '../components/ui';

export function PageEditor() {
  const { name = '', n = '1' } = useParams();
  const pageNumber = Number.parseInt(n, 10);

  const [book, setBook] = useState<BookRow | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [text, setText] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [imgError, setImgError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retranscribing, setRetranscribing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const page = useMemo(
    () => pages?.find((p) => p.page_number === pageNumber) ?? null,
    [pages, pageNumber],
  );
  const hasPrev = !!pages?.some((p) => p.page_number === pageNumber - 1);
  const hasNext = !!pages?.some((p) => p.page_number === pageNumber + 1);

  // Load all pages for the book (also powers prev/next)
  useEffect(() => {
    setPages(null);
    setError(null);
    api.getBookPages(name)
      .then((d) => {
        setBook(d.book);
        setPages(d.pages);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [name]);

  // Reset editable fields + image when the target page changes
  useEffect(() => {
    setText(page?.transcription ?? '');
    setTagsInput(parseTags(page?.tags ?? '[]').join(', '));
    setImgError(false);
    setActionError(null);
  }, [page]);

  const dirty =
    page != null &&
    (text !== (page.transcription ?? '') ||
      tagsInput !== parseTags(page.tags).join(', '));

  function applyUpdatedPage(updated: PageRow) {
    setPages((prev) =>
      prev ? prev.map((p) => (p.page_number === updated.page_number ? updated : p)) : prev,
    );
  }

  async function onSave() {
    setSaving(true);
    setActionError(null);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const { page: updated } = await api.updatePage(name, pageNumber, { transcription: text, tags });
      applyUpdatedPage(updated);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onRetranscribe() {
    setRetranscribing(true);
    setActionError(null);
    try {
      const { page: updated } = await api.retranscribePage(name, pageNumber);
      applyUpdatedPage(updated);
      setText(updated.transcription ?? '');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRetranscribing(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!pages) return <Loading label="Loading page…" />;
  if (!page) return <EmptyState>Page {pageNumber} not found in this book.</EmptyState>;

  const driveUrl = book ? `https://drive.google.com/file/d/${book.drive_file_id}/view` : null;

  return (
    <div>
      {/* Breadcrumb + pager */}
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm text-slate-500">
          <Link to="/" className="hover:text-slate-700">Library</Link>
          <span className="mx-1.5">/</span>
          <Link to={`/book/${encodeURIComponent(name)}`} className="hover:text-slate-700">
            {book?.title ?? name}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-slate-700">Page {pageNumber}</span>
        </div>
        <div className="flex gap-2">
          <PagerLink to={`/book/${encodeURIComponent(name)}/page/${pageNumber - 1}`} disabled={!hasPrev}>
            ← Prev
          </PagerLink>
          <PagerLink to={`/book/${encodeURIComponent(name)}/page/${pageNumber + 1}`} disabled={!hasNext}>
            Next →
          </PagerLink>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Image */}
        <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
          {imgError ? (
            <div className="p-6 text-center text-sm text-slate-500">
              <p>No scanned image for this page.</p>
              {driveUrl && (
                <a href={driveUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  View source on Drive
                </a>
              )}
            </div>
          ) : (
            <img
              src={api.pageImageUrl(name, pageNumber)}
              alt={`Page ${pageNumber}`}
              className="max-h-[70vh] w-full object-contain"
              onError={() => setImgError(true)}
            />
          )}
        </div>

        {/* Editor */}
        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Transcription
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="min-h-64 flex-1 resize-y rounded-md border border-slate-300 bg-white p-3 font-mono text-sm leading-relaxed focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Tags <span className="normal-case text-slate-400">(comma-separated)</span>
          </label>
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="climax, inciting incident"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {actionError && <ErrorBox message={actionError} />}

          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onRetranscribe}
              disabled={retranscribing}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {retranscribing ? 'Re-transcribing…' : 'Re-transcribe'}
            </button>
            {page.is_edited && <span className="text-xs text-slate-400">edited</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PagerLink({ to, disabled, children }: { to: string; disabled: boolean; children: ReactNode }) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      to={to}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
