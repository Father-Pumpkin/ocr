import React, { useEffect, useState } from 'react';

interface BookRow {
  id: number;
  title: string;
  drive_file_id: string;
  drive_file_name: string;
  page_count: number | null;
  status: string;
}

export function App(): React.JSX.Element {
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/library')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setBooks(data.books))
      .catch((err) => setError(err.message ?? String(err)));
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#c33' }}>
        <h1>OCR Tool</h1>
        <p>Error loading library: {error}</p>
      </div>
    );
  }

  if (!books) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1>OCR Tool</h1>
        <p>Loading library…</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 800 }}>
      <h1 style={{ margin: 0 }}>OCR Tool</h1>
      <p style={{ color: '#666', marginTop: 4 }}>
        Library — {books.length} book{books.length === 1 ? '' : 's'}
      </p>
      {books.length === 0 ? (
        <p style={{ color: '#888' }}>No books found.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
          {books.map((b) => (
            <li
              key={b.drive_file_id}
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid #eee',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <span style={{ fontWeight: 500 }}>{b.title}</span>
              <span style={{ color: '#888', fontSize: 12 }}>
                {b.status}
                {b.page_count != null && ` · ${b.page_count} pages`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
