import {
  chainBootCompile,
  isRendererCompileTimedOut,
  markRendererCompileTimedOut,
} from '@/lib/three/boot-core-compile';

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

  let healAttemptedInChain = false;
  if (input.compile && !isRendererCompileTimedOut(input.gl)) {
    // [R2-1 → BGR R2-NF1/impl-B1] the stage compile JOINS the renderer-wide
    // FIFO (an idle-await only observes work ALREADY chained — a compile
    // that starts before a successor generation chains its boot compile
    // could still overlap it). waitForStageSlotCompile self-bounds via
    // timeoutMs, so the chain cannot wedge; a TIMEOUT poisons the renderer
    // in the shared registry BEFORE the chain releases (the orphan tail is
    // uncancellable — poisoning is what makes releasing safe), and a
    // REJECTION heals the renderer front state with the direct warm INSIDE
    // the chained critical section (never skipped on supersession) so a
    // queued successor's compile never runs against a poisoned front.
    const compileResult = await chainBootCompile(async (): Promise<StageCompileWaitResult> => {
      // [fix-NF1] TOCTOU recheck: a predecessor in the chain may have timed
      // out and poisoned THIS renderer after the enqueue-time check above.
      if (isRendererCompileTimedOut(input.gl)) return { kind: 'bypassed' };
      const result = await waitForStageSlotCompile(
        input.slotId,
        input.gl,
        input.compile!,
        input.timeoutMs,
      );
      if (result.kind === 'timed-out') {
        markRendererCompileTimedOut(input.gl);
      } else if (result.kind === 'rejected') {
        // [fix-NF4] EVERY heal attempt stays in-chain, exactly once: a heal
        // that itself rejects poisons the renderer BEFORE the chain
        // releases (the front state is unrestored and unhealable — no
        // later compile may run against it). Never retried outside.
        healAttemptedInChain = true;
        try {
          await input.directWarm();
        } catch (error) {
          // [fix-R5-1] POISON FIRST — the safety write must never depend on
          // an observer behaving: a throwing onDirectWarmRejected would
          // otherwise reject the chained task and release the FIFO with the
          // renderer unpoisoned. Observer exceptions are contained.
          markRendererCompileTimedOut(input.gl);
          try {
            input.onDirectWarmRejected?.(error);
          } catch (observerError) {
            console.warn(
              '[stage-warmup] onDirectWarmRejected threw (contained):',
              observerError,
            );
          }
        }
      }
      return result;
    });
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
      warmAttempted: healAttemptedInChain,
    };
  }

  if (!healAttemptedInChain) {
    try {
      await input.directWarm();
    } catch (error) {
      input.onDirectWarmRejected?.(error);
    }
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
