import { useEffect, useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './pages/Library';
import { BookDetail } from './pages/BookDetail';
import { PageEditor } from './pages/PageEditor';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DriveStatus } from './components/DriveStatus';
import { AuthGate } from './components/AuthGate';
import { IconButton, buttonClass } from './components/ui';
import { Sun, Moon, LogOut, BookOpen } from './components/icons';
import { api, setWakingHandler } from './lib/api';
import { getTheme, toggleTheme, type Theme } from './lib/theme';

export function App() {
  return (
    <>
      <WakingBanner />
      <AuthGate>
        {(user) => (
          <div className="min-h-screen">
            <Header email={user.email} />
            <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
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

function Header({ email }: { email: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <BookOpen className="h-5 w-5" />
          </span>
          <span className="font-serif text-xl font-semibold tracking-tight text-ink">OCR Tool</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <UserMenu email={email} />
        </div>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  return (
    <IconButton
      aria-label="Toggle light or dark theme"
      title="Toggle theme"
      onClick={() => setThemeState(toggleTheme())}
    >
      {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </IconButton>
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
    <div className="flex items-center gap-2.5">
      {email && <span className="hidden text-sm text-muted sm:inline">{email}</span>}
      <button onClick={signOut} disabled={busy} title="Sign out" className={buttonClass('ghost', 'sm')}>
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">{busy ? 'Signing out…' : 'Sign out'}</span>
      </button>
    </div>
  );
}

/** Fixed banner shown while the API client retries a cold-starting server. */
function WakingBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    setWakingHandler(setWaking);
    return () => setWakingHandler(null);
  }, []);
  if (!waking) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-accent px-4 py-1.5 text-center text-xs font-medium text-accent-ink">
      Waking up the server… this can take up to a minute on the free tier.
    </div>
  );
}
