'use client';

import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

export class StageCanvasErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      '[WorldStage] canvas subtree crashed:',
      error,
      info.componentStack ?? '',
    );
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute inset-0 z-50 flex items-center justify-center bg-[#07131d] p-6"
      >
        <div className="max-w-xl text-center font-mono text-cyan-100">
          <p className="mb-5 text-base font-bold leading-relaxed">
            This browser couldn&apos;t start the 3D view. Try updating your
            browser or enabling hardware acceleration.
          </p>
          <button
            type="button"
            className="rounded-lg border border-cyan-300/70 bg-black/70 px-5 py-3 font-bold text-cyan-200"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
