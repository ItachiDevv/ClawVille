'use client';

/**
 * ModelLoadBoundary — isolates ONE optional figure (wandering NPC, remote
 * player) so its model failing to load removes only that figure.
 *
 * Why: vrm-loader's useVRMInstance rethrows a rejected VRM load raw into
 * render. With no boundary in the world scene, one VRM that failed all of
 * its request retries (404, or an outage longer than ~2.5 s) reached
 * StageCanvasErrorBoundary and replaced the whole world with "This browser
 * couldn't start the 3D view" (local repro + staging ad33939e, 2026-10-04).
 *
 * Behavior:
 * - A caught error renders `null` for this subtree; siblings and the rest of
 *   the world keep running. No state, no effects, no per-frame cost.
 * - One console.error per asset URL: `[3D] figure skipped (model load
 *   failed): <label> <url>` + the original error.
 * - R3F's reconciler root reports every caught error with
 *   `onCaughtError = reportError` (a window "error" event that Chrome prints
 *   as "Uncaught ..."). The boundary tags the error it handles in
 *   getDerivedStateFromError (render phase, before React's commit-phase
 *   onCaughtError) and one capture-phase window listener cancels the default
 *   report for tagged errors ONLY, so the one console.error is the only line.
 * - Retry: changing `resetKey` clears the failure and remounts the children.
 *   A remount of the owning figure also retries: its unmount runs
 *   disposeVRMInstance (useVRMOrphanCancel), which evicts the 'rejected'
 *   instance entry after the dispose grace window, and vrm-loader already
 *   evicts failed bytes; GLB figures need `useGLTF.clear(url)`.
 *
 * Do NOT wrap the LOCAL player's own body: it has no fallback model, so
 * rendering nothing there would leave the player invisible (3dStructure.md
 * §9a).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

const REPORTED_URLS = new Set<string>();
const HANDLED_ERRORS = new WeakSet<object>();
let reportFilterInstalled = false;

function installReportFilter(): void {
  if (reportFilterInstalled || typeof window === 'undefined') return;
  reportFilterInstalled = true;
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      const error: unknown = event.error;
      if (typeof error === 'object' && error !== null && HANDLED_ERRORS.has(error)) {
        event.preventDefault();
      }
    },
    true,
  );
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    const name = typeof ctor === 'string' && ctor !== '' && ctor !== 'Object'
      ? ctor
      : String((error as { name?: unknown }).name ?? 'Error');
    return `${name}: ${String((error as { message?: unknown }).message)}`;
  }
  return String(error);
}

export interface ModelLoadBoundaryProps {
  /** The figure's model URL (logged; the console.error is once per URL). */
  readonly assetUrl: string;
  /** Short figure label for the log, e.g. `wanderer:<npcId>`. */
  readonly label: string;
  /** Changing it clears the failed state and remounts the children. */
  readonly resetKey: string;
  readonly children?: ReactNode;
}

interface ModelLoadBoundaryState {
  readonly failed: boolean;
  readonly resetKey: string;
}

export class ModelLoadBoundary extends Component<ModelLoadBoundaryProps, ModelLoadBoundaryState> {
  state: ModelLoadBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: ModelLoadBoundaryProps,
    state: ModelLoadBoundaryState,
  ): Partial<ModelLoadBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<ModelLoadBoundaryState> {
    if (typeof error === 'object' && error !== null) HANDLED_ERRORS.add(error);
    installReportFilter();
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const { assetUrl, label } = this.props;
    if (REPORTED_URLS.has(assetUrl)) return;
    REPORTED_URLS.add(assetUrl);
    console.error(
      `[3D] figure skipped (model load failed): ${label} ${assetUrl} ${describeError(error)}`,
      error,
    );
  }

  render(): ReactNode {
    return this.state.failed ? null : (this.props.children ?? null);
  }
}
