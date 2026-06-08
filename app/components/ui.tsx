import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/* ---- Button -------------------------------------------------------------- */
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm',
  secondary: 'border border-border bg-surface text-ink hover:bg-surface-2',
  danger: 'border border-danger/30 bg-surface text-danger hover:bg-danger-soft',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
};

/** Shared button class string — also used to style <a> elements as buttons. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  return [
    'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    extra,
  ].join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}
export function Button({ variant, size, className = '', ...props }: ButtonProps) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

/** Square icon-only button (header controls, pager). */
export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={[
        'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors',
        'hover:bg-surface-2 hover:text-ink',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      ].join(' ')}
      {...props}
    />
  );
}

/* ---- Card ---------------------------------------------------------------- */
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`} {...props} />;
}

/* ---- Badge --------------------------------------------------------------- */
type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
};
export function Badge({
  tone = 'neutral',
  className = '',
  children,
  title,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === 'complete'
      ? 'ok'
      : status === 'transcribing'
        ? 'warn'
        : status === 'failed' || status === 'error'
          ? 'danger'
          : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

/* ---- Form bits ----------------------------------------------------------- */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-xs font-semibold uppercase tracking-wide text-muted ${className}`}>{children}</span>;
}

/* ---- Feedback ------------------------------------------------------------ */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner className="h-4 w-4" />
      {label}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{message}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-muted">{children}</div>;
}
