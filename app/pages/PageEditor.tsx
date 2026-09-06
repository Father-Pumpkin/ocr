import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { BookRow, PageRow, OcrRun } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState, Button, IconButton, Label, Badge } from '../components/ui';
import { useIsMember } from '../lib/session';
import {
  ChevronLeft,
  ChevronRight,
  Alert,
  Check,
  Upload,
  Refresh,
  ShieldCheck,
  Plus,
  Trash,
  ImageOff,
  Columns,
  Copy,
  Undo,
  Picture,
  X,
} from '../components/icons';
import { SplitDialog } from '../components/SplitDialog';
import { TagSelect } from '../components/TagSelect';

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function PageEditor() {
  // Every mutation on this page is member-only. Guests read the page, its
  // image, its tags and its OCR history; the controls that would change any
  // of it aren't rendered, and the server refuses them regardless.
  const isMember = useIsMember();
  const { name = '', n = '1' } = useParams();
  const pageNumber = Number.parseInt(n, 10);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [book, setBook] = useState<BookRow | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [text, setText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [imgError, setImgError] = useState(false);
  const [imageVersion, setImageVersion] = useState(0); // cache-bust after upload

  // OCR history (original + each re-OCR) and the pending re-OCR preview
  const [runs, setRuns] = useState<OcrRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [ocrPreview, setOcrPreview] = useState<OcrRun | null>(null);

  // Models for re-OCR
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');

  // Action states
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retranscribing, setRetranscribing] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [markingOk, setMarkingOk] = useState(false);
  const [togglingIllo, setTogglingIllo] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const page = useMemo(() => pages?.find((p) => p.page_number === pageNumber) ?? null, [pages, pageNumber]);
  const hasPrev = !!pages?.some((p) => p.page_number === pageNumber - 1);
  const hasNext = !!pages?.some((p) => p.page_number === pageNumber + 1);

  // Next suspect page after this one (wraps around); null if none flagged.
  const nextFlagged = useMemo(() => {
    if (!pages) return null;
    const flagged = pages
      .filter((p) => p.ocr_quality === 'suspect')
      .map((p) => p.page_number)
      .sort((a, b) => a - b);
    if (flagged.length === 0) return null;
    return flagged.find((num) => num > pageNumber) ?? flagged[0];
  }, [pages, pageNumber]);

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

  useEffect(() => {
    api
      .getTags()
      .then((d) => setAllTags(d.tags))
      .catch(() => {});
  }, []);

  // Reset editable fields when the target page changes
  useEffect(() => {
    setText(page?.transcription ?? '');
    setTags(parseTags(page?.tags ?? '[]'));
    setImgError(false);
    setShowHistory(false);
    setOcrPreview(null);
    setActionError(null);
    setSavedFlash(false);
    setCopied(false);
  }, [page]);

  // Load the OCR run history for the current page.
  useEffect(() => {
    let cancelled = false;
    api
      .getOcrRuns(name, pageNumber)
      .then((d) => {
        if (!cancelled) setRuns(d.runs);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [name, pageNumber]);

  const dirty =
    page != null &&
    (text !== (page.transcription ?? '') ||
      JSON.stringify([...tags].sort()) !== JSON.stringify([...parseTags(page.tags)].sort()));

  function applyUpdatedPage(updated: PageRow) {
    setPages((prev) => (prev ? prev.map((p) => (p.page_number === updated.page_number ? updated : p)) : prev));
  }

  /** Returns false if there are unsaved edits the user chooses not to discard. */
  function guardDirty(): boolean {
    return !dirty || window.confirm('You have unsaved changes that will be lost. Continue?');
  }

  /** Navigate, warning first if there are unsaved edits. */
  function go(to: string) {
    if (dirty && !window.confirm('Discard unsaved changes to this page?')) return;
    navigate(to);
  }

  const busy =
    saving || retranscribing || inserting || deleting || uploading || checking || markingOk || togglingIllo;

  async function onSave() {
    setSaving(true);
    setActionError(null);
    try {
      const { page: updated } = await api.updatePage(name, pageNumber, { transcription: text, tags });
      applyUpdatedPage(updated);
      setAllTags((prev) =>
        Array.from(new Set([...prev, ...tags])).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' }),
        ),
      );
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError('Could not copy to clipboard.');
    }
  }

  /** Replace the working text with a run's OCR (a pending edit the user can Save). */
  function useRun(run: OcrRun) {
    setText(run.text);
    setOcrPreview(null);
  }

  async function onRetranscribe() {
    setRetranscribing(true);
    setActionError(null);
    try {
      // Records a new OCR run; does NOT touch the working text. The user previews
      // it and applies it via "Use this" only if it's better — so no confirm here.
      const { run } = await api.retranscribePage(name, pageNumber, selectedModel || undefined);
      setRuns((prev) => [...prev, run]);
      setOcrPreview(run);
      setShowHistory(true);
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

  async function onMarkOk() {
    setMarkingOk(true);
    setActionError(null);
    try {
      const { page: updated } = await api.markPageOk(name, pageNumber);
      applyUpdatedPage(updated);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setMarkingOk(false);
    }
  }

  async function onToggleIllustration() {
    if (!page) return;
    if (!guardDirty()) return;
    setTogglingIllo(true);
    setActionError(null);
    try {
      const { page: updated } = await api.setIllustration(name, pageNumber, !page.has_illustration);
      applyUpdatedPage(updated);
      setText(updated.transcription ?? '');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setTogglingIllo(false);
    }
  }

  async function onInsert(after: number, gotoPage: number) {
    if (!guardDirty()) return;
    setInserting(true);
    setActionError(null);
    try {
      await api.insertPage(name, after);
      load();
      navigate(`/book/${encodeURIComponent(name)}/page/${gotoPage}`);
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
    } finally {
      setDeleting(false); // always clear, even on success — otherwise the editor stays "busy" forever
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
  const isIllustration = page.has_illustration;

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
          {nextFlagged != null && nextFlagged !== pageNumber && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => go(`/book/${encodeURIComponent(name)}/page/${nextFlagged}`)}
              title="Jump to the next flagged page"
            >
              <Alert className="h-3.5 w-3.5 text-warn" />
              Next flagged
            </Button>
          )}
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
            Re-transcribe with a stronger model, or click <span className="font-medium">Mark OK</span> if it's fine.
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
          {isMember && (
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
          )}
        </div>

        {/* Editor */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <Label>Transcription</Label>
            <span className="flex items-center gap-2">
              {page.ocr_quality === 'ok' && (
                <Badge tone="ok">
                  <Check className="h-3 w-3" />
                  checked
                </Badge>
              )}
              {isIllustration && <Badge tone="neutral">illustration</Badge>}
              {page.is_edited && <Badge tone="accent">edited</Badge>}
              <button
                onClick={onCopy}
                title="Copy transcription to clipboard"
                className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ink"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!isMember}
            spellCheck={false}
            title={isMember ? undefined : 'Read-only: editing is limited to approved accounts.'}
            className={`min-h-64 flex-1 resize-y rounded-lg border border-border p-3.5 font-mono text-sm leading-relaxed text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 ${
              isMember ? 'bg-surface' : 'bg-surface-2 cursor-default'
            }`}
          />

          {/* Re-OCR preview — compare the fresh OCR with the working text before applying */}
          {ocrPreview && (
            <div className="rounded-lg border border-accent/40 bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink">
                  New OCR{ocrPreview.model ? ` · ${ocrPreview.model}` : ''}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => useRun(ocrPreview)}>
                    <Check className="h-3.5 w-3.5" />
                    Use this
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setOcrPreview(null)}>
                    <X className="h-3.5 w-3.5" />
                    Discard
                  </Button>
                </div>
              </div>
              <p className="mb-1.5 text-xs text-muted">
                Saved to history. Applying replaces the working text (you can still edit, then Save).
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-2.5 font-mono text-xs text-ink">
                {ocrPreview.text}
              </pre>
            </div>
          )}

          {/* OCR history — the original plus each re-transcription, any restorable */}
          {runs.length > 0 && (
            <div>
              <button
                onClick={() => setShowHistory((s) => !s)}
                className="text-xs text-muted transition-colors hover:text-ink"
              >
                {showHistory ? '▾ Hide OCR history' : `▸ OCR history (${runs.length})`}
              </button>
              {showHistory && (
                <ul className="mt-2 flex flex-col gap-2">
                  {runs.map((run, i) => {
                    const inUse = run.text === text;
                    return (
                      <li key={run.id} className="rounded-lg border border-border bg-surface-2 p-3">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-xs">
                            <span className="font-medium text-ink">{i === 0 ? 'Original' : 'Re-OCR'}</span>
                            <span className="text-muted">
                              {' · '}
                              {run.model ?? 'unknown model'}
                              {run.created_at ? ` · ${new Date(run.created_at).toLocaleString()}` : ''}
                            </span>
                          </span>
                          <button
                            onClick={() => useRun(run)}
                            disabled={inUse}
                            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
                            title="Replace the working text with this OCR (you can still edit before saving)"
                          >
                            <Undo className="h-3.5 w-3.5" />
                            {inUse ? 'In use' : 'Use this'}
                          </button>
                        </div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-2.5 font-mono text-xs text-muted">
                          {run.text}
                        </pre>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <div>
            <Label>
              Tags{' '}
              {isMember && <span className="font-normal normal-case text-faint">(pick or create)</span>}
            </Label>
            <div className="mt-1.5">
              {isMember ? (
                <TagSelect key={pageNumber} value={tags} onChange={setTags} suggestions={allTags} />
              ) : tags.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <Badge key={t} tone="neutral">{t}</Badge>
                  ))}
                </span>
              ) : (
                <span className="text-sm text-faint">None</span>
              )}
            </div>
          </div>

          {actionError && <ErrorBox message={actionError} />}

          {!isMember && (
            <p className="text-xs text-muted">
              Read-only. Editing pages, re-running OCR and quality checks are limited to approved accounts.
            </p>
          )}

          {/* Primary actions — every one of these writes or spends. */}
          {isMember && (
            <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onSave} disabled={!dirty || busy}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {savedFlash && (
              <span className="inline-flex items-center gap-1 text-xs text-ok">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
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
          </div>

          {/* Quality / classification */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onCheckQuality} disabled={busy} title="Cheap Sonnet proofreader check">
              <ShieldCheck className="h-4 w-4" />
              {checking ? 'Checking…' : 'Check quality'}
            </Button>
            {page.ocr_quality !== 'ok' && (
              <Button variant="secondary" size="sm" onClick={onMarkOk} disabled={busy} title="Accept this transcription and clear any suspect flag">
                <Check className="h-4 w-4" />
                {markingOk ? 'Marking…' : 'Mark OK'}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={onToggleIllustration}
              disabled={busy}
              title={isIllustration ? 'Treat this as a normal text page' : 'Mark this page as illustration-only'}
            >
              <Picture className="h-4 w-4" />
              {togglingIllo ? '…' : isIllustration ? 'Unmark illustration' : 'Mark illustration'}
            </Button>
          </div>

          {/* Page management */}
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Label className="mr-1">Page</Label>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onInsert(pageNumber - 1, pageNumber)}
              disabled={busy}
              title="Insert a blank page before this one"
            >
              <Plus className="h-4 w-4" />
              Insert before
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onInsert(pageNumber, pageNumber + 1)}
              disabled={busy}
              title="Insert a blank page after this one"
            >
              <Plus className="h-4 w-4" />
              Insert after
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSplitOpen(true)}
              disabled={busy}
              title="Split this spread into two pages at the gutter"
            >
              <Columns className="h-4 w-4" />
              Split page
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
              <Trash className="h-4 w-4" />
              {deleting ? 'Deleting…' : 'Delete page'}
            </Button>
          </div>
            </>
          )}
        </div>
      </div>

      {splitOpen && (
        <SplitDialog
          bookName={name}
          pageNumber={pageNumber}
          imageSrc={imageUrl}
          initialText={text}
          onClose={() => setSplitOpen(false)}
          onDone={() => {
            setSplitOpen(false);
            setImgError(false);
            setImageVersion((v) => v + 1); // cache-bust so the new split image loads
            load();
            // The left half may have just gained its original run — refresh history.
            api.getOcrRuns(name, pageNumber).then((d) => setRuns(d.runs)).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
