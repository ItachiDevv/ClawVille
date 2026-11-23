import { useStageStore } from './stage-store';

/** The DOM panel does not own a renderer acknowledgement. */
export function retireBrainchainFallbackRequest(): void {
  useStageStore.setState({ pendingRequest: null, transition: null, renderPaused: false, outgoingOverlay: null });
}

export function needsBrainchainPanelFallback(pathname: string, mode: '2d' | '3d', rendererFailed: boolean, slotFailed: boolean, transitionFailed: boolean): boolean {
  return pathname === '/brainchain' && (mode === '2d' || rendererFailed || slotFailed || transitionFailed);
}
