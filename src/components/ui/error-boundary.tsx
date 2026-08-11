import React from "react";
import { Button } from "@/components/ui/button";
import { logError } from "@/lib/logger";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  resetKey?: string;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.(error, info);

    // Log to backend with component stack
    logError("React ErrorBoundary caught an error", {
      context: "error-boundary",
      data: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      },
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.assign("/");
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-lg font-semibold">Something went wrong</div>
        <div className="text-xs text-fg-mut">
          The page failed to render. You can reload or return home.
        </div>
        {this.state.error?.message && (
          <pre className="max-w-2xl whitespace-pre-wrap rounded-md bg-hover px-4 py-3 text-left text-xs text-fg-mut">
            {this.state.error.message}
          </pre>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={this.handleGoHome}>
            Go Home
          </Button>
          <Button onClick={this.handleReload}>Reload</Button>
        </div>
      </div>
    );
  }
}
