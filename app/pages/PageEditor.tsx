import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { BookRow, PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState, Button, IconButton, Label, Badge } from '../components/ui';
import { ChevronLeft, ChevronRight, Alert, Check, Upload, Refresh, ShieldCheck, Plus, Trash, ImageOff } from '../components/icons';

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

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
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const page = useMemo(() => pages?.find((p) => p.page_number === pageNumber) ?? null, [pages, pageNumber]);
  const hasPrev = !!pages?.some((p) => p.page_number === pageNumber - 1);
  const hasNext = !!pages?.some((p) => p.page_number === pageNumber + 1);

  const load = useCallback(() => {
    setPages(null);
    setError(null);
    api
      .getBookPages(name)
      .then((d) => {
        setBook(d.book);
        setPages(d.pages);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .getModels()
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
    page != null && (text !== (page.transcription ?? '') || tagsInput !== parseTags(page.tags).join(', '));

  function applyUpdatedPage(updated: PageRow) {
    setPages((prev) => (prev ? prev.map((p) => (p.page_number === updated.page_number ? updated : p)) : prev));
  }

  /** Navigate, warning first if there are unsaved edits. */
  function go(to: string) {
    if (dirty && !window.confirm('Discard unsaved changes to this page?')) return;
    navigate(to);
  }

  const busy = saving || retranscribing || inserting || deleting || uploading || checking;

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

  async function onCheckQuality() {
    setChecking(true);
    setActionError(null);
    try {
      const { page: updated } = await api.verifyPage(name, pageNumber);
      applyUpdatedPage(updated);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function onInsertAfter() {
    setInserting(true);
    setActionError(null);
    try {
      await api.insertPage(name, pageNumber);
      load();
      navigate(`/book/${encodeURIComponent(name)}/page/${pageNumber + 1}`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setInserting(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete page ${pageNumber}? This renumbers the following pages and cannot be undone.`)) {
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
      setImageVersion((v) => v + 1);
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
      <div className="mb-5 flex items-center justify-between gap-4">
        <nav className="flex items-center gap-1.5 text-sm text-muted">
          <button onClick={() => go('/')} className="transition-colors hover:text-ink">
            Library
          </button>
          <span className="text-faint">/</span>
          <button
            onClick={() => go(`/book/${encodeURIComponent(name)}`)}
            className="max-w-[10rem] truncate transition-colors hover:text-ink sm:max-w-[16rem]"
          >
            {book?.title ?? name}
          </button>
          <span className="text-faint">/</span>
          <span className="text-ink">Page {pageNumber}</span>
        </nav>
        <div className="flex items-center gap-2">
          <IconButton
            onClick={() => go(`/book/${encodeURIComponent(name)}/page/${pageNumber - 1}`)}
            disabled={!hasPrev}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton
            onClick={() => go(`/book/${encodeURIComponent(name)}/page/${pageNumber + 1}`)}
            disabled={!hasNext}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {page.ocr_quality === 'suspect' && (
        <div className="mb-5 flex gap-3 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          <Alert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-semibold">This transcription looks suspect.</span> {page.ocr_quality_reason}{' '}
            Consider re-transcribing with a stronger model (e.g. Opus) using the picker below.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Image */}
        <div className="flex flex-col gap-3">
          <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 shadow-card">
            {imgError ? (
              <div className="p-8 text-center text-sm text-muted">
                <ImageOff className="mx-auto mb-2 h-7 w-7 text-faint" />
                <p>No scanned image for this page.</p>
                {driveUrl && (
                  <a href={driveUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
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
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" />
              {uploading ? 'Uploading…' : imgError ? 'Upload image' : 'Replace image'}
            </Button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label>Transcription</Label>
            <span className="flex items-center gap-2">
              {page.ocr_quality === 'ok' && (
                <Badge tone="ok">
                  <Check className="h-3 w-3" />
                  checked
                </Badge>
              )}
              {page.is_edited && <Badge tone="accent">edited</Badge>}
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="min-h-64 flex-1 resize-y rounded-lg border border-border bg-surface p-3.5 font-mono text-sm leading-relaxed text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />

          {/* Original OCR (research) */}
          {original != null && original !== text && (
            <div>
              <button
                onClick={() => setShowOriginal((s) => !s)}
                className="text-xs text-muted transition-colors hover:text-ink"
              >
                {showOriginal ? '▾ Hide original OCR' : '▸ View original OCR'}
              </button>
              {showOriginal && (
                <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs text-muted">
                  {original}
                </pre>
              )}
            </div>
          )}

          <div>
            <Label>
              Tags <span className="font-normal normal-case text-faint">(comma-separated)</span>
            </Label>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="climax, inciting incident"
              className={`mt-1.5 ${inputClass}`}
            />
          </div>

          {actionError && <ErrorBox message={actionError} />}

          {/* Primary actions */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onSave} disabled={!dirty || busy}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={onRetranscribe} disabled={busy}>
              <Refresh className="h-4 w-4" />
              {retranscribing ? 'Re-transcribing…' : 'Re-transcribe'}
            </Button>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={busy || models.length === 0}
              title="Model for re-transcription"
              className="h-10 rounded-lg border border-border bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={onCheckQuality} disabled={busy} title="Cheap Sonnet proofreader check on this page">
              <ShieldCheck className="h-4 w-4" />
              {checking ? 'Checking…' : 'Check quality'}
            </Button>
          </div>

          {/* Page management */}
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Label className="mr-1">Page</Label>
            <Button variant="secondary" size="sm" onClick={onInsertAfter} disabled={busy}>
              <Plus className="h-4 w-4" />
              {inserting ? 'Inserting…' : 'Insert blank after'}
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
              <Trash className="h-4 w-4" />
              {deleting ? 'Deleting…' : 'Delete page'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
