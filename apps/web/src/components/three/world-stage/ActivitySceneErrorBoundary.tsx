'use client';

import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

interface ActivitySceneErrorBoundaryProps {
  readonly resetKey: string;
  readonly onFailed: (branch: 'scene-chunk-error') => void;
  readonly onTryAgain: () => void;
  readonly onReload: () => void;
  readonly children: ReactNode;
}

interface ActivitySceneErrorBoundaryState {
  failed: boolean;
  resetKey: string;
}

export class ActivitySceneErrorBoundary extends Component<
  ActivitySceneErrorBoundaryProps,
  ActivitySceneErrorBoundaryState
> {
  state: ActivitySceneErrorBoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(): Partial<ActivitySceneErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ActivitySceneErrorBoundaryProps,
    state: ActivitySceneErrorBoundaryState,
  ): Partial<ActivitySceneErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[activity] scene render failed', error, info.componentStack);
    this.props.onFailed('scene-chunk-error');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0a1628] px-6 text-center font-mono text-cyan-100"
      >
        <p>The activity scene failed to load.</p>
        <button type="button" onClick={this.props.onReload}>
          Reload
        </button>
        <button type="button" onClick={this.props.onTryAgain}>
          Try again
        </button>
      </div>
    );
  }
}
