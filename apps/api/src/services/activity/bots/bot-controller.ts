/**
 * Q2 Activity Portals — bot controller scaffolding (chunk #10).
 *
 * Bot controllers are server-side stand-ins for human/agent inputs. They
 * exist so a solo queuer doesn't sit forever waiting on `minPlayers` —
 * see backend §8.4. A controller is created when the matcher picks a
 * `subject_type='bot'` participant out of the reserved pool, and is
 * destroyed when the room ends.
 *
 * Pipeline parity:
 *   - Bots feed the SAME `applyInput()` path that humans + agents do.
 *   - The sim runs the same anti-cheat / rate validation against bot
 *     intents (no preferential treatment) so a buggy bot can't break
 *     physics.
 *   - Bots have NO WebSocket — `room.participants[botAvatarId].connected`
 *     stays false; the WS hub never tries to send to them.
 *
 * Reward filtering:
 *   - Bots NEVER earn ClawTokens or leaderboard points. Today the reward
 *     pipeline is a `// TODO chunk #7` stub, so this is enforced
 *     trivially. When chunk #7 lands the issuance code MUST filter
 *     `subject_type='bot'` before crediting — see `bots/README.md` and
 *     the inline TODO in `activity-room-manager.persistResultsTransition`.
 *
 * Sybil guards (per-user concurrent-match cap, per-agent rate limits) are
 * deliberately deferred from chunk #10 — they don't block solo Bumper
 * playability. Inline TODOs preserved in `activity-queue.enqueue()`.
 */

import type { BumperPowerUpKind } from '../sim/bumper-shells-sim';
import type { ReefPowerUpKind } from '../sim/reef-race-config';

/**
 * Cross-activity power-up kind union surfaced through the trimmed
 * `BotRoomView` bot controllers see. Each per-activity sim populates
 * the field with its own narrower type at build time; the union here
 * keeps both sims TS-compatible without a runtime cost.
 *
 * Adding a new activity that produces a different power-up kind union
 * requires extending this union — but the bot controllers themselves
 * receive only the kinds their host sim emits, so the widening here is
 * structural-only and does not require per-bot logic changes.
 */
export type AnyActivityPowerUpKind = BumperPowerUpKind | ReefPowerUpKind;

// ─── Controller interface ──────────────────────────────────────────────────

export interface BotInput {
  /** Direction unit vector — `null` ≡ no input (idle). */
  dir?: { x: number; y: number };
  /** 0..1 normally; a sim may opt into a bounded server-only bot catch-up band. Defaults 0. */
  thrust?: number;
  /** Bitfield: bit 0 = use slot 0, bit 1 = use slot 1. */
  actionBits?: number;
}

/**
 * Trimmed view of room state safe to pass to bots — no WS connections,
 * no DB references, no mutation handles. Per-tick allocation is cheap
 * (Map → array iteration once per bot per tick) and keeps the interface
 * a stable boundary the sim can satisfy without leaking internals.
 */
export interface BotRoomView {
  /** The bot's own avatarId */
  selfAvatarId: string;
  /** All bodies in the room (alive + eliminated) */
  bodies: Array<{
    avatarId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    alive: boolean;
    /**
     * Power-up inventory snapshot, indexed by slot.
     * `kind === null` means the slot is empty. Union widens across all
     * activities that ship a sim (Bumper Shells + Reef Race today).
     */
    inventory: Array<{
      kind: AnyActivityPowerUpKind | null;
      charges: number;
      cooldownUntil: number;
    }>;
  }>;
  /** Arena radius in world units — bots use this to avoid the boundary */
  arenaRadius: number;
  /** Wall-clock now (ms) so bots can compare against `cooldownUntil` */
  now: number;
  /**
   * Wall-clock match start (ms). Bots use this to gate aggressive behavior
   * during the opening seconds — see Bumper Shells controller's grace
   * period, which prevents instant elimination on spawn.
   */
  matchStartedAt: number;
}

export interface BotController {
  /** Stable avatarId matching the participant row */
  avatarId: string;
  /** Activity slug — controllers are 1:1 with activities */
  activityId: string;
  /**
   * Called by the sim every tick. Returns the input intent for this
   * tick. Pure function of `roomState` + internal controller state —
   * no side effects.
   */
  computeInput(roomState: BotRoomView, dt: number): BotInput;
  /** Optional one-shot lifecycle hook on first tick after spawn. */
  onSpawn?(roomState: BotRoomView): void;
}

/**
 * Per-activity factory map. Each entry produces a fresh controller bound
 * to a single avatarId for the duration of one room.
 */
export type BotControllerFactory = (avatarId: string) => BotController;

import { createBumperShellsBot } from './bumper-shells-bot';
import { createReefRaceBot } from './reef-race-bot';

export const BOT_CONTROLLERS: Record<string, BotControllerFactory> = {
  'bumper-shells': createBumperShellsBot,
  'reef-race': createReefRaceBot,
};

export function getBotControllerFactory(activityId: string): BotControllerFactory | null {
  return BOT_CONTROLLERS[activityId] ?? null;
}
