import { isEditable } from './jump-state';

/** DOM service panels retain the world scene but own keyboard and touch input. */
export function isWorldServicePanelPath(pathname: string): boolean {
  return pathname === '/brainchain' || pathname.startsWith('/brainchain/');
}

export function isWorldInputBlocked(): boolean {
  return (typeof window !== 'undefined' && isWorldServicePanelPath(window.location.pathname))
    || (typeof document !== 'undefined' && isEditable(document.activeElement));
}

/** Service panels suspend the retained scene; text focus only suppresses manual input. */
export function isWorldFrameBlocked(): boolean {
  return typeof window !== 'undefined' && isWorldServicePanelPath(window.location.pathname);
}
