import { describe, expect, test } from 'bun:test';
import {
  BlackjackRoomRevealEpoch,
  type BlackjackRoomCommittedStep,
} from '../blackjack-room-reveal-epoch';
import type { BlackjackDealStep } from '../use-blackjack-room-controller';

describe('BlackjackRoomRevealEpoch', () => {
  function fakeEpoch() {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const cleared: number[] = [];
    const epoch = new BlackjackRoomRevealEpoch(
      ((callback: () => void, delayMs: number) => {
        callbacks.push(callback);
        delays.push(delayMs);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      ((handle) => cleared.push(handle as unknown as number)),
    );
    return { callbacks, cleared, delays, epoch };
  }

  test('dealt natural stages hole -> dealer-reveal (120ms) -> settled (280ms)', () => {
    const { callbacks, delays, epoch } = fakeEpoch();
    const commits: BlackjackRoomCommittedStep[] = [];
    let dealStep: BlackjackDealStep = 'hole';
    epoch.begin('hand-a');
    const schedule = () => epoch.scheduleCommittedStep(
      'hand-a',
      dealStep,
      (nextStep) => {
        dealStep = nextStep;
        commits.push(nextStep);
        schedule();
      },
    );
    schedule();
    callbacks[0]!();
    callbacks[1]!();
    expect(commits).toEqual(['dealer-reveal', 'settled']);
    expect(delays).toEqual([120, 280]);
  });

  test('terminal action stages player-turn -> dealer-reveal (120ms) -> settled (280ms)', () => {
    const { callbacks, delays, epoch } = fakeEpoch();
    const commits: BlackjackRoomCommittedStep[] = [];
    let dealStep: BlackjackDealStep = 'player-turn';
    epoch.begin('hand-a');
    const schedule = () => epoch.scheduleCommittedStep(
      'hand-a',
      dealStep,
      (nextStep) => {
        dealStep = nextStep;
        commits.push(nextStep);
        schedule();
      },
    );
    schedule();
    callbacks[0]!();
    callbacks[1]!();
    expect(commits).toEqual(['dealer-reveal', 'settled']);
    expect(delays).toEqual([120, 280]);
  });

  test('settled and idle steps schedule nothing', () => {
    const { callbacks, epoch } = fakeEpoch();
    epoch.begin('hand-a');
    expect(epoch.scheduleCommittedStep('hand-a', 'settled', () => {})).toBeUndefined();
    expect(epoch.scheduleCommittedStep('hand-a', 'idle', () => {})).toBeUndefined();
    expect(epoch.scheduleCommittedStep('hand-a', 'split', () => {})).toBeUndefined();
    expect(callbacks).toHaveLength(0);
  });

  test('re-render of the same committed step does not double-arm', () => {
    const { callbacks, epoch } = fakeEpoch();
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep('hand-a', 'hole', () => {});
    epoch.scheduleCommittedStep('hand-a', 'hole', () => {});
    expect(callbacks).toHaveLength(1);
  });

  test('cancel invalidates an armed committed step', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: BlackjackRoomCommittedStep[] = [];
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep('hand-a', 'dealer-reveal', (step) => commits.push(step));
    epoch.cancel();
    callbacks[0]!();
    expect(commits).toEqual([]);
  });

  test('a new hand cannot receive the prior hand timer', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep('hand-a', 'hole', (step) => commits.push(`stale-${step}`));
    epoch.begin('hand-b');
    epoch.scheduleCommittedStep('hand-b', 'hole', (step) => commits.push(`fresh-${step}`));
    callbacks[0]!();
    callbacks[1]!();
    expect(commits).toEqual(['fresh-dealer-reveal']);
  });

  test('a mismatched correlation cannot arm a committed step', () => {
    const { callbacks, epoch } = fakeEpoch();
    epoch.begin('hand-a');
    const cleanup = epoch.scheduleCommittedStep('hand-b', 'hole', () => {});
    expect(cleanup).toBeUndefined();
    expect(callbacks).toHaveLength(0);
  });

  test('effect cleanup clears only its scheduled committed step', () => {
    const { callbacks, cleared, epoch } = fakeEpoch();
    const commits: BlackjackRoomCommittedStep[] = [];
    epoch.begin('hand-a');
    const cleanup = epoch.scheduleCommittedStep('hand-a', 'hole', (step) => commits.push(step));
    cleanup?.();
    callbacks[0]!();
    expect(cleared).toEqual([1]);
    expect(commits).toEqual([]);
    expect(epoch.isCurrent('hand-a')).toBe(true);
  });

  test('scheduleDeferred is epoch-guarded like committed steps', () => {
    const { callbacks, epoch } = fakeEpoch();
    let fired = 0;
    epoch.begin('hand-a');
    epoch.scheduleDeferred(0, () => { fired += 1; });
    epoch.cancel();
    callbacks[0]!();
    expect(fired).toBe(0);
    epoch.begin('hand-b');
    epoch.scheduleDeferred(0, () => { fired += 1; });
    callbacks[1]!();
    expect(fired).toBe(1);
  });

  test('default timers are bound (no Illegal invocation off the class)', async () => {
    const epoch = new BlackjackRoomRevealEpoch();
    let fired = 0;
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep('hand-a', 'hole', () => { fired += 1; });
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(fired).toBe(1);
    epoch.cancel();
  });
});
