import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { BookRow, PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState } from '../components/ui';

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function PageEditor() {
  const { name = '', n = '1' } = useParams();
  const pageNumber = Number.parseInt(n, 10);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [book, setBook] = useState<BookRow | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [text, setText] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [imgError, setImgError] = useState(false);
  const [imageVersion, setImageVersion] = useState(0); // cache-bust after upload
  const [showOriginal, setShowOriginal] = useState(false);

  // Models for re-OCR
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');

  // Action states
  const [saving, setSaving] = useState(false);
  const [retranscribing, setRetranscribing] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const page = useMemo(
    () => pages?.find((p) => p.page_number === pageNumber) ?? null,
    [pages, pageNumber],
  );
  const hasPrev = !!pages?.some((p) => p.page_number === pageNumber - 1);
  const hasNext = !!pages?.some((p) => p.page_number === pageNumber + 1);

  const load = useCallback(() => {
    setPages(null);
    setError(null);
    api.getBookPages(name)
      .then((d) => {
        setBook(d.book);
        setPages(d.pages);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  // Load model list once
  useEffect(() => {
    api.getModels()
      .then((m) => {
        setModels(m.models);
        setSelectedModel((s) => s || m.default);
      })
      .catch(() => {});
  }, []);

  // Reset editable fields when the target page changes
  useEffect(() => {
    setText(page?.transcription ?? '');
    setTagsInput(parseTags(page?.tags ?? '[]').join(', '));
    setImgError(false);
    setShowOriginal(false);
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

  /** Navigate, warning first if there are unsaved edits. */
  function go(to: string) {
    if (dirty && !window.confirm('Discard unsaved changes to this page?')) return;
    navigate(to);
  }

  const busy = saving || retranscribing || inserting || deleting || uploading;

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
    if (
      page?.is_edited &&
      !window.confirm('This page has manual edits. Re-transcribing will replace the current text with a fresh OCR. Continue?')
    ) {
      return;
    }
    setRetranscribing(true);
    setActionError(null);
    try {
      const { page: updated } = await api.retranscribePage(name, pageNumber, selectedModel || undefined);
      applyUpdatedPage(updated);
      setText(updated.transcription ?? '');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRetranscribing(false);
    }
  }

  async function onInsertAfter() {
    setInserting(true);
    setActionError(null);
    try {
      await api.insertPage(name, pageNumber); // inserts a blank page after this one
      load();
      navigate(`/book/${encodeURIComponent(name)}/page/${pageNumber + 1}`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setInserting(false);
    }
  }

  async function onDelete() {
    if (
      !window.confirm(
        `Delete page ${pageNumber}? This renumbers the following pages and cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setActionError(null);
    try {
      await api.deletePage(name, pageNumber);
      const remaining = (pages?.length ?? 1) - 1;
      load();
      if (remaining <= 0) navigate(`/book/${encodeURIComponent(name)}`);
      else navigate(`/book/${encodeURIComponent(name)}/page/${Math.max(1, pageNumber - 1)}`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      setDeleting(false);
    }
  }

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setActionError(null);
    try {
      const dataUrl = await readAsDataURL(file);
      await api.setPageImage(name, pageNumber, dataUrl);
      setImgError(false);
      setImageVersion((v) => v + 1); // force <img> reload
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!pages) return <Loading label="Loading page…" />;
  if (!page) return <EmptyState>Page {pageNumber} not found in this book.</EmptyState>;

  const driveUrl = book ? `https://drive.google.com/file/d/${book.drive_file_id}/view` : null;
  const imageUrl = `${api.pageImageUrl(name, pageNumber)}?v=${imageVersion}`;
  const original = page.original_transcription;

  return (
    <div>
      {/* Breadcrumb + pager */}
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm text-slate-500">
          <button onClick={() => go('/')} className="hover:text-slate-700">Library</button>
          <span className="mx-1.5">/</span>
          <button onClick={() => go(`/book/${encodeURIComponent(name)}`)} className="hover:text-slate-700">
            {book?.title ?? name}
          </button>
          <span className="mx-1.5">/</span>
          <span className="text-slate-700">Page {pageNumber}</span>
        </div>
        <div className="flex gap-2">
          <PagerButton onClick={() => go(`/book/${encodeURIComponent(name)}/page/${pageNumber - 1}`)} disabled={!hasPrev}>
            ← Prev
          </PagerButton>
          <PagerButton onClick={() => go(`/book/${encodeURIComponent(name)}/page/${pageNumber + 1}`)} disabled={!hasNext}>
            Next →
          </PagerButton>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Image */}
        <div className="flex flex-col gap-2">
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
              <a href={imageUrl} target="_blank" rel="noreferrer" title="Open full size">
                <img
                  src={imageUrl}
                  alt={`Page ${pageNumber}`}
                  className="max-h-[70vh] w-full object-contain"
                  onError={() => setImgError(true)}
                />
              </a>
            )}
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onPickImage(e.target.files?.[0])}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {uploading ? 'Uploading…' : imgError ? 'Upload image' : 'Replace image'}
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Transcription</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="min-h-64 flex-1 resize-y rounded-md border border-slate-300 bg-white p-3 font-mono text-sm leading-relaxed focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {/* Original OCR (research) */}
          {original != null && original !== text && (
            <div>
              <button
                onClick={() => setShowOriginal((s) => !s)}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                {showOriginal ? '▾ Hide original OCR' : '▸ View original OCR'}
              </button>
              {showOriginal && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-600">
                  {original}
                </pre>
              )}
            </div>
          )}

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

          {/* Primary actions */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              onClick={onSave}
              disabled={!dirty || busy}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onRetranscribe}
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {retranscribing ? 'Re-transcribing…' : 'Re-transcribe'}
            </button>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={busy || models.length === 0}
              title="Model for re-transcription"
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700 disabled:opacity-40"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {page.is_edited && <span className="text-xs text-slate-400">edited</span>}
          </div>

          {/* Page management */}
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <span className="text-xs uppercase tracking-wide text-slate-400">Page</span>
            <button
              onClick={onInsertAfter}
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {inserting ? 'Inserting…' : 'Insert blank page after'}
            </button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40"
            >
              {deleting ? 'Deleting…' : 'Delete page'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PagerButton({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
    >
      {children}
    </button>
  );
}
