'use client';

/**
 * ModelLoadBoundary — isolates ONE optional figure (wandering NPC, remote
 * player) so its MODEL failing to load removes only that figure.
 *
 * Why: vrm-loader's useVRMInstance rethrows a rejected VRM load into render.
 * With no boundary in the world scene, one VRM that failed all of its
 * request retries (404, or an outage longer than ~2.5 s) reached
 * StageCanvasErrorBoundary and replaced the whole world with "This browser
 * couldn't start the 3D view" (local repro + staging ad33939e, 2026-10-04).
 *
 * Behavior:
 * - Handles ONLY ModelLoadError (model-load-error.ts), tagged at the loader
 *   source (vrm-loader rejected entries, useGLTFWithKTX2 rejections). Any
 *   other error (a render bug in the figure) is rethrown to the outer
 *   boundary unchanged.
 * - A model failure renders `null` (or `fallback`, see below); siblings and
 *   the rest of the world keep running. No state beyond the flag, no
 *   per-frame cost.
 * - One console.error per (url, outcome, original loader error): `[3D]
 *   figure skipped (model load failed) (<phase>): <label> <url> <class>:
 *   <message>`. A later, different failure of the same URL logs again.
 * - R3F's reconciler root reports every caught error with
 *   `onCaughtError = reportError` (a window "error" event that Chrome prints
 *   as "Uncaught ..."). getDerivedStateFromError (render phase) marks the
 *   error ONE-SHOT; React's commit callback reports it and then calls
 *   componentDidCatch. One capture-phase window listener cancels the first
 *   report that matches a mark and consumes the mark; componentDidCatch
 *   drops any mark left. A later, separate report of the same error object
 *   is therefore NOT cancelled.
 * - Retry: on catch the boundary calls `error.clear()` (GLB: useGLTF.clear;
 *   VRM: evicts the rejected instance entry), so a `resetKey` change or a
 *   remount of the figure requests the model again.
 * - `fallback` (optional): rendered INSTEAD of null after a model failure.
 *   The LOCAL player's own body uses it (default lobster GLB body via
 *   local-player-model-fallback.ts), so the player is never invisible. A
 *   render bug still goes to the outer boundary, never to the fallback.
 *   Without `fallback` the behavior is unchanged.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isModelLoadError, type ModelLoadError } from './model-load-error';

/** original loader error (or the tag) -> report keys already logged */
const LOGGED = new WeakMap<object, Set<string>>();
/** One-shot marks: errors whose NEXT window "error" report is R3F's duplicate. */
const PENDING_REPORT_CANCEL = new WeakSet<object>();
let reportFilterInstalled = false;

function installReportFilter(): void {
  if (reportFilterInstalled || typeof window === 'undefined') return;
  reportFilterInstalled = true;
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      const error: unknown = event.error;
      if (typeof error === 'object' && error !== null && PENDING_REPORT_CANCEL.has(error)) {
        PENDING_REPORT_CANCEL.delete(error);
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

/** true the first time this (original error, key) pair is seen */
function firstReport(error: ModelLoadError, key: string): boolean {
  const identity =
    typeof error.original === 'object' && error.original !== null ? error.original : error;
  let keys = LOGGED.get(identity);
  if (!keys) {
    keys = new Set();
    LOGGED.set(identity, keys);
  }
  if (keys.has(key)) return false;
  keys.add(key);
  return true;
}

export interface ModelLoadBoundaryProps {
  /** The figure's model URL (logged). */
  readonly assetUrl: string;
  /** Short figure label for the log, e.g. `wanderer:<npcId>`. */
  readonly label: string;
  /** Changing it clears the failed state and remounts the children. */
  readonly resetKey: string;
  /** Rendered instead of null after a MODEL failure (local player body). */
  readonly fallback?: ReactNode;
  readonly children?: ReactNode;
}

interface ModelLoadBoundaryState {
  readonly failed: boolean;
  /** A non-model error to rethrow to the outer boundary. */
  readonly foreign: { readonly error: unknown } | null;
  readonly resetKey: string;
}

export class ModelLoadBoundary extends Component<ModelLoadBoundaryProps, ModelLoadBoundaryState> {
  state: ModelLoadBoundaryState = { failed: false, foreign: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: ModelLoadBoundaryProps,
    state: ModelLoadBoundaryState,
  ): Partial<ModelLoadBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, foreign: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<ModelLoadBoundaryState> {
    if (!isModelLoadError(error)) return { foreign: { error } };
    PENDING_REPORT_CANCEL.add(error);
    installReportFilter();
    return { failed: true, foreign: null };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (!isModelLoadError(error)) return;
    // The R3F report (if any) ran just before this callback; never let the
    // mark outlive it.
    PENDING_REPORT_CANCEL.delete(error);
    error.clear();
    const { label, fallback } = this.props;
    const outcome = fallback === undefined ? 'skipped' : 'replaced by fallback';
    if (!firstReport(error, `${outcome}|${error.url}`)) return;
    console.error(
      `[3D] figure ${outcome} (model load failed) (${error.phase}): ${label} ${error.url} ${describeError(error.original)}`,
      error,
    );
  }

  render(): ReactNode {
    if (this.state.foreign) throw this.state.foreign.error;
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children ?? null;
  }
}
