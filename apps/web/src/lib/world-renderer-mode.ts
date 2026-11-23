'use client';
import { useSyncExternalStore } from 'react';
export type WorldRendererMode = '2d' | '3d';
const KEY = 'clawville-world-view';
let selected: WorldRendererMode | undefined;
const listeners = new Set<() => void>();
export function resolveWorldRendererMode(search: string, stored: string | null): WorldRendererMode {
  const query = new URLSearchParams(search).get('view');
  return query === '2d' || query === '3d' ? query : stored === '2d' ? '2d' : '3d';
}
export function getWorldRendererMode(): WorldRendererMode {
  if (typeof window === 'undefined') return '3d';
  if (!selected) {
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(KEY); } catch {}
    selected = resolveWorldRendererMode(window.location.search, stored);
    try { sessionStorage.setItem(KEY, selected); } catch {}
  }
  return selected;
}
export function selectWorldRendererMode(mode: WorldRendererMode): void {
  selected = mode;
  try { sessionStorage.setItem(KEY, mode); } catch {}
  for (const listener of listeners) listener();
}
export function reloadWorldRenderer(mode: WorldRendererMode, pathname?: string): void {
  const url = new URL(window.location.href);
  if (pathname) url.pathname = pathname;
  url.searchParams.set('view', mode);
  window.location.assign(url);
}
export function useWorldRendererMode(): WorldRendererMode {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getWorldRendererMode, () => '3d');
}
export function isStageSceneAvailable(sceneId: string, mode = getWorldRendererMode()): boolean {
  return mode === '3d' || sceneId === 'world';
}

let firstFrame = false;
const frameListeners = new Set<() => void>();
export function notePixiFirstFrame(): void { if (firstFrame) return; firstFrame = true; for (const listener of frameListeners) listener(); }
export function usePixiFirstFrame(): boolean { return useSyncExternalStore((listener) => { frameListeners.add(listener); return () => { frameListeners.delete(listener); }; }, () => firstFrame, () => false); }

/** Refuse before queue state, guest creation, audio, or network mutation. */
export function allowWorldActivityQueue(notice: () => void): boolean {
  if (isStageSceneAvailable('activity')) return true;
  notice(); return false;
}
export function shouldReleaseWorldLoader(mode: WorldRendererMode, pixiFrame: boolean, rendererFailed: boolean): boolean {
  return rendererFailed || (mode === '2d' && pixiFrame);
}
