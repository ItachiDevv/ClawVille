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
 *   - Bots have NO WebSocket — `room.participants[botPetId].connected`
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

// ─── Controller interface ──────────────────────────────────────────────────

export interface BotInput {
  /** Direction unit vector — `null` ≡ no input (idle). */
  dir?: { x: number; y: number };
  /** 0..1 thrust. Defaults 0 if dir is null. */
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
  /** The bot's own petId */
  selfPetId: string;
  /** All bodies in the room (alive + eliminated) */
  bodies: Array<{
    petId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    alive: boolean;
    /**
     * Power-up inventory snapshot, indexed by slot.
     * `kind === null` means the slot is empty.
     */
    inventory: Array<{
      kind: BumperPowerUpKind | null;
      charges: number;
      cooldownUntil: number;
    }>;
  }>;
  /** Arena radius in world units — bots use this to avoid the boundary */
  arenaRadius: number;
  /** Wall-clock now (ms) so bots can compare against `cooldownUntil` */
  now: number;
}

export interface BotController {
  /** Stable petId matching the participant row */
  petId: string;
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
 * to a single petId for the duration of one room.
 */
export type BotControllerFactory = (petId: string) => BotController;

import { createBumperShellsBot } from './bumper-shells-bot';

export const BOT_CONTROLLERS: Record<string, BotControllerFactory> = {
  'bumper-shells': createBumperShellsBot,
};

export function getBotControllerFactory(activityId: string): BotControllerFactory | null {
  return BOT_CONTROLLERS[activityId] ?? null;
}
