import type { BlackjackDealStep } from './use-blackjack-room-controller';

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

export type BlackjackRoomCommittedStep = 'dealer-reveal' | 'settled';

const ROOM_STAGE_MS = 120;
const ROOM_SETTLE_REVEAL_MS = 280;

/**
 * Settled-staging scheduler for the 3D blackjack room. Sibling of the certified
 * 2D BlackjackRevealEpoch (deliberately NOT a shared refactor — the 2D class and
 * its step plan are certified surface): every callback captures both the epoch
 * and the correlation active when scheduled, then re-proves both before
 * committing, and each staged step is armed only from the COMMITTED previous
 * frame, so a step can never outrun React's commit of the frame before it.
 *
 * Plan (a settled response is always pending while this runs):
 *   hole        -> dealer-reveal after 120ms (dealt naturals)
 *   player-turn -> dealer-reveal after 120ms (terminal-action masked beat)
 *   dealer-reveal -> settled     after 280ms
 */
export class BlackjackRoomRevealEpoch {
  private epoch = 0;
  private correlation: string | null = null;
  private committedStepKey: string | null = null;
  private readonly timers = new Set<TimerHandle>();

  constructor(
    private readonly setTimer: SetTimer = (callback, delayMs) => (
      setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearTimer = (handle) => clearTimeout(handle),
  ) {}

  begin(correlation: string): void {
    this.cancel();
    this.correlation = correlation;
  }

  scheduleCommittedStep(
    correlation: string,
    dealStep: BlackjackDealStep,
    commit: (step: BlackjackRoomCommittedStep) => void,
  ): (() => void) | undefined {
    if (this.correlation !== correlation) return;

    let delayMs: number;
    let nextStep: BlackjackRoomCommittedStep;
    if (dealStep === 'hole' || dealStep === 'player-turn') {
      delayMs = ROOM_STAGE_MS;
      nextStep = 'dealer-reveal';
    } else if (dealStep === 'dealer-reveal') {
      delayMs = ROOM_SETTLE_REVEAL_MS;
      nextStep = 'settled';
    } else {
      return;
    }

    const key = `${correlation}:${dealStep}`;
    if (this.committedStepKey === key) return;
    this.committedStepKey = key;
    const cleanup = this.schedule(delayMs, () => {
      if (this.committedStepKey !== key) return;
      this.committedStepKey = null;
      commit(nextStep);
    });
    return () => {
      if (this.committedStepKey === key) this.committedStepKey = null;
      cleanup();
    };
  }

  /** Epoch-owned deferral (e.g. the zero-delay settled transition reset). */
  scheduleDeferred(delayMs: number, callback: () => void): () => void {
    return this.schedule(delayMs, callback);
  }

  private schedule(delayMs: number, callback: () => void): () => void {
    const scheduledEpoch = this.epoch;
    const scheduledCorrelation = this.correlation;
    let active = true;
    const handle = this.setTimer(() => {
      active = false;
      this.timers.delete(handle);
      if (
        scheduledEpoch !== this.epoch ||
        scheduledCorrelation === null ||
        scheduledCorrelation !== this.correlation
      ) {
        return;
      }
      callback();
    }, delayMs);
    this.timers.add(handle);
    return () => {
      if (!active) return;
      active = false;
      this.timers.delete(handle);
      this.clearTimer(handle);
    };
  }

  isCurrent(correlation: string): boolean {
    return this.correlation === correlation;
  }

  cancel(): void {
    this.epoch += 1;
    this.correlation = null;
    this.committedStepKey = null;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }
}
