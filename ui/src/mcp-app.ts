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
  has_illustration: boolean | number;
  is_edited: boolean | number;
  tags: string[];
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
  transcribingBooks: Set<string>;
  currentBook: Book | null;
  currentPages: Page[];
  loadingPages: boolean;
  editingPage: number | null;
  tagPickerPage: number | null;
  confirmingDelete: number | null; // page_number pending delete confirmation
  pageImages: Map<number, string>; // page_number -> base64 JPEG
  pageImagesLoading: Set<number>;
  currentBookDriveUrl: string | null;
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
  confirmingDelete: null,
  pageImages: new Map(),
  pageImagesLoading: new Set(),
  currentBookDriveUrl: null,
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
    empty.innerHTML = '<p>No books found. Check your Google Drive folder configuration.</p>';
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

function cardId(book: Book): string {
  return `book-card-${book.drive_file_id}`;
}

function buildBookCard(book: Book): HTMLElement {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.id = cardId(book);

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

  if (book.status === 'complete') {
    card.addEventListener('click', () => openBook(book));
  } else {
    const btn = document.createElement('button');
    btn.className = 'transcribe-btn';
    const isTranscribing = state.transcribingBooks.has(book.title);
    btn.textContent = isTranscribing ? 'Transcribing…' : 'Transcribe';
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
    // keep existing books on error
  }
  renderLibrary();
}

async function triggerTranscription(book: Book): Promise<void> {
  state.transcribingBooks.add(book.title);
  updateBookCard(book);
  toast(`Transcribing "${book.title}"…`);

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

function updateBookCard(book: Book): void {
  const existing = document.getElementById(cardId(book));
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
  state.confirmingDelete = null;
  state.loadingPages = true;
  state.pageImages = new Map();
  state.pageImagesLoading = new Set();
  state.currentBookDriveUrl = null;

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
  loadPageImages(); // fire-and-forget
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
  populatePagesList(list);
  main.append(list);
}

function populatePagesList(list: HTMLElement): void {
  list.append(buildInsertSeparator(0));
  for (const page of state.currentPages) {
    list.append(buildPageItem(page));
    list.append(buildInsertSeparator(page.page_number));
  }
}

// Re-render the pages list in place without losing scroll position
function rerenderPagesList(): void {
  const list = document.getElementById('pages-list');
  if (!list) return;
  list.innerHTML = '';
  populatePagesList(list);
}

// ── Load page images (background) ──────────────────────────────────────────

async function loadPageImages(): Promise<void> {
  if (!state.currentBook) return;
  const pages = state.currentPages;
  for (const page of pages) {
    if (!state.currentBook) break; // user navigated away
    try {
      state.pageImagesLoading.add(page.page_number);
      refreshPage(page); // show spinner immediately
      const result = await mcpApp.callServerTool({
        name: 'get_page_image',
        arguments: { book_name: state.currentBook.title, page_number: page.page_number },
      });
      const data = result.structuredContent as { imageData?: string; driveUrl?: string } | undefined;
      if (data?.imageData) {
        state.pageImages.set(page.page_number, data.imageData);
        if (!state.currentBookDriveUrl && data.driveUrl) {
          state.currentBookDriveUrl = data.driveUrl;
        }
      }
    } catch {
      // ignore per-page errors
    } finally {
      state.pageImagesLoading.delete(page.page_number);
    }
    refreshPage(page); // re-render with image
  }
}

// ── Page item ──────────────────────────────────────────────────────────────

function buildPageItem(page: Page): HTMLElement {
  const isEditing   = state.editingPage === page.page_number;
  const isTagPicker = state.tagPickerPage === page.page_number;
  const isIllus     = Boolean(page.has_illustration);
  const isEdited    = Boolean(page.is_edited);

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
  } else if (state.confirmingDelete === page.page_number) {
    const confirmMsg = document.createElement('span');
    confirmMsg.className = 'delete-confirm-msg';
    confirmMsg.textContent = 'Delete this page?';

    const yesBtn = document.createElement('button');
    yesBtn.className = 'btn btn-delete';
    yesBtn.textContent = 'Yes, delete';
    yesBtn.addEventListener('click', () => doDeletePage(page));

    const noBtn = document.createElement('button');
    noBtn.className = 'btn btn-cancel';
    noBtn.textContent = 'Cancel';
    noBtn.addEventListener('click', () => {
      state.confirmingDelete = null;
      refreshPage(page);
    });

    actions.append(confirmMsg, yesBtn, noBtn);
  } else {
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-edit';
    editBtn.textContent = 'Edit';
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

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      state.confirmingDelete = page.page_number;
      state.editingPage = null;
      state.tagPickerPage = null;
      refreshPage(page);
    });

    actions.append(editBtn, deleteBtn);
  }

  head.append(label, actions);
  item.append(head);

  // ── Two-column layout ──────────────────────────────────────────────────────
  const columns = document.createElement('div');
  columns.className = 'page-columns';

  // Left: image
  const imageCol = document.createElement('div');
  imageCol.className = 'page-image-col';

  const imageData = state.pageImages.get(page.page_number);
  const isLoadingImg = state.pageImagesLoading.has(page.page_number);

  if (imageData) {
    const img = document.createElement('img');
    img.className = 'page-img';
    img.src = `data:image/jpeg;base64,${imageData}`;
    img.alt = `Page ${page.page_number}`;
    imageCol.append(img);
  } else if (isLoadingImg) {
    const imgSpinner = document.createElement('div');
    imgSpinner.className = 'img-spinner';
    imageCol.append(imgSpinner);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'img-placeholder';
    imageCol.append(placeholder);
  }

  if (state.currentBookDriveUrl) {
    const link = document.createElement('a');
    link.className = 'drive-link';
    link.href = state.currentBookDriveUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open in Drive \u2197';
    imageCol.append(link);
  }

  // Right: tags + body
  const textCol = document.createElement('div');
  textCol.className = 'page-text-col';

  // Tags
  if (page.tags.length > 0 || isTagPicker) {
    textCol.append(buildTagsSection(page, isTagPicker));
  } else {
    textCol.append(buildTagsSection(page, false));
  }

  if (isTagPicker) {
    textCol.append(buildTagPicker(page));
  }

  // Body
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
    ph.textContent = 'Illustration only';
    body.append(ph);
  } else {
    const txt = document.createElement('div');
    txt.className = 'transcription';
    txt.textContent = page.transcription ?? '';
    body.append(txt);
  }

  textCol.append(body);

  columns.append(imageCol, textCol);
  item.append(columns);
  return item;
}

// ── Insert page ────────────────────────────────────────────────────────────

function buildInsertSeparator(afterPageNumber: number): HTMLElement {
  const sep = document.createElement('div');
  sep.className = 'insert-separator';

  const btn = document.createElement('button');
  btn.className = 'insert-btn';
  btn.textContent = afterPageNumber === 0 ? '+ Insert before page 1' : '+ Insert page here';
  btn.addEventListener('click', () => doInsertPage(afterPageNumber));

  sep.append(btn);
  return sep;
}

async function doDeletePage(page: Page): Promise<void> {
  if (!state.currentBook) return;
  state.confirmingDelete = null;
  const deletedNum = page.page_number;
  try {
    await mcpApp.callServerTool({
      name: 'delete_page',
      arguments: { book_name: state.currentBook.title, page_number: deletedNum },
    });

    // Remove page and renumber subsequent ones in place
    state.currentPages = state.currentPages.filter(p => p.page_number !== deletedNum);
    for (const p of state.currentPages) {
      if (p.page_number > deletedNum) p.page_number--;
    }

    // Shift image cache down
    state.pageImages.delete(deletedNum);
    const newImages = new Map<number, string>();
    for (const [pn, img] of state.pageImages) {
      newImages.set(pn > deletedNum ? pn - 1 : pn, img);
    }
    state.pageImages = newImages;

    rerenderPagesList();
    toast(`Page ${deletedNum} deleted.`);
  } catch (err) {
    toast(`Failed to delete page: ${(err as Error).message}`, 'err');
  }
}

async function doInsertPage(afterPageNumber: number): Promise<void> {
  if (!state.currentBook) return;
  const book = state.currentBook;
  try {
    const result = await mcpApp.callServerTool({
      name: 'insert_page',
      arguments: { book_name: book.title, after_page_number: afterPageNumber },
    });
    const data = result.structuredContent as { page_number?: number } | undefined;
    const newPageNumber = data?.page_number ?? afterPageNumber + 1;

    // Renumber existing pages >= newPageNumber in place
    for (const p of state.currentPages) {
      if (p.page_number >= newPageNumber) p.page_number++;
    }

    // Insert new blank page at correct position
    const newPage: Page = {
      id: -1,
      book_id: book.id,
      page_number: newPageNumber,
      transcription: null,
      has_illustration: false,
      is_edited: false,
      tags: [],
      status: 'pending',
      batch_custom_id: null,
      created_at: '',
      updated_at: '',
    };
    const insertIdx = state.currentPages.findIndex(p => p.page_number > newPageNumber);
    if (insertIdx === -1) state.currentPages.push(newPage);
    else state.currentPages.splice(insertIdx, 0, newPage);

    // Shift image cache up
    const newImages = new Map<number, string>();
    for (const [pn, img] of state.pageImages) {
      newImages.set(pn >= newPageNumber ? pn + 1 : pn, img);
    }
    state.pageImages = newImages;

    rerenderPagesList();
    toast(`Page inserted${afterPageNumber > 0 ? ` after page ${afterPageNumber}` : ' before page 1'}.`);
    requestAnimationFrame(() => {
      document.getElementById(`page-${newPageNumber}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch (err) {
    toast(`Failed to insert page: ${(err as Error).message}`, 'err');
  }
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
  await saveTagsForPage(page, [...page.tags, tag]);
}

async function doRemoveTag(page: Page, tag: string): Promise<void> {
  await saveTagsForPage(page, page.tags.filter((t) => t !== tag));
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
    page.is_edited = true;
    page.has_illustration = newText === '[ILLUSTRATION]';
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
  const structured = result.structuredContent as { pages?: Array<Omit<Page, 'tags'> & { tags?: string | string[] }> } | undefined;
  if (structured?.pages) {
    return structured.pages.map((p) => ({
      ...p,
      tags: parseTags(p.tags),
    }));
  }

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
      has_illustration: transcription === '[ILLUSTRATION]',
      is_edited: false,
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
