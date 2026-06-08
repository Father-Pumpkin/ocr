import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X, Plus, Tag } from './icons';

/**
 * Token-input tag picker: selected tags render as removable chips, a dropdown
 * offers the existing vocabulary (filtered as you type), and anything new can be
 * created inline. Keyboard: ↑/↓ to move, Enter/`,` to add, Esc to close,
 * Backspace on an empty field removes the last chip.
 */
export function TagSelect({
  value,
  onChange,
  suggestions,
  placeholder = 'Add a tag…',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close when clicking outside the widget.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const selectedLower = useMemo(() => new Set(value.map((t) => t.toLowerCase())), [value]);
  const q = query.trim();

  // Vocabulary matches: not already chosen, and matching the typed filter.
  const matches = useMemo(() => {
    const ql = q.toLowerCase();
    return suggestions
      .filter((t) => !selectedLower.has(t.toLowerCase()))
      .filter((t) => (ql ? t.toLowerCase().includes(ql) : true))
      .slice(0, 50);
  }, [suggestions, selectedLower, q]);

  // Offer "Create" only when the typed text isn't already a tag (selected or known).
  const canCreate =
    q.length > 0 &&
    !selectedLower.has(q.toLowerCase()) &&
    !suggestions.some((t) => t.toLowerCase() === q.toLowerCase());

  const optionCount = matches.length + (canCreate ? 1 : 0);

  // Reset the highlighted row whenever the option set changes.
  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t || selectedLower.has(t.toLowerCase())) {
      setQuery('');
      return;
    }
    onChange([...value, t]);
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus(); // stay focused to keep adding
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function commit() {
    if (highlight < matches.length) addTag(matches[highlight]);
    else if (q) addTag(q); // create row, or a bare typed value
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      if (q || matches.length) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'ArrowDown') {
      if (optionCount) {
        e.preventDefault();
        setOpen(true);
        setHighlight((h) => (h + 1) % optionCount);
      }
    } else if (e.key === 'ArrowUp') {
      if (optionCount) {
        e.preventDefault();
        setHighlight((h) => (h - 1 + optionCount) % optionCount);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Backspace' && q === '' && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  }

  const showDropdown = open && optionCount > 0;

  return (
    <div ref={containerRef} className="relative">
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30"
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2 pr-1 text-xs font-medium text-accent"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink placeholder:text-faint focus:outline-none"
        />
      </div>

      {showDropdown && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-card">
          {matches.map((tag, i) => (
            <li key={tag}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()} // don't blur the input
                onMouseEnter={() => setHighlight(i)}
                onClick={() => addTag(tag)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  i === highlight ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'
                }`}
              >
                <Tag className="h-3.5 w-3.5 opacity-60" />
                {tag}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(matches.length)}
                onClick={() => addTag(q)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  highlight === matches.length ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2'
                }`}
              >
                <Plus className="h-3.5 w-3.5" />
                Create <span className="font-medium">“{q}”</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
