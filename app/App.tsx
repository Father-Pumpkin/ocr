import { useEffect, useState } from 'react';
import { Routes, Route, Link, NavLink } from 'react-router-dom';
import { Library } from './pages/Library';
import { BookDetail } from './pages/BookDetail';
import { PageEditor } from './pages/PageEditor';
import { Analysis } from './pages/Analysis';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DriveStatus } from './components/DriveStatus';
import { AuthGate } from './components/AuthGate';
import { useSession } from './lib/session';
import { IconButton, buttonClass, Badge } from './components/ui';
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
              {/* Drive is a member-only surface; guests never see its state. */}
              {user.isMember && <DriveStatus onConnected={() => window.location.reload()} />}
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<Library />} />
                  <Route path="/book/:name" element={<BookDetail />} />
                  <Route path="/book/:name/page/:n" element={<PageEditor />} />
                  <Route path="/analysis" element={<Analysis />} />
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
          <RoleBadge />
          <nav className="flex items-center gap-1">
            <NavItem to="/">Library</NavItem>
            <NavItem to="/analysis">Analysis</NavItem>
          </nav>
          <ThemeToggle />
          <UserMenu email={email} />
        </div>
      </div>
    </header>
  );
}

/**
 * Tells a guest, once and quietly, why some controls aren't there. Members see
 * nothing — their tier is the unremarkable case.
 */
function RoleBadge() {
  const { isMember } = useSession();
  if (isMember) return null;
  return (
    <span
      title="You're signed in as a guest: browse the library and build comparisons from the pre-computed scores. Editing and running new analyses are limited to approved accounts."
    >
      <Badge tone="neutral">Guest</Badge>
    </span>
  );
}

/** Header link that highlights when its route is active. */
function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
        }`
      }
    >
      {children}
    </NavLink>
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
