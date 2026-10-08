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
  QUALITY_DEGRADE_SAMPLES,
  QUALITY_FPS_DOWN,
  QUALITY_MAX_TIER,
  QUALITY_POST_LOAD_CEILING_MS,
  QUALITY_POST_LOAD_SETTLE_MS,
  QUALITY_SAMPLE_MS,
  QUALITY_WARMUP_MS,
  createQualityGovernor,
  worldQualitySignals,
  type QualityGovernorSignals,
} from './adaptive-quality-governor';

/** `dismissedAt`: the loader's own dismissal time (null while the loader is up). */
type Signals = QualityGovernorSignals & { dismissedAt: number | null; quiet: boolean };

function signals(dismissed = false, quiet = false): Signals {
  return {
    dismissedAt: dismissed ? 0 : null,
    quiet,
    getLoadingDismissedAt() {
      return this.dismissedAt;
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
      s.dismissedAt = now >= 6_000 ? 6_000 : null;
    });
    expect(loading).toEqual([]);
    // Work goes quiet at 17 s; frames stay at 60 FPS through the settle window.
    s.quiet = true;
    expect(drive(gov, 17_000, 17_000 + QUALITY_POST_LOAD_SETTLE_MS, 60)).toEqual([]);
    // A real gameplay drop after arming degrades after 2 consecutive low
    // windows (web-load T11).
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
      s.dismissedAt = now >= dismissAt ? dismissAt : null;
    });
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    expect(changes[0]![0]).toBeGreaterThanOrEqual(dismissAt + QUALITY_POST_LOAD_CEILING_MS);
  });
});

describe('adaptive quality governor: ceiling origin and quiet signal (Codex E3 on 9ec8bd50)', () => {
  test('the ceiling counts from the LOADER dismissal time, not from the first frame that sees it', () => {
    // The loader was dismissed at 6 s while the world scene was inactive (a
    // stage visit): the governor's first frame runs at 40 s. Post-load work
    // never goes quiet. The ceiling (dismissal + 30 s = 36 s) has already
    // passed, so the gate opens at once; only the 5 s warmup remains.
    const s = signals(false, false);
    s.dismissedAt = 6_000;
    const gov = createQualityGovernor(0, s);
    const start = 40_000;
    gov.resume(start);
    const changes = drive(gov, start, start + 20_000, 30);
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    expect(changes[0]![0]).toBeLessThanOrEqual(start + QUALITY_WARMUP_MS + QUALITY_SAMPLE_MS + 50);
  });

  test('worldQualitySignals: quiet only when stream settled, warm queue idle AND no decoration warm read pending', () => {
    const probe = { dismissedAt: 1234 as number | null, settled: true, idle: true, decoPending: false };
    const sig = worldQualitySignals({
      loadingDismissedAt: () => probe.dismissedAt,
      streamSettled: () => probe.settled,
      warmQueueIdle: () => probe.idle,
      decorationWarmReadPending: () => probe.decoPending,
    });
    expect(sig.getLoadingDismissedAt()).toBe(1234);
    expect(sig.isPostLoadQuiet()).toBe(true);
    probe.decoPending = true; // the 11 decoration GLBs are still loading / parsing
    expect(sig.isPostLoadQuiet()).toBe(false);
    probe.decoPending = false;
    probe.idle = false;
    expect(sig.isPostLoadQuiet()).toBe(false);
    probe.idle = true;
    probe.settled = false;
    expect(sig.isPostLoadQuiet()).toBe(false);
    probe.dismissedAt = null;
    expect(sig.getLoadingDismissedAt()).toBeNull();
  });

  test('a decoration warm read pending past the settle keeps the gate closed; it opens 3 s after it ends', () => {
    const probe = { decoPending: true };
    const gov = createQualityGovernor(
      0,
      worldQualitySignals({
        loadingDismissedAt: () => 0,
        streamSettled: () => true,
        warmQueueIdle: () => true,
        decorationWarmReadPending: () => probe.decoPending,
      }),
    );
    gov.resume(0);
    expect(drive(gov, 0, 12_000, 30)).toEqual([]);
    expect(gov.armed).toBe(false);
    probe.decoPending = false;
    expect(drive(gov, 12_000, 12_000 + QUALITY_POST_LOAD_SETTLE_MS - 100, 60)).toEqual([]);
    expect(gov.armed).toBe(false);
    drive(gov, 12_000 + QUALITY_POST_LOAD_SETTLE_MS - 100, 12_000 + QUALITY_POST_LOAD_SETTLE_MS + 100, 60);
    expect(gov.armed).toBe(true);
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

  test('(f) the second degrade still latches; a later stable 60 FPS never recovers', () => {
    const { gov, t } = armed();
    // degrade 1 (2 low windows) -> recovery (3 high windows) -> degrade 2.
    const d1 = drive(gov, t, t + 2 * QUALITY_SAMPLE_MS + 100, 40);
    expect(d1.map(([, v]) => v)).toEqual([1]);
    expect(gov.latched).toBe(false);
    const t1 = t + 2 * QUALITY_SAMPLE_MS + 100;
    expect(drive(gov, t1, t1 + 4 * QUALITY_SAMPLE_MS + 100, 60).map(([, v]) => v)).toEqual([0]);
    const t2 = t1 + 4 * QUALITY_SAMPLE_MS + 100;
    expect(drive(gov, t2, t2 + 2 * QUALITY_SAMPLE_MS + 100, 40).map(([, v]) => v)).toEqual([1]);
    expect(gov.latched).toBe(true);
    const t3 = t2 + 2 * QUALITY_SAMPLE_MS + 100;
    expect(drive(gov, t3, t3 + 120_000, 60)).toEqual([]);
    expect(gov.tier).toBe(QUALITY_MAX_TIER);
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
    s.dismissedAt = 20_000;
    s.quiet = true;
    const r = drive(gov, 20_000, 20_000 + QUALITY_POST_LOAD_SETTLE_MS + 4 * QUALITY_SAMPLE_MS + 100, 60);
    expect(r.map(([, v]) => v)).toEqual([0]);
  });
});

/**
 * web-load T11 (staging 4fe13447, headless, runs v4-A1..A5 / L1..L3 / B1..B5):
 * one 2.5 s window below 58 FPS degraded, and at 60 Hz that is only 5 missed
 * frames. 9 of 13 trigger windows lost <= 9 frames (one short bucket or
 * scattered one-frame losses), and tier 1 did not lower the dip rate (2.5 s
 * windows < 58: 7.4% at tier 0, 11.8% at tier 1). The old rule latched in
 * 5/5 phase offsets on A2-A5, L2 and L3. New rule: 2 CONSECUTIVE windows
 * below 55 FPS. After arming, every window counts (the busy-window skip was
 * removed after Codex E3 on 58d7d91b).
 */
describe('adaptive quality governor: 2 consecutive low windows (web-load T11)', () => {
  /** Frames at `fps`, with one stall of `stallMs` (no frames) starting at `stallAt`. */
  function driveWithStall(
    gov: ReturnType<typeof createQualityGovernor>,
    from: number,
    to: number,
    fps: number,
    stallAt: number,
    stallMs: number,
  ): Array<[number, number]> {
    const changes: Array<[number, number]> = [];
    const step = 1000 / fps;
    for (let now = from; now < to; now += step) {
      if (now >= stallAt && now < stallAt + stallMs) continue;
      const next = gov.frame(now);
      if (next !== null) changes.push([Math.round(now), next]);
    }
    return changes;
  }

  test('the down threshold is 55 FPS and 2 consecutive windows are needed', () => {
    expect(QUALITY_FPS_DOWN).toBe(55);
    expect(QUALITY_DEGRADE_SAMPLES).toBe(2);
  });

  test('(a) one short dip window never degrades (a 400 ms stall, then a whole 40 FPS window)', () => {
    const { gov, t } = armed();
    // A 400 ms task inside one window: ~24 lost frames, the window reads ~50 FPS.
    expect(driveWithStall(gov, t, t + 30_000, 60, t + 6_000, 400)).toEqual([]);
    // One whole window at 40 FPS between 60 FPS stretches.
    const t1 = t + 30_000;
    expect(drive(gov, t1, t1 + QUALITY_SAMPLE_MS + 10, 40)).toEqual([]);
    expect(drive(gov, t1 + QUALITY_SAMPLE_MS + 10, t1 + 40_000, 60)).toEqual([]);
    expect(gov.tier).toBe(0);
  });

  test('(b) two consecutive windows below 55 degrade at the end of the second', () => {
    const { gov, t } = armed();
    // 60 FPS until a window boundary, then 50 FPS.
    expect(drive(gov, t, t + 10_000, 60)).toEqual([]);
    const lowFrom = t + 10_000;
    const changes = drive(gov, lowFrom, lowFrom + 4 * QUALITY_SAMPLE_MS, 50);
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    // The window that straddles the drop may read >= 55; at most 3 windows.
    expect(changes[0]![0]).toBeGreaterThanOrEqual(lowFrom + QUALITY_SAMPLE_MS + 50);
    expect(changes[0]![0]).toBeLessThanOrEqual(lowFrom + 3 * QUALITY_SAMPLE_MS + 50);
  });

  test('(c) a window below 55 followed by a window >= 55 resets the run', () => {
    const { gov, t } = armed();
    // Alternate whole windows: 50 FPS, then 56 FPS (>= 55 but < 59), x6.
    let now = t;
    for (let i = 0; i < 6; i++) {
      const lowEnd = now + QUALITY_SAMPLE_MS + 10;
      expect(drive(gov, now, lowEnd, 50)).toEqual([]);
      const highEnd = lowEnd + QUALITY_SAMPLE_MS + 10;
      expect(drive(gov, lowEnd, highEnd, 56)).toEqual([]);
      now = highEnd;
    }
    expect(gov.tier).toBe(0);
  });

  test('(d) post-load work after arming never hides low windows: 40 FPS with a busy blip in every window degrades', () => {
    // Codex E3 on 58d7d91b: a per-window busy skip could skip EVERY window when a
    // brief job ran in each one, so a 40 FPS machine would never degrade.
    // After arming, the busy signal is not read at all.
    const { gov, s, t } = armed();
    const changes = drive(gov, t, t + 4 * QUALITY_SAMPLE_MS, 40, (now) => {
      // A 100 ms busy blip every 1.25 s (at least one in every window).
      s.quiet = (now - t) % 1250 >= 100;
    });
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    expect(changes[0]![0]).toBeLessThanOrEqual(t + 3 * QUALITY_SAMPLE_MS + 50);
  });

  test('(e) a slow series (5-20 FPS) degrades within 2 windows of arming', () => {
    const s = signals(true, false);
    const gov = createQualityGovernor(0, s);
    gov.resume(0);
    // Busy until 20 s at 8 FPS (load), then quiet: arms at 23 s.
    expect(drive(gov, 0, 20_000, 8)).toEqual([]);
    s.quiet = true;
    const changes: Array<[number, number]> = [];
    let now = 20_000;
    let i = 0;
    const fpsCycle = [5, 12, 20, 9, 15, 7];
    while (now < 40_000) {
      const fps = fpsCycle[i++ % fpsCycle.length]!;
      const end = now + 1_000;
      changes.push(...drive(gov, now, end, fps));
      now = end;
    }
    expect(gov.armed).toBe(true);
    expect(changes.length).toBe(1);
    expect(changes[0]![1]).toBe(QUALITY_MAX_TIER);
    const armedAt = 20_000 + QUALITY_POST_LOAD_SETTLE_MS;
    // 2 windows + one 5 FPS frame step.
    expect(changes[0]![0]).toBeLessThanOrEqual(armedAt + 2 * QUALITY_SAMPLE_MS + 200 + 200);
  });
});
