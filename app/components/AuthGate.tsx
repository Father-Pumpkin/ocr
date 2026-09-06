import { useEffect, useState, type ReactNode } from 'react';
import { api, LOGIN_URL } from '../lib/api';
import { buttonClass, Spinner } from './ui';
import { Google, BookOpen } from './icons';
import { SessionProvider, type Role, type Session } from '../lib/session';

/**
 * Gates the app behind a valid session. Calls /api/me on mount: a 200 renders
 * the app; a 401 (or any failure) shows the sign-in screen. When auth is
 * disabled locally, /api/me returns a dev identity.
 *
 * Any verified Google account gets in — the response's `role` decides whether
 * they see the editing and analysis controls, and is published through
 * SessionProvider so components deep in the tree can ask without prop drilling.
 */
type AuthState =
  | { kind: 'loading' }
  | { kind: 'authed'; email: string; role: Role }
  | { kind: 'anon' };

export function AuthGate({ children }: { children: (user: Session) => ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((u) => {
        if (!cancelled) setState({ kind: 'authed', email: u.email ?? '', role: u.role ?? 'guest' });
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
            A research library of transcribed Spanish children's books. Sign in with any Google account to
            browse it and build sentiment comparisons; editing is limited to approved accounts.
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

  const session: Session = {
    email: state.email,
    role: state.role,
    isMember: state.role === 'member',
  };
  return (
    <SessionProvider value={session}>
      {children(session)}
    </SessionProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-6">{children}</div>;
}
