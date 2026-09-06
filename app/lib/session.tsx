import { createContext, useContext, type ReactNode } from 'react';

/**
 * Who is signed in, and what they're allowed to do.
 *
 * Two tiers: `member` (on the server's allowlist) can edit books and run
 * analyses; `guest` — any other verified Google account — gets the library and
 * the pre-computed scores, read-only.
 *
 * This drives presentation only. The server enforces the same boundary on every
 * route (see http/middleware/require-auth), so hiding a control here is a
 * courtesy to the user, never the thing keeping them out. Components should
 * still handle a 403, because a role can change between page load and click.
 */
export type Role = 'member' | 'guest';

export interface Session {
  email: string;
  role: Role;
  /** Convenience: `role === 'member'`. Read as "may edit and may spend". */
  isMember: boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a SessionProvider.');
  return session;
}

/** Shorthand for the common case — gating a control. */
export function useIsMember(): boolean {
  return useSession().isMember;
}

/** The line shown wherever a guest meets a member-only control. */
export const MEMBER_ONLY_HINT =
  'Available to approved accounts only. You can browse the library and build comparisons from the pre-computed scores.';
