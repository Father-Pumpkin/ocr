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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
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
}

const enc = encodeURIComponent;

export { ApiError };

export const api = {
  getLibrary: () => request<{ books: BookRow[] }>('/api/library'),

  getBookPages: (name: string) =>
    request<{ book: BookRow; pages: PageRow[] }>(`/api/books/${enc(name)}/pages`),

  /** URL for a page's image — use directly as <img src>. */
  pageImageUrl: (name: string, n: number) => `/api/books/${enc(name)}/pages/${n}/image`,

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

  insertPage: (name: string, afterPageNumber: number) =>
    request<{ page: PageRow }>(`/api/books/${enc(name)}/pages`, {
      method: 'POST',
      body: JSON.stringify({ afterPageNumber }),
    }),

  deletePage: (name: string, n: number) =>
    request<{ ok: true }>(`/api/books/${enc(name)}/pages/${n}`, { method: 'DELETE' }),
};
