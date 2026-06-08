import { useEffect, useState, type ReactNode } from 'react';
import { api, LOGIN_URL } from '../lib/api';

/**
 * Gates the app behind a valid session. Calls /api/me on mount: a 200 renders
 * the app (passing the signed-in email down); a 401 (or any failure) shows the
 * sign-in screen. When auth is disabled locally, /api/me returns a dev identity
 * so this is transparent in development.
 */
type AuthState =
  | { kind: 'loading' }
  | { kind: 'authed'; email: string }
  | { kind: 'anon' };

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
        // 401 = not signed in; any other failure also lands on the sign-in screen.
        if (!cancelled) setState({ kind: 'anon' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <CenteredCard>
        <p className="text-sm text-slate-500">Loading…</p>
      </CenteredCard>
    );
  }
  if (state.kind === 'anon') {
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">OCR Tool</h1>
        <p className="mt-2 text-sm text-slate-500">
          This app is private. Sign in with an approved Google account to continue.
        </p>
        <a
          href={LOGIN_URL}
          className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Sign in with Google
        </a>
      </CenteredCard>
    );
  }
  return <>{children({ email: state.email })}</>;
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {children}
      </div>
    </div>
  );
}
