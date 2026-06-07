import type { ReactNode } from 'react';

const STATUS_STYLES: Record<string, string> = {
  complete: 'bg-emerald-100 text-emerald-700',
  transcribing: 'bg-amber-100 text-amber-700',
  pending: 'bg-slate-100 text-slate-600',
  failed: 'bg-red-100 text-red-700',
  error: 'bg-red-100 text-red-700',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{label}</p>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-sm text-slate-500">{children}</div>;
}
