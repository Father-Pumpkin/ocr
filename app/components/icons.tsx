/** Small inline SVG icons (lucide-style strokes; Google uses its brand colors). */
import type { ReactNode } from 'react';

type IconProps = { className?: string };

function S({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Sun = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </S>
);

export const Moon = (p: IconProps) => (
  <S {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </S>
);

export const ChevronLeft = (p: IconProps) => (
  <S {...p}>
    <path d="M15 18l-6-6 6-6" />
  </S>
);

export const ChevronRight = (p: IconProps) => (
  <S {...p}>
    <path d="M9 18l6-6-6-6" />
  </S>
);

export const ImageOff = (p: IconProps) => (
  <S {...p}>
    <path d="M3 3l18 18M21 15V5a2 2 0 0 0-2-2H9M3 7v12a2 2 0 0 0 2 2h12" />
    <path d="M8.5 8.5a1.5 1.5 0 1 0 2 2M21 15l-5-5-2 2M8 21l5-5" />
  </S>
);

export const Check = (p: IconProps) => (
  <S {...p}>
    <path d="M20 6L9 17l-5-5" />
  </S>
);

export const Alert = (p: IconProps) => (
  <S {...p}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </S>
);

export const Plus = (p: IconProps) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
);

export const Trash = (p: IconProps) => (
  <S {...p}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
  </S>
);

export const Upload = (p: IconProps) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </S>
);

export const Refresh = (p: IconProps) => (
  <S {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
  </S>
);

export const ShieldCheck = (p: IconProps) => (
  <S {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="M9 12l2 2 4-4" />
  </S>
);

export const LogOut = (p: IconProps) => (
  <S {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </S>
);

export const BookOpen = (p: IconProps) => (
  <S {...p}>
    <path d="M12 7v14M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3Z" />
  </S>
);

export const Search = (p: IconProps) => (
  <S {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.3-4.3" />
  </S>
);

export const Columns = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </S>
);

export const Copy = (p: IconProps) => (
  <S {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
);

export const Undo = (p: IconProps) => (
  <S {...p}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </S>
);

export const Picture = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21" />
  </S>
);

export const Download = (p: IconProps) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </S>
);

export const Pencil = (p: IconProps) => (
  <S {...p}>
    <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);

export const X = (p: IconProps) => (
  <S {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </S>
);

export const Tag = (p: IconProps) => (
  <S {...p}>
    <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </S>
);

export const Google = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
    />
  </svg>
);
