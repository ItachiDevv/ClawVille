// boot-core-compile.ts — rung-4 slice E rev 2 (docs/perf-cold-load-rung4-sliceE-spec.md
// §2a): SERIAL boot-core compile queue. Width is structurally 1 — Codex R1
// (spec §6, findings 1-3) proved concurrent r185 compileAsync calls unsafe:
// WebGPU error scopes are device-wide LIFO, the shared RenderList/LightsNode
// is mutated per front while cove chunks carry real point lights, and WebGL2
// readiness polls read the shared materialProperties.currentProgram. The
// slice-E win comes from STARTING this serial queue early (overlapped with
// the dep wait + scans), not from compile-vs-compile concurrency.
//
// Abort-on-failure (R1-4): a rejection leaves renderer front state
// unrestored (no finally in r185's compileAsync front), so the queue stops
// dispatching on the first rejection. The subsequent warm draw is the
// fail-open — render() re-seats _handleObjectFunction/_currentRenderContext
// at entry and synchronously compiles whatever the queue missed, behind the
// overlay.

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
