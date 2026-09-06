import type {
  BookRow,
  PageRow,
  OcrRun,
  AnalysisOptions,
  AnalysisQuery,
  AnalysisRun,
  AnalyzeResult,
  DimensionRow,
  ExportFormat,
  LexiconPreview,
  LexiconSummary,
  RunMode,
  ScoringEstimate,
  SeedOutcome,
  SentimentBatch,
} from '../types';

/**
 * Thin typed wrappers over the local HTTP backend. All paths are relative so
 * Vite's dev proxy (and same-origin in prod) routes them to the Node server.
 */

class ApiError extends Error {
  status: number;
  authRequired: boolean;
  /** True when the server refused because the account isn't on the allowlist. */
  memberRequired: boolean;
  constructor(message: string, status: number, authRequired = false, memberRequired = false) {
    super(message);
    this.status = status;
    this.authRequired = authRequired;
    this.memberRequired = memberRequired;
  }
}

export { ApiError };

/** Full-page login link (a server redirect flow, not a fetch). */
export const LOGIN_URL = '/api/auth/google/login';

// --- Cold-start resilience -------------------------------------------------
// On the free hosting tier the server sleeps after ~15 min idle and can take up
// to a minute to wake. We retry transient failures (network error / timeout /
// 502-504) on idempotent GETs with backoff, and surface a "waking" signal so
// the UI can reassure the user. Non-GET requests are never retried (avoids
// double-submitting writes); by then the initial GETs have warmed the server.
let wakingHandler: ((waking: boolean) => void) | null = null;
export function setWakingHandler(fn: ((waking: boolean) => void) | null): void {
  wakingHandler = fn;
}
function setWaking(waking: boolean): void {
  try {
    wakingHandler?.(waking);
  } catch {
    /* ignore */
  }
}

const RETRY_DELAYS_MS = [1500, 3000, 6000, 8000, 8000, 8000]; // ~35s of retries
const ATTEMPT_TIMEOUT_MS = 25000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTransientStatus = (s: number) => s === 502 || s === 503 || s === 504;

async function fetchOnce(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    return await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const idempotent = !init?.method || init.method.toUpperCase() === 'GET';
  const maxRetries = idempotent ? RETRY_DELAYS_MS.length : 0;
  let signalledWaking = false;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchOnce(path, init);

      // Gateway error during a cold start — back off and retry.
      if (isTransientStatus(res.status) && attempt < maxRetries) {
        signalledWaking = true;
        setWaking(true);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (signalledWaking) setWaking(false);

      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        let authRequired = false;
        let memberRequired = false;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
          authRequired = Boolean(body?.authRequired);
          memberRequired = Boolean(body?.memberRequired);
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(message, res.status, authRequired, memberRequired);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      // A real HTTP error response — surface it (don't retry 4xx, esp. 401).
      if (err instanceof ApiError) {
        if (signalledWaking) setWaking(false);
        throw err;
      }
      // Network error / timeout / abort — retry if attempts remain.
      if (attempt < maxRetries) {
        signalledWaking = true;
        setWaking(true);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      setWaking(false);
      throw new ApiError('Could not reach the server. It may be waking up — please retry in a moment.', 0);
    }
  }
}

const enc = encodeURIComponent;

/**
 * Serialize an analysis scope into a query string. Repeats a param per value
 * (`?books=a&books=b`) rather than joining, so titles containing commas survive.
 */
function analysisQuery(q: AnalysisQuery): string {
  const params = new URLSearchParams();
  for (const key of ['books', 'dimensions', 'methods', 'tags'] as const) {
    for (const v of q[key] ?? []) params.append(key, v);
  }
  if (q.groupBy) params.set('groupBy', q.groupBy);
  if (q.aggregate) params.set('aggregate', q.aggregate);
  if (q.pageStart !== undefined) params.set('pageStart', String(q.pageStart));
  if (q.pageEnd !== undefined) params.set('pageEnd', String(q.pageEnd));
  return params.toString();
}

/** Body of a scoring run — a style plus the scope it should cover. */
export interface RunRequest extends AnalysisQuery {
  style: string;
  /** Omit to follow the estimate's recommendation; set to override it. */
  mode?: RunMode;
  rubric?: string;
  rubricName?: string;
  negation?: boolean;
  overwrite?: boolean;
}

export interface DriveStatus {
  connected: boolean;
  connecting: boolean;
  connectable?: boolean;
  reason?: string;
}

export const api = {
  /** Identity + tier. `role` decides which controls the UI offers. */
  getMe: () => request<{ email: string | null; role: 'member' | 'guest' }>('/api/me'),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  getLibrary: () => request<{ books: BookRow[] }>('/api/library'),

  getModels: () => request<{ models: string[]; default: string }>('/api/models'),

  getTags: () => request<{ tags: string[] }>('/api/tags'),

  getDriveStatus: () => request<DriveStatus>('/api/auth/drive/status'),
  connectDrive: () => request<{ started: boolean }>('/api/auth/drive/connect', { method: 'POST' }),
  disconnectDrive: () => request<{ connected: boolean }>('/api/auth/drive/disconnect', { method: 'POST' }),

  getBookPages: (name: string) =>
    request<{ book: BookRow; pages: PageRow[] }>(`/api/books/${enc(name)}/pages`),

  /** URL for a page's image — use directly as <img src>. */
  pageImageUrl: (name: string, n: number) => `/api/books/${enc(name)}/pages/${n}/image`,

  setPageImage: (name: string, n: number, imageBase64: string) =>
    request<{ ok: true }>(`/api/books/${enc(name)}/pages/${n}/image`, {
      method: 'PUT',
      body: JSON.stringify({ imageBase64 }),
    }),

  updatePage: (name: string, n: number, body: { transcription?: string; tags?: string[] }) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages/${n}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  /** Re-runs OCR and returns the candidate run (does not change the page text). */
  retranscribePage: (name: string, n: number, model?: string) =>
    request<{ run: OcrRun; page: PageRow }>(`/api/books/${enc(name)}/pages/${n}/retranscribe`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  /** OCR run history for a page (oldest first; first element is the original). */
  getOcrRuns: (name: string, n: number) =>
    request<{ runs: OcrRun[] }>(`/api/books/${enc(name)}/pages/${n}/ocr-runs`),

  verifyPage: (name: string, n: number) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages/${n}/verify`, { method: 'POST' }),

  verifyBook: (name: string) =>
    request<{ total: number; flagged: number; quality: string; note: string | null; pages: PageRow[] }>(
      `/api/books/${enc(name)}/verify`,
      { method: 'POST' },
    ),

  insertPage: (name: string, afterPageNumber: number) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages`, {
      method: 'POST',
      body: JSON.stringify({ afterPageNumber }),
    }),

  deletePage: (name: string, n: number) =>
    request<{ ok: true }>(`/api/books/${enc(name)}/pages/${n}`, { method: 'DELETE' }),

  markPageOk: (name: string, n: number) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages/${n}/mark-ok`, { method: 'POST' }),

  splitPage: (name: string, n: number, body: { leftText: string; rightText: string; ratio: number }) =>
    request<{ left: PageRow; right: PageRow }>(`/api/books/${enc(name)}/pages/${n}/split`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  renameBook: (name: string, title: string) =>
    request<{ book: BookRow }>(`/api/books/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  setIllustration: (name: string, n: number, isIllustration: boolean) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages/${n}/illustration`, {
      method: 'POST',
      body: JSON.stringify({ isIllustration }),
    }),

  // --- Sentiment analysis ---------------------------------------------------

  /** Styles, dimensions, books, tags and the server's call limit, in one call. */
  getAnalysisOptions: () => request<AnalysisOptions>('/api/analysis/options'),

  /** Size a run (pages, calls, whether it exceeds the cap) without spending. */
  estimateAnalysis: (body: RunRequest) =>
    request<ScoringEstimate>('/api/analysis/estimate', { method: 'POST', body: JSON.stringify(body) }),

  /** Start scoring. Returns immediately — poll getAnalysisRun for progress. */
  startAnalysisRun: (body: RunRequest) =>
    request<{ run: AnalysisRun }>('/api/analysis/runs', { method: 'POST', body: JSON.stringify(body) }),

  getAnalysisRun: (id: string) => request<{ run: AnalysisRun }>(`/api/analysis/runs/${enc(id)}`),

  getAnalysisResults: (q: AnalysisQuery) =>
    request<AnalyzeResult>(`/api/analysis/results?${analysisQuery(q)}`),

  /** Download href — a plain link so the browser handles the file save. */
  analysisExportUrl: (q: AnalysisQuery, format: ExportFormat) =>
    `/api/analysis/export?${analysisQuery(q)}&format=${enc(format)}`,

  createDimension: (body: { name: string; description: string; minLabel?: string; maxLabel?: string }) =>
    request<{ dimension: DimensionRow }>('/api/analysis/dimensions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteDimension: (name: string) =>
    request<{ ok: true }>(`/api/analysis/dimensions/${enc(name)}`, { method: 'DELETE' }),

  /** Parse an uploaded dictionary's structure so its columns can be mapped. */
  previewLexicon: (body: { content: string; fileName: string; delimiter?: string; hasHeader?: boolean }) =>
    request<LexiconPreview>('/api/analysis/lexicons/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  uploadLexicon: (body: {
    name: string;
    fileName: string;
    content: string;
    termColumn: string;
    valueColumns: Record<string, string>;
    /** Word lists: every term takes this value on `dimension`. */
    fixedValue?: number;
    dimension?: string;
    /** Add to an existing lexicon — the other half of a polarity pair. */
    appendToExisting?: boolean;
    scaleMin: number;
    scaleMax: number;
    delimiter?: string;
    /** Force the header decision when detection gets an odd file wrong. */
    hasHeader?: boolean;
    /** Map non-numeric value cells to numbers, e.g. {"POSITIVE": 1, "NEGATIVE": -1}. */
    labelValues?: Record<string, number>;
    note?: string;
    negation?: boolean;
  }) =>
    request<{ lexicon: LexiconSummary; inserted: number; perDimension: Record<string, number> }>(
      '/api/analysis/lexicons',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteLexicon: (name: string) =>
    request<{ ok: true }>(`/api/analysis/lexicons/${enc(name)}`, { method: 'DELETE' }),

  /** Sentiment batches in flight — DB-backed, so they survive a reload. */
  getBatches: () => request<{ batches: SentimentBatch[] }>('/api/analysis/batches'),

  checkBatch: (batchId: string) =>
    request<{ status: string; processedCount: number; summary: string }>(
      `/api/analysis/batches/${enc(batchId)}/check`,
      { method: 'POST' },
    ),

  /** Score the whole library with every loaded dictionary. Local and free. */
  prewarmLexicons: (overwrite = false) =>
    request<{ run: AnalysisRun }>('/api/analysis/prewarm', {
      method: 'POST',
      body: JSON.stringify({ overwrite }),
    }),

  /** Re-scan the lexicons folder on the server. */
  seedLexicons: () =>
    request<{ outcomes: SeedOutcome[] }>('/api/analysis/lexicons/seed', { method: 'POST' }),
};
