'use client';

import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

export interface StageSlotErrorBoundaryProps {
  readonly resetKey: string;
  readonly onRuntimeError: (
    error: unknown,
    componentStack: string | null,
  ) => void;
  readonly children: ReactNode;
}

interface StageSlotErrorBoundaryState {
  readonly failed: boolean;
  readonly resetKey: string;
}

export class StageSlotErrorBoundary extends Component<
  StageSlotErrorBoundaryProps,
  StageSlotErrorBoundaryState
> {
  state: StageSlotErrorBoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromProps(
    props: StageSlotErrorBoundaryProps,
    state: StageSlotErrorBoundaryState,
  ): Partial<StageSlotErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<StageSlotErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    console.error(
      '[WorldStage] slot subtree crashed:',
      error,
      componentStack ?? '',
    );
    this.props.onRuntimeError(error, componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
