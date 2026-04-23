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

function makeView(self: { x: number; y: number; inventory?: BotRoomView['bodies'][number]['inventory'] }, opponents: Array<{ petId: string; x: number; y: number; alive?: boolean }>): BotRoomView {
  return {
    selfPetId: 'bot-self',
    bodies: [
      makeBody('bot-self', self.x, self.y, true, self.inventory),
      ...opponents.map((o) => makeBody(o.petId, o.x, o.y, o.alive ?? true)),
    ],
    arenaRadius: 500,
    now: 1000,
  };
}

describe('BumperShellsBot.computeInput', () => {
  it('moves toward the nearest alive opponent', () => {
    const bot = createBumperShellsBot('bot-self');
    const view = makeView(
      { x: 0, y: 0 },
      [
        { petId: 'opp-near', x: 100, y: 0 },
        { petId: 'opp-far', x: -300, y: 0 },
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
      [{ petId: 'opp', x: 600, y: 0 }],
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
    const view = makeView({ x: 0, y: 0, inventory: inv }, [{ petId: 'opp', x: 100, y: 0 }]);
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
    const view = makeView({ x: 0, y: 0, inventory: inv }, [{ petId: 'opp', x: 100, y: 0 }]);
    view.now = 1_000; // before cooldownUntil
    for (let i = 0; i < 200; i++) {
      const intent = bot.computeInput(view, 1 / 60);
      expect((intent.actionBits ?? 0) & 0b01).toBe(0);
    }
  });

  it('returns a safe idle when the controlled body is dead', () => {
    const bot = createBumperShellsBot('bot-self');
    const view: BotRoomView = {
      selfPetId: 'bot-self',
      bodies: [makeBody('bot-self', 0, 0, false), makeBody('opp', 100, 0, true)],
      arenaRadius: 500,
      now: 1000,
    };
    const intent = bot.computeInput(view, 1 / 60);
    expect(intent.thrust).toBe(0);
    expect(intent.actionBits).toBe(0);
  });

  it('does not crash when there are no opponents', () => {
    const bot = createBumperShellsBot('bot-self');
    const view: BotRoomView = {
      selfPetId: 'bot-self',
      bodies: [makeBody('bot-self', 200, 0, true)],
      arenaRadius: 500,
      now: 1000,
    };
    const intent = bot.computeInput(view, 1 / 60);
    expect(intent).toBeDefined();
    expect(intent.dir).toBeDefined();
    // With no opponents and inside the edge buffer, bot should head
    // toward origin (negative x because self is at +200).
    expect(intent.dir!.x).toBeLessThan(0);
  });

  it('skips eliminated opponents when picking the nearest', () => {
    const bot = createBumperShellsBot('bot-self');
    const view = makeView(
      { x: 0, y: 0 },
      [
        // Closer but eliminated — should be ignored.
        { petId: 'opp-dead', x: 50, y: 0, alive: false },
        // Farther but alive — should be the chosen target.
        { petId: 'opp-alive', x: 0, y: 200 },
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
