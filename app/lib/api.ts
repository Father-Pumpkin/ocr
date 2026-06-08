import type { BookRow, PageRow } from '../types';

/**
 * Thin typed wrappers over the local HTTP backend. All paths are relative so
 * Vite's dev proxy (and same-origin in prod) routes them to the Node server.
 */

class ApiError extends Error {
  status: number;
  authRequired: boolean;
  constructor(message: string, status: number, authRequired = false) {
    super(message);
    this.status = status;
    this.authRequired = authRequired;
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
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
          authRequired = Boolean(body?.authRequired);
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(message, res.status, authRequired);
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

export interface DriveStatus {
  connected: boolean;
  connecting: boolean;
  connectable?: boolean;
  reason?: string;
}

export const api = {
  getMe: () => request<{ email: string | null }>('/api/me'),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  getLibrary: () => request<{ books: BookRow[] }>('/api/library'),

  getModels: () => request<{ models: string[]; default: string }>('/api/models'),

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

  retranscribePage: (name: string, n: number, model?: string) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages/${n}/retranscribe`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

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
};
