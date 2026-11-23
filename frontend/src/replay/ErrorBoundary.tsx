/**
 * Race Replay — catches a view that fails to render (the 3D chunk failing to load, or no WebGL)
 * and shows `fallback` instead of taking the page down.
 */

import React from 'react';

interface Props {
  fallback: (error: Error) => React.ReactNode;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn('Replay view failed, showing the fallback:', error);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
