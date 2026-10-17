import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { BookRow } from '../types';
import { Loading, ErrorBox, EmptyState, Badge, Button, Card, buttonClass } from '../components/ui';
import { Search, BookOpen, Plus, Upload, Eye, EyeOff, Trash, X } from '../components/icons';
import { useIsMember } from '../lib/session';

/** The Batch API's per-request PDF limit; anything larger would fail after the upload. */
const MAX_PDF_BYTES = 32 * 1024 * 1024;

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function Library() {
  const isMember = useIsMember();
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const reload = useCallback(() => {
    return api
      .getLibrary()
      .then((d) => setBooks(d.books))
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Only members are sent hidden books at all; this just keeps them out of the
  // way until asked for.
  const hiddenCount = useMemo(() => (books ?? []).filter((b) => b.hidden).length, [books]);
  const visibleCount = (books?.length ?? 0) - hiddenCount;

  const filtered = useMemo(() => {
    let list = books ?? [];
    if (!showHidden) list = list.filter((b) => !b.hidden);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((b) => b.title.toLowerCase().includes(q));
    return list;
  }, [books, query, showHidden]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setOpError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await reload();
    } catch (e) {
      setOpError(errorText(e));
    }
  }

  const onHide = (b: BookRow, hidden: boolean) =>
    act(() => api.setBookHidden(b.drive_file_id, hidden), hidden ? `Hid “${b.title}”.` : `“${b.title}” is back in the library.`);

  const onDelete = (b: BookRow) => {
    const fromDrive = !b.drive_file_id.startsWith('upload:');
    const ok = window.confirm(
      `Permanently delete “${b.title}”?\n\nThis erases its transcription, edits, tags, scores and images. It can't be undone.` +
        (fromDrive ? '\n\nThe PDF is still in Drive, so the book will come back as untranscribed. Hide it if you want it gone from the library.' : ''),
    );
    if (!ok) return;
    void act(() => api.deleteBook(b.drive_file_id), `Deleted “${b.title}”.`);
  };

  const onTranscribe = (b: BookRow) =>
    act(
      () => api.transcribeBook(b.drive_file_id),
      `“${b.title}” is queued for transcription. Batches take about an hour, and it opens once the text is in.`,
    );

  if (error) return <ErrorBox message={`Couldn't load library: ${error}`} />;
  if (!books) return <Loading label="Loading library…" />;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">Library</h1>
          <p className="mt-1 text-sm text-muted">
            {visibleCount} book{visibleCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles…"
              className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:w-64"
            />
          </div>
          {isMember && (
            <Button variant="primary" onClick={() => setShowAdd((v) => !v)}>
              <Plus className="h-4 w-4" />
              Add book
            </Button>
          )}
        </div>
      </div>

      {isMember && showAdd && (
        <AddBookPanel
          onClose={() => setShowAdd(false)}
          onAdded={(title) => {
            setShowAdd(false);
            setNotice(`“${title}” is uploaded and queued for transcription. Batches take about an hour.`);
            void reload();
          }}
        />
      )}

      {isMember && hiddenCount > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
              showHidden ? 'border-accent bg-accent text-accent-ink' : 'border-border bg-surface text-muted hover:text-ink'
            }`}
          >
            <EyeOff className="h-3.5 w-3.5" />
            {showHidden ? 'Showing hidden' : 'Show hidden'} <span className={showHidden ? '' : 'text-faint'}>{hiddenCount}</span>
          </button>
        </div>
      )}

      {notice && <p className="mb-4 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-ink">{notice}</p>}
      {opError && (
        <div className="mb-4">
          <ErrorBox message={opError} />
        </div>
      )}

      {books.length === 0 ? (
        <EmptyState>No books yet.</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No books match.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((b) => (
            <BookCard
              key={b.drive_file_id}
              book={b}
              isMember={isMember}
              onHide={onHide}
              onDelete={onDelete}
              onTranscribe={onTranscribe}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BookCard({
  book,
  isMember,
  onHide,
  onDelete,
  onTranscribe,
}: {
  book: BookRow;
  isMember: boolean;
  onHide: (b: BookRow, hidden: boolean) => Promise<void>;
  onDelete: (b: BookRow) => void;
  onTranscribe: (b: BookRow) => Promise<void>;
}) {
  const isPending = book.id < 0 || book.status === 'pending';
  const [imgOk, setImgOk] = useState(true);
  const [busy, setBusy] = useState(false);
  // Guests read a book's structure and analyse it, but nothing on a card is a
  // destination for them, so the card is a plain tile rather than a link.
  const linked = isMember && !isPending;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const inner = (
    <>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-surface-2 shadow-card">
        {imgOk && !isPending ? (
          <img
            src={api.pageImageUrl(book.title, 1)}
            alt=""
            loading="lazy"
            onError={() => setImgOk(false)}
            className={
              'h-full w-full object-cover' + (linked ? ' transition-transform duration-300 group-hover:scale-[1.03]' : '')
            }
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <BookOpen className="h-7 w-7 text-faint" />
            <span className="line-clamp-2 font-serif text-sm text-muted">{book.title}</span>
          </div>
        )}
        {book.hidden && (
          <span className="absolute left-2 top-2">
            <Badge tone="neutral">
              <EyeOff className="h-3 w-3" />
              hidden
            </Badge>
          </span>
        )}
      </div>
      <div className="mt-2.5 px-0.5">
        <h2 className="line-clamp-2 font-serif text-[0.95rem] font-medium leading-snug text-ink">{book.title}</h2>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted">
          {book.page_count != null && <span>{book.page_count} scenes</span>}
          {book.status === 'transcribing' && <Badge tone="neutral">transcribing</Badge>}
          {isPending && <span>not transcribed</span>}
        </p>
      </div>
    </>
  );

  return (
    <li className={book.hidden ? 'opacity-60' : ''}>
      {linked ? (
        <Link
          to={`/book/${encodeURIComponent(book.title)}`}
          className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {inner}
        </Link>
      ) : (
        <div className={isPending ? 'opacity-70' : ''}>{inner}</div>
      )}

      {isMember && (
        <div className="mt-2 flex flex-wrap items-center gap-1 px-0.5">
          {isPending && !book.hidden && (
            <CardAction onClick={() => run(() => onTranscribe(book))} disabled={busy} title="Transcribe this book with the Batch API">
              {busy ? 'Submitting…' : 'Transcribe'}
            </CardAction>
          )}
          <CardAction
            onClick={() => run(() => onHide(book, !book.hidden))}
            disabled={busy}
            title={book.hidden ? 'Put this book back in the library' : 'Take this book off the library and out of analysis'}
          >
            {book.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {book.hidden ? 'Unhide' : 'Hide'}
          </CardAction>
          {book.id >= 0 && book.status !== 'transcribing' && (
            <CardAction onClick={() => onDelete(book)} disabled={busy} title="Permanently delete this book's data" danger>
              <Trash className="h-3.5 w-3.5" />
              Delete
            </CardAction>
          )}
        </div>
      )}
    </li>
  );
}

function CardAction({
  children,
  danger,
  ...props
}: { children: ReactNode; danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        danger ? 'text-muted hover:bg-danger-soft hover:text-danger' : 'text-muted hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function AddBookPanel({ onClose, onAdded }: { onClose: () => void; onAdded: (title: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      setError('Pick a PDF.');
      return;
    }
    if (f.size > MAX_PDF_BYTES) {
      setError(`That PDF is ${(f.size / 1024 / 1024).toFixed(1)} MB. The transcription service takes up to 32 MB.`);
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ''));
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const pdfBase64 = await readAsBase64(file);
      const r = await api.uploadBook({ fileName: file.name, title: title.trim() || undefined, pdfBase64 });
      onAdded(r.book.title);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-lg font-semibold text-ink">Add a book</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Upload a PDF of the book, one spread per page, the same as the Drive scans. It's transcribed with the Batch
            API, which takes about an hour. Books in the Drive folder that haven't been transcribed yet show up below
            with a <span className="font-medium text-ink">Transcribe</span> button instead.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className={buttonClass('secondary')}>
          <Upload className="h-4 w-4" />
          {file ? file.name : 'Choose PDF'}
        </button>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            className="h-10 w-72 max-w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <Button variant="primary" onClick={submit} disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Upload and transcribe'}
        </Button>
      </div>
      {busy && (
        <p className="mt-3 text-xs text-muted">Rendering the pages and submitting the batch. This can take a minute.</p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Card>
  );
}
