import { awaitBootCompileIdle } from '@/lib/three/boot-core-compile';

export const STAGE_COMPILE_TIMEOUT_MS = 20_000;

interface StageCompileEntry {
  gl: unknown;
  compilePromise: Promise<void>;
  timedOut: boolean;
  settled: boolean;
}

export type StageCompileWaitResult =
  | { kind: 'settled' }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timed-out' }
  | { kind: 'bypassed' };

export interface StageWarmupResult {
  status: 'completed' | 'superseded';
  warmedRenderer: unknown | null;
  warmAttempted: boolean;
}

const compileEntriesBySlot = new Map<string, StageCompileEntry>();

function createEntry(
  slotId: string,
  gl: unknown,
  compile: () => Promise<void>,
): StageCompileEntry {
  const entry: StageCompileEntry = {
    gl,
    compilePromise: Promise.resolve().then(compile),
    timedOut: false,
    settled: false,
  };
  entry.compilePromise.then(
    () => {
      entry.settled = true;
      if (compileEntriesBySlot.get(slotId) === entry && !entry.timedOut) {
        compileEntriesBySlot.delete(slotId);
      }
    },
    () => {
      entry.settled = true;
      if (compileEntriesBySlot.get(slotId) === entry && !entry.timedOut) {
        compileEntriesBySlot.delete(slotId);
      }
    },
  );
  return entry;
}

export async function waitForStageSlotCompile(
  slotId: string,
  gl: unknown,
  compile: () => Promise<void>,
  timeoutMs = STAGE_COMPILE_TIMEOUT_MS,
): Promise<StageCompileWaitResult> {
  let entry = compileEntriesBySlot.get(slotId);
  if (!entry || entry.gl !== gl) {
    entry = createEntry(slotId, gl, compile);
    compileEntriesBySlot.set(slotId, entry);
  }
  if (entry.timedOut) return { kind: 'bypassed' };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StageCompileWaitResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (compileEntriesBySlot.get(slotId) === entry && !entry.settled) {
        entry.timedOut = true;
      }
      resolve({ kind: 'timed-out' });
    }, timeoutMs);
  });
  const settled = entry.compilePromise.then<
    StageCompileWaitResult,
    StageCompileWaitResult
  >(
    () => ({ kind: 'settled' }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return result;
}

export async function warmStageSlotRenderer(input: {
  slotId: string;
  gl: unknown;
  warmedRenderer: unknown | null;
  compile?: () => Promise<void>;
  directWarm: () => Promise<void>;
  isCurrent: () => boolean;
  timeoutMs?: number;
  onCompileRejected?: (error: unknown) => void;
  onCompileTimedOut?: () => void;
  onDirectWarmRejected?: (error: unknown) => void;
}): Promise<StageWarmupResult> {
  if (input.warmedRenderer === input.gl) {
    return {
      status: input.isCurrent() ? 'completed' : 'superseded',
      warmedRenderer: input.warmedRenderer,
      warmAttempted: false,
    };
  }

  if (input.compile) {
    // [R2-1] a scene entered mid-world-boot must not run its stage compile
    // while an orphan boot compileAsync tail is still draining.
    await awaitBootCompileIdle();
    const compileResult = await waitForStageSlotCompile(
      input.slotId,
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

export function resetStageWarmupEntriesForTests(): void {
  compileEntriesBySlot.clear();
}
