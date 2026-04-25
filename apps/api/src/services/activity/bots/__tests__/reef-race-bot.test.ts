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
