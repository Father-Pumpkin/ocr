import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './pages/Library';
import { BookDetail } from './pages/BookDetail';
import { PageEditor } from './pages/PageEditor';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DriveStatus } from './components/DriveStatus';

export function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            OCR Tool
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <DriveStatus onConnected={() => window.location.reload()} />
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/book/:name" element={<BookDetail />} />
            <Route path="/book/:name/page/:n" element={<PageEditor />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
