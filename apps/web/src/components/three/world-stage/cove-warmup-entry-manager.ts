export const COVE_COMPILE_TIMEOUT_MS = 20_000;

interface CoveCompileEntry {
  gl: unknown;
  compilePromise: Promise<void>;
  timedOut: boolean;
  settled: boolean;
}

export type CoveCompileWaitResult =
  | { kind: 'settled' }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timed-out' }
  | { kind: 'bypassed' };

export interface CoveWarmupResult {
  status: 'completed' | 'superseded';
  warmedRenderer: unknown | null;
  warmAttempted: boolean;
}

let currentCompileEntry: CoveCompileEntry | null = null;

function createEntry(
  gl: unknown,
  compile: () => Promise<void>,
): CoveCompileEntry {
  const entry: CoveCompileEntry = {
    gl,
    compilePromise: Promise.resolve().then(compile),
    timedOut: false,
    settled: false,
  };
  entry.compilePromise.then(
    () => {
      entry.settled = true;
      if (currentCompileEntry === entry && !entry.timedOut) {
        currentCompileEntry = null;
      }
    },
    () => {
      entry.settled = true;
      if (currentCompileEntry === entry && !entry.timedOut) {
        currentCompileEntry = null;
      }
    },
  );
  return entry;
}

export async function waitForCoveCompile(
  gl: unknown,
  compile: () => Promise<void>,
  timeoutMs = COVE_COMPILE_TIMEOUT_MS,
): Promise<CoveCompileWaitResult> {
  if (!currentCompileEntry || currentCompileEntry.gl !== gl) {
    currentCompileEntry = createEntry(gl, compile);
  }
  const entry = currentCompileEntry;
  if (entry.timedOut) return { kind: 'bypassed' };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CoveCompileWaitResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (currentCompileEntry === entry && !entry.settled) {
        entry.timedOut = true;
      }
      resolve({ kind: 'timed-out' });
    }, timeoutMs);
  });
  const settled = entry.compilePromise.then<
    CoveCompileWaitResult,
    CoveCompileWaitResult
  >(
    () => ({ kind: 'settled' }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return result;
}

export async function warmCoveRendererForGeneration(input: {
  gl: unknown;
  warmedRenderer: unknown | null;
  compile?: () => Promise<void>;
  directWarm: () => Promise<void>;
  isCurrent: () => boolean;
  timeoutMs?: number;
  onCompileRejected?: (error: unknown) => void;
  onCompileTimedOut?: () => void;
  onDirectWarmRejected?: (error: unknown) => void;
}): Promise<CoveWarmupResult> {
  if (input.warmedRenderer === input.gl) {
    return {
      status: input.isCurrent() ? 'completed' : 'superseded',
      warmedRenderer: input.warmedRenderer,
      warmAttempted: false,
    };
  }

  if (input.compile) {
    const compileResult = await waitForCoveCompile(
      input.gl,
      input.compile,
      input.timeoutMs,
    );
    if (compileResult.kind === 'rejected') {
      input.onCompileRejected?.(compileResult.error);
    } else if (compileResult.kind === 'timed-out') {
      input.onCompileTimedOut?.();
    }
  }

  if (!input.isCurrent()) {
    return {
      status: 'superseded',
      warmedRenderer: input.warmedRenderer,
      warmAttempted: false,
    };
  }

  try {
    await input.directWarm();
  } catch (error) {
    input.onDirectWarmRejected?.(error);
  }

  if (!input.isCurrent()) {
    return {
      status: 'superseded',
      warmedRenderer: input.warmedRenderer,
      warmAttempted: true,
    };
  }
  return {
    status: 'completed',
    warmedRenderer: input.gl,
    warmAttempted: true,
  };
}

export function resetCoveWarmupEntriesForTests(): void {
  currentCompileEntry = null;
}
