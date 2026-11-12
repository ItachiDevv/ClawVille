import { isEditable } from './jump-state';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { useBrainchainInteriorStore } from '@/components/brainchain/brainchain-interior-store';
import { getStageRendererFailure } from '@/components/three/world-stage/stage-renderer-status';
import { getWorldRendererMode } from '@/lib/world-renderer-mode';

/** Office routes always suspend the town controller, including the 2D fallback. */
export function isWorldServicePanelPath(pathname: string): boolean {
  return pathname === '/brainchain' || pathname.startsWith('/brainchain/');
}

function brainchainInteriorOwnsInput(): boolean {
  if (typeof window === 'undefined' || window.location.pathname !== '/brainchain') return false;
  const stage = useStageStore.getState();
  const office = useBrainchainInteriorStore.getState();
  return stage.activeScene === 'brainchain' && getWorldRendererMode() === '3d'
    && !getStageRendererFailure() && !office.failed && office.section === null
    && (!stage.transition || stage.transition.phase === 'idle' || stage.transition.phase === 'fadingIn');
}

export function isWorldInputBlocked(): boolean {
  return (typeof window !== 'undefined' && isWorldServicePanelPath(window.location.pathname) && !brainchainInteriorOwnsInput())
    || (typeof document !== 'undefined' && isEditable(document.activeElement));
}

/** Only the active Office controller can bypass this route's town-frame block. */
export function isWorldFrameBlocked(sceneId?: string | null): boolean {
  return typeof window !== 'undefined' && isWorldServicePanelPath(window.location.pathname)
    && !(sceneId === 'brainchain' && brainchainInteriorOwnsInput());
}
