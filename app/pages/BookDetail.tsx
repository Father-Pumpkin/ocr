import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { PageRow } from '../types';
import { parseTags } from '../types';
import { Loading, ErrorBox, EmptyState, Card, Button, IconButton, Badge, buttonClass } from '../components/ui';
import { ChevronLeft, ImageOff, Download, Pencil, Gauge, Eye, EyeOff, Trash } from '../components/icons';
import { useIsMember } from '../lib/session';

function snippet(page: PageRow, textHidden: boolean): string {
  if (page.has_illustration) return '[illustration]';
  // The server withholds the text from guests, so an empty string here means
  // "not shown to you" rather than "this page is blank" — say which.
  if (textHidden) return '— transcript not shown —';
  const t = (page.transcription ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

type BookMeta = { title: string; drive_file_id: string; hidden: boolean };

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function BookDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  // Renaming, hiding and deleting all write, so they're member-only. Reading
  // the book and analysing it are not.
  const isMember = useIsMember();
  const [book, setBook] = useState<BookMeta | null>(null);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [managing, setManaging] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // Rename
  const [renaming, setRenaming] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  useEffect(() => {
    setPages(null);
    setError(null);
    setNotFound(false);
    setOpError(null);
    setRenaming(false);
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

  async function toggleHidden() {
    if (!book) return;
    setManaging(true);
    setOpError(null);
    try {
      const r = await api.setBookHidden(book.drive_file_id, !book.hidden);
      setBook((b) => (b ? { ...b, hidden: r.book.hidden } : b));
    } catch (e) {
      setOpError(`Couldn't ${book.hidden ? 'unhide' : 'hide'} the book: ${errorText(e)}`);
    } finally {
      setManaging(false);
    }
  }

  async function onDelete() {
    if (!book) return;
    const fromDrive = !book.drive_file_id.startsWith('upload:');
    const ok = window.confirm(
      `Permanently delete “${book.title}”?\n\nThis erases its transcription, edits, tags, scores and images. It can't be undone.` +
        (fromDrive
          ? '\n\nThe PDF is still in Drive, so the book will come back as untranscribed. Hide it if you want it gone from the library.'
          : ''),
    );
    if (!ok) return;
    setManaging(true);
    setOpError(null);
    try {
      await api.deleteBook(book.drive_file_id);
      navigate('/');
    } catch (e) {
      setOpError(`Delete failed: ${errorText(e)}`);
      setManaging(false);
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
      setOpError(`Rename failed: ${errorText(e)}`);
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

        {book && (
          <div className="flex flex-wrap items-center gap-2">
            {pages && pages.length > 0 && (
              <Link
                to={`/analysis?book=${encodeURIComponent(book.title)}`}
                className={buttonClass('secondary', 'sm')}
                title="Run a sentiment analysis scoped to this book"
              >
                <Gauge className="h-4 w-4" />
                Analyse
              </Link>
            )}
            {isMember && pages && pages.length > 0 && (
              <Button variant="secondary" size="sm" onClick={exportTxt} title="Download the full transcription as a .txt">
                <Download className="h-4 w-4" />
                Download
              </Button>
            )}
            {isMember && (
              <Button
                variant="secondary"
                size="sm"
                onClick={toggleHidden}
                disabled={managing}
                title={book.hidden ? 'Put this book back in the library' : 'Take this book off the library and out of analysis'}
              >
                {book.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {book.hidden ? 'Unhide' : 'Hide'}
              </Button>
            )}
            {isMember && (
              <Button variant="danger" size="sm" onClick={onDelete} disabled={managing} title="Permanently delete this book's data">
                <Trash className="h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {opError && (
        <div className="mb-4">
          <ErrorBox message={opError} />
        </div>
      )}

      {book?.hidden && (
        <p className="mb-5 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          This book is hidden. It's off the library and out of analysis until you unhide it.
        </p>
      )}

      {error && <ErrorBox message={error} />}
      {notFound && <EmptyState>This book hasn't been transcribed yet. Start it from the library, then refresh.</EmptyState>}
      {!error && !notFound && !pages && <Loading label="Loading scenes…" />}
      {pages && pages.length === 0 && (
        <EmptyState>No pages yet. If the book was just added, its transcription is still running.</EmptyState>
      )}

      {pages && pages.length > 0 && (
        <Card className="divide-y divide-border overflow-hidden">
          {pages.map((p) => (
            <PageRowItem key={p.id} book={name} page={p} />
          ))}
        </Card>
      )}
    </div>
  );
}

function PageRowItem({ book, page }: { book: string; page: PageRow }) {
  const isMember = useIsMember();
  const tags = parseTags(page.tags);
  const [imgOk, setImgOk] = useState(true);

  // The single-scene view is a member surface: it exists to read and edit one
  // scene closely, and a guest has nothing to do there. Rows stay visible — the
  // structure of a book is public — but they stop being links.
  const Row = isMember ? Link : 'div';
  const rowProps = isMember
    ? { to: `/book/${encodeURIComponent(book)}/page/${page.page_number}` }
    : {};

  return (
    <Row
      {...(rowProps as { to: string })}
      className={
        'block px-3 py-3 sm:px-4' + (isMember ? ' transition-colors hover:bg-surface-2' : '')
      }
    >
      <div className="flex items-center gap-3 sm:gap-4">
        {/* Guests get the cover and nothing else, so the per-scene thumbnails
            would be a row of 403s. Show the placeholder rather than asking. */}
        <div className="hidden h-12 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2 sm:block">
          {imgOk && isMember ? (
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
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{snippet(page, !isMember)}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {page.is_edited && <Badge tone="accent">edited</Badge>}
          {tags.map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </span>
      </div>
    </Row>
  );
}
