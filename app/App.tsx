import { useEffect, useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './pages/Library';
import { BookDetail } from './pages/BookDetail';
import { PageEditor } from './pages/PageEditor';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DriveStatus } from './components/DriveStatus';
import { AuthGate } from './components/AuthGate';
import { api, setWakingHandler } from './lib/api';

export function App() {
  return (
    <>
      <WakingBanner />
      <AuthGate>
        {(user) => (
          <div className="min-h-screen bg-slate-50 text-slate-900">
            <header className="border-b border-slate-200 bg-white">
              <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
                <Link to="/" className="text-lg font-semibold tracking-tight">
                  OCR Tool
                </Link>
                <UserMenu email={user.email} />
              </div>
            </header>
            <main className="mx-auto max-w-5xl px-6 py-6">
              <DriveStatus onConnected={() => window.location.reload()} />
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<Library />} />
                  <Route path="/book/:name" element={<BookDetail />} />
                  <Route path="/book/:name/page/:n" element={<PageEditor />} />
                </Routes>
              </ErrorBoundary>
            </main>
          </div>
        )}
      </AuthGate>
    </>
  );
}

function UserMenu({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      /* ignore — clear client state regardless */
    }
    window.location.href = '/';
  }
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500">
      {email && <span className="hidden sm:inline">{email}</span>}
      <button
        onClick={signOut}
        disabled={busy}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

/**
 * Fixed banner shown while the API client is retrying a request — i.e. the free
 * tier's server is cold-starting. Mounted above the gate so it's visible during
 * the initial /api/me call too.
 */
function WakingBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    setWakingHandler(setWaking);
    return () => setWakingHandler(null);
  }, []);
  if (!waking) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">
      Waking up the server… this can take up to a minute on the free tier.
    </div>
  );
}
