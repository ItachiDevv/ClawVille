type GpuDrainTimer = {
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Wait for work submitted by the direct warm draw. All paths fail open. */
export async function waitForTradingFloorGpuDrain(
  renderer: unknown,
  timeoutMs = 3000,
  timers: GpuDrainTimer = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
  },
): Promise<void> {
  try {
    const render = renderer as {
      backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } }; gl?: WebGL2RenderingContext };
      getContext?: () => WebGL2RenderingContext;
    };
    const submitted = render.backend?.device?.queue?.onSubmittedWorkDone;
    if (typeof submitted === 'function') {
      await new Promise<void>((resolve) => {
        const timer = timers.schedule(resolve, timeoutMs);
        try {
          void submitted.call(render.backend!.device!.queue).then(
            () => { timers.cancel(timer); resolve(); },
            () => { timers.cancel(timer); resolve(); },
          );
        } catch {
          timers.cancel(timer);
          resolve();
        }
      });
      return;
    }

    const context = render.backend?.gl ?? render.getContext?.();
    if (!context || typeof context.fenceSync !== 'function' ||
        typeof context.getSyncParameter !== 'function' ||
        typeof context.deleteSync !== 'function' || typeof context.flush !== 'function') return;
    const sync = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) timers.cancel(pollTimer);
        if (deadline !== undefined) timers.cancel(deadline);
        try { context.deleteSync(sync); } catch { /* fail open */ }
        resolve();
      };
      const poll = () => {
        try {
          if (context.getSyncParameter(sync, context.SYNC_STATUS) === context.SIGNALED) {
            finish();
          } else {
            pollTimer = timers.schedule(poll, 16);
          }
        } catch {
          finish();
        }
      };
      deadline = timers.schedule(finish, timeoutMs);
      try {
        context.flush();
        poll();
      } catch {
        finish();
      }
    });
  } catch {
    // GPU drain is a best-effort warm barrier, never a transition blocker.
  }
}

