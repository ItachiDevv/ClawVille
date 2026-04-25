/**
 * Q2 Activity Portals — Reef Race bot heuristic tests (chunk #5).
 *
 * Pure unit tests against the controller's `computeInput`. The bot is
 * heuristic by design — assertions cover directional tendency (toward
 * the next checkpoint) + safe behaviour on degenerate inputs (no
 * checkpoints, dead body).
 */

import { describe, expect, it } from 'bun:test';
import { createReefRaceBot } from '../reef-race-bot';
import type { BotRoomView } from '../bot-controller';
import {
  buildReefCheckpoints,
  ACTION_BIT_DRIFT,
  ACTION_BIT_LAUNCH,
  type ReefPowerUpKind,
} from '../../sim/reef-race-config';

function emptyInventory(): BotRoomView['bodies'][number]['inventory'] {
  return [
    { kind: null, charges: 0, cooldownUntil: 0 },
    { kind: null, charges: 0, cooldownUntil: 0 },
  ];
}

function makeBody(
  petId: string,
  x: number,
  y: number,
  alive = true,
  inventory: BotRoomView['bodies'][number]['inventory'] = emptyInventory(),
): BotRoomView['bodies'][number] {
  return {
    petId,
    x,
    y,
    vx: 0,
    vy: 0,
    rot: 0,
    alive,
    inventory,
  };
}

function makeReefView(opts: {
  selfPos: { x: number; y: number; alive?: boolean };
  inventory?: BotRoomView['bodies'][number]['inventory'];
  nextCheckpoint?: number;
  withCheckpoints?: boolean;
}): BotRoomView & { nextCheckpoint?: number; checkpoints?: ReturnType<typeof buildReefCheckpoints> } {
  const checkpoints = opts.withCheckpoints !== false ? buildReefCheckpoints() : undefined;
  return {
    selfPetId: 'bot-self',
    bodies: [makeBody('bot-self', opts.selfPos.x, opts.selfPos.y, opts.selfPos.alive ?? true, opts.inventory)],
    arenaRadius: 2000,
    // matchAge = now - matchStartedAt = 5000ms, well past the 2.5s
    // opening grace window, so existing assertions (chase checkpoint,
    // off-track recovery, power-up fire) run in the post-grace branch.
    now: 5_000,
    matchStartedAt: 0,
    nextCheckpoint: opts.nextCheckpoint ?? 1,
    checkpoints,
  };
}

describe('ReefRaceBot.computeInput', () => {
  it('aims toward the next-checkpoint center', () => {
    const checkpoints = buildReefCheckpoints();
    const target = checkpoints[1];
    const bot = createReefRaceBot('bot-self');
    // Place bot at origin; target is somewhere on the oval.
    const view = makeReefView({ selfPos: { x: 0, y: 0 }, nextCheckpoint: 1 });
    const targetMag = Math.hypot(target.center.x, target.center.y);
    const wantX = target.center.x / targetMag;
    const wantY = target.center.y / targetMag;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 30; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      expect(intent.dir).toBeDefined();
      xs.push(intent.dir!.x);
      ys.push(intent.dir!.y);
    }
    const avgX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const avgY = ys.reduce((s, v) => s + v, 0) / ys.length;
    // Direction vector should average close to the unit vector toward
    // the target. Allow generous slack for the per-tick jitter.
    expect(Math.sign(avgX)).toBe(Math.sign(wantX) || 1);
    expect(Math.sign(avgY)).toBe(Math.sign(wantY) || 1);
  });

  it('returns a safe coast when the body is dead', () => {
    const bot = createReefRaceBot('bot-self');
    const view = makeReefView({ selfPos: { x: 0, y: 0, alive: false } });
    const intent = bot.computeInput(view, 1 / 30);
    expect(intent.thrust).toBe(0);
    expect(intent.actionBits).toBe(0);
  });

  it('does not crash on empty roomState (no checkpoints)', () => {
    const bot = createReefRaceBot('bot-self');
    const view = makeReefView({
      selfPos: { x: 0, y: 0 },
      withCheckpoints: false,
    });
    const intent = bot.computeInput(view, 1 / 30);
    expect(intent).toBeDefined();
    expect(intent.dir).toBeDefined();
    expect(intent.thrust).toBeGreaterThan(0);
  });

  it('uses an off-cooldown power-up at the configured probability', () => {
    const bot = createReefRaceBot('bot-self');
    const inv: BotRoomView['bodies'][number]['inventory'] = [
      { kind: 'rr-turbo-bubble' as ReefPowerUpKind, charges: 1, cooldownUntil: 0 },
      { kind: null, charges: 0, cooldownUntil: 0 },
    ];
    const view = makeReefView({ selfPos: { x: 0, y: 0 }, inventory: inv });
    let usedCount = 0;
    const TICKS = 1000;
    for (let i = 0; i < TICKS; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      if ((intent.actionBits ?? 0) & 0b01) usedCount++;
    }
    // POWERUP_USE_CHANCE = 0.3 ± slack for randomness.
    const ratio = usedCount / TICKS;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.45);
  });

  it('does not fire a power-up while it is on cooldown', () => {
    const bot = createReefRaceBot('bot-self');
    const inv: BotRoomView['bodies'][number]['inventory'] = [
      { kind: 'rr-seeker-jelly' as ReefPowerUpKind, charges: 1, cooldownUntil: 5_000 },
      { kind: null, charges: 0, cooldownUntil: 0 },
    ];
    const view = makeReefView({ selfPos: { x: 0, y: 0 }, inventory: inv });
    view.now = 1_000;
    for (let i = 0; i < 200; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      expect((intent.actionBits ?? 0) & 0b01).toBe(0);
    }
  });
});

// ─── Phase 1 — Bot drift + launch behaviour (T22–T25) ───────────────────────

describe('ReefRaceBot — Phase 1 launch + drift (T22–T25)', () => {
  it('T22 — launch attempt bypasses grace thrust cap (audit C5)', () => {
    const bot = createReefRaceBot('bot-self');
    // Run repeatedly across the launch jitter range to cover any random
    // jitter draw; once `view.now >= matchStartedAt + 400` the launch
    // window is unconditionally over and the bot will have fired.
    let observedLaunch = false;
    for (let trial = 0; trial < 50; trial++) {
      const fresh = createReefRaceBot('bot-self');
      const checkpoints = buildReefCheckpoints();
      const view: BotRoomView & { nextCheckpoint?: number; checkpoints?: typeof checkpoints } = {
        selfPetId: 'bot-self',
        bodies: [
          {
            petId: 'bot-self',
            x: 0, y: 0, vx: 0, vy: 0, rot: 0, alive: true,
            inventory: [
              { kind: null, charges: 0, cooldownUntil: 0 },
              { kind: null, charges: 0, cooldownUntil: 0 },
            ],
          },
        ],
        arenaRadius: 2000,
        // matchAge = 0 (well inside grace) — but launch fires within the
        // ±400ms jitter window, so the early-return will trip on most
        // trials. We only need ONE successful trial across the run to
        // prove the path bypasses the grace cap.
        now: 500,
        matchStartedAt: 500,
        nextCheckpoint: 1,
        checkpoints,
      };
      // Force the launch to fire NOW by overriding the planned time.
      // (private field — set via `(bot as any)`).
      (fresh as any).launchFireMs = view.now - 1;
      const intent = fresh.computeInput(view, 1 / 30);
      if ((intent.actionBits ?? 0) & ACTION_BIT_LAUNCH) {
        // CRITICAL: thrust must be 1.0 (the early-return bypasses
        // `thrust: inGrace ? 0.4 : thrust`).
        expect(intent.thrust).toBe(1.0);
        observedLaunch = true;
        break;
      }
      // Sanity for the trial loop — _bot_ may have suppressed launch this
      // trial because `launchAttempted` flips after first call. Try again.
      void bot;
    }
    expect(observedLaunch).toBe(true);
  });

  it('T23 — no drift bit during grace window', () => {
    const checkpoints = buildReefCheckpoints();
    const bot = createReefRaceBot('bot-self');
    // matchStartedAt = 0, now = 500ms (well inside 2.5s grace).
    const view: BotRoomView & { nextCheckpoint?: number; checkpoints?: typeof checkpoints } = {
      selfPetId: 'bot-self',
      bodies: [
        {
          petId: 'bot-self',
          x: 0, y: 0, vx: 0, vy: 0, rot: 0, alive: true,
          inventory: [
            { kind: null, charges: 0, cooldownUntil: 0 },
            { kind: null, charges: 0, cooldownUntil: 0 },
          ],
        },
      ],
      arenaRadius: 2000,
      now: 500,
      matchStartedAt: 0,
      nextCheckpoint: 1,
      checkpoints,
    };
    // Mark launch as already attempted so we exercise the post-launch path.
    (bot as any).launchAttempted = true;
    (bot as any).launchFireMs = -10;
    for (let i = 0; i < 100; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      expect((intent.actionBits ?? 0) & ACTION_BIT_DRIFT).toBe(0);
    }
  });

  it('T24 — uses drift on hairpins (statistical, post-grace)', () => {
    const checkpoints = buildReefCheckpoints();
    const bot = createReefRaceBot('bot-self');
    const target = checkpoints[1];
    // Place body opposite the next checkpoint so dot < 0.5 + dist > 200.
    const view: BotRoomView & { nextCheckpoint?: number; checkpoints?: typeof checkpoints } = {
      selfPetId: 'bot-self',
      bodies: [
        {
          petId: 'bot-self',
          // Position behind & moving the wrong way so dot < 0.5.
          x: -target.center.x,
          y: -target.center.y,
          vx: -target.center.x,
          vy: -target.center.y,
          rot: 0,
          alive: true,
          inventory: [
            { kind: null, charges: 0, cooldownUntil: 0 },
            { kind: null, charges: 0, cooldownUntil: 0 },
          ],
        },
      ],
      arenaRadius: 2000,
      now: 5_000, // post-grace
      matchStartedAt: 0,
      nextCheckpoint: 1,
      checkpoints,
    };
    (bot as any).launchAttempted = true;
    let driftTicks = 0;
    const TICKS = 600;
    for (let i = 0; i < TICKS; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      if ((intent.actionBits ?? 0) & ACTION_BIT_DRIFT) driftTicks++;
    }
    // Bot averages ~0.6/30 = 2% trigger rate, but once active it holds for
    // 12-45 ticks. Expect non-trivial drift presence — the threshold is set
    // low enough to weather the trigger jitter.
    expect(driftTicks).toBeGreaterThan(TICKS * 0.05);
  });

  it('T25 — no drift on straights (dot ≥ 0.5)', () => {
    const checkpoints = buildReefCheckpoints();
    const bot = createReefRaceBot('bot-self');
    const target = checkpoints[1];
    // Place body slightly behind target, moving roughly toward it (dot ≈ 1).
    const dx = target.center.x;
    const dy = target.center.y;
    const len = Math.hypot(dx, dy);
    const view: BotRoomView & { nextCheckpoint?: number; checkpoints?: typeof checkpoints } = {
      selfPetId: 'bot-self',
      bodies: [
        {
          petId: 'bot-self',
          x: 0, y: 0,
          vx: (dx / len) * 200,
          vy: (dy / len) * 200,
          rot: 0,
          alive: true,
          inventory: [
            { kind: null, charges: 0, cooldownUntil: 0 },
            { kind: null, charges: 0, cooldownUntil: 0 },
          ],
        },
      ],
      arenaRadius: 2000,
      now: 5_000,
      matchStartedAt: 0,
      nextCheckpoint: 1,
      checkpoints,
    };
    (bot as any).launchAttempted = true;
    for (let i = 0; i < 300; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      expect((intent.actionBits ?? 0) & ACTION_BIT_DRIFT).toBe(0);
    }
  });
});
