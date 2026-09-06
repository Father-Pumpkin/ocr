import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState, Card, Button, IconButton, Badge, buttonClass } from '../components/ui';
import { ChevronLeft, ShieldCheck, Alert, ImageOff, Download, Pencil, Check, Gauge } from '../components/icons';
import { useIsMember } from '../lib/session';

function snippet(page: PageRow): string {
  if (page.has_illustration) return '[illustration]';
  const t = (page.transcription ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

type BookMeta = { title: string; ocr_quality: string | null; ocr_quality_note: string | null };

export function BookDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  // Renaming and the OCR quality check both write (and the latter spends), so
  // they're member-only. Reading the book and analysing it are not.
  const isMember = useIsMember();
  const [book, setBook] = useState<BookMeta | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  // Rename
  const [renaming, setRenaming] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  // Filter
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  useEffect(() => {
    setPages(null);
    setError(null);
    setNotFound(false);
    setCheckMsg(null);
    setOpError(null);
    setRenaming(false);
    setOnlyFlagged(false);
    api
      .getBookPages(name)
      .then((d) => {
        setBook(d.book);
        setPages(d.pages);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e.message ?? String(e));
      });
  }, [name]);

  const flaggedCount = useMemo(
    () => (pages ?? []).filter((p) => p.ocr_quality === 'suspect').length,
    [pages],
  );
  const visiblePages = useMemo(
    () => (onlyFlagged ? (pages ?? []).filter((p) => p.ocr_quality === 'suspect') : pages ?? []),
    [pages, onlyFlagged],
  );

  async function onCheck() {
    setChecking(true);
    setCheckMsg(null);
    try {
      const r = await api.verifyBook(name);
      setPages(r.pages);
      setBook((b) => (b ? { ...b, ocr_quality: r.quality, ocr_quality_note: r.note } : b));
      setCheckMsg(`Checked ${r.total} page${r.total === 1 ? '' : 's'} — ${r.flagged} flagged`);
    } catch (e) {
      setCheckMsg(`Check failed: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function saveRename() {
    const next = titleInput.trim();
    if (!next || next === (book?.title ?? name)) {
      setRenaming(false);
      return;
    }
    setSavingTitle(true);
    setOpError(null);
    try {
      await api.renameBook(name, next);
      navigate(`/book/${encodeURIComponent(next)}`);
    } catch (e) {
      setOpError(`Rename failed: ${e instanceof ApiError ? e.message : String(e)}`);
      setSavingTitle(false);
      setRenaming(false);
    }
  }

  function exportTxt() {
    if (!pages || !book) return;
    const body = pages
      .map((p) => {
        const t = p.has_illustration ? '[ILLUSTRATION]' : (p.transcription ?? '').trimEnd();
        return `--- Page ${p.page_number} ---\n${t}`;
      })
      .join('\n\n');
    const blob = new Blob([`${book.title}\n\n${body}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${book.title.replace(/[^\w\d\- ]+/g, '').trim() || 'transcription'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-ink">
        <ChevronLeft className="h-4 w-4" /> Library
      </Link>

      <div className="mb-5 mt-2 flex flex-wrap items-start justify-between gap-4">
        {renaming ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-72 rounded-lg border border-border bg-surface px-3 py-1.5 font-serif text-xl text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <Button variant="primary" size="sm" onClick={saveRename} disabled={savingTitle}>
              {savingTitle ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(false)} disabled={savingTitle}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">{book?.title ?? name}</h1>
            {isMember && (
              <IconButton
                className="h-8 w-8"
                aria-label="Rename book"
                title="Rename book"
                onClick={() => {
                  setTitleInput(book?.title ?? name);
                  setRenaming(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        )}

        {pages && pages.length > 0 && (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <Link
                to={`/analysis?book=${encodeURIComponent(book?.title ?? name)}`}
                className={buttonClass('secondary', 'sm')}
                title="Run a sentiment analysis scoped to this book"
              >
                <Gauge className="h-4 w-4" />
                Analyse
              </Link>
              <Button variant="secondary" size="sm" onClick={exportTxt} title="Download the full transcription as a .txt">
                <Download className="h-4 w-4" />
                Download
              </Button>
              {isMember && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onCheck}
                  disabled={checking}
                  title="Run a cheap Sonnet proofreader over every page"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {checking ? 'Checking…' : 'Check OCR quality'}
                </Button>
              )}
            </div>
            {checkMsg && <span className="text-xs text-muted">{checkMsg}</span>}
          </div>
        )}
      </div>

      {opError && (
        <div className="mb-4">
          <ErrorBox message={opError} />
        </div>
      )}

      {book?.ocr_quality === 'bad' && (
        <Banner tone="danger">
          <strong className="font-semibold">Most pages look garbled.</strong> {book.ocr_quality_note}. You're likely
          better off re-transcribing the whole book on a stronger model than fixing it page-by-page.
        </Banner>
      )}
      {book?.ocr_quality === 'suspect' && (
        <Banner tone="warn">
          <strong className="font-semibold">Some pages look suspect.</strong> {book.ocr_quality_note}. Open the flagged
          pages and re-transcribe them with a stronger model.
        </Banner>
      )}

      {error && <ErrorBox message={error} />}
      {notFound && (
        <EmptyState>This book hasn't been transcribed yet. Run a transcription from Claude Desktop, then refresh.</EmptyState>
      )}
      {!error && !notFound && !pages && <Loading label="Loading pages…" />}
      {pages && pages.length === 0 && <EmptyState>No pages stored for this book.</EmptyState>}

      {pages && pages.length > 0 && (
        <>
          {flaggedCount > 0 && (
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {pages.length} pages · {flaggedCount} flagged
              </span>
              <button
                onClick={() => setOnlyFlagged((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                  onlyFlagged
                    ? 'border-warn/40 bg-warn-soft text-warn'
                    : 'border-border bg-surface text-muted hover:text-ink'
                }`}
              >
                <Alert className="h-3.5 w-3.5" />
                {onlyFlagged ? 'Showing flagged only' : 'Show only flagged'}
              </button>
            </div>
          )}
          <Card className="divide-y divide-border overflow-hidden">
            {visiblePages.map((p) => (
              <PageRowItem key={p.id} book={name} page={p} />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

function PageRowItem({ book, page }: { book: string; page: PageRow }) {
  const tags = parseTags(page.tags);
  const suspect = page.ocr_quality === 'suspect';
  const [imgOk, setImgOk] = useState(true);

  return (
    <Link
      to={`/book/${encodeURIComponent(book)}/page/${page.page_number}`}
      className="block px-3 py-3 transition-colors hover:bg-surface-2 sm:px-4"
    >
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="hidden h-12 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2 sm:block">
          {imgOk ? (
            <img
              src={api.pageImageUrl(book, page.page_number)}
              alt=""
              loading="lazy"
              onError={() => setImgOk(false)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-faint">
              <ImageOff className="h-4 w-4" />
            </div>
          )}
        </div>
        <span className="w-6 shrink-0 text-right font-serif text-sm text-faint">{page.page_number}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{snippet(page)}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {page.ocr_quality === 'ok' && (
            <Badge tone="ok">
              <Check className="h-3 w-3" />
            </Badge>
          )}
          {suspect && (
            <Badge tone="warn">
              <Alert className="h-3 w-3" />
              check
            </Badge>
          )}
          {page.is_edited && <Badge tone="accent">edited</Badge>}
          {tags.map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </span>
      </div>
      {suspect && page.ocr_quality_reason && (
        <p className="mt-1.5 pl-10 text-xs leading-snug text-warn sm:pl-[5.5rem]">{page.ocr_quality_reason}</p>
      )}
    </Link>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) {
  const cls =
    tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-warn/30 bg-warn-soft text-warn';
  return <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
