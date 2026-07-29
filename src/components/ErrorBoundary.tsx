import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Without this, a single render throw leaves the user on a blank page with no
 * way back. Catches the error, shows it, and offers a recovery path.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[BookForge] render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0A0A0B] p-6 text-[#E4E4E7]">
        <div className="max-w-lg w-full bg-[#111114] border border-[#27272A] rounded-2xl p-6 space-y-4">
          <div>
            <h1 className="font-display text-lg font-bold text-white">Something broke in the interface</h1>
            <p className="text-xs text-[#71717A] mt-1 leading-relaxed">
              Your files were not sent anywhere and nothing was lost on the server. Reloading usually clears it.
            </p>
          </div>

          <pre className="text-[11px] font-mono text-red-300 bg-red-950/20 border border-red-500/20 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {error.message}
          </pre>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="px-3 py-2 rounded-lg bg-[#D4AF37] text-black text-xs font-bold uppercase tracking-wider cursor-pointer hover:bg-[#b08e24] transition"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-2 rounded-lg bg-[#18181B] border border-[#27272A] text-xs font-semibold cursor-pointer hover:text-white transition"
            >
              Reload the app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
