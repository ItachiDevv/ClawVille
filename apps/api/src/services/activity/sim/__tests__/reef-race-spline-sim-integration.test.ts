/**
 * Reef Race v2 — full-room integration smoke test.
 *
 * Boots a single room with 1 human avatar + 7 bots, ticks the sim for ~90s of
 * simulated time (90 * 30 = 2700 ticks via `__tickOnceForTest`), and
 * asserts the Phase 1 ship gate: races complete end-to-end, bots traverse
 * the slalom, the player can drive forward, the finish line works.
 *
 * Constraints (per .claude/plans/reef-race-v2.md Phase 1 ship gate):
 *   - At least one body crosses the finish line (progress >= 1.0)
 *   - `event.crossed_finish` is broadcast for that body
 *   - `event.match_ended` eventually fires (finish-wait + endRound path)
 *   - No body's progress regresses beyond the 0.02 anti-cheat tolerance
 *   - The human avatar's body moves at least 1000 wu in XZ from spawn
 *
 * Performance target: full 2700 ticks should run in under 5s wall-clock.
 *
 * Spec / architecture:
 *   - .claude/plans/reef-race-v2.md (Phase 1 ship gate)
 *   - .claude/plans/reef-race-v2-spline-architecture.md §5 (Bot AI),
 *     §6 (anti-cheat: 2% backward tolerance)
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Silence DB / event-logger wires (mirrors spline-sim unit-test setup).
mock.module('../../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {
    ANTI_CHEAT_FLAG: 'anti_cheat.flag',
  },
}));
mock.module('../../activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));

const { reefRaceSplineSim } = await import('../reef-race-spline-sim');
const { REEF_TICK_HZ, REEF_RACE_LOOP_HARD_TIMEOUT_MS } = await import('../reef-race-config');
const { createReefRaceBot } = await import('../../bots/reef-race-bot');
const { ReefSpline } = await import('../reef-race-spline');
const { REEF_RACE_DEFAULT_TRACK } = await import('../reef-race-track-layout');

// Mirrors the constant inside reef-race-spline-sim.ts; keeping it local so
// the test doesn't rely on a private export.
const REEF_FINISH_WAIT_MS = 30_000;

const ROOM_ID = 'spline-integration-room';
const HUMAN_PET = 'human-avatar';
const BOT_PETS = [
  'bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6', 'bot-7',
] as const;
const ALL_PETS = [HUMAN_PET, ...BOT_PETS];

const DT = 1 / REEF_TICK_HZ;
// CLOSED-LOOP (2026-06-22): a full N-lap race is ~3× one loop, so tick the
// whole race window (the loop hard timeout) + a margin, NOT a single 90s loop.
const SIM_DURATION_SEC = Math.ceil(REEF_RACE_LOOP_HARD_TIMEOUT_MS / 1000) + 10;
const TOTAL_TICKS = SIM_DURATION_SEC * REEF_TICK_HZ;
// Whole-race progress (lap + within-lap fraction) — the MONOTONIC ordering key.
// Raw body.progress WRAPS 1→0 each lap on the closed loop, so regression must
// be measured on this, not on body.progress.
function totalProgress(lap: number, progress: number): number {
  return lap + progress;
}

describe('ReefRaceSplineSim — full-room integration smoke test', () => {
  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
  });

  it('1 human + 7 bots → at least one finishes, no progress regression, match_ended fires', () => {
    const events: Array<{ type: string; avatarId?: string; reason?: string }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as { type: string; avatarId?: string; reason?: string }),
    );

    // The endedFn callback is what the room manager normally wires; we hook
    // it to broadcast a synthetic event.match_ended so the test can detect
    // the round-end transition without owning a room manager.
    let matchEndedFired = false;
    reefRaceSplineSim.setEndedFn((_roomId) => {
      matchEndedFired = true;
      events.push({ type: 'event.match_ended' });
    });

    // Build bot controllers for the 7 bot avatars.
    const bots = BOT_PETS.map((avatarId) => createReefRaceBot(avatarId));

    // Start the room. `isBot` returns true for the bot avatars so the sim
    // tags them correctly (mirrors how the room manager calls in prod).
    const isBot = (avatarId: string) =>
      (BOT_PETS as ReadonlyArray<string>).includes(avatarId);

    const tStart = performance.now();

    reefRaceSplineSim.startRoom(
      ROOM_ID,
      'reef-race',
      Array.from(ALL_PETS),
      {
        bots,
        isBot,
        startedAt: Date.now(),
      },
    );

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const humanBody = state.bodies.get(HUMAN_PET)!;
    // CLOSED-LOOP: net displacement from spawn is NOT a good "drove" proxy — a
    // racer that completes laps returns near the start. Track CUMULATIVE path
    // length + race progress (startCrossed) instead.
    let humanPathLen = 0;
    let humanPrevX = humanBody.x;
    let humanPrevZ = humanBody.z;

    // Track per-avatar progress regression — the spline sim's anti-cheat
    // already flags >0.02 backward, but we double-check here so a
    // regression that's silently absorbed by floating-point noise can't
    // hide. We sample EVERY tick, not just snapshot ticks.
    const maxRegressionByAvatar = new Map<string, number>();
    const lastProgressByAvatar = new Map<string, number>();
    for (const avatar of ALL_PETS) {
      maxRegressionByAvatar.set(avatar, 0);
      lastProgressByAvatar.set(avatar, 0);
    }

    // Apply a steady forward thrust for the human so they actually drive.
    // CLOSED-LOOP: steer along the START TANGENT (the start straight heads
    // ~ -21°, not +Z), so the human actually drives forward around the loop.
    const splineForDir = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
    const startTangent = splineForDir.tangentAt(0);
    let humanSeq = 1;
    const applyHumanThrust = () => {
      // Steer toward the spline tangent just ahead of the human's current t so
      // they follow the loop, not a fixed world direction.
      const c = splineForDir.closestPointOnSpline({ x: humanBody.x, z: humanBody.z });
      const tg = splineForDir.tangentAt((c.t + 0.02) % 1);
      reefRaceSplineSim.applyInput(
        ROOM_ID,
        HUMAN_PET,
        humanSeq++,
        DT,
        { thrust: 1, dir: { x: tg.x, y: tg.z }, actionBits: 0 },
      );
    };
    void startTangent;
    applyHumanThrust();

    // Tick the sim. Stop early if the room ended.
    let ticksRun = 0;
    for (let i = 0; i < TOTAL_TICKS; i++) {
      // Re-apply human input every 10 ticks so the seq advances cleanly
      // (the sim consumes seq once per applyInput; without re-application,
      // the body's intent.dir stays fixed, which is fine for this test).
      if (i % 10 === 0) {
        applyHumanThrust();
      }

      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      ticksRun++;

      // Check progress regression on every tick — on WHOLE-RACE progress
      // (lap + within-lap fraction). Two legitimate non-monotonic events on the
      // closed loop are NOT regressions and must be excluded:
      //   (a) a forward lap wrap (progress 0.99→0.01 WITH lap++), and
      //   (b) the START GUN (progress 0.99→0.01 while lap stays 0 — body started
      //       behind the line).
      // Both manifest as a totalProgress DROP of ~1.0 in a single tick, which a
      // legitimately-moving body (≤ ~0.0006 of a loop/tick) can NEVER produce by
      // going backward. So a drop > 0.5 is a forward wrap, not a regression.
      for (const avatar of ALL_PETS) {
        const body = state.bodies.get(avatar);
        if (!body) continue;
        const prev = lastProgressByAvatar.get(avatar)!;
        const curr = totalProgress(body.lap, body.progress);
        let drop = prev - curr;
        if (drop > 0.5) drop = 0; // forward lap/start-gun wrap, not a regression
        if (drop > maxRegressionByAvatar.get(avatar)!) {
          maxRegressionByAvatar.set(avatar, drop);
        }
        lastProgressByAvatar.set(avatar, curr);
      }

      // Accumulate the human's cumulative path length (loop-safe "drove" proxy).
      humanPathLen += Math.hypot(humanBody.x - humanPrevX, humanBody.z - humanPrevZ);
      humanPrevX = humanBody.x;
      humanPrevZ = humanBody.z;

      if (state.ended) break;
    }

    // Spline-sim's `shouldEndRound` ends the round either when all bodies
    // finish/DNF, when wall-clock crosses hardEndsAt (90 + 30 = 120s after
    // startedAt), or when wall-clock crosses firstFinishedAt + 30s. The
    // synchronous tick loop runs in ~2.5s wall-clock — too short for the
    // 30s wait-window. To exercise the end-round path WITHOUT padding the
    // test with 30s of real-time sleep, fast-forward firstFinishedAt back
    // by REEF_FINISH_WAIT_MS once at least one body has finished. Then
    // tick once more to let `shouldEndRound` fire.
    if (
      !state.ended &&
      state.firstFinishedAt !== null
    ) {
      state.firstFinishedAt = Date.now() - REEF_FINISH_WAIT_MS - 1;
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    }

    const wallElapsedMs = performance.now() - tStart;

    // Diagnostic: per-avatar final progress + finish count, useful when
    // tuning bot AI or diagnosing a regression.
    const finishedCount = Array.from(state.bodies.values()).filter(
      (b) => b.finishedAt !== null,
    ).length;
    const racingCount = Array.from(state.bodies.values()).filter(
      (b) => b.alive && !b.dnf && b.finishedAt === null,
    ).length;
    console.log(
      `[spline integration] ticks=${ticksRun} wall=${wallElapsedMs.toFixed(0)}ms ` +
        `finishers=${finishedCount} racing=${racingCount} bodies=${state.bodies.size} ended=${state.ended}`,
    );

    // ─── Assertions (Phase 1 ship gate) ───────────────────────────────────

    // 1. AT LEAST ONE body crossed the finish line.
    const finishers = Array.from(state.bodies.values()).filter(
      (b) => b.finishedAt !== null,
    );
    expect(finishers.length).toBeGreaterThanOrEqual(1);

    // 2. `event.crossed_finish` was broadcast.
    const crossedEvents = events.filter((e) => e.type === 'event.crossed_finish');
    expect(crossedEvents.length).toBeGreaterThanOrEqual(1);
    expect(crossedEvents[0].avatarId).toBeDefined();
    // The first crossed_finish event's avatarId should match the first body in
    // state.finishOrder (the sim is single-source-of-truth on finish order).
    expect(crossedEvents[0].avatarId).toBe(state.finishOrder[0]);

    // 3. `event.match_ended` eventually fires.
    expect(matchEndedFired).toBe(true);

    // 4. No progress regressed beyond 0.02 anti-cheat tolerance.
    for (const avatar of ALL_PETS) {
      const maxDrop = maxRegressionByAvatar.get(avatar)!;
      expect(maxDrop).toBeLessThanOrEqual(0.02);
    }

    // 5. The human actually DROVE the loop: crossed the start line (start gun)
    //    and traversed a meaningful cumulative path (≥ 1000 wu). Net XZ
    //    displacement is NOT used — a lapping racer returns near the start.
    expect(humanBody.startCrossed).toBe(true);
    expect(humanPathLen).toBeGreaterThanOrEqual(1000);

    // 6. Performance budget — 2700 ticks should run < 5s wall-clock.
    // Report as a soft assertion: log the actual time but don't fail unless
    // we cross 10s (catastrophic regression). Profiling on a faster machine
    // might want a stricter bound; this guards against runaway loops.
    if (wallElapsedMs >= 5000) {
      console.warn(
        `[spline-sim integration] ${ticksRun} ticks took ${wallElapsedMs.toFixed(0)} ms ` +
          `(target: <5000 ms; 10000 ms cliff)`,
      );
    }
    expect(wallElapsedMs).toBeLessThan(15000);
  }, 30_000); // CLOSED-LOOP: a full 3-lap race is ~9 300 ticks (~8-9s wall);
              // raise the per-test timeout above bun's 5s default.
});
