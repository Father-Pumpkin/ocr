/**
 * Request rate limiting, sized for a publicly-readable deployment.
 *
 * Opening the app to any Google account means the expensive endpoints are now
 * reachable by people we don't know. The access tiers already stop guests
 * spending Anthropic credits; this stops anyone — guest or member — hammering
 * what's left: full-corpus exports, local scoring runs, and the OAuth flow.
 *
 * Design notes worth not re-deriving:
 *
 * - **Keyed by identity, not IP, wherever possible.** Every /api request is
 *   authenticated, and a session email is both stable and unspoofable, whereas
 *   IPs are shared by whole institutions — exactly the population likely to read
 *   this. IP is the fallback for pre-auth routes (login), which is why
 *   `trust proxy` has to be set correctly for it to mean anything.
 *
 * - **Guests are limited harder than members**, because a member's account is
 *   traceable and their limits exist mainly to catch a runaway loop.
 *
 * - **Burst tolerance is the binding constraint on reads.** The library page
 *   fires one image request per book — ~76 in a second on the current corpus —
 *   so a "sensible-looking" 60/minute read limit would break ordinary browsing
 *   on the very first page. READS is set well above realistic page loads; it is
 *   there to stop scraping, not to pace a browser.
 *
 * - **Counters are in memory.** They reset on deploy and are per-instance, so on
 *   a multi-instance host the effective limit multiplies by the instance count.
 *   For a single small service that is the right trade against a Redis
 *   dependency; revisit if this ever scales out.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthedRequest } from './require-auth.js';

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitOptions {
  /** Namespaces the counter, so two limiters never share a bucket. */
  name: string;
  member: RateLimitRule;
  guest: RateLimitRule;
  /** 'user' keys by session email and falls back to IP; 'ip' always uses IP. */
  keyBy?: 'user' | 'ip';
}

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();

/** Scale every limit without a code change, e.g. to tighten during an incident. */
function factor(): number {
  const raw = Number(process.env.RATE_LIMIT_FACTOR);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function disabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === '1';
}

function identify(req: Request, keyBy: 'user' | 'ip'): string {
  if (keyBy === 'user') {
    const email = (req as AuthedRequest).user?.email;
    if (email) return `u:${email.toLowerCase()}`;
  }
  return `i:${req.ip ?? 'unknown'}`;
}

/**
 * Take one token for `key`. Fixed window rather than a sliding one: a burst at a
 * window boundary can briefly reach 2x, which is irrelevant at these sizes and
 * costs a fraction of the bookkeeping.
 */
function consume(key: string, rule: RateLimitRule): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const max = Math.max(1, Math.round(rule.max * factor()));
  const existing = counters.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + rule.windowMs;
    counters.set(key, { count: 1, resetAt });
    return { ok: true, remaining: max - 1, resetAt };
  }
  existing.count++;
  return {
    ok: existing.count <= max,
    remaining: Math.max(0, max - existing.count),
    resetAt: existing.resetAt,
  };
}

// Expired counters would otherwise accumulate one entry per identity forever.
const SWEEP_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, c] of counters) if (c.resetAt <= now) counters.delete(key);
}, SWEEP_MS);
sweeper.unref?.();

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const keyBy = opts.keyBy ?? 'user';
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (disabled()) {
      next();
      return;
    }
    const role = (req as AuthedRequest).user?.role ?? 'guest';
    const rule = role === 'member' ? opts.member : opts.guest;
    const key = `${opts.name}:${identify(req, keyBy)}`;
    const { ok, remaining, resetAt } = consume(key, rule);

    const resetSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.set('RateLimit-Limit', String(Math.round(rule.max * factor())));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(resetSeconds));

    if (!ok) {
      res.set('Retry-After', String(resetSeconds));
      res.status(429).json({
        error: `Too many requests. Try again in ${resetSeconds} second${resetSeconds === 1 ? '' : 's'}.`,
        rateLimited: true,
        retryAfterSeconds: resetSeconds,
      });
      return;
    }
    next();
  };
}

/** Test/debug helper: forget every counter. */
export function resetRateLimits(): void {
  counters.clear();
}

const MINUTE = 60 * 1000;

/**
 * The limits themselves, in one place so they can be read as a policy.
 *
 * READS is deliberately loose — see the burst note above. The tight ones are
 * EXPORTS (serializes the whole corpus) and SCORING (runs the scorer over every
 * page, or submits a batch), which are the only endpoints where a single request
 * costs real work.
 */
export const LIMITS = {
  /** Everything under /api. Sized so a full library page load can't trip it. */
  READS: rateLimit({
    name: 'reads',
    member: { windowMs: MINUTE, max: 600 },
    guest: { windowMs: MINUTE, max: 300 },
  }),

  /** Full-corpus CSV/JSON serialization. */
  EXPORTS: rateLimit({
    name: 'exports',
    member: { windowMs: MINUTE, max: 30 },
    guest: { windowMs: MINUTE, max: 10 },
  }),

  /** Scoring runs, prewarming and estimates — CPU, or Anthropic spend. */
  SCORING: rateLimit({
    name: 'scoring',
    member: { windowMs: MINUTE, max: 20 },
    guest: { windowMs: MINUTE, max: 5 },
  }),

  /** Page images: one per book on the library page, so bursty by nature. */
  IMAGES: rateLimit({
    name: 'images',
    member: { windowMs: MINUTE, max: 600 },
    guest: { windowMs: MINUTE, max: 300 },
  }),

  /**
   * The OAuth entry point, before any session exists — the one limiter that has
   * to key on IP, and the reason `trust proxy` matters.
   */
  LOGIN: rateLimit({
    name: 'login',
    member: { windowMs: 15 * MINUTE, max: 30 },
    guest: { windowMs: 15 * MINUTE, max: 30 },
    keyBy: 'ip',
  }),
};
