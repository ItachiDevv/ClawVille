// boot-core-compile.ts — rung-4 slice E (docs/perf-cold-load-rung4-sliceE-spec.md
// §2a + §8): SERIAL boot-core compile queue + renderer-wide boot-compile
// FIFO. Width is structurally 1 — Codex R1 (spec §6, findings 1-3) proved
// concurrent r185 compileAsync calls unsafe: WebGPU error scopes are
// device-wide LIFO, the shared RenderList/LightsNode is mutated per front
// while cove chunks carry real point lights, and WebGL2 readiness polls read
// the shared materialProperties.currentProgram. The early-start overlap
// experiment was MEASURED OUT (spec §8) — the SHIPPED shape runs this queue
// once, post-scans, at the slice-D position; what ships from slice E is the
// hardening (this FIFO, abort-on-failure, signature coverage, atomic culling
// windows, honest stamps).
//
// Abort-on-failure (R1-4): a rejection leaves renderer front state
// unrestored (no finally in r185's compileAsync front), so the queue stops
// dispatching on the first rejection. The caller heals the renderer with a
// controlled render INSIDE the chained task (R3-3) before the chain
// releases; the warm draw remains the broader fail-open.

// ---------------------------------------------------------------------------
// Renderer-wide compile serialization [R2-1]: a warmup generation's cleanup
// can flip `cancelled` but CANNOT cancel an in-flight compileAsync tail. A
// successor generation (renderer replacement, StrictMode replay) or a
// post-fuse deferred/stage warm starting its own compileAsync while the
// orphan tail drains would resurrect the R1 concurrency races. Every boot
// compile phase runs through `chainBootCompile` (strict FIFO — one compile
// task in flight PROCESS-WIDE), and the deferred-warm + stage-warm paths
// await `awaitBootCompileIdle()` before their first compile.
// ---------------------------------------------------------------------------

let bootCompileChain: Promise<void> = Promise.resolve();
let bootCompileBusy = 0;

export function chainBootCompile<T>(task: () => Promise<T>): Promise<T> {
  bootCompileBusy += 1;
  const run = bootCompileChain.then(task, task);
  bootCompileChain = run.then(
    () => {
      bootCompileBusy -= 1;
    },
    () => {
      bootCompileBusy -= 1;
    },
  );
  return run;
}

export function isBootCompileIdle(): boolean {
  return bootCompileBusy === 0;
}

/** Resolves once every currently-chained boot compile has settled (loops in
 *  case a new phase chains while awaiting). */
export async function awaitBootCompileIdle(): Promise<void> {
  while (bootCompileBusy > 0) {
    await bootCompileChain;
  }
}

/** Test-only reset. */
export function __resetBootCompileChainForTests(): void {
  bootCompileChain = Promise.resolve();
  bootCompileBusy = 0;
}

export type BootCoreCompileResult = {
  /** Unique roots handed to this queue invocation. */
  requested: number;
  /** Roots for which compile() was actually invoked. */
  dispatched: number;
  /** Roots whose compile settled (fulfilled or rejected). */
  settled: number;
  /** Rejected roots (0 in a normal boot — evaluator-asserted). */
  failed: number;
  /** True when stopOnFailure ended the queue before dispatching every root. */
  aborted: boolean;
};

export type BootCoreCompileOptions<G> = {
  groups: readonly G[];
  /** One renderer.compileAsync(group, camera, scene) call. The caller scopes
   *  the frustum-culling override to the SYNCHRONOUS front (spec §2c) —
   *  this queue only awaits the returned promise. */
  compile: (group: G) => Promise<unknown>;
  /** Checked before each dispatch; in-flight awaits cannot be cancelled. */
  isCancelled: () => boolean;
  /** Observer per settled root. Failures here are swallowed (R1-12) — an
   *  observer throw must never reject the queue. */
  onGroupSettled?: (group: G, failed: boolean, error?: unknown) => void;
  /** Stop dispatching after the first rejection (default true, R1-4). */
  stopOnFailure?: boolean;
};

export async function runBootCoreCompileQueue<G>(
  options: BootCoreCompileOptions<G>,
): Promise<BootCoreCompileResult> {
  const { groups, compile, isCancelled, onGroupSettled } = options;
  const stopOnFailure = options.stopOnFailure !== false;
  const result: BootCoreCompileResult = {
    requested: groups.length,
    dispatched: 0,
    settled: 0,
    failed: 0,
    aborted: false,
  };
  for (const group of groups) {
    if (isCancelled()) {
      result.aborted = result.dispatched < groups.length;
      return result;
    }
    result.dispatched += 1;
    let failed = false;
    let error: unknown;
    try {
      await compile(group);
    } catch (err) {
      failed = true;
      error = err;
      result.failed += 1;
    }
    result.settled += 1;
    try {
      onGroupSettled?.(group, failed, error);
    } catch {
      // Observer errors are deliberately swallowed (R1-12).
    }
    if (failed && stopOnFailure) {
      result.aborted = result.dispatched < groups.length;
      return result;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shipped-mode constant + pure helpers extracted for unit tests [R3-1][R3-4].
// ---------------------------------------------------------------------------

/** The SHIPPED compile shape (post-scans serial). The reverted early-start
 *  experiment's mode was 'group-serial-early-1' — the --slice-e evaluator
 *  still pins THAT string as the experiment's gate, deliberately. */
export const BOOT_CORE_COMPILE_SHIPPED_MODE = 'group-serial-1';

export type BootCompileStampInput = {
  /** performance.now() at the first dispatched front (0 = never dispatched). */
  firstKickAt: number;
  /** performance.now() at the last settlement (0 = never settled). */
  lastSettleAt: number;
  /** performance.now() when the texture scan loop finished. */
  scansEndAt: number;
};

/**
 * Timing stamps with the invariants the slice-E evaluator asserts
 * [R3-1]: tail ≤ wall and wall = hidden + tail EXACTLY, by construction —
 * the tail boundary is max(scansEndAt, firstKickAt), so a first kick that
 * happens AFTER the scans (the shipped post-scans shape, where inventory
 * runs between the two) can never produce tail > wall.
 */
export function computeBootCompileStamps(input: BootCompileStampInput): {
  wallMs: number;
  tailMs: number;
  hiddenMs: number;
} {
  if (!(input.firstKickAt > 0) || !(input.lastSettleAt > 0)) {
    return { wallMs: 0, tailMs: 0, hiddenMs: 0 };
  }
  const wallMs = Math.max(0, input.lastSettleAt - input.firstKickAt);
  const tailBoundary = Math.max(input.scansEndAt, input.firstKickAt);
  const tailMs = Math.max(0, Math.min(wallMs, input.lastSettleAt - tailBoundary));
  return { wallMs, tailMs, hiddenMs: wallMs - tailMs };
}

/**
 * Signature-keyed root selection [R2-2][R3-4]: returns the roots whose
 * (uuid → subtree signature) is new or changed since the last compiled
 * front. Duplicated uuids within one inventory are reported once and
 * skipped (structural assert, R1-15).
 */
export function selectRootsToCompile<G extends { uuid: string }>(
  groups: readonly G[],
  compiledSignatures: ReadonlyMap<string, string>,
  signatureOf: (group: G) => string,
  onDuplicate?: (group: G) => void,
): G[] {
  const seen = new Set<string>();
  const out: G[] = [];
  for (const group of groups) {
    if (seen.has(group.uuid)) {
      onDuplicate?.(group);
      continue;
    }
    seen.add(group.uuid);
    if (compiledSignatures.get(group.uuid) !== signatureOf(group)) out.push(group);
  }
  return out;
}
