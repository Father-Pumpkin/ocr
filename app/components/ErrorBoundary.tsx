import { Component, type ReactNode, type ErrorInfo } from 'react';
import { buttonClass } from './ui';

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
    console.error('UI render error:', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-5 text-sm text-danger">
          <p className="font-semibold">Something went wrong rendering this view.</p>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs opacity-90">{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()} className={buttonClass('primary', 'sm', 'mt-3')}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
