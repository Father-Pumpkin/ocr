import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import './styles.css';

// ── Types ──────────────────────────────────────────────────────────────────

interface Book {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: 'pending' | 'transcribing' | 'complete' | 'error';
  created_at: string;
  updated_at: string;
}

interface Page {
  id: number;
  book_id: number;
  page_number: number;
  transcription: string | null;
  has_illustration: number; // SQLite 0 | 1
  is_edited: number;        // SQLite 0 | 1
  tags: string[];           // parsed from JSON in DB
  status: string;
  batch_custom_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const PRESET_TAGS = [
  'first page of content',
  'character introduction',
  'inciting incident',
  'rising action',
  'climax',
  'falling action',
  'resolution',
];

// ── State ──────────────────────────────────────────────────────────────────

interface State {
  view: 'library' | 'book';
  books: Book[];
  transcribingBooks: Set<string>; // book titles currently being transcribed
  currentBook: Book | null;
  currentPages: Page[];
  loadingPages: boolean;
  editingPage: number | null;
  tagPickerPage: number | null; // page_number with open tag picker
}

const state: State = {
  view: 'library',
  books: [],
  transcribingBooks: new Set(),
  currentBook: null,
  currentPages: [],
  loadingPages: false,
  editingPage: null,
  tagPickerPage: null,
};

// ── App instance ───────────────────────────────────────────────────────────

const mcpApp = new App({ name: 'Transcription Viewer', version: '1.0.0' });

function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

mcpApp.onhostcontextchanged = handleHostContextChanged;
mcpApp.onerror = console.error;

// Initial tool result: library push from view_transcriptions
mcpApp.ontoolresult = (result: CallToolResult) => {
  const data = result.structuredContent as { books?: Book[] } | undefined;
  if (data?.books) {
    state.books = data.books;
    renderLibrary();
  }
};

mcpApp.connect().then(() => {
  const ctx = mcpApp.getHostContext();
  if (ctx) handleHostContextChanged(ctx);
});

// ── Utilities ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_LABEL: Record<string, string> = {
  complete:     'Transcribed',
  transcribing: 'In Progress',
  pending:      'Not Started',
  error:        'Error',
};

function makeBadge(status: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `badge badge-${status}`;
  el.textContent = STATUS_LABEL[status] ?? status;
  return el;
}

function toast(msg: string, type: 'ok' | 'err' = 'ok'): void {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.getElementById('toasts')!.append(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Library view ───────────────────────────────────────────────────────────

function renderLibrary(): void {
  state.view = 'library';
  state.currentBook = null;
  state.currentPages = [];
  state.editingPage = null;
  state.tagPickerPage = null;

  const app = document.getElementById('app')!;
  app.innerHTML = '';

  const header = document.createElement('header');
  header.innerHTML = '<h1>Transcription Viewer</h1>';
  app.append(header);

  const main = document.createElement('main');
  app.append(main);

  const viewHeader = document.createElement('div');
  viewHeader.className = 'view-header';
  viewHeader.innerHTML = `
    <h2>My Library</h2>
    <span class="sub">${state.books.length} book${state.books.length !== 1 ? 's' : ''}</span>
  `;
  main.append(viewHeader);

  if (state.books.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div class="icon">📚</div><p>No books yet. Use <code>transcribe_books</code> to get started.</p>';
    main.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'books-grid';
  for (const book of state.books) {
    grid.append(buildBookCard(book));
  }
  main.append(grid);
}

function buildBookCard(book: Book): HTMLElement {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.id = `book-card-${book.id}`;

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = book.title;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const pagesLbl = document.createElement('span');
  pagesLbl.className = 'pages-lbl';
  pagesLbl.textContent = book.page_count != null ? `${book.page_count} pages` : '—';
  meta.append(makeBadge(book.status), pagesLbl);

  card.append(title, meta);

  // Click on card body → open book (if transcribed)
  if (book.status === 'complete') {
    card.addEventListener('click', () => openBook(book));
  }

  // Transcribe button for non-complete books
  if (book.status !== 'complete') {
    const btn = document.createElement('button');
    btn.className = 'transcribe-btn';
    const isTranscribing = state.transcribingBooks.has(book.title);
    btn.textContent = isTranscribing ? '⏳ Transcribing…' : 'Transcribe';
    btn.disabled = isTranscribing;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerTranscription(book);
    });
    card.append(btn);
  }

  return card;
}

async function refreshLibrary(): Promise<void> {
  try {
    const result = await mcpApp.callServerTool({ name: 'view_transcriptions', arguments: {} });
    const data = result.structuredContent as { books?: Book[] } | undefined;
    if (data?.books) state.books = data.books;
  } catch {
    // Silently keep existing books on error
  }
  renderLibrary();
}

async function triggerTranscription(book: Book): Promise<void> {
  state.transcribingBooks.add(book.title);
  updateBookCard(book);
  toast(`Transcribing "${book.title}"… this may take a few minutes.`);

  try {
    await mcpApp.callServerTool({
      name: 'transcribe_books',
      arguments: { book_names: [book.title], use_batch: false, overwrite: false },
    });
    toast(`"${book.title}" transcribed successfully.`);
  } catch (err) {
    toast(`Transcription failed: ${(err as Error).message}`, 'err');
  } finally {
    state.transcribingBooks.delete(book.title);
    await refreshLibrary();
  }
}

/** Rebuild and swap just one book card without re-rendering the whole grid. */
function updateBookCard(book: Book): void {
  const existing = document.getElementById(`book-card-${book.id}`);
  if (!existing) return;
  existing.replaceWith(buildBookCard(book));
}

// ── Book view ──────────────────────────────────────────────────────────────

async function openBook(book: Book): Promise<void> {
  state.view = 'book';
  state.currentBook = book;
  state.currentPages = [];
  state.editingPage = null;
  state.tagPickerPage = null;
  state.loadingPages = true;

  renderBookShell();

  try {
    const result = await mcpApp.callServerTool({
      name: 'get_transcription',
      arguments: { book_name: book.title, include_illustrations: true },
    });
    state.currentPages = extractPages(result);
  } catch (err) {
    toast(`Failed to load pages: ${(err as Error).message}`, 'err');
  } finally {
    state.loadingPages = false;
  }

  renderBookPages();
}

function renderBookShell(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';

  const header = document.createElement('header');
  const crumbLib = document.createElement('span');
  crumbLib.className = 'crumb crumb-link';
  crumbLib.textContent = 'Library';
  crumbLib.addEventListener('click', renderLibrary);
  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.textContent = ' / ';
  const crumbTitle = document.createElement('h1');
  crumbTitle.textContent = state.currentBook!.title;
  header.append(crumbLib, sep, crumbTitle);
  app.append(header);

  const main = document.createElement('main');
  main.id = 'book-main';
  app.append(main);

  const bookHeader = document.createElement('div');
  bookHeader.className = 'book-header';
  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', renderLibrary);
  const titleEl = document.createElement('h2');
  titleEl.textContent = state.currentBook!.title;
  bookHeader.append(backBtn, titleEl, makeBadge(state.currentBook!.status));
  main.append(bookHeader);

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.id = 'pages-spinner';
  spinner.textContent = 'Loading pages…';
  main.append(spinner);
}

function renderBookPages(): void {
  const main = document.getElementById('book-main');
  if (!main) return;
  document.getElementById('pages-spinner')?.remove();

  if (state.currentPages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<p>No pages transcribed yet.</p>';
    main.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'pages-list';
  list.id = 'pages-list';
  for (const page of state.currentPages) {
    list.append(buildPageItem(page));
  }
  main.append(list);
}

// ── Page item ──────────────────────────────────────────────────────────────

function buildPageItem(page: Page): HTMLElement {
  const isEditing    = state.editingPage === page.page_number;
  const isTagPicker  = state.tagPickerPage === page.page_number;
  const isIllus      = page.has_illustration === 1;
  const isEdited     = page.is_edited === 1;

  const item = document.createElement('div');
  item.className = 'page-item';
  item.id = `page-${page.page_number}`;

  // ── Head ──────────────────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'page-head';

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `Page ${page.page_number}`;
  if (isEdited) {
    const eb = document.createElement('span');
    eb.className = 'badge badge-edited';
    eb.textContent = 'Edited';
    label.append(eb);
  }

  const actions = document.createElement('div');
  actions.className = 'page-actions';

  if (isEditing) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-save';
    saveBtn.id = `save-${page.page_number}`;
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => doSave(page));

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      state.editingPage = null;
      refreshPage(page);
    });
    actions.append(saveBtn, cancelBtn);
  } else {
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-edit';
    editBtn.textContent = '✎ Edit';
    editBtn.addEventListener('click', () => {
      state.editingPage = page.page_number;
      state.tagPickerPage = null;
      refreshPage(page);
      requestAnimationFrame(() => {
        document.getElementById(`ta-${page.page_number}`)?.focus();
        document.getElementById(`page-${page.page_number}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    actions.append(editBtn);
  }

  head.append(label, actions);
  item.append(head);

  // ── Tags section ──────────────────────────────────────────────────────────
  const tagsSection = buildTagsSection(page, isTagPicker);
  item.append(tagsSection);

  // ── Tag picker ────────────────────────────────────────────────────────────
  if (isTagPicker) {
    item.append(buildTagPicker(page));
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'page-body';

  if (isEditing) {
    const ta = document.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.id = `ta-${page.page_number}`;
    ta.value = isIllus ? '' : (page.transcription ?? '');
    body.append(ta);
  } else if (isIllus) {
    const ph = document.createElement('div');
    ph.className = 'illus-placeholder';
    ph.textContent = '🖼 Illustration only';
    body.append(ph);
  } else {
    const txt = document.createElement('div');
    txt.className = 'transcription';
    txt.textContent = page.transcription ?? '';
    body.append(txt);
  }

  item.append(body);
  return item;
}

function buildTagsSection(page: Page, pickerOpen: boolean): HTMLElement {
  const section = document.createElement('div');
  section.className = 'tags-section';

  for (const tag of page.tags) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tag-remove';
    removeBtn.title = 'Remove tag';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => doRemoveTag(page, tag));

    chip.append(removeBtn);
    section.append(chip);
  }

  if (!pickerOpen) {
    const addBtn = document.createElement('button');
    addBtn.className = 'add-tag-btn';
    addBtn.textContent = '+ Tag';
    addBtn.addEventListener('click', () => {
      state.tagPickerPage = page.page_number;
      state.editingPage = null;
      refreshPage(page);
      requestAnimationFrame(() =>
        document.getElementById(`tag-input-${page.page_number}`)?.focus()
      );
    });
    section.append(addBtn);
  }

  return section;
}

function buildTagPicker(page: Page): HTMLElement {
  const picker = document.createElement('div');
  picker.className = 'tag-picker';

  const label = document.createElement('div');
  label.className = 'tag-picker-label';
  label.textContent = 'Add tag';
  picker.append(label);

  // Preset tags (exclude ones already applied)
  const presets = PRESET_TAGS.filter((t) => !page.tags.includes(t));
  if (presets.length > 0) {
    const presetRow = document.createElement('div');
    presetRow.className = 'preset-tags';
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'preset-tag';
      btn.textContent = preset;
      btn.addEventListener('click', () => doAddTag(page, preset));
      presetRow.append(btn);
    }
    picker.append(presetRow);
  }

  // Custom tag input
  const customRow = document.createElement('div');
  customRow.className = 'tag-custom-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.id = `tag-input-${page.page_number}`;
  input.placeholder = 'Custom tag…';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      if (val) doAddTag(page, val);
    } else if (e.key === 'Escape') {
      state.tagPickerPage = null;
      refreshPage(page);
    }
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tag-input-add';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const val = input.value.trim();
    if (val) doAddTag(page, val);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'tag-picker-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    state.tagPickerPage = null;
    refreshPage(page);
  });

  customRow.append(input, addBtn, cancelBtn);
  picker.append(customRow);
  return picker;
}

function refreshPage(page: Page): void {
  const existing = document.getElementById(`page-${page.page_number}`);
  if (!existing) return;
  existing.replaceWith(buildPageItem(page));
}

// ── Tag actions ────────────────────────────────────────────────────────────

async function doAddTag(page: Page, tag: string): Promise<void> {
  if (page.tags.includes(tag)) {
    state.tagPickerPage = null;
    refreshPage(page);
    return;
  }
  const newTags = [...page.tags, tag];
  await saveTagsForPage(page, newTags);
}

async function doRemoveTag(page: Page, tag: string): Promise<void> {
  const newTags = page.tags.filter((t) => t !== tag);
  await saveTagsForPage(page, newTags);
}

async function saveTagsForPage(page: Page, newTags: string[]): Promise<void> {
  state.tagPickerPage = null;
  try {
    await mcpApp.callServerTool({
      name: 'tag_page',
      arguments: {
        book_name: state.currentBook!.title,
        page_number: page.page_number,
        tags: newTags,
      },
    });
    page.tags = newTags;
    refreshPage(page);
  } catch (err) {
    toast(`Failed to save tags: ${(err as Error).message}`, 'err');
    refreshPage(page);
  }
}

// ── Edit save ──────────────────────────────────────────────────────────────

async function doSave(page: Page): Promise<void> {
  const ta = document.getElementById(`ta-${page.page_number}`) as HTMLTextAreaElement | null;
  const newText = ta?.value.trim() ?? '';
  if (!newText) {
    toast('Transcription cannot be empty.', 'err');
    return;
  }

  const saveBtn = document.getElementById(`save-${page.page_number}`) as HTMLButtonElement | null;
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    await mcpApp.callServerTool({
      name: 'update_page',
      arguments: {
        book_name: state.currentBook!.title,
        page_number: page.page_number,
        transcription: newText,
      },
    });
    page.transcription = newText;
    page.is_edited = 1;
    page.has_illustration = newText === '[ILLUSTRATION]' ? 1 : 0;
    state.editingPage = null;
    refreshPage(page);
    toast(`Page ${page.page_number} saved.`);
    requestAnimationFrame(() =>
      document.getElementById(`page-${page.page_number}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    );
  } catch (err) {
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    toast(`Save failed: ${(err as Error).message}`, 'err');
  }
}

// ── Parse pages from tool result ───────────────────────────────────────────

function extractPages(result: CallToolResult): Page[] {
  // Prefer structuredContent { pages: PageRow[] } from the server
  const structured = result.structuredContent as { pages?: Array<Omit<Page, 'tags'> & { tags?: string | string[] }> } | undefined;
  if (structured?.pages) {
    return structured.pages.map((p) => ({
      ...p,
      // tags comes as a JSON string from SQLite; parse it here
      tags: parseTags(p.tags),
    }));
  }

  // Fall back to parsing the text response
  const textBlock = result.content?.find((c) => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  const pages: Page[] = [];
  const regex = /---\s*Page\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*Page\s+\d+\s*---|$)/g;
  let match: RegExpExecArray | null;
  let idCounter = 0;

  while ((match = regex.exec(textBlock.text)) !== null) {
    const pageNumber = parseInt(match[1], 10);
    const transcription = match[2].trim() || null;
    pages.push({
      id: ++idCounter,
      book_id: state.currentBook!.id,
      page_number: pageNumber,
      transcription,
      has_illustration: transcription === '[ILLUSTRATION]' ? 1 : 0,
      is_edited: 0,
      tags: [],
      status: 'complete',
      batch_custom_id: null,
      created_at: '',
      updated_at: '',
    });
  }

  return pages;
}

function parseTags(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}
