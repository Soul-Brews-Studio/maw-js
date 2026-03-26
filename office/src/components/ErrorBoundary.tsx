import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        className="fixed inset-0 flex items-center justify-center z-[9999]"
        style={{ background: "#020208" }}
      >
        <div className="text-center max-w-md px-6">
          <div className="text-6xl mb-6">💥</div>
          <h1
            className="text-xl font-mono font-bold mb-3"
            style={{ color: "#ef4444" }}
          >
            Something crashed
          </h1>
          <p
            className="text-sm font-mono mb-6 leading-relaxed"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            {this.state.error?.message || "Unknown error"}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-xl font-mono text-sm cursor-pointer transition-all active:scale-95"
            style={{
              background: "rgba(100,181,246,0.15)",
              border: "1px solid rgba(100,181,246,0.3)",
              color: "#64b5f6",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
