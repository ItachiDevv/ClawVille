export interface KelpRealmRendererFailure {
  readonly webGPUError: unknown;
  readonly webGLError: unknown;
}

const rendererFailureListeners = new Set<() => void>();
let rendererFailure: KelpRealmRendererFailure | null = null;

export function getKelpRealmRendererFailure(): KelpRealmRendererFailure | null {
  return rendererFailure;
}

export function getKelpRealmRendererFailureServerSnapshot(): null {
  return null;
}

export function subscribeKelpRealmRendererFailure(listener: () => void): () => void {
  rendererFailureListeners.add(listener);
  return () => rendererFailureListeners.delete(listener);
}

export function clearKelpRealmRendererFailure(): void {
  if (rendererFailure === null) return;
  rendererFailure = null;
  for (const listener of rendererFailureListeners) listener();
}

export function reportKelpRealmRendererFailure(
  webGPUError: unknown,
  webGLError: unknown,
): void {
  rendererFailure = Object.freeze({ webGPUError, webGLError });
  for (const listener of rendererFailureListeners) listener();
}
