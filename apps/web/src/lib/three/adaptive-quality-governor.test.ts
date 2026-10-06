/**
 * Adaptive quality governor (web-load T8). Local prod build at 1342805d,
 * RTX 3080, 3/3 cold loads: the loader was dismissed at ~6 s, but post-load
 * work (stream members, deferred GPU warms, the seabed decoration warm) ran
 * to ~17 s and dropped 500 ms buckets to 34-56 FPS. The governor sampled
 * that load and degraded to tier 1 at 9.3-11.8 s; its recovery at 19-25 s
 * remounted seaweed + kelp (a 154-181 ms task), the second degrade followed
 * 2.3 s later and latched tier 1: decorations hidden for the session.
 *
 * These tests pin: load-time frames never count, the post-load gate needs
 * the loader dismissed AND the post-load work quiet for a settle window (or
 * the ceiling), and the anti-flap latch is unchanged for gameplay drops.
 */
import { describe, expect, test } from 'bun:test';
import {
  QUALITY_MAX_TIER,
  QUALITY_POST_LOAD_CEILING_MS,
  QUALITY_POST_LOAD_SETTLE_MS,
  QUALITY_SAMPLE_MS,
  QUALITY_WARMUP_MS,
  createQualityGovernor,
  type QualityGovernorSignals,
} from './adaptive-quality-governor';

type Signals = QualityGovernorSignals & { dismissed: boolean; quiet: boolean };

function signals(dismissed = false, quiet = false): Signals {
  return {
    dismissed,
    quiet,
    isLoadingDismissed() {
      return this.dismissed;
    },
    isPostLoadQuiet() {
      return this.quiet;
    },
  };
}

/** Feed rAF frames at `fps` from `from` to `to` ms; returns [time, tier] changes. */
function drive(
  gov: ReturnType<typeof createQualityGovernor>,
  from: number,
  to: number,
  fps: number,
  onFrame?: (now: number) => void,
): Array<[number, number]> {
  const changes: Array<[number, number]> = [];
  const step = 1000 / fps;
  for (let now = from; now < to; now += step) {
    onFrame?.(now);
    const next = gov.frame(now);
    if (next !== null) changes.push([Math.round(now), next]);
  }
  return changes;
}

/** Arms the governor: loader dismissed, work quiet for the settle window. */
function armed(initialTier = 0) {
  const s = signals(true, true);
  const gov = createQualityGovernor(initialTier, s);
  gov.resume(0);
  expect(drive(gov, 0, QUALITY_POST_LOAD_SETTLE_MS + 50, 60)).toEqual([]);
  return { gov, s, t: QUALITY_POST_LOAD_SETTLE_MS + 50 };
}

describe('adaptive quality governor: load-time frames never count', () => {
  test('while the loader is up, 20 s at 30 FPS never degrades', () => {
    const gov = createQualityGovernor(0, signals(false, false));
    gov.resume(0);
    expect(drive(gov, 0, 20_000, 30)).toEqual([]);
    expect(gov.tier).toBe(0);
  });

  test('after dismissal, busy post-load work never degrades; the first quiet settle arms it', () => {
    const s = signals(false, false);
    const gov = createQualityGovernor(0, s);
    gov.resume(0);
    // Loader up 0-6 s, post-load work busy 6-17 s: both at 30 FPS.
    const loading = drive(gov, 0, 17_000, 30, (now) => {
      s.dismissed = now >= 6_000;
    });
    expect(loading).toEqual([]);
    // Work goes quiet at 17 s; frames stay at 60 FPS through the settle window.
    s.quiet = true;
    expect(drive(gov, 17_000, 17_000 + QUALITY_POST_LOAD_SETTLE_MS, 60)).toEqual([]);
    // A real gameplay drop after arming degrades within one sample window
    // (plus the window that straddles the drop).
    const armedAt = 17_000 + QUALITY_POST_LOAD_SETTLE_MS;
    const drop = drive(gov, armedAt, armedAt + 3 * QUALITY_SAMPLE_MS, 30);
    expect(drop.length).toBe(1);
    expect(drop[0]![1]).toBe(QUALITY_MAX_TIER);
    expect(drop[0]![0]).toBeLessThanOrEqual(armedAt + 2 * QUALITY_SAMPLE_MS + 50);
  });

  test('quiet must hold for the whole settle window; a busy blip restarts it', () => {
    const s = signals(true, true);
    const gov = createQualityGovernor(0, s);
    gov.resume(0);
    // Quiet for less than the settle window, then busy again (a late warm job).
    expect(drive(gov, 0, QUALITY_POST_LOAD_SETTLE_MS - 500, 60)).toEqual([]);
    s.quiet = false;
    expect(drive(gov, QUALITY_POST_LOAD_SETTLE_MS - 500, 12_000, 30)).toEqual([]);
    expect(gov.tier).toBe(0);
  });

  test('frames before arming never leak into the first counted sample', () => {
    const s = signals(true, false);
    const gov = createQualityGovernor(0, s);
    gov.resume(0);
    // 30 FPS while busy (would read 30 FPS if counted).
    expect(drive(gov, 0, 10_000, 30)).toEqual([]);
    s.quiet = true;
    // From here 60 FPS only: no sample may average in the 30 FPS frames.
    expect(drive(gov, 10_000, 30_000, 60)).toEqual([]);
    expect(gov.tier).toBe(0);
  });

  test('the ceiling arms the governor when post-load work never goes quiet', () => {
    const s = signals(false, false);
    const gov = createQualityGovernor(0, s);
    gov.resume(0);
    const dismissAt = 6_000;
    const changes = drive(gov, 0, dismissAt + QUALITY_POST_LOAD_CEILING_MS + 3 * QUALITY_SAMPLE_MS, 30, (now) => {
      s.dismissed = now >= dismissAt;
    });
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    expect(changes[0]![0]).toBeGreaterThanOrEqual(dismissAt + QUALITY_POST_LOAD_CEILING_MS);
  });
});

describe('adaptive quality governor: gameplay rules unchanged once armed', () => {
  test('degrade, recover after 3 high samples, second degrade latches tier 1', () => {
    const { gov, t } = armed();
    const d1 = drive(gov, t, t + 2 * QUALITY_SAMPLE_MS + 100, 30);
    expect(d1.map(([, v]) => v)).toEqual([1]);
    const t1 = t + 2 * QUALITY_SAMPLE_MS + 100;
    const r1 = drive(gov, t1, t1 + 4 * QUALITY_SAMPLE_MS + 100, 60);
    expect(r1.map(([, v]) => v)).toEqual([0]);
    const t2 = t1 + 4 * QUALITY_SAMPLE_MS + 100;
    const d2 = drive(gov, t2, t2 + 2 * QUALITY_SAMPLE_MS + 100, 30);
    expect(d2.map(([, v]) => v)).toEqual([1]);
    expect(gov.latched).toBe(true);
    const t3 = t2 + 2 * QUALITY_SAMPLE_MS + 100;
    expect(drive(gov, t3, t3 + 60_000, 60)).toEqual([]);
    expect(gov.tier).toBe(1);
  });

  test('one hitch degrades once and does not latch', () => {
    const { gov, t } = armed();
    const hitch = drive(gov, t, t + QUALITY_SAMPLE_MS + 10, 40);
    expect(hitch.map(([, v]) => v)).toEqual([1]);
    expect(gov.latched).toBe(false);
  });

  test('resume() keeps the tier and the latch; only the warmup restarts', () => {
    const { gov, t } = armed();
    drive(gov, t, t + 2 * QUALITY_SAMPLE_MS + 100, 30);
    expect(gov.tier).toBe(1);
    // A stage visit stops the rAF loop; the world comes back later.
    const back = 100_000;
    gov.resume(back);
    expect(gov.tier).toBe(1);
    // Warmup: no decision inside QUALITY_WARMUP_MS, then 3 high samples recover.
    const r = drive(gov, back, back + QUALITY_WARMUP_MS + 4 * QUALITY_SAMPLE_MS + 100, 60);
    expect(r.map(([, v]) => v)).toEqual([0]);
    expect(r[0]![0]).toBeGreaterThanOrEqual(back + QUALITY_WARMUP_MS);
  });

  test('initial tier 1 (desktop-low) recovers only after arming', () => {
    const s = signals(false, false);
    const gov = createQualityGovernor(1, s);
    gov.resume(0);
    expect(drive(gov, 0, 20_000, 60)).toEqual([]);
    s.dismissed = true;
    s.quiet = true;
    const r = drive(gov, 20_000, 20_000 + QUALITY_POST_LOAD_SETTLE_MS + 4 * QUALITY_SAMPLE_MS + 100, 60);
    expect(r.map(([, v]) => v)).toEqual([0]);
  });
});
