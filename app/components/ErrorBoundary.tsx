import { Component, type ReactNode, type ErrorInfo } from 'react';

interface State {
  error: Error | null;
}

/** Catches render errors so a crash shows a message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for debugging
    console.error('UI render error:', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Something went wrong rendering this view.</p>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
