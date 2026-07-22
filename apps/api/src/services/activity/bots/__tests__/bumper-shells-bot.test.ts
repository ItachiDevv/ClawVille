/**
 * Q2 Activity Portals — Bumper Shells bot heuristic tests (chunk #10).
 *
 * Pure unit tests against the controller's `computeInput` — no sim, no
 * DB. The controller is intentionally heuristic so we assert directional
 * tendencies (toward opponent / away from edge) rather than exact
 * values, which would be brittle against the per-tick jitter.
 */

import { describe, expect, it } from 'bun:test';
import { createBumperShellsBot } from '../bumper-shells-bot';
import type { BotRoomView } from '../bot-controller';
import type { BumperPowerUpKind } from '../../sim/bumper-shells-sim';

function emptyInventory(): BotRoomView['bodies'][number]['inventory'] {
  return [
    { kind: null, charges: 0, cooldownUntil: 0 },
    { kind: null, charges: 0, cooldownUntil: 0 },
  ];
}

function makeBody(
  avatarId: string,
  x: number,
  y: number,
  alive = true,
  inventory: BotRoomView['bodies'][number]['inventory'] = emptyInventory(),
): BotRoomView['bodies'][number] {
  return {
    avatarId,
    x,
    y,
    vx: 0,
    vy: 0,
    rot: 0,
    alive,
    inventory,
  };
}

function makeView(self: { x: number; y: number; inventory?: BotRoomView['bodies'][number]['inventory'] }, opponents: Array<{ avatarId: string; x: number; y: number; alive?: boolean }>): BotRoomView {
  return {
    selfAvatarId: 'bot-self',
    bodies: [
      makeBody('bot-self', self.x, self.y, true, self.inventory),
      ...opponents.map((o) => makeBody(o.avatarId, o.x, o.y, o.alive ?? true)),
    ],
    arenaRadius: 500,
    now: 10_000,
    // matchStartedAt: 0 ⇒ matchAge = 10s, past BOT_OPENING_GRACE_MS (2.5s),
    // so test expectations (chase nearest, edge avoid, power-up usage) run
    // in the post-grace branch. (now: 1000 was INSIDE grace — bots cruised
    // to center with actionBits 0 and all three hunt assertions read zeros.)
    matchStartedAt: 0,
  };
}

describe('BumperShellsBot.computeInput', () => {
  it('moves toward the nearest alive opponent', () => {
    const bot = createBumperShellsBot('bot-self');
    const view = makeView(
      { x: 0, y: 0 },
      [
        { avatarId: 'opp-near', x: 100, y: 0 },
        { avatarId: 'opp-far', x: -300, y: 0 },
      ],
    );
    // Run a few ticks — jitter averages out.
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      expect(intent.dir).toBeDefined();
      xs.push(intent.dir!.x);
    }
    const avgX = xs.reduce((s, v) => s + v, 0) / xs.length;
    // Mean dir.x should lean clearly positive (toward opp-near at +100,0).
    expect(avgX).toBeGreaterThan(0.5);
  });

  it('turns away from the arena edge when closer than EDGE_BUFFER', () => {
    const bot = createBumperShellsBot('bot-self');
    // Self at (480, 0) — 20wu from the edge of a 500wu arena. Opponent
    // is OUTSIDE the bot's edge buffer toward +x; bot must still pull
    // back toward origin.
    const view = makeView(
      { x: 480, y: 0 },
      [{ avatarId: 'opp', x: 600, y: 0 }],
    );
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      xs.push(intent.dir!.x);
    }
    const avgX = xs.reduce((s, v) => s + v, 0) / xs.length;
    // Edge override: dir.x should be NEGATIVE (toward origin), not +x.
    expect(avgX).toBeLessThan(0);
  });

  it('uses an off-cooldown power-up at the configured probability', () => {
    const bot = createBumperShellsBot('bot-self');
    const inv: BotRoomView['bodies'][number]['inventory'] = [
      { kind: 'bs-speed-boost' as BumperPowerUpKind, charges: 1, cooldownUntil: 0 },
      { kind: null, charges: 0, cooldownUntil: 0 },
    ];
    const view = makeView({ x: 0, y: 0, inventory: inv }, [{ avatarId: 'opp', x: 100, y: 0 }]);
    let usedCount = 0;
    const TICKS = 1000;
    for (let i = 0; i < TICKS; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      if ((intent.actionBits ?? 0) & 0b01) usedCount++;
    }
    // POWERUP_USE_CHANCE = 0.3; allow generous bounds for randomness.
    const ratio = usedCount / TICKS;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.45);
  });

  it('does not fire a power-up while it is on cooldown', () => {
    const bot = createBumperShellsBot('bot-self');
    const inv: BotRoomView['bodies'][number]['inventory'] = [
      { kind: 'bs-knockback-aura' as BumperPowerUpKind, charges: 1, cooldownUntil: 5_000 },
      { kind: null, charges: 0, cooldownUntil: 0 },
    ];
    const view = makeView({ x: 0, y: 0, inventory: inv }, [{ avatarId: 'opp', x: 100, y: 0 }]);
    view.now = 1_000; // before cooldownUntil
    for (let i = 0; i < 200; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      expect((intent.actionBits ?? 0) & 0b01).toBe(0);
    }
  });

  it('returns a safe idle when the controlled body is dead', () => {
    const bot = createBumperShellsBot('bot-self');
    const view: BotRoomView = {
      selfAvatarId: 'bot-self',
      bodies: [makeBody('bot-self', 0, 0, false), makeBody('opp', 100, 0, true)],
      arenaRadius: 500,
      now: 1000,
      matchStartedAt: 0,
    };
    const intent = bot.computeInput(view, 1 / 60);
    expect(intent.thrust).toBe(0);
    expect(intent.actionBits).toBe(0);
  });

  it('does not crash when there are no opponents', () => {
    const bot = createBumperShellsBot('bot-self');
    const view: BotRoomView = {
      selfAvatarId: 'bot-self',
      bodies: [makeBody('bot-self', 200, 0, true)],
      arenaRadius: 500,
      now: 1000,
      matchStartedAt: 0,
    };
    const intent = bot.computeInput(view, 1 / 60);
    expect(intent).toBeDefined();
    expect(intent.dir).toBeDefined();
    // With no opponents and inside the edge buffer, bot should head
    // toward origin (negative x because self is at +200).
    expect(intent.dir!.x).toBeLessThan(0);
  });

  it('respects the opening grace window — no ramming or power-ups in first 2.5s', () => {
    const bot = createBumperShellsBot('bot-self');
    const inv: BotRoomView['bodies'][number]['inventory'] = [
      { kind: 'bs-speed-boost' as BumperPowerUpKind, charges: 1, cooldownUntil: 0 },
      { kind: null, charges: 0, cooldownUntil: 0 },
    ];
    // Self at +x=150 with an opponent right next to us at +x=200 — would
    // normally trigger the RAM_DISTANCE branch with thrust=1. During grace
    // we expect bot to head toward origin (negative x) at 0.4 thrust and
    // never fire the power-up.
    const view = makeView({ x: 150, y: 0, inventory: inv }, [{ avatarId: 'opp', x: 200, y: 0 }]);
    view.now = 1500;
    view.matchStartedAt = 0; // matchAge = 1500ms < 2500ms ⇒ grace active
    // Grace path is fully deterministic — no Math.random in scope, so
    // a single computeInput call is sufficient. A handful of iterations
    // gives defense in depth against future edits adding randomness here.
    for (let i = 0; i < 5; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      expect(intent.actionBits ?? 0).toBe(0); // no power-up during grace
      expect(intent.dir!.x).toBeLessThan(0);   // toward origin (negative x)
      expect(intent.thrust).toBeCloseTo(0.4, 5);
    }
  });

  it('skips eliminated opponents when picking the nearest', () => {
    const bot = createBumperShellsBot('bot-self');
    const view = makeView(
      { x: 0, y: 0 },
      [
        // Closer but eliminated — should be ignored.
        { avatarId: 'opp-dead', x: 50, y: 0, alive: false },
        // Farther but alive — should be the chosen target.
        { avatarId: 'opp-alive', x: 0, y: 200 },
      ],
    );
    const ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      ys.push(intent.dir!.y);
    }
    const avgY = ys.reduce((s, v) => s + v, 0) / ys.length;
    // Should chase the alive opponent at +y, ignoring the dead one at +x.
    expect(avgY).toBeGreaterThan(0.5);
  });
});
