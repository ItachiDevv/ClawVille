export interface StageRendererFailure {
  readonly webGPUError: unknown;
  readonly webGLError: unknown;
  readonly phase: 'initial' | 'recovery';
  readonly route: string;
}

type StageRendererFailureListener = () => void;

let failure: StageRendererFailure | null = null;
const listeners = new Set<StageRendererFailureListener>();

export function getStageRendererFailure(): StageRendererFailure | null {
  return failure;
}

export function getStageRendererFailureServerSnapshot(): null {
  return null;
}

export function subscribeStageRendererFailure(
  listener: StageRendererFailureListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportStageRendererFailure(
  nextFailure: StageRendererFailure,
): void {
  failure = nextFailure;
  for (const listener of listeners) listener();
}

export function clearStageRendererFailure(): void {
  if (failure === null) return;
  failure = null;
  for (const listener of listeners) listener();
}

export async function runStageRendererInitialization<T>(input: {
  readonly route: string;
  readonly forceWebGL: boolean;
  readonly initialize: (forceWebGL: boolean) => Promise<T>;
  readonly onWebGPUFailure?: (error: unknown) => void;
}): Promise<{ renderer: T; usedWebGL: boolean }> {
  let webGPUError: unknown = null;
  let webGLError: unknown = null;
  try {
    const renderer = await input.initialize(input.forceWebGL);
    clearStageRendererFailure();
    return { renderer, usedWebGL: input.forceWebGL };
  } catch (firstError) {
    if (input.forceWebGL) {
      webGLError = firstError;
      reportStageRendererFailure({
        webGPUError,
        webGLError,
        phase: 'initial',
        route: input.route,
      });
      throw firstError;
    }
    webGPUError = firstError;
    input.onWebGPUFailure?.(firstError);
  }

  try {
    const renderer = await input.initialize(true);
    clearStageRendererFailure();
    return { renderer, usedWebGL: true };
  } catch (secondError) {
    webGLError = secondError;
    reportStageRendererFailure({
      webGPUError,
      webGLError,
      phase: 'initial',
      route: input.route,
    });
    throw secondError;
  }
}

export function reportStageRendererRecoveryFailure(input: {
  readonly route: string;
  readonly webGPUError: unknown;
  readonly webGLError: unknown;
}): void {
  reportStageRendererFailure({
    ...input,
    phase: 'recovery',
  });
}
