import { useEffect, useState, type ReactNode } from 'react';
import { api, LOGIN_URL } from '../lib/api';
import { buttonClass, Spinner } from './ui';
import { Google, BookOpen } from './icons';

/**
 * Gates the app behind a valid session. Calls /api/me on mount: a 200 renders
 * the app (passing the signed-in email down); a 401 (or any failure) shows the
 * sign-in screen. When auth is disabled locally, /api/me returns a dev identity.
 */
type AuthState = { kind: 'loading' } | { kind: 'authed'; email: string } | { kind: 'anon' };

export function AuthGate({ children }: { children: (user: { email: string }) => ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((u) => {
        if (!cancelled) setState({ kind: 'authed', email: u.email ?? '' });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'anon' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <Centered>
        <Spinner className="h-7 w-7 text-accent" />
      </Centered>
    );
  }

  if (state.kind === 'anon') {
    return (
      <Centered>
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
          <span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-ink">
            <BookOpen className="h-6 w-6" />
          </span>
          <h1 className="font-serif text-2xl font-semibold text-ink">OCR Tool</h1>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted">
            A private transcription library. Sign in with an approved Google account to continue.
          </p>
          <a href={LOGIN_URL} className={buttonClass('primary', 'md', 'mt-6 w-full')}>
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white">
              <Google className="h-3.5 w-3.5" />
            </span>
            Sign in with Google
          </a>
        </div>
      </Centered>
    );
  }

  return <>{children({ email: state.email })}</>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-6">{children}</div>;
}
