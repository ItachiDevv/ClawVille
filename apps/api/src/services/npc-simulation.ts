import {
  NPC_DEFINITIONS,
  NPC_BUILDING_CENTERS,
  BUILDING_INTERACTION_RADIUS,
  buildingEdgeDistanceGamePx,
  MAP_LOCATIONS,
  AUTONOMY_ENTERABLE_PLACES,
  type AutonomyEnterablePlace,
  HATCHER_ACTION_VERBS,
  type HatcherActionVerb,
  COVE_SLOTS_BET_STEP,
  COVE_SLOTS_MIN_BET,
  COVE_SLOTS_MAX_BET,
  BUILDING_OPENCLAW_THEMES,
  type NpcDefinition,
  type AgentSubstrateRegistration,
  type AgentAvatarConfig,
  type NpcActivity,
  type AgentPerception,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  type ClawConfig,
  type BrowserClawSnapshot,
  type ArenaSettings,
  type ArenaRoundState,
  DEFAULT_ARENA_SETTINGS,
  clampPosition2D,
  WORLD_COLLIDER_MAP_HALF,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  type HatcherWorldState,
} from '@clawville/shared';
import { generateCannedConversation, generateNpcConversation, generateOpenClawConversation } from './npc-conversation-engine';
import {
  findPath,
  hasClearance,
  isCollisionFreeWorld,
  findNearestWalkable,
  isPathCollisionFree,
  type PathNode,
} from './pathfinding';
import { AvatarSimulationBridge } from './avatar-simulation-bridge';
import { memoryService } from './memory-service';
import { sessionDigest } from './session-digest';
import {
  getCollaborationBroker,
  type CollaborationLogEntry,
} from '@clawville/agent-runtime';
import type { AgentSubstrateClient } from './agent-substrate-client';
// P3 slice 6: the two in-world-cognition predicates below are driven from the
// PROTOCOL capability table (agent-session-config.ts), generalizing the former
// hardcoded `=== 'hatcher-proxy'` checks to every server-hosted-cognition
// protocol ([ACTION:] parity) while keeping the proximity-exemption Hatcher-only.
import {
  protocolEmitsInWorldActions,
  protocolProximityGateExempt,
} from './agent-session-config';
import { resolveBuildingId } from './building-center';
// Shared never-clobber ownership predicate (magic-link onboarding D1b) — the
// SAME rule the /enter SQL bind guard states, from its dependency-free module
// so bindAgentOwner + the route + the tests can never drift on it.
import { canBindAgentOwner } from './agent-owner-binding';
import { roomRegistry, FREE_ROAMER_NPC_IDS, derivePublicId } from './room-registry';
import type { PlayerSnapshot } from '@clawville/shared';
import {
  and,
  avatarSkins,
  cosmeticSkus,
  cosmeticVariants,
  db,
  eq,
  sql,
} from '@clawville/database';
import { createHash, randomUUID } from 'crypto';
import { recordCovenantAction } from './covenant-action-recorder';
import { BLACKJACK_MIN_BET, BLACKJACK_MAX_BET } from './blackjack-engine';

// Map dimensions — land-builder-economics (2026-06-24): 704×704 grid of 32px tiles = 22528×22528 world.
// CROSS-PACKAGE INVARIANT: this MUST equal the client `MAP_WIDTH`/`MAP_HEIGHT` in
// apps/web/src/lib/pixi/tilemap-data.ts (MAP_COLS*TILE_SIZE = 704*32 = 22528). The
// server can't import the client tilemap module, so this value is duplicated by
// necessity — if the client world dimension changes, change it here in the same diff.
const MAP_WIDTH = 22528;
const MAP_HEIGHT = 22528;
// Watcher gate: how long after the last visibility heartbeat (POST
// /api/npc/watch, sent every ~30s ONLY from a visible browser tab) the world
// still counts as "watched" for ambient-banter inference. 90s tolerates two
// missed beats/jitter; an empty (or all-hidden-tabs) world stops spending
// within ~1.5 min. SSE connections deliberately do NOT arm this — the web
// client keeps EventSource open in hidden tabs (join-budget protection), so a
// backgrounded tab would otherwise hold the gate open forever (Codex round,
// 2026-07-13).
const WATCHER_GRACE_MS = 90_000;

// Hard cost backstop for ambient banter, INDEPENDENT of the watcher latch: max
// LLM-generated conversations per fixed hourly window (per box). The /watch
// heartbeat is deliberately unauthenticated (anonymous explore visitors are
// real watchers — the acquisition funnel), so the latch is spoofable by
// design; this cap bounds the worst case a spoofer or held-open latch can burn
// (~cap × $0.0002/convo on gpt-4o-mini) regardless of latch state (Codex
// round, 2026-07-13). Over cap → canned lines. 0 disables LLM banter entirely.
// Read per call so a redeploy-baked env change (or a test) takes effect
// without module reload gymnastics.
function banterLlmHourlyCap(): number {
  // Unset/blank MUST fall to the default BEFORE numeric conversion:
  // Number('') === 0, which would silently disable LLM banter on every box
  // that never sets the var (Codex round 2, HIGH #1).
  const raw = process.env.NPC_BANTER_HOURLY_LLM_CAP?.trim();
  if (!raw) return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120;
}

// Hatcher proxy-cognition (partner #2, Phase A — 2026-06-01). The canonical
// "you are inside ClawVille" orientation text, joined + frozen once at module
// load. Prepended (with a per-call serialized world-state block) as the
// system message for a hatcher-proxy agent so the Hatcher-hosted brain acts
// as an agent inside ClawVille. Single source of truth lives in
// packages/shared/src/constants/orientation-skill.ts (same body returned on
// /api/agent/connect). See `.claude/plans/hatcher-integration.md` §14.
const HATCHER_ORIENTATION_TEXT = CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n');

// --- Hatcher proxy-cognition [ACTION:] whitelist (Phase A++, 2026-06-02) ---
//
// A Hatcher-hosted brain returns plain text; ClawVille parses [ACTION: ...]
// tags out of the reply server-side and executes ONLY the strict MVP whitelist
// below. Unknown action names or invalid/out-of-bounds params are DROPPED +
// logged (never executed, never crash). The remaining (action-stripped) text is
// the agent's speech. accept_quest + read_book are intentionally OUT of MVP
// (not agent-actionable yet). See `.claude/plans/hatcher-integration.md` §14.
//
// World bounds for move(): 32..(MAP_WIDTH-32). Town-px coords (the same space
// `move`'s targetX/targetY use in the REST handler).
const HATCHER_MOVE_MIN = 32;
const HATCHER_MOVE_MAX = MAP_WIDTH - 32; // 22496 for the 22528 world

// emote(name) — the partner-facing emote vocabulary mapped to a real in-world
// NpcActivity + emoji so the avatar visibly reacts. (The sim's activity enum is
// the truth; this maps the 7 MVP emote names onto it.)
const HATCHER_EMOTE_MAP: Record<string, { activity: NpcActivity; emoji: string }> = {
  wave: { activity: 'socializing', emoji: '👋' },
  dance: { activity: 'socializing', emoji: '💃' },
  think: { activity: 'thinking', emoji: ACTIVITY_EMOJIS.thinking },
  scan: { activity: 'exploring', emoji: ACTIVITY_EMOJIS.exploring },
  work: { activity: 'crafting', emoji: ACTIVITY_EMOJIS.crafting },
  celebrate: { activity: 'socializing', emoji: '🎉' },
  alert: { activity: 'training', emoji: '⚠️' },
};
const OWNED_EMOTE_NAME_PATTERN = /^[a-z0-9_]{1,40}$/;

async function ownsEquippedEmote(avatarId: string, animationKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: avatarSkins.id })
    .from(avatarSkins)
    .innerJoin(cosmeticSkus, eq(cosmeticSkus.id, avatarSkins.skuId))
    .innerJoin(cosmeticVariants, eq(cosmeticVariants.skuId, cosmeticSkus.id))
    .where(and(
      eq(avatarSkins.avatarId, avatarId),
      eq(avatarSkins.equipped, true),
      eq(cosmeticSkus.category, 'emote'),
      sql`${cosmeticVariants.assetMeta} ->> 'animationKey' = ${animationKey}`,
    ))
    .limit(1);
  return rows.length > 0;
}

// Parse pattern shared with eliza-runtime.ts (parseActionInvocations) so the
// hatcher-proxy reply and the Eliza action path stay consistent.
const HATCHER_ACTION_REGEX = /\[ACTION:\s*(\w+)\(([^)]*)\)\]/g;
const HATCHER_TALK_MESSAGE_MAX = 500;

const HATCHER_ACTION_VERB_SET: ReadonlySet<string> = new Set(HATCHER_ACTION_VERBS);

function isHatcherActionVerb(name: string): name is HatcherActionVerb {
  return HATCHER_ACTION_VERB_SET.has(name);
}

// Hard cap on how many [ACTION:] tags we will EXECUTE per cognition reply.
// Each move()/enter_building() runs an A* search (up to ~6000 iterations) and
// each talk_to_npc() pushes a pending event broadcast to every connected
// client. NpcSimulation is a SHARED singleton, so an unbounded action count
// from a single (hostile / prompt-injected) Hatcher reply would block the
// single-threaded event loop and stall the sim tick for ALL co-present users.
// Four visible actions are already more than one plausible cognition turn;
// the cap stays fixed as the whitelist grows. Tags beyond it are STILL stripped,
// just never executed.
const MAX_HATCHER_ACTIONS_PER_REPLY = 4;
const MISSING_ACTION_ATTRIBUTION_WARN_MAX = 1_024;

interface AgentActionAttribution {
  avatarId: string;
  agentId: string;
  sessionId: string;
  actorKind: 'agent';
}

const AUTONOMOUS_COVE_PLAY_INTERVAL_MS = 30_000;

// Non-teaching place centers in town-pixel coords. Built venues resolve from
// MAP_LOCATIONS; world POIs without a map row provide an inline center derived
// from their canonical shared geometry constants.
type AutonomyPlaceCenter = AutonomyEnterablePlace & {
  centerX: number;
  centerY: number;
};

const AUTONOMY_PLACE_CENTERS = AUTONOMY_ENTERABLE_PLACES.flatMap<AutonomyPlaceCenter>((place) => {
  if (place.center) {
    return [{ ...place, centerX: place.center.x, centerY: place.center.y }];
  }
  const location = MAP_LOCATIONS.find((candidate) => candidate.id === place.mapLocationId);
  if (!location) return [];
  return [{
    ...place,
    centerX: location.positionX + location.width / 2,
    centerY: location.positionY + location.height / 2,
  }];
});

const COVE_CENTER: { x: number; y: number } | null = (() => {
  const cove = AUTONOMY_PLACE_CENTERS.find((place) => place.placeId === 'cove');
  return cove ? { x: cove.centerX, y: cove.centerY } : null;
})();

const KELP_FOREST_CENTER: { x: number; y: number } | null = (() => {
  const kelp = AUTONOMY_PLACE_CENTERS.find((place) => place.placeId === 'kelp-forest');
  return kelp ? { x: kelp.centerX, y: kelp.centerY } : null;
})();

// Town-center anchor and the annulus (ring) free-roaming wanderers stay inside.
// Buildings are on a ring at ~4160wu from center (R=130 tiles). Keep free
// roamers in the open commons between the dense town-center prop cluster
// (Nori, auction podium, bazaar pedestals, bounty board, town directory sign
// — all within ~700wu of center) and the outer building ring (~3600wu inner
// edge once exclusion padding is applied).
//
// 2026-05-26: ring re-widened to 1500-3200 after the 900-2400 setting from
// `cf1feb96` allowed planApproachNearbyNpc to drag every free roamer into a
// tight cluster against the town-center sign. Symptoms: 8 NPCs piled inside
// 300wu of center, walking through the directory sign, with near-zero
// velocity (client clamp + entity push-out cancelled out their motion → no
// facing update → "walking aimlessly" visual).
const TOWN_CENTER_X = MAP_WIDTH / 2;       // 11264 (land-builder-economics: was 9216)
const TOWN_CENTER_Y = MAP_HEIGHT / 2;      // 11264
const FREE_ROAMER_MIN_RADIUS = 1500;
const FREE_ROAMER_MAX_RADIUS = 3200;
const FREE_ROAMER_MIN_RADIUS_SQ = FREE_ROAMER_MIN_RADIUS * FREE_ROAMER_MIN_RADIUS;
const FREE_ROAMER_MAX_RADIUS_SQ = FREE_ROAMER_MAX_RADIUS * FREE_ROAMER_MAX_RADIUS;
const NPC_COLLISION_HALF = 30;

const FREE_ROAMER_IDS = new Set(
  NPC_DEFINITIONS.filter((def) => def.buildingId === '').map((def) => def.id),
);

// --- Types ---

export interface NpcRuntimeState {
  id: string;
  name: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  homeX: number;
  homeY: number;
  patrolRadius: number;
  direction: 'idle' | 'left' | 'right' | 'up' | 'down';
  species: string;
  color: number;
  inConversation: boolean;
  conversationCooldownUntil: number;
  // Activity system
  activity: NpcActivity;
  activityEmoji: string;
  /** Last server-broadcast owned emote clip. Clients trigger only on seq change. */
  emoteClip?: string;
  /** Monotonic per-body trigger sequence for the keep-last emote payload. */
  emoteSeq?: number;
  destinationBuildingId: string | null;
  path: PathNode[];
  pathIndex: number;
  activityEndsAt: number;
  behaviorCooldown: number;
  intentDescription: string;
  /**
   * Ticks-in-a-row that AABB clamp blocked movement (2026-05-22).
   * Incremented every movement tick where clamped.hit is true; reset on a
   * net position delta ≥ 2 px. When stuckTicks ≥ 4 (≈800 ms at 5 Hz), the
   * NPC abandons its current path/target and re-plans — safety net for
   * cases where a path's final waypoint sits in the gap between A* grid
   * and pixel-accurate clamp, or a target NPC parked against a wall.
   */
  stuckTicks: number;
  /**
   * Ticks-in-a-row this NPC was involved in an entity push-out with
   * another NPC (2026-05-31). Incremented inside `resolveNpcNpcOverlaps`
   * for every NPC that overlapped another this tick; reset to 0 when
   * the NPC has no overlap. When ≥ 3 (≈ 600 ms at 5 Hz), the LEX-LOWER
   * id of an overlapping pair yields — abandons its path, drops to idle,
   * and waits 8-15 ticks before re-planning so the other NPC walks past.
   * Symptom this catches: two NPCs walking toward each other freeze at
   * exactly combinedHalf distance because the half-push cancels each
   * step. `stuckTicks` doesn't trip because the perpendicular push
   * counts as `moved >= 2`. The client sees `direction !== 'idle'` and
   * plays the walk cycle in place → "moonwalk".
   */
  overlapTicks: number;
  /**
   * World-space heading of the last applied movement step, radians,
   * atan2(dy, dx) in gamePx space (2026-06-10). Persists through idle so
   * `planCenterWander` can bias the next wander leg into a forward cone —
   * without it every replan picked a uniformly random annulus point, which
   * is on average sideways-or-backward from the current position and read
   * as "the NPC sensed something and turned around" (~9 reversals/min/NPC
   * measured live on staging before the fix).
   */
  headingAngle: number;
  // Arena-only fields
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  inCombat: boolean;
  inventory: string[];
  isDead: boolean;
  respawnAt: number;
  hasSword: boolean;
  isOpenClaw: boolean;
  level: number;
  kills: number;
  xp: number;
  baseAttack: number;
  baseDefense: number;
  baseSpeed: number;
  baseMaxHp: number;
  combatTargetId: string | null;
  lastAttackAt: number;
  lastHitAt: number;
  respawnedAt: number;
  invulnerableUntil: number;
  combatAction: 'attack' | 'heavy' | 'block' | 'dodge' | 'combo' | 'special' | null;
  combatActionAt: number;
  autonomyMode: 'server-managed' | 'self-managed' | 'native';
}

export interface NpcConversation {
  id: string;
  npc1Id: string;
  npc2Id: string;
  messages: Array<{ npcId: string; npcName: string; text: string }>;
  currentIndex: number;
  nextMessageAt: number;
  state: 'active' | 'done';
  typingNpcId: string | null;
  typingUntil: number;
}

export interface NpcCombat {
  id: string;
  attacker: string;
  defender: string;
  rounds: Array<{ attacker: string; damage: number; defenderHpAfter: number; isCrit?: boolean; isDodge?: boolean; isBlocked?: boolean }>;
  state: 'active' | 'done';
  winner: string | null;
  lootTransferred: string[];
  startedAt: number;
  nextRoundAt: number;
  phase: 'approach' | 'fighting' | 'done';
}

export interface SimulationEvent {
  id: string;
  type: string;
  npcId: string;
  npcName: string;
  data: Record<string, any>;
  timestamp: number;
}

export interface SimulationSnapshot {
  /**
   * Multiplayer Phase 1 — set on per-room snapshots from
   * `getRoomSnapshot(roomId)`. Legacy callers of `getSnapshot()` see this as
   * an empty string. SSE consumers should always read this off the parsed
   * payload rather than trusting URL state alone.
   */
  roomId: string;
  /** Remote players in the same room (always empty for the global snapshot). */
  players: PlayerSnapshot[];
  npcs: NpcRuntimeState[];
  conversations: NpcConversation[];
  combats: NpcCombat[];
  events: SimulationEvent[];
  autonomousAvatars: Array<{
    // Identity-leak scrub (P0 2026-07-01, sibling of the B1 bearer fix): the raw
    // AvatarSimBroadcast carries the owner `userId` + the raw `avatarId`
    // (avatars.id UUID) — plus internal budget/action fields. None is a
    // credential (no CT theft), but userId + the raw avatarId are internal
    // identity that must NOT ship on the UNAUTH snapshot (enumeration /
    // correlation). This PUBLIC shape drops userId + the budget/action fields,
    // and `avatarId` here is the non-secret, non-reversible derivePublicId(
    // avatars.id) — an opaque stable render/interp key, matching the player +
    // browser-claw presence-id pattern. Projected by `publicAutonomousAvatars()`.
    avatarId: string; name: string; species: string; color: string;
    x: number; y: number; direction: string; activity: string; activityEmoji: string;
    isAutonomous: boolean; chatMessage: string | null;
  }>;
  browserClaws: BrowserClawSnapshot[];
  arenaRound: ArenaRoundState | null;
  arenaSettings: ArenaSettings;
  collaborationEvents: CollaborationLogEntry[];
  timestamp: number;
}

/**
 * SSE listener signature — receives a PRE-SERIALIZED JSON string of the
 * snapshot. Multiplayer Phase 1 changed this from `(snapshot: object) =>
 * void` to a string so the broadcast loop can `JSON.stringify` once per
 * room and reuse the same buffer across every consumer in that room (B6
 * — punch list). Listeners that need the structured object can call
 * `npcSimulation.getRoomSnapshot(roomId)` themselves; SSE consumers
 * write the raw string to the stream and never need to re-parse.
 */
type SSEListener = (snapshotJson: string) => void;

// Arena round constants
const DEFAULT_MAX_ROUNDS = 5;
const ROUND_DURATION_MS = 60_000;   // 60s per round
const INTERMISSION_MS = 8_000;      // 8s between rounds

// --- Simulation Singleton ---

/**
 * Thrown by `registerAgentBot` in OVERRIDE mode when the target NPC is already
 * overridden by a DIFFERENT session. Callers (partner-hatcher register/PATCH P5-2)
 * map this to a client-actionable 409 `override_target_unavailable` vs a generic
 * 503 — a TYPED sentinel instead of message-string matching, so the HTTP status
 * never silently degrades if the error text is reworded (Codex pass-5 nit #1).
 */
export class OverrideTargetUnavailableError extends Error {
  readonly targetNpcId: string;
  constructor(targetNpcId: string) {
    super(`NPC "${targetNpcId}" is already overridden`);
    this.name = 'OverrideTargetUnavailableError';
    this.targetNpcId = targetNpcId;
  }
}

class NpcSimulation {
  private npcs: Map<string, NpcRuntimeState> = new Map();
  private conversations: Map<string, NpcConversation> = new Map();
  private combats: Map<string, NpcCombat> = new Map();
  /**
   * Legacy global listener bucket — receives the room-less snapshot via
   * `getSnapshot()`. Kept so the existing `/api/npc/stream` SSE route can
   * stay live during the multiplayer rollout. New consumers should
   * `addRoomListener(roomId, fn)` instead.
   */
  private listeners: Set<SSEListener> = new Set();
  /**
   * Multiplayer Phase 1 — per-room SSE buckets. Each room ID maps to the
   * set of listeners attached to `/api/world/:roomId/stream`. tick() loops
   * over rooms and broadcasts a per-room snapshot (NPC roster filtered to
   * `room.npcs`, players from RoomRegistry).
   */
  private roomListeners: Map<string, Set<SSEListener>> = new Map();
  /**
   * Watcher-presence gate for ambient LLM banter (2026-07-13 OpenAI-usage
   * audit — ambient NPC↔NPC chatter was ~410 inference calls/hr per box with
   * zero humans online). Epoch-ms of the last VISIBILITY HEARTBEAT (`POST
   * /api/npc/watch`, sent by the web client every ~30s only while
   * `document.visibilityState === 'visible'`). This is the ONLY arming
   * signal: SSE listeners do NOT count (the client keeps EventSource open in
   * hidden tabs, so a backgrounded tab would hold the gate open forever), the
   * REST snapshot fetch does NOT count (any crawler hitting the public
   * endpoint once a minute would re-arm paid inference), and agent sessions
   * are excluded at the route (banter is user entertainment; agents read
   * world state via server-side perception). Ambient conversations spend
   * inference only while `hasActiveWatchers()` AND the hourly LLM budget has
   * headroom; otherwise they use the canned pool. Unwatched conversations
   * still EXIST (canned), so snapshot + agent-perception shapes never change.
   * (Codex adversarial round, 2026-07-13.)
   */
  private lastWatchedAt = 0;
  /** Fixed hourly window for the banter LLM budget — see `banterLlmHourlyCap()`. */
  private banterLlmWindowStart = 0;
  private banterLlmUsed = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private arenaMode = false;
  private tickCount = 0;
  private conversationCooldown = 0;
  private combatCooldown = 0;
  private idCounter = 0;
  private pendingEvents: SimulationEvent[] = [];
  public avatarAutonomyManager = new AvatarSimulationBridge();
  /** Test seam; production remains the canonical covenant recorder. */
  covenantRecord: typeof recordCovenantAction = recordCovenantAction;
  /** Test seam; production performs the canonical equipped-emote ownership query. */
  emoteOwnershipQuery: (avatarId: string, animationKey: string) => Promise<boolean> = ownsEquippedEmote;
  /** Test seam; production lazily loads the zero-network audited slots adapter. */
  autonomousCoveSlotsPlay: (input: {
    agentSessionId: string;
    actionId: string;
    wager: number;
  }) => Promise<unknown> = async (input) => {
    const { playAutonomousCoveSlots } = await import('../routes/cove-slots');
    return playAutonomousCoveSlots(input);
  };
  /** Test seam; production lazily loads the atomic autonomous blackjack adapter. */
  autonomousCoveBlackjackPlay: (input: {
    agentSessionId: string;
    expectedAgentId: string;
    expectedAvatarId: string;
    actionId: string;
    wager: number;
  }) => Promise<unknown> = async (input) => {
    const { playAutonomousCoveBlackjack } = await import('../routes/cove-blackjack');
    return playAutonomousCoveBlackjack(input);
  };
  /** Test seam; production re-resolves the live ledger-capable session. */
  autonomousCoveAgentResolve: (sessionId: string) => Promise<{
    agentId: string;
    userId: string | null;
    avatarId: string | null;
    ledgerCapable: boolean;
  } | null> = async (sessionId) => {
    const { resolveAgentSession } = await import('../middleware/require-auth-or-agent');
    return resolveAgentSession(sessionId);
  };
  private arenaSettings: ArenaSettings = { ...DEFAULT_ARENA_SETTINGS };
  private arenaRound: ArenaRoundState | null = null;

  // OpenClaw bot registry
  private agentBotSessions: Map<string, { config: AgentSubstrateRegistration; client: AgentSubstrateClient }> = new Map();
  private npcOverrides: Map<string, string> = new Map(); // npcId → sessionId
  /** Bounded warn-once keys for bodies whose action attribution is unavailable. */
  /** Elapsed-time limiter reservation; set before async settle to close tag races. */
  private autonomousCovePlayLastAdmittedAt = new Map<string, number>();
  private missingActionAttributionWarned: Set<string> = new Set();
  // Magic-link onboarding D3 (2026-07-02): direct npcId → agentId for AVATAR-mode
  // (`ocb-`) bodies, written at registerAgentBot and cleared with the ownership-
  // scoped body teardown. The human-control suppression predicate consults THIS
  // map for avatar bodies instead of the npcOverrides→agentBotSessions session chain:
  // that chain names the CURRENT owner session and dangles whenever the owning
  // session churns (rebind eviction, sweeper races, restore windows), which left
  // `ocb-` bodies unsuppressed while their human drove the avatar — the exact
  // double-body gap this map closes. The body id is deterministic per agentId
  // (`avatarBodyId`), so re-registration overwrites idempotently.
  private avatarBodyOwners: Map<string, string> = new Map(); // ocb-npcId → agentId
  // Controlled-launch suppression: agentId → epoch-ms until which a Hatcher
  // proxy NPC is "human-driven" and must be hidden + frozen (its owner is
  // driving the bound avatar in 'player' mode). Refreshed at 5 Hz by
  // /api/world/position; entries auto-expire when the owner stops driving.
  private humanControlledOpenClawUntil: Map<string, number> = new Map();
  // Controlled-launch binding: userId -> launched agentId(s). This is the
  // durable server-side memory that lets /api/world/position re-create a lapsed
  // 3s suppression window after a transient upload stall, without suppressing
  // every other Hatcher proxy bound to the same user.
  private humanControlledOpenClawLaunchesByUser: Map<string, Set<string>> = new Map();

  // Browser-connected claws (no gateway — controlled by browser client)
  private browserClaws: Map<string, {
    config: ClawConfig;
    sessionId: string;
    x: number;
    y: number;
    direction: string;
    activity: string;
    activityEmoji: string;
    lastHeartbeat: number;
  }> = new Map();

  start(arenaMode: boolean) {
    if (this.intervalId) return;
    this.arenaMode = arenaMode;
    this.initNpcs();
    if (arenaMode) this.initRounds();
    console.log(`[NPC Simulation] Starting in ${arenaMode ? 'arena' : 'world'} mode with ${this.npcs.size} NPCs`);
    // Tick rate 200ms (5Hz). 2026-04-25: bumped from 500ms because client lerp
    // produced visible burst-stop pattern between snapshots — at 2Hz the client
    // converged ~70% in 500ms then sat for 100ms+ waiting for the next update.
    // 5Hz with proportionally smaller per-tick deltas (baseStep 110 → 44)
    // keeps total speed constant but motion reads as continuous, not stepped.
    this.intervalId = setInterval(() => this.tick(), 200);
  }

  switchMode(arenaMode: boolean) {
    if (this.arenaMode === arenaMode) return;
    console.log(`[NPC Simulation] Switching to ${arenaMode ? 'arena' : 'world'} mode`);
    this.stop();
    this.tickCount = 0;
    this.conversationCooldown = 0;
    this.combatCooldown = 0;
    this.idCounter = 0;
    this.pendingEvents = [];
    this.arenaSettings = { ...DEFAULT_ARENA_SETTINGS };
    this.arenaRound = null;
    this.start(arenaMode);
  }

  getMode(): 'arena' | 'world' {
    return this.arenaMode ? 'arena' : 'world';
  }

  updateSettings(settings: Partial<ArenaSettings>) {
    if (!this.arenaMode) return;
    if (settings.combatSpeed !== undefined) this.arenaSettings.combatSpeed = Math.max(0.5, Math.min(3, settings.combatSpeed));
    if (settings.moveSpeed !== undefined) this.arenaSettings.moveSpeed = Math.max(0.5, Math.min(3, settings.moveSpeed));
    if (settings.maxFights !== undefined) this.arenaSettings.maxFights = Math.max(1, Math.min(10, Math.round(settings.maxFights)));
    if (settings.respawnTime !== undefined) this.arenaSettings.respawnTime = Math.max(1, Math.min(30, Math.round(settings.respawnTime)));
  }

  getSettings(): ArenaSettings {
    return { ...this.arenaSettings };
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.npcs.clear();
    this.conversations.clear();
    this.combats.clear();
    console.log('[NPC Simulation] Stopped');
  }

  addListener(listener: SSEListener) { this.listeners.add(listener); }
  removeListener(listener: SSEListener) { this.listeners.delete(listener); }

  /** Stamp watcher presence — see `lastWatchedAt`. Called ONLY by the
   * `POST /api/npc/watch` visibility heartbeat (agent sessions excluded at
   * the route). SSE listeners and REST snapshots must never call this. */
  noteWorldWatched(): void { this.lastWatchedAt = Date.now(); }

  /**
   * True when ambient banter has an audience: a visibility heartbeat within
   * the grace window. Deliberately NOT derived from live SSE listeners or
   * snapshot fetches — see `lastWatchedAt`. `nowMs` is injectable for tests.
   */
  hasActiveWatchers(nowMs: number = Date.now()): boolean {
    return nowMs - this.lastWatchedAt < WATCHER_GRACE_MS;
  }

  /**
   * Hourly budget for LLM banter — the cost dampener that holds even if the
   * watcher latch is spoofed or held open (Codex round, 2026-07-13). Fixed
   * window: first consume after an hour rolls it. Consumed once per PAID
   * REQUEST (a failed request still counts — conservative), never per
   * conversation.
   *
   * SCOPE — deliberately per-process, NOT durable (Codex round-3 finding,
   * accepted residual): a restart/crash-loop resets the window, and multiple
   * processes would each get an allowance. Durable (DB-backed) accounting was
   * evaluated and rejected as disproportionate for a cosmetic-chat budget,
   * because two stronger bounds already cap worst-case spend regardless of
   * this counter's state: (1) the visibility-heartbeat gate, and (2) the sim's
   * own cadence — at most one conversation start per 8s × ≤2 paid legs
   * ≈ 900 paid requests/hour ≈ $0.25/hour on gpt-4o-mini, vs the ~$0.10/hour
   * this cap targets. The counter's job is killing the 24/7 idle burn, which
   * a process-local window does fully. `nowMs` is injectable for tests.
   */
  tryConsumeBanterLlmBudget(nowMs: number = Date.now()): boolean {
    if (nowMs - this.banterLlmWindowStart >= 60 * 60 * 1000) {
      this.banterLlmWindowStart = nowMs;
      this.banterLlmUsed = 0;
    }
    if (this.banterLlmUsed >= banterLlmHourlyCap()) return false;
    this.banterLlmUsed++;
    return true;
  }

  /**
   * Multiplayer Phase 1 — subscribe to per-room snapshot broadcasts. The
   * caller is responsible for matching `removeRoomListener(roomId, fn)` on
   * SSE disconnect — leaked listeners pile up forever.
   */
  addRoomListener(roomId: string, listener: SSEListener) {
    let bucket = this.roomListeners.get(roomId);
    if (!bucket) {
      bucket = new Set();
      this.roomListeners.set(roomId, bucket);
    }
    bucket.add(listener);
  }
  removeRoomListener(roomId: string, listener: SSEListener) {
    const bucket = this.roomListeners.get(roomId);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) this.roomListeners.delete(roomId);
  }

  /**
   * Read-only snapshot — safe for non-broadcast callers (avatar chat context,
   * agent gateway perception, REST /api/npc/state, etc.). Does NOT drain
   * the collaboration broker queue; collaborationEvents is always empty.
   */
  /**
   * True when `npcId` is a connected-agent body whose owner is actively
   * driving the bound avatar in 'player' mode (Controlled). Such a body
   * must be hidden from snapshots and skipped by all autonomy planning so it
   * doesn't appear as a second, auto-walking copy of the player. Expired
   * entries are pruned lazily on read.
   *
   * TWO resolution paths (magic-link onboarding D3, 2026-07-02):
   *   - AVATAR-mode (`ocb-`) bodies resolve DIRECTLY via `avatarBodyOwners`
   *     (npcId → agentId), immune to owning-session churn.
   *   - OVERRIDE-mode bodies keep the original chain
   *     (npcOverrides → agentBotSessions → config.agentId), since an override body
   *     has no `avatarBodyOwners` entry.
   * Before this, ONLY the session chain existed — an `ocb-` body whose owner
   * session had churned was never suppressed (the double-body gap).
   */
  private isHumanControlledOpenClawNpc(npcId: string, now = Date.now()): boolean {
    // Avatar-mode bodies: direct, session-independent lookup.
    const avatarAgentId = this.avatarBodyOwners.get(npcId);
    if (avatarAgentId) return this.isAgentHumanControlled(avatarAgentId, now);
    // Override-mode bodies: npcId → current owner session → agentId.
    const sessionId = this.npcOverrides.get(npcId);
    if (!sessionId) return false;
    const agentId = this.agentBotSessions.get(sessionId)?.config.agentId;
    if (!agentId) return false;
    return this.isAgentHumanControlled(agentId, now);
  }

  /**
   * PUBLIC: is this agent currently human-controlled (its owner is driving the
   * bound avatar in 'player' mode)? The single TTL read for the suppression
   * window — the npcId predicate above, the SSE `control` event, perception's
   * `humanControlled` field, and `GET /session-status` all consult this so the
   * signal an agent sees can never drift from the suppression the world
   * enforces. Expired entries are pruned lazily on read.
   */
  isAgentHumanControlled(agentId: string, now = Date.now()): boolean {
    const until = this.humanControlledOpenClawUntil.get(agentId) ?? 0;
    if (until <= now) {
      this.humanControlledOpenClawUntil.delete(agentId);
      return false;
    }
    return true;
  }

  /**
   * True for a SELF-MANAGED OpenClaw body (the house agent / autonomous fleet).
   * Such bodies are driven EXCLUSIVELY by `agentAutonomyDriver` on its own ~30s
   * loop, so the 200ms sim must NOT pull one into an ambient NPC↔NPC
   * conversation: that would set `inConversation` (freezing the driver mid
   * walk→talk) AND produce degenerate empty bubbles (nanoclaw `chat()` returns
   * ''). Mirrors the `isHumanControlledOpenClawNpc` suppression, scoped tightly
   * to self-managed — Hatcher (server-managed) is intentionally NOT excluded and
   * keeps its existing ambient behavior. (N4)
   */
  private isSelfManagedOpenClawNpc(npc: NpcRuntimeState): boolean {
    return npc.isOpenClaw && npc.autonomyMode === 'self-managed';
  }

  /** Prime/extend the human-driving suppression window for a specific agent. */
  markHumanControlledOpenClaw(agentId: string, ttlMs = 3000): void {
    this.humanControlledOpenClawUntil.set(agentId, Date.now() + ttlMs);
    // Freeze the proxy body NOW: clearing the in-flight A* path stops it drifting
    // for the rest of the current tick (moveNpcs also skips suppressed bodies,
    // but a path may have been assigned earlier in the same tick), and dropping
    // any walking activity prevents a stale "walking" pose lingering on the
    // hidden body when suppression later lapses.
    for (const [, { config }] of this.agentBotSessions) {
      if (config.agentId !== agentId) continue;
      const npcId = config.mode === 'override' ? config.targetNpcId : this.avatarBodyId(config.agentId);
      const npc = this.npcs.get(npcId);
      if (!npc) continue;
      npc.path = [];
      npc.pathIndex = 0;
      npc.destinationBuildingId = null;
      if (npc.activity === 'walking') {
        npc.activity = 'idle';
        npc.activityEmoji = '';
      }
    }
  }

  /**
   * Remember that `userId` launched and is driving `agentId`. The launch route
   * knows the exact agent; /api/world/position only knows the human user.
   */
  bindHumanControlledOpenClawLaunch(userId: string, agentId: string): void {
    let agentIds = this.humanControlledOpenClawLaunchesByUser.get(userId);
    if (!agentIds) {
      agentIds = new Set<string>();
      this.humanControlledOpenClawLaunchesByUser.set(userId, agentIds);
    }
    agentIds.add(agentId);
  }

  private forgetHumanControlledOpenClawLaunch(agentId: string, userId?: string | null): void {
    if (userId) {
      const agentIds = this.humanControlledOpenClawLaunchesByUser.get(userId);
      if (!agentIds) return;
      agentIds.delete(agentId);
      if (agentIds.size === 0) this.humanControlledOpenClawLaunchesByUser.delete(userId);
      return;
    }

    for (const [boundUserId, agentIds] of this.humanControlledOpenClawLaunchesByUser) {
      agentIds.delete(agentId);
      if (agentIds.size === 0) this.humanControlledOpenClawLaunchesByUser.delete(boundUserId);
    }
  }

  /**
   * PUBLIC (§B.1, 2026-07-08): fully release the Controlled-mode human-control
   * state for (userId, agentId) — BOTH the durable launch binding AND the
   * immediate suppression until-entry. Called on Autonomous activation.
   *
   * Why both: `refreshHumanControlledOpenClawForUser` runs UNCONDITIONALLY on
   * every 5 Hz /api/world/position upload, and each refresh routes through
   * `markHumanControlledOpenClaw`, which CLEARS the body's A* path +
   * destinationBuildingId. If the launch binding survived into Autonomous mode,
   * the driver's body would have its path wiped 5×/sec and never move (the
   * freeze bug). Deleting the binding stops the refresh at its source; deleting
   * the until-entry lifts the current suppression window immediately instead of
   * waiting out its TTL. Scoped to the exact (userId, agentId) pair — other
   * launched agents bound to the same user keep their suppression.
   */
  releaseHumanControlledOpenClaw(userId: string, agentId: string): void {
    this.forgetHumanControlledOpenClawLaunch(agentId, userId);
    this.humanControlledOpenClawUntil.delete(agentId);
  }

  /**
   * Refresh suppression only for Hatcher proxies this user actually launched.
   * Called on the owner's 5 Hz /api/world/position uploads. Because the binding
   * outlives the short TTL, a resumed upload after a >3s stall re-primes the
   * specific driven agent instead of letting its autonomous proxy stay visible.
   */
  refreshHumanControlledOpenClawForUser(userId: string, ttlMs = 3000): void {
    const agentIds = this.humanControlledOpenClawLaunchesByUser.get(userId);
    if (!agentIds) return;

    for (const agentId of agentIds) {
      this.markHumanControlledOpenClaw(agentId, ttlMs);
    }
  }

  /**
   * P0 (B1 ROOT-FIX) — the non-secret, STABLE, unique in-world body id for an
   * avatar-mode connected agent. Decoupled from the sessionId so the bearer
   * (`X-Clawville-Agent-Session`, the real-CT credential) can NEVER appear in a
   * wire id — whether via the public `/api/npc/state|stream` snapshot, the
   * authenticated `/perception` harvest path (the cross-agent harvest the
   * adversary flagged), the Hatcher partner world-state, or any FUTURE serializer.
   * It is ALSO the `talk_to_npc` target: the Hatcher action validates
   * `this.npcs.has(target)`, and since this bodyId is the Map key, a perceived id
   * resolves for free (a boundary-sanitize that kept the internal `oc-` key would
   * BREAK that action). Bypass-proof at the source.
   *
   * SHAPE — `ocb-${base64url(agentId)}` — a DETERMINISTIC, DOM-safe, non-secret
   * encoding of the public agentId:
   *   - DETERMINISTIC from agentId (not random): lazy-restore re-registers from the
   *     row, so f(agentId) reproduces the SAME body id after a restart → entity
   *     interpolation + `talk_to_npc` targets survive a restart identically (one
   *     body per agentId, so f is unambiguous). A random-per-registration id would
   *     pop the body + orphan a learned target on every restart.
   *   - DOM-safe: base64url is `[A-Za-z0-9_-]` only, so the id never carries the
   *     COLON in a namespaced agentId (`hatcher:…`/`milady:…`) that would break an
   *     unescaped `querySelector('#…')` on the client's label DOM ids.
   *   - The `ocb-` prefix guarantees no collision with a resident/wanderer/override
   *     npc id in `this.npcs`, and never matches the client's `milady-`/`chibi-`
   *     render heuristic. Client recovers the agentId by base64url-decoding the
   *     tail. Reverse lookup (bodyId → sessionId) is `npcOverrides`; forward
   *     (sessionId → bodyId) is this pure function, so no extra map is needed.
   */
  private avatarBodyId(agentId: string): string {
    return `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;
  }

  /**
   * PUBLIC projection of the autonomous-avatar broadcast for the UNAUTH snapshot
   * (`getSnapshot`/`getRoomSnapshot` → `/api/npc/state`, `/api/world/:room/stream`).
   * Identity-leak scrub (P0 2026-07-01, sibling of the B1 bearer fix): the raw
   * `AvatarSimBroadcast` carries the owner `userId` + the raw `avatarId`
   * (avatars.id UUID) + internal budget/action fields. Neither id is a credential
   * (no CT theft) but both are internal identity that must not go on the public
   * wire (enumeration/correlation). This ALLOWLIST projection (not a denylist —
   * new broadcast fields default to NOT-exposed) emits only render fields, drops
   * `userId` + the budget/action fields, and replaces the raw `avatarId` with the
   * same non-secret, non-reversible `derivePublicId` the player + browser-claw
   * snapshots use — an opaque stable render/interp key. Single serialization
   * point, so there is no sibling projection to miss.
   */
  private publicAutonomousAvatars(): SimulationSnapshot['autonomousAvatars'] {
    return this.avatarAutonomyManager.getAutonomousAvatars().map((a) => ({
      avatarId: derivePublicId(a.avatarId),
      name: a.name,
      species: a.species,
      color: a.color,
      x: a.x,
      y: a.y,
      direction: a.direction,
      activity: a.activity,
      activityEmoji: a.activityEmoji,
      isAutonomous: a.isAutonomous,
      chatMessage: a.chatMessage,
    }));
  }

  getSnapshot(): SimulationSnapshot {
    const now = Date.now();
    return {
      roomId: '',
      players: [],
      npcs: Array.from(this.npcs.values())
        .filter((n) => !this.isHumanControlledOpenClawNpc(n.id, now))
        .map((n) => ({ ...n })),
      conversations: Array.from(this.conversations.values())
        .filter((c) => c.state === 'active')
        .filter((c) => !this.isHumanControlledOpenClawNpc(c.npc1Id, now) && !this.isHumanControlledOpenClawNpc(c.npc2Id, now))
        .map((c) => ({ ...c, messages: [...c.messages] })),
      combats: Array.from(this.combats.values()).filter((c) => c.state === 'active').map((c) => ({ ...c, rounds: [...c.rounds] })),
      events: [...this.pendingEvents],
      autonomousAvatars: this.publicAutonomousAvatars(),
      browserClaws: this.getBrowserClawSnapshots(),
      arenaRound: this.arenaRound ? { ...this.arenaRound } : null,
      arenaSettings: { ...this.arenaSettings },
      collaborationEvents: [],
      timestamp: Date.now(),
    };
  }

  /**
   * Multiplayer Phase 1 — same payload as `getSnapshot()` but:
   *   - `npcs` is filtered to the room's swap-eligible roster + every
   *     building resident (residents are always present in every room).
   *   - `players` is the room's PlayerSnapshot[] from the RoomRegistry.
   *   - `roomId` is stamped onto the payload so SSE clients can verify
   *     they're seeing the room they think they are.
   *
   * Behavior when the room doesn't exist: returns a snapshot with the
   * legacy roster (every NPC, no players). This keeps backwards-compat
   * paths like the `solo-${sessionId}` alias from the npc-sse shim working
   * even before the explicit `POST /api/world/join` lands.
   */
  getRoomSnapshot(roomId: string): SimulationSnapshot {
    const room = roomRegistry.getRoom(roomId);
    // Build NPC list directly from `room.npcs` + the resident set rather
    // than cloning every global NPC and filtering — at 20 rooms this saved
    // ~20× redundant clone work per tick (B6 — punch list). Residents
    // (buildingId !== '') are never swap-eligible so they're always
    // present; wanderers are looked up by ID from `room.npcs`.
    const npcs: NpcRuntimeState[] = [];
    const now = Date.now();
    if (room) {
      for (const npc of this.npcs.values()) {
        // Hide a Hatcher proxy body whose owner is driving the bound avatar.
        if (this.isHumanControlledOpenClawNpc(npc.id, now)) continue;
        if (!FREE_ROAMER_NPC_IDS.has(npc.id)) {
          npcs.push({ ...npc });
        } else if (room.npcs.has(npc.id)) {
          npcs.push({ ...npc });
        }
      }
    } else {
      // Unknown room (e.g. solo- alias from npc-sse shim) → full roster.
      for (const npc of this.npcs.values()) {
        if (this.isHumanControlledOpenClawNpc(npc.id, now)) continue;
        npcs.push({ ...npc });
      }
    }

    return {
      roomId,
      players: roomRegistry.getPlayerSnapshots(roomId),
      npcs,
      conversations: Array.from(this.conversations.values())
        .filter((c) => c.state === 'active')
        .filter((c) => !this.isHumanControlledOpenClawNpc(c.npc1Id, now) && !this.isHumanControlledOpenClawNpc(c.npc2Id, now))
        .map((c) => ({ ...c, messages: [...c.messages] })),
      combats: Array.from(this.combats.values())
        .filter((c) => c.state === 'active')
        .map((c) => ({ ...c, rounds: [...c.rounds] })),
      events: [...this.pendingEvents],
      autonomousAvatars: this.publicAutonomousAvatars(),
      browserClaws: this.getBrowserClawSnapshots(),
      arenaRound: this.arenaRound ? { ...this.arenaRound } : null,
      arenaSettings: { ...this.arenaSettings },
      // Hardcoded []. The collaboration-broker drain happens ONCE per tick in
      // broadcast(), which overwrites this with the shared drained array
      // before serialize. Callers that are NOT the broadcast loop (e.g. the
      // world.ts initial-connect snapshot) intentionally keep [] so they
      // don't steal entries destined for the room broadcast.
      collaborationEvents: [],
      timestamp: Date.now(),
    };
  }

  // NOTE: the former `buildBroadcastSnapshot()` was removed (2026-06-06). The
  // collaboration-broker drain now happens EXACTLY ONCE per tick inside
  // `broadcast()` and the drained array is shared across the per-room AND the
  // global snapshots. A second drain site would return [] (queue already
  // emptied) and silently starve whichever stream drained second, which is
  // exactly the bug that left the /game COLLAB tab dead after the SSE swap.

  private resolveSafeSpawn(rawX: number, rawY: number): { x: number; y: number } {
    const snapped = findNearestWalkable(rawX, rawY, NPC_COLLISION_HALF);
    if (snapped) return snapped;

    // Fallback for deep-in-collider legacy/restored positions where the
    // walkable search cannot escape within its planner radius.
    const clamped = clampPosition2D(
      rawX - WORLD_COLLIDER_MAP_HALF,
      rawY - WORLD_COLLIDER_MAP_HALF,
      NPC_COLLISION_HALF,
    );
    return {
      x: clamped.x + WORLD_COLLIDER_MAP_HALF,
      y: clamped.z + WORLD_COLLIDER_MAP_HALF,
    };
  }

  private initNpcs() {
    this.npcs.clear();
    for (const def of NPC_DEFINITIONS) {
      // Spawn resolve: choose a planner-valid walkable point before falling
      // back to raw clamp output. Clamp-only starts can sit on an AABB edge
      // without the clearance that path planning assumes.
      const spawn = this.resolveSafeSpawn(def.homeX, def.homeY);
      const spawnX = spawn.x;
      const spawnY = spawn.y;
      this.npcs.set(def.id, {
        id: def.id, name: def.name,
        x: spawnX, y: spawnY,
        targetX: spawnX, targetY: spawnY,
        homeX: spawnX, homeY: spawnY,
        patrolRadius: def.patrolRadius,
        direction: 'idle', species: def.species, color: def.color,
        inConversation: false, conversationCooldownUntil: 0,
        activity: 'idle', activityEmoji: '', destinationBuildingId: null,
        path: [], pathIndex: 0, activityEndsAt: 0,
        behaviorCooldown: 5 + Math.floor(Math.random() * 10),
        intentDescription: '',
        stuckTicks: 0,
        overlapTicks: 0,
        headingAngle: Math.random() * Math.PI * 2,
        hp: def.stats.hp, maxHp: def.stats.hp,
        attack: def.stats.attack, defense: def.stats.defense, speed: def.stats.speed,
        inCombat: false, inventory: [], isDead: false, respawnAt: 0,
        hasSword: this.arenaMode, isOpenClaw: false,
        level: 1, kills: 0, xp: 0,
        baseAttack: def.stats.attack, baseDefense: def.stats.defense,
        baseSpeed: def.stats.speed, baseMaxHp: def.stats.hp,
        combatTargetId: null, lastAttackAt: 0, lastHitAt: 0,
        respawnedAt: 0, invulnerableUntil: 0,
        combatAction: null, combatActionAt: 0,
        autonomyMode: 'native',
      });
    }
  }

  // --- OpenClaw Methods ---

  registerAgentBot(config: AgentSubstrateRegistration, client: AgentSubstrateClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
    if (config.mode === 'override') {
      if (!this.npcs.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" not found`);
      // Typed sentinel (not a bare Error) so the partner-hatcher P5-2 path can map
      // an occupied target to 409 via `instanceof`, never message-string matching.
      if (this.npcOverrides.has(config.targetNpcId)) throw new OverrideTargetUnavailableError(config.targetNpcId);
      this.agentBotSessions.set(config.sessionId, { config, client });
      this.npcOverrides.set(config.targetNpcId, config.sessionId);
      const npc = this.npcs.get(config.targetNpcId)!;
      npc.isOpenClaw = true;
      npc.autonomyMode = config.autonomyMode ?? 'server-managed';
      // Hatcher proxy-cognition: bind the STRUCTURED world-state provider to
      // the overridden NPC's body. Hatcher owns the root prompt and builds it
      // from the `clawville` block we ship (no forced system message). Also
      // bind the legacy text provider for any non-Hatcher caller / fallback
      // (no-op for non-proxy protocols).
      if (config.protocol === 'hatcher-proxy') {
        const boundNpcId = config.targetNpcId;
        client.setWorldStateProvider(() => this.buildHatcherWorldState(boundNpcId, 'override'));
        client.setSystemContextProvider(() => this.buildHatcherSystemContext(boundNpcId));
      }
      // Log the sessionDigest, NOT the raw sessionId (Codex auth-lens fix #4):
      // the raw id is the real-CT bearer credential; a leaked log line must not
      // hand it back. Digest is correlation-only.
      console.log(`[OpenClaw] Override registered: ${config.targetNpcId} -> sess:${sessionDigest(config.sessionId)} (${npc.autonomyMode})`);
    } else {
      const avatarConfig = config as AgentAvatarConfig;
      // B1 ROOT-FIX: body id is the non-secret `ocb-<base64url(agentId)>`, NEVER
      // `oc-<sessionId>` (the sessionId is the real-CT bearer). npcOverrides keys
      // this bodyId → sessionId for the reverse lookup.
      const npcId = this.avatarBodyId(config.agentId);
      const rawSpawnX = restoredState?.lastX ?? avatarConfig.homeX;
      const rawSpawnY = restoredState?.lastY ?? avatarConfig.homeY;
      const spawn = this.resolveSafeSpawn(rawSpawnX, rawSpawnY);
      const spawnX = spawn.x;
      const spawnY = spawn.y;
      this.npcs.set(npcId, {
        id: npcId, name: avatarConfig.name,
        x: spawnX, y: spawnY,
        targetX: spawnX, targetY: spawnY,
        homeX: spawnX, homeY: spawnY,
        patrolRadius: avatarConfig.patrolRadius,
        direction: 'idle', species: avatarConfig.species, color: avatarConfig.color,
        inConversation: false, conversationCooldownUntil: 0,
        activity: 'idle', activityEmoji: '', destinationBuildingId: null,
        path: [], pathIndex: 0, activityEndsAt: 0, behaviorCooldown: 30, intentDescription: '',
        stuckTicks: 0,
        overlapTicks: 0,
        headingAngle: Math.random() * Math.PI * 2,
        hp: avatarConfig.stats.hp, maxHp: avatarConfig.stats.hp,
        attack: avatarConfig.stats.attack, defense: avatarConfig.stats.defense, speed: avatarConfig.stats.speed,
        inCombat: false, inventory: [], isDead: false, respawnAt: 0,
        hasSword: this.arenaMode, isOpenClaw: true,
        level: 1, kills: 0, xp: 0,
        baseAttack: avatarConfig.stats.attack, baseDefense: avatarConfig.stats.defense,
        baseSpeed: avatarConfig.stats.speed, baseMaxHp: avatarConfig.stats.hp,
        combatTargetId: null, lastAttackAt: 0, lastHitAt: 0,
        respawnedAt: 0, invulnerableUntil: 0,
        combatAction: null, combatActionAt: 0,
        autonomyMode: config.autonomyMode ?? 'server-managed',
      });
      this.agentBotSessions.set(config.sessionId, { config, client });
      this.npcOverrides.set(npcId, config.sessionId);
      // D3 (2026-07-02): record the session-independent npcId → agentId link so
      // the human-control suppression predicate covers `ocb-` bodies even when
      // the owning session churns. Idempotent — the body id is deterministic
      // per agentId, so a re-register overwrites with the same value.
      this.avatarBodyOwners.set(npcId, config.agentId);
      // Hatcher proxy-cognition: bind the STRUCTURED world-state provider to
      // the freshly-spawned avatar body (Hatcher owns the root prompt). Also
      // bind the legacy text provider for any non-Hatcher fallback (no-op for
      // non-proxy protocols).
      if (config.protocol === 'hatcher-proxy') {
        client.setWorldStateProvider(() => this.buildHatcherWorldState(npcId, 'avatar'));
        client.setSystemContextProvider(() => this.buildHatcherSystemContext(npcId));
      }
      // Log the sessionDigest, NOT the raw sessionId (Codex auth-lens fix #4): the
      // sessionId is the real-CT bearer credential, so printing it leaks it into
      // logs. Digest is correlation-only. (The npcId is now the non-secret
      // `ocb-<base64url(agentId)>`, but the bearer sessionId is still secret.)
      console.log(`[OpenClaw] Avatar injected: "${avatarConfig.name}" (oc-sess:${sessionDigest(config.sessionId)}) [${config.autonomyMode ?? 'server-managed'}]${restoredState?.lastX != null ? ' [restored position]' : ''}`);
    }
  }

  unregisterAgentBot(sessionId: string): boolean {
    const bot = this.agentBotSessions.get(sessionId);
    if (!bot) return false;
    // Drop any human-control suppression entry for this agent so a stale TTL
    // can't outlive the session (a re-registered agent gets a fresh window).
    this.humanControlledOpenClawUntil.delete(bot.config.agentId);
    this.forgetHumanControlledOpenClawLaunch(bot.config.agentId, bot.config.boundUserId);
    if (bot.config.mode === 'override') {
      const npcId = bot.config.targetNpcId;
      this.cleanupNpcFromCombats(npcId);
      this.npcOverrides.delete(npcId);
      const npc = this.npcs.get(npcId);
      if (npc) { npc.isOpenClaw = false; npc.inCombat = false; npc.combatTargetId = null; }
    } else {
      // B1 ROOT-FIX: avatar body id is `ocb-<base64url(agentId)>` (non-secret), not
      // `oc-<sessionId>`; resolve it from the bot's own config.
      const npcId = this.avatarBodyId(bot.config.agentId);
      // OWNERSHIP-SCOPED teardown (M1 sweeper race, Codex P0 gate 2026-07-01): the
      // body id is DETERMINISTIC per agentId, so many sessionIds for one agentId
      // share ONE body, and `npcOverrides[npcId]` names the CURRENT owner. `/connect`
      // does NOT evict prior sessions on a normal (same-owner) reconnect, so a stale
      // session (e.g. one the TTL sweeper is reaping) can coexist with a fresh one
      // that has already rebound the body to itself. Tear the shared body down ONLY
      // if THIS session still owns it — otherwise a stale unregister would orphan the
      // live session (delete the body + override the newer session depends on, while
      // that session stays Map-present so lazy-restore never re-heals it). If we no
      // longer own it, just drop our own `agentBotSessions` entry below.
      if (this.npcOverrides.get(npcId) === sessionId) {
        this.cleanupNpcFromCombats(npcId);
        this.npcOverrides.delete(npcId);
        this.npcs.delete(npcId);
        // D3 (2026-07-02): the avatar body is gone, so drop its direct
        // npcId → agentId suppression link with it. Scoped to the SAME
        // ownership check above — a stale session tearing down must not strip
        // the live body's suppression entry.
        this.avatarBodyOwners.delete(npcId);
      }
    }
    this.agentBotSessions.delete(sessionId);
    // sessionDigest, NOT the raw sessionId (Codex auth-lens fix #4) - bearer
    // credential, must not appear in logs.
    console.log(`[OpenClaw] Unregistered: sess:${sessionDigest(sessionId)}`);
    return true;
  }

  getAgentBotClient(npcId: string): AgentSubstrateClient | null {
    const sessionId = this.npcOverrides.get(npcId);
    if (!sessionId) return null;
    return this.agentBotSessions.get(sessionId)?.client ?? null;
  }

  /**
   * Public roster of connected agent bodies for the world view.
   *
   * SECURITY (Codex auth-lens fix #1, 2026-06-03): this is surfaced by the
   * PUBLIC `GET /api/openclaw/active` endpoint, so it must carry NO recoverable
   * session id. The session id is the bearer credential the cove trusts for
   * real-CT play; historically this returned the raw `sessionId` AND embedded it
   * a second time inside the avatar `npcId` (`oc-${sid}`) — so any unauthenticated
   * caller could harvest live bearer creds and spend a victim's real CT.
   *
   * The B1 ROOT-FIX (P0) removed the second vector at its source: an avatar body's
   * in-world id is now the non-secret `ocb-<base64url(agentId)>` (never `oc-<sessionId>`),
   * so the bearer is structurally absent from EVERY wire path, not just this one.
   * We still emit only NON-secret identifiers here: the bot's stable public
   * `agentId` and (for override bodies) the public `targetNpcId`.
   */
  getActiveAgentBots(): Array<{ agentId: string; mode: string; npcId?: string; name?: string }> {
    const result: Array<{ agentId: string; mode: string; npcId?: string; name?: string }> = [];
    for (const [, { config }] of this.agentBotSessions) {
      if (config.mode === 'override') {
        result.push({ agentId: config.agentId, mode: 'override', npcId: config.targetNpcId });
      } else {
        result.push({ agentId: config.agentId, mode: 'avatar', name: config.name });
      }
    }
    return result;
  }

  getAgentBotClientBySession(sessionId: string): AgentSubstrateClient | null {
    return this.agentBotSessions.get(sessionId)?.client ?? null;
  }

  getAgentBotConfig(sessionId: string): AgentSubstrateRegistration | null {
    return this.agentBotSessions.get(sessionId)?.config ?? null;
  }

  /**
   * Attach server-resolved covenant attribution after a connect flow resolves
   * or creates its avatar later than body registration. Internal-only: callers
   * must supply an authoritative avatars.id; this changes no wire response.
   */
  bindAgentAvatarAttribution(sessionId: string, avatarId: string): boolean {
    const session = this.agentBotSessions.get(sessionId);
    if (!session || !avatarId) return false;
    session.config.avatarId = avatarId;
    return true;
  }

  /**
   * Find all currently-connected agent session IDs whose agent IDs are in
   * the given set. Used by the skill-event-bus auto-install push so a
   * book read by a human triggers a `knowledge_added` SSE event on every
   * one of the user's active agent sessions.
   */
  findActiveSessionsByAgentIds(agentIds: Iterable<string>): string[] {
    const ids = new Set(agentIds);
    if (ids.size === 0) return [];
    const found: string[] = [];
    for (const [sid, { config }] of this.agentBotSessions) {
      if (ids.has(config.agentId)) found.push(sid);
    }
    return found;
  }

  /**
   * Magic-link onboarding D1b (2026-07-02) — propagate the bind-at-redemption
   * claim event into every LIVE in-memory session for `agentId`, so the
   * already-connected agent becomes ledger-capable WITHOUT a reconnect.
   *
   * Called by `GET /api/auth/enter` right after it atomically binds the
   * `openclaw_bots.user_id` row (guarded UPDATE). The row bind alone is not
   * enough: `resolveAgentSession` grants real-CT spend only when the session
   * config's `boundUserId` matches the row's CURRENT `userId` (the round-2
   * rebind demotion backstop), and a first-contact session was minted with
   * `boundUserId: null` — so without this in-memory update the freshly-bound
   * agent would stay demoted until its next /connect. Setting `boundUserId`
   * here makes the backstop PASS for first-contact sessions (whose
   * `ledgerCapable` flag is already true — no existing owner at registration).
   *
   * NEVER-CLOBBER (same rule as the SQL guard, via the shared
   * `canBindAgentOwner`): a config that already proved ownership of a
   * DIFFERENT user is left untouched — we only fill a null `boundUserId` or
   * re-affirm the same user. `ledgerCapable` is deliberately NOT flipped: a
   * session registered non-ledger (agentId-only reconnect to a bound bot)
   * stays non-ledger; it re-proves ownership through connect-token or the
   * signed-challenge reconnect, exactly as before.
   *
   * Returns the number of live configs updated (0 when the agent has no live
   * session — the row bind still lands, and the next /connect picks it up).
   */
  bindAgentOwner(agentId: string, userId: string): number {
    let updated = 0;
    for (const [, { config }] of this.agentBotSessions) {
      if (config.agentId !== agentId) continue;
      if (!canBindAgentOwner(config.boundUserId ?? null, userId)) continue;
      config.boundUserId = userId;
      updated++;
    }
    return updated;
  }

  /**
   * Snapshot of every live agent body as `{ sessionId, agentId }` pairs. Used by
   * the body-idle-despawn sweeper (agent-body-idle-sweeper.ts) to map live bodies
   * back to their DB rows (keyed by agentId) so it can check each one's
   * `lastSeenAt` and despawn the dormant ones WITHOUT touching the session TTL.
   * Returns a fresh array (safe to iterate while the caller despawns entries).
   */
  getActiveAgentSessionPairs(): Array<{ sessionId: string; agentId: string }> {
    const pairs: Array<{ sessionId: string; agentId: string }> = [];
    for (const [sid, { config }] of this.agentBotSessions) {
      pairs.push({ sessionId: sid, agentId: config.agentId });
    }
    return pairs;
  }

  /** Get avatar's current position for persistence on disconnect */
  getAgentBotAvatarPosition(sessionId: string): { x: number; y: number } | null {
    // B1 ROOT-FIX: avatar body id is `ocb-<base64url(agentId)>`, resolved from the config.
    const config = this.agentBotSessions.get(sessionId)?.config;
    if (!config) return null;
    const npcId = this.avatarBodyId(config.agentId);
    const npc = this.npcs.get(npcId);
    return npc ? { x: npc.x, y: npc.y } : null;
  }

  /**
   * Hatcher proxy-cognition (Phase A) — build the system-message context for
   * an agent's body: the canonical ClawVille orientation + a serialized,
   * compact world-state snapshot for THIS NPC (self pose/hp/activity, nearby
   * NPCs within radius, nearest buildings + their crypto focus). Returns null
   * if the body isn't in the world (so the client skips system injection).
   *
   * This is a TEXT serialization of the same world-state shape `buildPerception`
   * (apps/api/src/routes/agent-gateway.ts) exposes as JSON — kept here so the
   * sim (which can't import a route) can produce a self-contained system prompt
   * for the cognition seam. Bound to `npcId` at registration time via a
   * provider closure on the AgentSubstrateClient config.
   */
  buildHatcherSystemContext(npcId: string): string | null {
    const npc = this.npcs.get(npcId);
    if (!npc) return null;

    const PERCEPTION_RADIUS = 500;
    const nearby = this.getAllNpcs()
      .filter((o) => o.id !== npcId)
      .map((o) => {
        const dx = o.x - npc.x;
        const dy = o.y - npc.y;
        return { o, dist: Math.round(Math.sqrt(dx * dx + dy * dy)) };
      })
      .filter(({ dist }) => dist <= PERCEPTION_RADIUS)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8)
      .map(({ o, dist }) =>
        `- ${o.name} (${o.species}, ${dist}px${o.isOpenClaw ? ', agent' : ''}${o.inCombat ? ', in combat' : ''}, doing ${o.activity})`,
      );

    const buildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][])
      .map(([buildingId, center]) => {
        const dx = center.x - npc.x;
        const dy = center.y - npc.y;
        const theme = BUILDING_OPENCLAW_THEMES[buildingId];
        return {
          buildingId,
          label: theme?.label ?? buildingId,
          focus: theme?.focus ?? '',
          dist: Math.round(Math.sqrt(dx * dx + dy * dy)),
        };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map((b) => `- ${b.label} [${b.buildingId}] (${b.dist}px)${b.focus ? `: ${b.focus.split(',')[0]}` : ''}`);

    const worldState = [
      '--- ClawVille world state (live) ---',
      `You are at (${Math.round(npc.x)}, ${Math.round(npc.y)}) in a ${MAP_WIDTH}x${MAP_HEIGHT} world. HP ${npc.hp}/${npc.maxHp}, level ${npc.level}, currently ${npc.activity}${npc.inCombat ? ' (in combat)' : ''}.`,
      `Game mode: ${this.getMode()}.`,
      nearby.length > 0 ? `Nearby (within ${PERCEPTION_RADIUS}px):\n${nearby.join('\n')}` : `No one nearby (within ${PERCEPTION_RADIUS}px).`,
      `Nearest buildings:\n${buildings.join('\n')}`,
    ].join('\n');

    return `${HATCHER_ORIENTATION_TEXT}\n\n${worldState}`;
  }

  /**
   * Hatcher proxy-cognition (Phase A++, 2026-06-02) — build the STRUCTURED,
   * PUBLIC-ONLY world-state snapshot shipped in the top-level `clawville`
   * block of the cognition request so Hatcher builds its own system prompt.
   *
   * This is the structured sibling of `buildHatcherSystemContext` (which
   * serialized the same data to text). It mirrors `buildPerception`
   * (apps/api/src/routes/agent-gateway.ts) reduced to public fields. Returns
   * null if the body isn't in the world (so the client omits `worldState`).
   *
   * SECURITY: emit ONLY public world-state — never the scoped token, wallet /
   * identity secret, session id, userId, or any internal id beyond public
   * npc/building ids. (Browser players are exposed by display name + distance
   * only; agent npcs by their public npcId.)
   *
   * @param mode 'avatar' (own body) | 'override' (possessing a roaming NPC) —
   *   exposed so the partner's prompt can reflect what kind of body it drives.
   */
  buildHatcherWorldState(npcId: string, mode: 'avatar' | 'override'): HatcherWorldState | null {
    const npc = this.npcs.get(npcId);
    if (!npc) return null;

    const PERCEPTION_RADIUS = 500;

    // Nearby agent/NPC bodies (public npcId + name + distance + isAgent flag).
    const nearbyNpcs = this.getAllNpcs()
      .filter((o) => o.id !== npcId)
      .map((o) => {
        const dx = o.x - npc.x;
        const dy = o.y - npc.y;
        return { o, dist: Math.round(Math.sqrt(dx * dx + dy * dy)) };
      })
      .filter(({ dist }) => dist <= PERCEPTION_RADIUS)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8)
      .map(({ o, dist }) => ({
        // B1 ROOT-FIX: `o.id` for an avatar body is now the non-secret
        // `ocb-<base64url(agentId)>` (never the `oc-<sessionId>` bearer), so it is safe to
        // ship to the Hatcher partner in the `clawville.worldState` block.
        id: o.id,
        name: o.name,
        isAgent: o.isOpenClaw,
        distance: dist,
      }));

    // Nearby human players (browser claws) — display name + distance ONLY (no
    // session id, no internal handle).
    const nearbyPlayers = this.getBrowserClawSnapshots()
      .map((p) => {
        const dx = p.x - npc.x;
        const dy = p.y - npc.y;
        return { name: p.name, distance: Math.round(Math.sqrt(dx * dx + dy * dy)) };
      })
      .filter((p) => p.distance <= PERCEPTION_RADIUS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    // Nearest 5 buildings + their public crypto focus.
    const nearbyBuildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][])
      .map(([buildingId, center]) => {
        const dx = center.x - npc.x;
        const dy = center.y - npc.y;
        const theme = BUILDING_OPENCLAW_THEMES[buildingId];
        return {
          id: buildingId,
          name: theme?.label ?? buildingId,
          cryptoFocus: theme?.focus ?? '',
          dist: Math.round(Math.sqrt(dx * dx + dy * dy)),
        };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map(({ id, name, cryptoFocus }) => ({ id, name, cryptoFocus }));

    return {
      self: {
        name: npc.name,
        mode,
        x: Math.round(npc.x),
        y: Math.round(npc.y),
        hp: npc.hp,
        activity: npc.activity,
      },
      nearbyPlayers,
      nearbyNpcs,
      nearbyBuildings,
      gameMode: this.getMode(),
    };
  }

  // --- Agent Gateway Accessors ---

  /** Get NPC state by ID (for agent perception) */
  getNpcById(npcId: string): NpcRuntimeState | null {
    return this.npcs.get(npcId) ?? null;
  }

  /**
   * Null a body's destinationBuildingId. Used by the autonomy driver (N3) to
   * clear any STALE prior-turn destination BEFORE dispatching a new decision, so
   * a dropped enter_building leaves the field null instead of a stale value the
   * driver would misread as this turn's choice. A successful enter_building
   * re-stamps it via setNpcPath.
   */
  clearDestinationBuilding(npcId: string): void {
    const npc = this.npcs.get(npcId);
    if (npc) npc.destinationBuildingId = null;
  }

  /** Map a session ID to the NPC body it controls */
  getNpcIdForSession(sessionId: string): string | null {
    const bot = this.agentBotSessions.get(sessionId);
    if (!bot) return null;
    // B1 ROOT-FIX: avatar body id is the non-secret `ocb-<base64url(agentId)>`.
    return bot.config.mode === 'override' ? bot.config.targetNpcId : this.avatarBodyId(bot.config.agentId);
  }

  /** Check if a session ID corresponds to a valid agent */
  isValidAgentSession(sessionId: string): boolean {
    return this.agentBotSessions.has(sessionId);
  }

  /** Get all NPC states (for perception radius calculation) */
  getAllNpcs(): NpcRuntimeState[] {
    return Array.from(this.npcs.values());
  }

  /** Get all active conversations */
  getActiveConversations(): NpcConversation[] {
    return Array.from(this.conversations.values()).filter(c => c.state === 'active');
  }

  /** Get all active combats */
  getActiveCombats(): NpcCombat[] {
    return Array.from(this.combats.values()).filter(c => c.state === 'active');
  }

  /**
   * Build a connected-agent perception snapshot for a body (self pose + nearby
   * NPCs within radius + ALL buildings by distance + active conversations /
   * combats). The SINGLE shared perception builder (agent-metaverse P1): the
   * authed gateway (`GET /perception` + SSE `/events`) AND the autonomy driver
   * both call this — extracted here (from the former module-local
   * `agent-gateway.ts buildPerception`) so the sim, which owns `this.npcs`, is
   * the single source and there is no duplicated projection to drift.
   *
   * SECURITY: `other.id` for an avatar body is the non-secret
   * `ocb-<base64url(agentId)>` (never the `oc-<sessionId>` bearer, per the B1
   * root-fix), so exposing it to another agent leaks no real-CT credential.
   */
  buildPerception(npcId: string): AgentPerception | null {
    const npc = this.npcs.get(npcId);
    if (!npc) return null;

    const PERCEPTION_RADIUS = 500;

    // Nearby NPCs within radius
    const nearbyNpcs = this.getAllNpcs()
      .filter((other) => other.id !== npcId)
      .map((other) => {
        const dx = other.x - npc.x;
        const dy = other.y - npc.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return { other, distance };
      })
      .filter(({ distance }) => distance <= PERCEPTION_RADIUS)
      .map(({ other, distance }) => ({
        npcId: other.id,
        name: other.name,
        x: other.x,
        y: other.y,
        distance: Math.round(distance),
        species: other.species,
        hp: other.hp,
        isDead: other.isDead,
        inCombat: other.inCombat,
        activity: other.activity,
        level: other.level,
        isOpenClaw: other.isOpenClaw,
      }));

    // Nearby buildings (all 10, sorted by distance) + their crypto focus.
    const nearbyBuildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][]).map(([buildingId, center]) => {
      const dx = center.x - npc.x;
      const dy = center.y - npc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const theme = BUILDING_OPENCLAW_THEMES[buildingId];
      return {
        buildingId,
        label: theme?.label ?? buildingId,
        cryptoFocus: theme?.focus ?? '',
        centerX: center.x,
        centerY: center.y,
        distance: Math.round(distance),
        // Distance to the building's collider FOOTPRINT edge (0 inside). This is
        // the metric the interaction gates use — center-distance is unsatisfiable
        // for the larger buildings. Falls back to center-distance if the id has
        // no collider entry (defensive; all 10 do).
        edgeDistance: Math.round(buildingEdgeDistanceGamePx(npc.x, npc.y, buildingId) ?? distance),
      };
    }).sort((a, b) => a.distance - b.distance);

    // Non-teaching destinations exposed to autonomous decision paths. Cove and
    // poker intentionally share one physical center but keep distinct action
    // syntax, allowing the model to express the requested activity precisely.
    const places = AUTONOMY_PLACE_CENTERS.map((place) => {
      const dx = place.centerX - npc.x;
      const dy = place.centerY - npc.y;
      return {
        placeId: place.placeId,
        label: place.label,
        description: place.description,
        actionVerb: place.actionVerb,
        actionSyntax: place.actionSyntax,
        destinationId: place.destinationId,
        centerX: place.centerX,
        centerY: place.centerY,
        distance: Math.round(Math.sqrt(dx * dx + dy * dy)),
      };
    }).sort((a, b) => a.distance - b.distance);

    // Active conversations involving this NPC
    const conversations = this.getActiveConversations();
    const activeConversations = conversations.map((conv) => ({
      id: conv.id,
      participants: [conv.npc1Id, conv.npc2Id],
      latestMessage: conv.messages.length > 0
        ? conv.messages[Math.min(conv.currentIndex, conv.messages.length - 1)].text
        : '',
      involvesMe: conv.npc1Id === npcId || conv.npc2Id === npcId,
    }));

    // Active combats
    const combats = this.getActiveCombats();
    const activeCombats = combats.map((combat) => ({
      id: combat.id,
      attacker: combat.attacker,
      defender: combat.defender,
      involvesMe: combat.attacker === npcId || combat.defender === npcId,
      lastRound: combat.rounds.length > 0
        ? combat.rounds[combat.rounds.length - 1]
        : null,
    }));

    const arenaRound = this.getMode() === 'arena'
      ? this.getSnapshot().arenaRound
      : null;

    return {
      self: {
        npcId: npc.id,
        x: npc.x,
        y: npc.y,
        hp: npc.hp,
        maxHp: npc.maxHp,
        level: npc.level,
        kills: npc.kills,
        xp: npc.xp,
        inventory: npc.inventory,
        activity: npc.activity,
        inCombat: npc.inCombat,
        isDead: npc.isDead,
        combatAction: npc.combatAction,
        direction: npc.direction,
      },
      nearbyNpcs,
      nearbyBuildings,
      places,
      activeConversations,
      activeCombats,
      gameMode: this.getMode(),
      arenaRound,
      // Magic-link onboarding D4 (2026-07-02): TRUE while this body's human
      // owner is driving the bound avatar (Controlled mode). A self-managed
      // agent seeing true should PAUSE self-driving — its in-world body is
      // suppressed and its actions would fight the human's. Same predicate the
      // world-side suppression uses, so signal and enforcement cannot drift.
      humanControlled: this.isHumanControlledOpenClawNpc(npcId),
      timestamp: Date.now(),
    };
  }

  /**
   * Count of live HUMAN presences in the world — browser-legacy claws +
   * multiplayer-room players across every room. Used ONLY by the autonomy
   * driver's idle-throttle (cost control: back off the LLM cadence when nobody
   * is around). Cheap (rooms ≤ 20). NEVER serialized onto any wire.
   */
  getActiveHumanCount(): number {
    let n = this.browserClaws.size;
    for (const room of roomRegistry.listRooms()) n += room.players.size;
    return n;
  }

  /** Set an NPC's path (for agent-controlled movement) */
  setNpcPath(npcId: string, path: PathNode[], destinationBuildingId?: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.path = path;
    npc.pathIndex = 0;
    npc.activity = 'walking';
    npc.activityEmoji = '';
    npc.destinationBuildingId = destinationBuildingId ?? null;
    npc.behaviorCooldown = 200; // Prevent server from overriding agent's path
  }

  /** Inject a chat bubble from an agent-controlled NPC */
  injectAgentChat(npcId: string, message: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    this.pendingEvents.push({
      id: this.nextId(),
      type: 'agent_chat',
      npcId: npc.id,
      npcName: npc.name,
      data: { message },
      timestamp: Date.now(),
    });
  }

  /** Set an NPC's combat action (for agent-controlled combat) */
  setNpcCombatAction(npcId: string, action: NpcRuntimeState['combatAction']) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.combatAction = action;
    npc.combatActionAt = Date.now();
  }

  /** Set an NPC's activity and emoji (for agent emotes) */
  setNpcActivity(npcId: string, activity: NpcActivity, emoji: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.activity = activity;
    npc.activityEmoji = emoji;
    npc.activityEndsAt = Date.now() + 8000 + Math.random() * 12000;
  }

  /**
   * Hatcher proxy-cognition (Phase A++, 2026-06-02) — parse [ACTION: ...] tags
   * out of a Hatcher proxy reply, execute the STRICT MVP whitelist via the same
   * in-world sim primitives the REST handlers use, and return the cleaned
   * (action-stripped) speech text.
   *
   * Whitelist (validate EVERY param; drop+log anything invalid):
   *   move(x:int 32..22496, y:int 32..22496)             -> setNpcPath (findPath)
   *   emote(name in {wave,dance,think,scan,work,celebrate,alert}) -> setNpcActivity
   *   enter_building(buildingId in the 10 MAP_LOCATIONS ids)      -> walk to building
   *   enter_cove()                                        -> walk to the Cove
   *   play_cove_game(game=slots|blackjack, wager=game bounds) -> one settled game
   *   enter_poker_room()                                  -> walk to the Cove poker tables
   *   enter_kelp_forest()                                 -> walk to the Kelp Forest portal
   *   talk_to_npc(npcId|buildingId, message<=500)         -> injectAgentChat bubble
   *
   * Unknown names / bad params are DROPPED (never executed, never throw). Only
   * applies to a body that is in the world; otherwise tags are still stripped.
   *
   * NOTE (honest scope): non-economic verbs dispatch only their visible
   * in-world effects; their REST-side CT/event/RAG/knowledge effects remain on
   * the authenticated /api/agent/:sid/* endpoints. play_cove_game is the one
   * economic exception: it re-resolves the live ledger session and delegates to
   * the existing atomic slots handlers before tagging the visible body.
   */
  dispatchHatcherActions(npcId: string, replyText: string): string {
    if (!replyText) return replyText;
    // Owner is driving this proxy — a cognition reply must not move or act in the
    // world. Strip the action tags from speech (mirrors the post-loop cleanup
    // below) and execute none of them.
    if (this.isHumanControlledOpenClawNpc(npcId)) {
      return replyText.replace(HATCHER_ACTION_REGEX, '').replace(/\s{2,}/g, ' ').trim();
    }
    const npc = this.npcs.get(npcId);
    // Resolve covenant attribution ONCE per cognition reply for non-economic
    // world records. Money-bearing actions use it only as a claimed binding and
    // re-resolve the live ledger-capable session before any admission/settle.
    // Missing attribution deliberately leaves non-economic effects unchanged.
    const sessionId = this.npcOverrides.get(npcId);
    const actionConfig = sessionId
      ? this.agentBotSessions.get(sessionId)?.config
      : undefined;
    const attribution: AgentActionAttribution | null = sessionId && actionConfig?.avatarId
      ? {
          avatarId: actionConfig.avatarId,
          agentId: actionConfig.agentId,
          sessionId,
          actorKind: 'agent',
        }
      : null;
    if (!attribution && !this.missingActionAttributionWarned.has(npcId)) {
      if (this.missingActionAttributionWarned.size >= MISSING_ACTION_ATTRIBUTION_WARN_MAX) {
        const oldest = this.missingActionAttributionWarned.values().next().value;
        if (oldest !== undefined) this.missingActionAttributionWarned.delete(oldest);
      }
      this.missingActionAttributionWarned.add(npcId);
      console.warn(
        `[Covenant] no avatar attribution for in-world agent body ${npcId}; actions continue without records`,
      );
    }

    let match: RegExpExecArray | null;
    let executed = 0; // bound A*/broadcast cost per reply (DoS guard)
    HATCHER_ACTION_REGEX.lastIndex = 0; // regex has /g state — reset per call
    while ((match = HATCHER_ACTION_REGEX.exec(replyText)) !== null) {
      // Stop EXECUTING once the per-reply cap is hit — remaining tags are still
      // stripped from speech by the .replace() below. This caps the number of
      // synchronous A* searches / pending-event broadcasts to a small constant
      // regardless of how many tags a hostile proxy reply contains.
      if (executed >= MAX_HATCHER_ACTIONS_PER_REPLY) {
        console.warn(
          `[Hatcher] action cap (${MAX_HATCHER_ACTIONS_PER_REPLY}) reached for ${npcId} — remaining tags stripped, not executed`,
        );
        break;
      }
      const name = match[1];
      const paramStr = match[2].trim();
      const params: Record<string, string> = {};
      if (paramStr.length > 0) {
        for (const part of paramStr.split(',')) {
          const eq = part.indexOf('=');
          if (eq > 0) {
            const k = part.slice(0, eq).trim();
            const v = part.slice(eq + 1).trim();
            if (k.length > 0) params[k] = v;
          }
        }
        // `message` is FREE TEXT and documented last, so the naive comma-split
        // above truncates it at its first comma AND — when the model separates
        // params with spaces instead of commas (live drop on staging
        // 2026-07-15: `talk_to_npc(buildingId=x message=...)` parsed as an
        // unknown target and was silently dropped, losing the bubble, the
        // covenant record, and the teacher settle) — leaves it glued onto the
        // previous param's value. Re-extract message from the RAW param string
        // to end-of-string and strip the spill-over from sibling params.
        // Leniency-only: correctly comma-separated tags parse identically.
        const msgMatch = /(?:^|[,\s])message\s*=\s*(.+)$/.exec(paramStr);
        if (msgMatch) {
          params.message = msgMatch[1].trim();
          for (const key of Object.keys(params)) {
            if (key === 'message') continue;
            const spill = params[key].search(/\s+message\s*=/);
            if (spill >= 0) params[key] = params[key].slice(0, spill).trim();
          }
        }
      }
      // Body must be in-world to act; still strip the tag below either way.
      if (!npc) {
        console.warn(`[Hatcher] action "${name}" dropped — body ${npcId} not in world`);
        continue;
      }
      executed++; // counts attempts that reach execution (A*/broadcast cost)
      try {
        this.executeHatcherAction(npcId, npc, name, params, attribution);
      } catch (err) {
        console.error(`[Hatcher] action "${name}" execution failed for ${npcId} — dropped:`, err);
      }
    }

    // Strip ALL [ACTION:...] tags (including any dropped/unknown ones) so the
    // remainder is clean agent speech. Collapse whitespace left behind.
    return replyText.replace(HATCHER_ACTION_REGEX, '').replace(/\s{2,}/g, ' ').trim();
  }

  private async settleAutonomousCoveGame(
    npcId: string,
    attribution: AgentActionAttribution,
    game: 'slots' | 'blackjack',
    wager: number,
  ): Promise<void> {
    const resolved = await this.autonomousCoveAgentResolve(attribution.sessionId);
    if (!resolved) {
      console.warn('[Hatcher] play_cove_game dropped — invalid or expired agent session');
      return;
    }
    if (!resolved.ledgerCapable) {
      console.warn('[Hatcher] play_cove_game dropped — agent session is not ledger-authorized');
      return;
    }
    if (!resolved.avatarId || !resolved.userId) {
      console.warn('[Hatcher] play_cove_game dropped — agent has no bound active avatar');
      return;
    }
    if (resolved.avatarId !== attribution.avatarId || resolved.agentId !== attribution.agentId) {
      console.warn('[Hatcher] play_cove_game dropped — live agent/avatar binding changed');
      return;
    }

    const admittedAt = Date.now();
    if (this.autonomousCovePlayLastAdmittedAt.size > 5_000) {
      for (const [avatarId, lastAt] of this.autonomousCovePlayLastAdmittedAt) {
        if (admittedAt - lastAt >= AUTONOMOUS_COVE_PLAY_INTERVAL_MS) {
          this.autonomousCovePlayLastAdmittedAt.delete(avatarId);
        }
      }
    }
    const prior = this.autonomousCovePlayLastAdmittedAt.get(resolved.avatarId);
    if (prior !== undefined && admittedAt - prior < AUTONOMOUS_COVE_PLAY_INTERVAL_MS) {
      console.warn('[Hatcher] play_cove_game dropped — rate limit (one play per 30 seconds)');
      return;
    }
    // Reserve before the first async settle await so two tags cannot pass the
    // elapsed-time check concurrently. Every valid admitted action consumes
    // the interval even when the money preflight refuses it, preventing a
    // cognition loop from churning over-cap requests or session reads.
    this.autonomousCovePlayLastAdmittedAt.set(resolved.avatarId, admittedAt);
    const actionId = randomUUID();
    try {
      if (game === 'slots') {
        await this.autonomousCoveSlotsPlay({
          agentSessionId: attribution.sessionId,
          actionId,
          wager,
        });
      } else {
        await this.autonomousCoveBlackjackPlay({
          agentSessionId: attribution.sessionId,
          expectedAgentId: resolved.agentId,
          expectedAvatarId: resolved.avatarId,
          actionId,
          wager,
        });
      }
      const body = this.npcs.get(npcId);
      if (body) {
        this.setNpcActivity(npcId, 'trading', '🎰');
        body.destinationBuildingId = 'cove';
        body.intentDescription = `playing ${game} at the cove (${wager} vCLAW)`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[Hatcher] play_cove_game dropped — ${reason}`);
    }
  }

  /** Validate + execute ONE whitelisted Hatcher action. Invalid params drop. */
  private executeHatcherAction(
    npcId: string,
    npc: NpcRuntimeState,
    name: string,
    params: Record<string, string>,
    attribution: AgentActionAttribution | null = null,
  ): void {
    // Canonical hard membership gate shared with the autonomous decision menu.
    // Parameter validation remains in the exhaustive switch below.
    if (!isHatcherActionVerb(name)) {
      console.warn(`[Hatcher] action dropped — not in whitelist: "${name}"`);
      return;
    }
    switch (name) {
      case 'move': {
        const x = Number(params.x);
        const y = Number(params.y);
        if (
          !Number.isFinite(x) || !Number.isFinite(y) ||
          x < HATCHER_MOVE_MIN || x > HATCHER_MOVE_MAX ||
          y < HATCHER_MOVE_MIN || y > HATCHER_MOVE_MAX
        ) {
          console.warn(`[Hatcher] move dropped — out-of-bounds/invalid (x=${params.x}, y=${params.y})`);
          return;
        }
        const path = findPath(npc.x, npc.y, Math.round(x), Math.round(y));
        if (path.length === 0) {
          console.warn(`[Hatcher] move dropped — no path to (${Math.round(x)}, ${Math.round(y)})`);
          return;
        }
        this.setNpcPath(npcId, path);
        this.recordAgentWorldAction(attribution, 'agent.move', {
          x: Math.round(x),
          y: Math.round(y),
        });
        return;
      }
      case 'emote': {
        // Object.hasOwn guard: inherited prototype keys (constructor, __proto__,
        // toString, hasOwnProperty, …) must NEVER satisfy the whitelist. A bare
        // truthy bracket-access guard would treat `HATCHER_EMOTE_MAP['constructor']`
        // (the Object ctor fn) as a valid emote and corrupt NPC activity state.
        if (!Object.hasOwn(HATCHER_EMOTE_MAP, params.name)) {
          if (this.dispatchOwnedEmote(npcId, npc, params.name, attribution)) return;
          console.warn(`[Hatcher] emote dropped — unknown name "${params.name}"`);
          return;
        }
        const emote = HATCHER_EMOTE_MAP[params.name];
        this.setNpcActivity(npcId, emote.activity, emote.emoji);
        // `think` is both a frozen legacy activity name and a Meshy shop SKU
        // animationKey. Preserve the immediate legacy behavior above for every
        // caller; an attributed owner with the equipped SKU additionally gets
        // the real one-shot broadcast. An ownership miss is not an unknown
        // legacy action, so it stays silent and leaves the activity intact.
        if (params.name === 'think') {
          this.dispatchOwnedEmote(npcId, npc, params.name, attribution, false);
        }
        return;
      }
      case 'enter_building': {
        // Label-tolerant slug resolution (prototype-key-safe): the LLM usually
        // emits the bracketed slug ("code-development") but occasionally echoes
        // the human label ("Chum Bucket"). resolveBuildingId maps either to the
        // canonical slug and rejects inherited prototype keys. null → drop.
        const buildingId = resolveBuildingId(params.buildingId);
        if (!buildingId) {
          console.warn(`[Hatcher] enter_building dropped — unknown buildingId "${params.buildingId}"`);
          return;
        }
        const center = NPC_BUILDING_CENTERS[buildingId];
        // Mirror the /move?buildingId path: walk toward the building (slight
        // jitter at the entrance) and tag the destination so the sim shows the
        // approach. The visible in-world effect of entering a building.
        const destX = center.x + (Math.random() - 0.5) * 40;
        const destY = center.y + 20 + Math.random() * 20;
        const path = findPath(npc.x, npc.y, destX, destY);
        if (path.length === 0) {
          console.warn(`[Hatcher] enter_building dropped — no path to "${buildingId}"`);
          return;
        }
        this.setNpcPath(npcId, path, buildingId);
        this.recordAgentWorldAction(attribution, 'agent.move', {
          destination: buildingId,
        });
        return;
      }
      case 'enter_cove': {
        // enter_cove() — the HYBRID gateway verb (Rule E5 / [cards] spec). Walks
        // the agent body to the Predictive Gaming Cove and tags the destination
        // so the sim shows the approach. This is the VISIBLE in-world effect of
        // "I am going to the casino"; the agent then drives REAL-CT blackjack via
        // the agent-callable cove tools (GET/POST /api/agent/:sid/cove/blackjack/*),
        // which bind to its avatar's ClawToken ledger. No params.
        //
        // The Cove is NOT in NPC_BUILDING_CENTERS (10 teaching buildings only);
        // its center comes from the MAP_LOCATIONS rect, resolved once at module
        // load into COVE_CENTER. Drop loudly (never crash) if it's missing.
        if (!COVE_CENTER) {
          console.warn('[Hatcher] enter_cove dropped — cove location missing from MAP_LOCATIONS');
          return;
        }
        const destX = COVE_CENTER.x + (Math.random() - 0.5) * 40;
        const destY = COVE_CENTER.y + 20 + Math.random() * 20;
        const path = findPath(npc.x, npc.y, destX, destY);
        if (path.length === 0) {
          console.warn('[Hatcher] enter_cove dropped — no path to the cove');
          return;
        }
        this.setNpcPath(npcId, path, 'cove');
        // 'trading' is the closest valid NpcActivity for casino play; override
        // the emoji to the slot 🎰 so the bubble reads as "at the Cove".
        this.setNpcActivity(npcId, 'trading', '🎰');
        this.recordAgentWorldAction(attribution, 'agent.move', {
          destination: 'cove',
          venue: 'cove',
        });
        return;
      }
      case 'play_cove_game': {
        const keys = Object.keys(params);
        if (keys.some((key) => key !== 'game' && key !== 'wager')) {
          console.warn('[Hatcher] play_cove_game dropped — unknown parameter');
          return;
        }
        if (params.game !== 'slots' && params.game !== 'blackjack') {
          console.warn(`[Hatcher] play_cove_game dropped — unsupported game "${params.game}"`);
          return;
        }
        if (!/^\d+$/.test(params.wager ?? '')) {
          console.warn(`[Hatcher] play_cove_game dropped — wager must be an integer (got "${params.wager}")`);
          return;
        }
        const wager = Number(params.wager);
        if (params.game === 'slots' && (
          !Number.isSafeInteger(wager)
          || wager < COVE_SLOTS_MIN_BET
          || wager > COVE_SLOTS_MAX_BET
          || wager % COVE_SLOTS_BET_STEP !== 0
        )) {
          console.warn(
            `[Hatcher] play_cove_game dropped — slots wager must be ${COVE_SLOTS_MIN_BET}..${COVE_SLOTS_MAX_BET} vCLAW in steps of ${COVE_SLOTS_BET_STEP}`,
          );
          return;
        }
        if (
          params.game === 'blackjack'
          && (
            !Number.isSafeInteger(wager)
            || wager < BLACKJACK_MIN_BET
            || wager > BLACKJACK_MAX_BET
          )
        ) {
          console.warn(
            `[Hatcher] play_cove_game dropped — blackjack wager must be ${BLACKJACK_MIN_BET}..${BLACKJACK_MAX_BET} vCLAW`,
          );
          return;
        }
        if (!COVE_CENTER) {
          console.warn('[Hatcher] play_cove_game dropped — cove location missing from MAP_LOCATIONS');
          return;
        }
        const distanceFromCove = Math.hypot(npc.x - COVE_CENTER.x, npc.y - COVE_CENTER.y);
        if (distanceFromCove > BUILDING_INTERACTION_RADIUS) {
          console.warn(
            `[Hatcher] play_cove_game dropped — body is ${Math.round(distanceFromCove)}wu from the cove (need <=${BUILDING_INTERACTION_RADIUS}wu; use enter_cove first)`,
          );
          return;
        }
        if (!attribution) {
          console.warn('[Hatcher] play_cove_game dropped — no bound agent/avatar attribution');
          return;
        }
        void this.settleAutonomousCoveGame(npcId, attribution, params.game, wager).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[Hatcher] play_cove_game dropped — ${reason}`);
        });
        return;
      }
      case 'enter_poker_room': {
        // enter_poker_room() — the HYBRID gateway verb for tournament poker (Rule
        // E5). Walks the agent body to the Cove poker area (the poker tables live
        // INSIDE the Cove, so the destination is the same Cove center as
        // enter_cove) and tags it. This is the VISIBLE in-world effect of "I am
        // going to the poker tables"; the agent then registers + plays REAL-CT MTT
        // poker via the agent-callable poker tools (GET/POST
        // /api/agent/:sid/cove/poker/*), which bind to its avatar's ClawToken
        // ledger. BETTING NEVER flows through this action parser — only the
        // authenticated, session-bound tool endpoints. No params.
        if (!COVE_CENTER) {
          console.warn('[Hatcher] enter_poker_room dropped — cove location missing from MAP_LOCATIONS');
          return;
        }
        const destX = COVE_CENTER.x + (Math.random() - 0.5) * 40;
        const destY = COVE_CENTER.y + 20 + Math.random() * 20;
        const path = findPath(npc.x, npc.y, destX, destY);
        if (path.length === 0) {
          console.warn('[Hatcher] enter_poker_room dropped — no path to the cove poker area');
          return;
        }
        this.setNpcPath(npcId, path, 'cove');
        // 'trading' is the closest valid NpcActivity for casino play; ♠ reads as
        // "at the poker tables".
        this.setNpcActivity(npcId, 'trading', '♠️');
        this.recordAgentWorldAction(attribution, 'agent.move', {
          destination: 'cove',
          venue: 'poker',
        });
        return;
      }
      case 'enter_kelp_forest': {
        // Gateway-only parity verb: walk the visible body to the safe approach
        // outside the solid portal collider. The agent's brain then traverses
        // the SAME neighbor-reveal beacon REST API as a human; reward settlement
        // never occurs in this unauthenticated action parser.
        if (!KELP_FOREST_CENTER) {
          console.warn('[Hatcher] enter_kelp_forest dropped — shared portal approach missing');
          return;
        }
        const path = findPath(npc.x, npc.y, KELP_FOREST_CENTER.x, KELP_FOREST_CENTER.y);
        if (path.length === 0) {
          console.warn('[Hatcher] enter_kelp_forest dropped — no path to the portal approach');
          return;
        }
        this.setNpcPath(npcId, path, 'kelp-forest-portal');
        this.setNpcActivity(npcId, 'exploring', '🫧');
        this.recordAgentWorldAction(attribution, 'agent.move', {
          destination: 'kelp-forest-portal',
          venue: 'kelp-forest',
        });
        return;
      }
      case 'talk_to_npc': {
        // Target is a public npcId OR a buildingId; message is the speech. The
        // visible effect is the agent's own chat bubble (mirror of /chat's
        // injectAgentChat). Validate the target exists + bound the message.
        const rawTarget = params.npcId ?? params.buildingId;
        if (!rawTarget) {
          console.warn('[Hatcher] talk_to_npc dropped — no npcId/buildingId target');
          return;
        }
        // Resolve to a live npc id (as-is) OR a canonical building slug. The
        // building branch is label-tolerant (resolveBuildingId maps "Chum
        // Bucket" → "code-development") and prototype-key-safe — never an
        // inherited key. `target` below is the resolved value used for both the
        // proximity center and validity.
        const buildingTarget = this.npcs.has(rawTarget) ? null : resolveBuildingId(rawTarget);
        const target = this.npcs.has(rawTarget) ? rawTarget : buildingTarget;
        if (!target) {
          console.warn(`[Hatcher] talk_to_npc dropped — unknown target "${rawTarget}"`);
          return;
        }
        const message = (params.message ?? '').slice(0, HATCHER_TALK_MESSAGE_MAX).trim();
        if (!message) {
          console.warn('[Hatcher] talk_to_npc dropped — empty message');
          return;
        }
        // PROXIMITY GATE (agent-metaverse P1 slice 3, founder-signed). A body
        // must be physically NEAR its target to converse — the anti-abuse
        // backbone: no walk/proximity → no interaction (→ no reward, once slice
        // 4 wires it). EXEMPT only the contract-locked-talk protocols: today that
        // is Hatcher (`hatcher-proxy`) ONLY — a LIVE partner whose `talk` is
        // contract-locked (§3a manual + PROTOCOL_VERSION + harness). Server-hosted
        // harnesses (hermes-local, any future hosted protocol) STAY GATED here —
        // they must walk to talk — even though they DO get [ACTION:] parsing
        // (dispatch predicate below). The two capabilities are deliberately
        // distinct: `protocolProximityGateExempt` (hatcher-only) ≠
        // `protocolEmitsInWorldActions` (all server-hosted). P3 slice 6 replaced
        // the former hardcoded `=== 'hatcher-proxy'` with the capability read so
        // the two never drift. FAIL-CLOSED: an unresolvable body → undefined
        // protocol → NOT exempt → the gate applies. Predicate keys on the in-world
        // client protocol (NOT `is_house`, which isn't on the reg config and is
        // the wrong polarity). Both Hatcher register modes set
        // `protocol==='hatcher-proxy'` (registerAgentBot :786/:837) so Hatcher is
        // exempt in avatar AND override mode.
        const proximityExempt =
          protocolProximityGateExempt(this.getAgentBotClient(npcId)?.getProtocol());
        if (!proximityExempt) {
          // Resolve the target's center: a live npc body, else the building
          // center (Object.hasOwn guard — never an inherited prototype key).
          // `target` is already the resolved npc id / canonical building slug,
          // so one of the two branches resolves.
          const targetNpc = this.npcs.get(target);
          let dist: number;
          if (targetNpc) {
            // NPC target → point-to-point distance.
            dist = Math.hypot(npc.x - targetNpc.x, npc.y - targetNpc.y);
          } else if (Object.hasOwn(NPC_BUILDING_CENTERS, target)) {
            // Building target → distance to the collider FOOTPRINT edge, NOT the
            // center (a center-radius gate is unsatisfiable for the larger
            // buildings; same fix as the /visit-building + /building/:id/chat gates).
            dist = buildingEdgeDistanceGamePx(npc.x, npc.y, target) ?? Infinity;
          } else {
            // Unreachable given `target` resolved above, but fail-closed: drop
            // rather than let an unresolvable target skip the distance check.
            console.warn(`[Autonomy] talk_to_npc dropped — target "${target}" not resolvable for proximity`);
            return;
          }
          if (dist > BUILDING_INTERACTION_RADIUS) {
            console.warn(
              `[Autonomy] talk_to_npc gated — ${Math.round(dist)}wu from "${target}" (need <=${BUILDING_INTERACTION_RADIUS}wu)`,
            );
            return;
          }
        }
        this.injectAgentChat(npcId, message);
        this.recordAgentWorldAction(attribution, 'agent.chat', {
          target,
          msgSha256: createHash('sha256').update(message, 'utf8').digest('hex'),
          len: message.length,
        });
        return;
      }
    }
    const exhaustive: never = name;
    return exhaustive;
  }

  /**
   * Start an additive owned-emote lookup without making the synchronous action
   * executor async. Invalid/prototype names and unattributed bodies fail before
   * any database work. The body identity fence after the await prevents a stale
   * result from mutating a despawned/replaced body with the same id.
   */
  private dispatchOwnedEmote(
    npcId: string,
    npc: NpcRuntimeState,
    name: string,
    attribution: AgentActionAttribution | null,
    warnOnMiss = true,
  ): boolean {
    if (
      typeof name !== 'string' ||
      !OWNED_EMOTE_NAME_PATTERN.test(name) ||
      Object.hasOwn(Object.prototype, name) ||
      !attribution
    ) {
      return false;
    }

    void this.emoteOwnershipQuery(attribution.avatarId, name)
      .then((owned) => {
        if (!owned) {
          if (!warnOnMiss) return;
          console.warn(`[Hatcher] emote dropped — unknown name "${name}"`);
          return;
        }
        if (this.npcs.get(npcId) !== npc) return;
        npc.emoteClip = name;
        npc.emoteSeq = (npc.emoteSeq ?? 0) + 1;
      })
      .catch((err: unknown) => {
        console.error(
          `[Hatcher] emote ownership check failed for ${npcId} — dropped:`,
          err instanceof Error ? err.message : err,
        );
      });
    return true;
  }

  /**
   * Best-effort standalone record for non-money world actions. There is no
   * surrounding business transaction at this synchronous executor boundary,
   * so this deliberately uses the recorder's documented standalone mode. A
   * recorder failure is observational only and must never undo a world action.
   */
  private recordAgentWorldAction(
    attribution: AgentActionAttribution | null,
    action: 'agent.move' | 'agent.chat',
    payload: Record<string, unknown>,
  ): void {
    if (!attribution) return;
    void this.covenantRecord({
      action,
      subjectType: 'avatar',
      subjectId: attribution.avatarId,
      actorKind: attribution.actorKind,
      payload,
    }).catch((err: unknown) => {
      console.error(
        `[Covenant] failed to record ${action} for ${attribution.avatarId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  // --- Browser Claw Methods ---

  registerBrowserClaw(sessionId: string, config: ClawConfig): void {
    const spawnX = 540 + Math.random() * 200;
    const spawnY = 300 + Math.random() * 200;
    this.browserClaws.set(sessionId, {
      config,
      sessionId,
      x: spawnX,
      y: spawnY,
      direction: 'idle',
      activity: 'idle',
      activityEmoji: '',
      lastHeartbeat: Date.now(),
    });
    console.log(`[BrowserClaw] Connected: "${config.name}" (sess:${sessionDigest(sessionId)})`);
  }

  unregisterBrowserClaw(sessionId: string): boolean {
    const existed = this.browserClaws.delete(sessionId);
    if (existed) console.log(`[BrowserClaw] Disconnected: sess:${sessionDigest(sessionId)}`);
    return existed;
  }

  updateBrowserClawPosition(sessionId: string, x: number, y: number, direction?: string, activity?: string): boolean {
    const claw = this.browserClaws.get(sessionId);
    if (!claw) return false;
    claw.x = Math.max(16, Math.min(MAP_WIDTH - 16, x));
    claw.y = Math.max(16, Math.min(MAP_HEIGHT - 16, y));
    if (direction) claw.direction = direction;
    if (activity) claw.activity = activity;
    claw.lastHeartbeat = Date.now();
    return true;
  }

  getBrowserClaw(sessionId: string): { config: ClawConfig; sessionId: string; x: number; y: number } | null {
    return this.browserClaws.get(sessionId) ?? null;
  }

  getBrowserClawSnapshots(): BrowserClawSnapshot[] {
    return Array.from(this.browserClaws.values()).map((c) => ({
      // B1 (non-CT griefing vector, non-blocking): the raw browser-claw sessionId
      // (`claw-<ts>-<rand>`, low entropy) was broadcast verbatim on the public
      // snapshot, letting anyone impersonate/grief a browser claw. Emit the SAME
      // salted, non-reversible presence id the multiplayer player snapshots use
      // (derivePublicId) — stable per claw, opaque, brute-force-resistant. (Field
      // name kept `sessionId` for wire compat; it now carries the public digest.)
      sessionId: derivePublicId(c.sessionId),
      name: c.config.name,
      species: c.config.species,
      color: c.config.color,
      x: c.x,
      y: c.y,
      direction: c.direction,
      activity: c.activity,
      activityEmoji: c.activityEmoji,
    }));
  }

  private cleanupStaleClaws() {
    const cutoff = Date.now() - 30000; // 30s no heartbeat
    for (const [sid, claw] of this.browserClaws) {
      if (claw.lastHeartbeat < cutoff) {
        this.browserClaws.delete(sid);
        console.log(`[BrowserClaw] Stale timeout: "${claw.config.name}" (sess:${sessionDigest(sid)})`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — NPC-vs-NPC entity push-out
  // ---------------------------------------------------------------------------

  private resolveNpcNpcOverlaps() {
    const alive: NpcRuntimeState[] = [];
    for (const npc of this.npcs.values()) {
      if (!npc.isDead && !npc.inConversation) alive.push(npc);
    }

    // Half-width: chibi VRMs (milady-* and chibi-*) 25wu, everything else 50wu.
    const halfOf = (npc: NpcRuntimeState): number =>
      npc.id.startsWith('milady-') || npc.id.startsWith('chibi-') ? 25 : 50;

    // Track which NPCs participated in any overlap this tick. Bounded by alive.length
    // (≈14) — small enough that a Set is fine. Pairs that overlapped get queued for
    // the deadlock-yield pass below.
    const overlappedIds = new Set<string>();
    const overlappingPairs: Array<[NpcRuntimeState, NpcRuntimeState]> = [];

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i]!;
        const b = alive[j]!;
        const combinedHalf = halfOf(a) + halfOf(b);
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= combinedHalf * combinedHalf || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const overlap = combinedHalf - dist;
        const pushX = (dx / dist) * (overlap * 0.5);
        const pushY = (dy / dist) * (overlap * 0.5);

        const rawAX = Math.max(16, Math.min(MAP_WIDTH - 16, a.x + pushX));
        const rawAY = Math.max(16, Math.min(MAP_HEIGHT - 16, a.y + pushY));
        const rawBX = Math.max(16, Math.min(MAP_WIDTH - 16, b.x - pushX));
        const rawBY = Math.max(16, Math.min(MAP_HEIGHT - 16, b.y - pushY));

        // Re-clamp pushed positions against building AABBs so two NPCs meeting
        // near a building wall can't push each other through it.
        const clA = clampPosition2D(rawAX - WORLD_COLLIDER_MAP_HALF, rawAY - WORLD_COLLIDER_MAP_HALF, halfOf(a));
        a.x = Math.max(16, Math.min(MAP_WIDTH - 16, clA.x + WORLD_COLLIDER_MAP_HALF));
        a.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clA.z + WORLD_COLLIDER_MAP_HALF));

        const clB = clampPosition2D(rawBX - WORLD_COLLIDER_MAP_HALF, rawBY - WORLD_COLLIDER_MAP_HALF, halfOf(b));
        b.x = Math.max(16, Math.min(MAP_WIDTH - 16, clB.x + WORLD_COLLIDER_MAP_HALF));
        b.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clB.z + WORLD_COLLIDER_MAP_HALF));

        overlappedIds.add(a.id);
        overlappedIds.add(b.id);
        overlappingPairs.push([a, b]);
      }
    }

    // Overlap-counter maintenance. NPCs in an overlap this tick → ++; everyone
    // else resets to 0. Counter persists between ticks so deadlocked pairs can
    // accumulate the YIELD_THRESHOLD even though each individual tick "moved"
    // them sideways by the half-push (which fools stuckTicks).
    for (const npc of alive) {
      if (overlappedIds.has(npc.id)) {
        npc.overlapTicks++;
      } else {
        npc.overlapTicks = 0;
      }
    }

    // Deadlock-yield pass. For each overlapping pair, the LEX-LOWER id is the
    // yielder. Asymmetric on purpose — if both yielded, both would replan and
    // potentially reconverge on the same area. Lex-lower is deterministic and
    // testable. Threshold = 3 ticks (~600 ms at 5 Hz) so a transient
    // push-through doesn't trigger a spurious yield, but a true deadlock breaks
    // before the user perceives it as a stuck character.
    const YIELD_THRESHOLD = 3;
    for (const [a, b] of overlappingPairs) {
      const yielder = a.id < b.id ? a : b;
      // Already yielded this tick (path empty) or busy in combat — skip.
      if (yielder.path.length === 0) continue;
      if (yielder.inCombat || yielder.inConversation) continue;
      if (yielder.overlapTicks < YIELD_THRESHOLD) continue;

      // Abandon current path, drop to idle so the client stops playing the
      // walk-in-place animation immediately. Cooldown 8-15 ticks (≈ 1.6-3s)
      // before re-planning so the higher-id NPC walks past before the yielder
      // picks a new target — prevents immediate re-collision.
      yielder.path = [];
      yielder.pathIndex = 0;
      yielder.activity = 'idle';
      yielder.activityEmoji = '';
      yielder.destinationBuildingId = null;
      yielder.direction = 'idle';
      yielder.intentDescription = 'Stepping aside';
      yielder.behaviorCooldown = 8 + Math.floor(Math.random() * 8);
      yielder.overlapTicks = 0;
    }
  }

  private nextId(): string { return `ev-${++this.idCounter}`; }

  private tick() {
    this.tickCount++;
    this.conversationCooldown = Math.max(0, this.conversationCooldown - 1);
    this.combatCooldown = Math.max(0, this.combatCooldown - 1);
    this.pendingEvents = [];

    this.handleRespawns();
    this.progressCombats();
    this.progressConversations();

    if (!this.arenaMode) {
      this.handleActivityDurations();
      this.planNpcBehaviors();
    }

    this.moveNpcs();

    // NPC-vs-NPC push-out (world mode only, Phase 4).
    // Runs after all positions are updated so we resolve overlaps once per tick
    // rather than re-checking every individual step. The push amount is small
    // enough (~30wu max) that one pass per 200ms tick is sufficient.
    if (!this.arenaMode) {
      this.resolveNpcNpcOverlaps();
    }

    if (this.conversationCooldown === 0 && this.tickCount % 40 === 0) {
      this.tryStartConversation().catch((err) => {
        console.error('[NPC Simulation] tryStartConversation failed:', err);
      });
    }
    if (this.arenaMode && this.combatCooldown === 0 && this.tickCount % 3 === 0) {
      this.tryStartCombat();
    }

    // Arena round progression
    if (this.arenaMode) this.tickRounds();

    // Sweep for orphaned combat flags every 10 ticks (~5s) in arena mode
    if (this.arenaMode && this.tickCount % 10 === 0) {
      this.sweepOrphanedCombatFlags();
    }

    // Autonomous avatar behavior (world mode only) — Phase 2: via SimulationRuntime
    if (!this.arenaMode) {
      this.avatarAutonomyManager.tick();
    }

    this.cleanup();
    this.broadcast();

    // Clean up stale browser claws every ~6s (30 ticks * 200ms)
    if (this.tickCount % 30 === 0) {
      this.cleanupStaleClaws();
    }

    // Periodic memory cleanup (~every 12 min: 3600 ticks * 200ms = 720s)
    if (this.tickCount % 3600 === 0) {
      memoryService.cleanup().catch(console.error);
    }
  }

  private handleRespawns() {
    const now = Date.now();
    for (const npc of this.npcs.values()) {
      if (npc.isDead && npc.respawnAt > 0 && now >= npc.respawnAt) {
        npc.isDead = false; npc.hp = npc.maxHp;
        npc.x = npc.homeX; npc.y = npc.homeY;
        npc.targetX = npc.homeX; npc.targetY = npc.homeY;
        npc.inCombat = false; npc.inConversation = false; npc.respawnAt = 0;
        npc.direction = 'idle'; npc.activity = 'idle'; npc.activityEmoji = '';
        npc.path = []; npc.pathIndex = 0; npc.destinationBuildingId = null;
        npc.behaviorCooldown = 10;
        npc.stuckTicks = 0;
        npc.overlapTicks = 0;
        npc.combatTargetId = null;
        npc.respawnedAt = now;
        npc.invulnerableUntil = now + 3000;
        console.log(`[NPC Simulation] ${npc.name} respawned (Lv${npc.level})`);
      }
    }
  }

  // --- Behavior Planning (World Mode) ---

  /**
   * Validate a candidate (gamePx) target against the pixel-accurate AABB
   * clamp. If the target sits inside a collider, snap it outward to the
   * nearest collision-free game-pixel via `findNearestWalkable`. Returns
   * null when no safe spot exists within the search radius — callers must
   * then re-pick or fall back to behaviorCooldown.
   *
   * Added 2026-05-22 to plug RCA gap #3: planners used to validate only
   * against `hasClearance` (coarse A* grid) and skipped the per-axis pad-
   * vs-real-extent test. A "valid" wander/visit/approach target could land
   * inside a prop AABB or in the gap between A*'s 11-tile pad and the
   * real building half-extents (e.g. messaging-channels halfX=850 wu vs
   * pad-only=576 wu).
   */
  private snapPlannerTarget(
    tx: number,
    ty: number,
    entityHalf: number = NPC_COLLISION_HALF,
  ): { x: number; y: number } | null {
    if (
      hasClearance(tx, ty, 3) &&
      isCollisionFreeWorld(tx, ty, entityHalf)
    ) {
      return { x: tx, y: ty };
    }
    return findNearestWalkable(tx, ty, entityHalf);
  }

  private findSafePath(
    npc: NpcRuntimeState,
    tx: number,
    ty: number,
    entityHalf: number = NPC_COLLISION_HALF,
  ): PathNode[] {
    const path = findPath(npc.x, npc.y, tx, ty);
    if (path.length === 0) return [];
    return isPathCollisionFree(npc.x, npc.y, path, entityHalf) ? path : [];
  }

  private planNpcBehaviors() {
    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation || npc.inCombat) continue;
      if (npc.activity !== 'idle') continue;
      if (npc.isOpenClaw && npc.autonomyMode === 'self-managed') continue;
      // Owner is driving this proxy in 'player' mode — don't plan autonomy for it.
      if (this.isHumanControlledOpenClawNpc(npc.id)) continue;

      npc.behaviorCooldown--;
      if (npc.behaviorCooldown > 0) continue;

      // Free-roaming wanderers (`buildingId === ''` in NPC_DEFINITIONS) skip
      // the building-visit and idle-near-home branches entirely. Hermes and
      // chibi wanderers do not use the old milady-/wanderer- ID prefixes, so
      // prefix checks quietly sent them back into building-wall paths.
      // Building-anchored NPCs (Bubbles, Inky, Hazel, etc.) keep the original
      // distribution — for them the idle-near-home wiggle is a meaningful
      // behavior because they have a real anchor (their building).
      const isFreeRoamer = FREE_ROAMER_IDS.has(npc.id);
      const roll = Math.random();
      if (isFreeRoamer) {
        // Free roamers (Milady/Hermes/chibi/crustacean wanderers) stay in the
        // town commons. They skip building visits entirely (buildings live on
        // the outer ring — walking there reads as leaving town) and
        // only occasionally approach nearby NPCs. The dedicated
        // `planCenterWander` picks targets within the FREE_ROAMER annulus.
        //
        // 2026-05-26: approach probability dropped 0.50 → 0.20. At 0.50, every
        // 9-NPC tick had ~4-5 approach plans queued, all converging on each
        // other inside the 250wu stand-off — producing the town-center pile-up
        // the user reported as "walking aimlessly into buildings". Wandering
        // 80% of the time keeps them visibly traversing the commons; the
        // remaining 20% still produces the occasional chat-bubble pairing.
        // If an NPC is currently OUTSIDE the annulus (got dragged in by a
        // chained approach or pushed out by entity overlap), force a wander
        // so its next decision pulls it back into the commons.
        const dx = npc.x - TOWN_CENTER_X;
        const dy = npc.y - TOWN_CENTER_Y;
        const distSqFromCenter = dx * dx + dy * dy;
        const isInAnnulus =
          distSqFromCenter >= FREE_ROAMER_MIN_RADIUS_SQ &&
          distSqFromCenter <= FREE_ROAMER_MAX_RADIUS_SQ;
        if (!isInAnnulus) {
          this.planCenterWander(npc);
        } else if (roll < 0.20) {
          this.planApproachNearbyNpc(npc);
        } else {
          this.planCenterWander(npc);
        }
        npc.behaviorCooldown = Math.floor(npc.behaviorCooldown / 2);
      } else {
        if (roll < 0.40) this.planVisitBuilding(npc);
        else if (roll < 0.60) this.planApproachNpc(npc);
        else if (roll < 0.90) this.planIdleNearHome(npc);
        else this.planWander(npc);
      }
    }
  }

  private planVisitBuilding(npc: NpcRuntimeState) {
    const buildingIds = Object.keys(NPC_BUILDING_CENTERS).filter((id) => id !== npc.id);
    if (buildingIds.length === 0) return;

    const withDist = buildingIds.map((id) => {
      const c = NPC_BUILDING_CENTERS[id];
      const dx = c.x - npc.x; const dy = c.y - npc.y;
      return { id, dist: Math.sqrt(dx * dx + dy * dy) };
    }).sort((a, b) => a.dist - b.dist);

    const candidates = withDist.slice(0, 5);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const center = NPC_BUILDING_CENTERS[target.id];

    // Up to 5 attempts to find a building approach point that's both
    // pathable AND outside the building AABB (2026-05-22). The naive
    // center+offset frequently lands inside the new larger building
    // colliders (e.g. messaging-channels halfX=850 wu). When the raw
    // candidate fails the collision test, snapPlannerTarget snaps outward.
    for (let attempt = 0; attempt < 5; attempt++) {
      const offsetX = (Math.random() - 0.5) * 40;
      const offsetY = 20 + Math.random() * 20;
      const snapped = this.snapPlannerTarget(center.x + offsetX, center.y + offsetY);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.destinationBuildingId = target.id;
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Walking to ${target.id}`;
        npc.behaviorCooldown = 120;
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planApproachNpc(npc: NpcRuntimeState) {
    const others = Array.from(this.npcs.values()).filter(
      (o) => o.id !== npc.id && !o.isDead && !o.inCombat && !o.inConversation && o.activity !== 'sleeping' &&
        // N4: don't let ambient NPCs converge on / pair with a self-managed
        // (house/fleet) body — it is driver-owned, not part of town liveliness.
        !this.isSelfManagedOpenClawNpc(o)
    );
    if (others.length === 0) { npc.behaviorCooldown = 20; return; }

    const target = others[Math.floor(Math.random() * others.length)];

    // Pick a stand-off point 80 wu from the target toward us. Walking to
    // target.x/y directly can land us on top of (or inside) the target's
    // own AABB or wedge us against whatever wall the target is parked at
    // (2026-05-22). 5 attempts: first the chaser-direction stand-off,
    // then random angles if that's blocked.
    const STAND_OFF = 80;
    const tdx = target.x - npc.x;
    const tdy = target.y - npc.y;
    const tdist = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      let standX: number;
      let standY: number;
      if (attempt === 0) {
        // Stand-off along the line from chaser → target.
        standX = target.x - (tdx / tdist) * STAND_OFF;
        standY = target.y - (tdy / tdist) * STAND_OFF;
      } else {
        const angle = Math.random() * Math.PI * 2;
        standX = target.x + Math.cos(angle) * STAND_OFF;
        standY = target.y + Math.sin(angle) * STAND_OFF;
      }
      const snapped = this.snapPlannerTarget(standX, standY);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Approaching ${target.name}`;
        npc.behaviorCooldown = 80;
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planIdleNearHome(npc: NpcRuntimeState) {
    // Up to 5 attempts — the home position may sit just outside a building
    // AABB and a small wiggle radius can land the candidate inside
    // (2026-05-22).
    for (let attempt = 0; attempt < 5; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 20 + Math.random() * 40;
      const tx = Math.max(32, Math.min(MAP_WIDTH - 32, npc.homeX + Math.cos(angle) * radius));
      const ty = Math.max(32, Math.min(MAP_HEIGHT - 32, npc.homeY + Math.sin(angle) * radius));
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Strolling nearby';
        npc.behaviorCooldown = 40 + Math.floor(Math.random() * 40);
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planWander(npc: NpcRuntimeState) {
    // Up to 5 attempts so a single bad random sample doesn't burn the tick
    // (2026-05-22). Random map points can easily land in a building or
    // prop AABB now that we rasterize 18 colliders with real extents.
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = 64 + Math.random() * (MAP_WIDTH - 128);
      const ty = 64 + Math.random() * (MAP_HEIGHT - 128);
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Wandering';
        npc.behaviorCooldown = 80 + Math.floor(Math.random() * 60);
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  // Free-roamer wander that picks a point inside the town RING (annulus
  // between FREE_ROAMER_MIN_RADIUS and FREE_ROAMER_MAX_RADIUS). Prevents
  // Miladys and crustacean wanderers both from crowding on top of the
  // town-center furniture AND from drifting to the map edge / outer
  // building ring.
  private planCenterWander(npc: NpcRuntimeState) {
    // Uniform area sampling in an annulus:
    //   r = sqrt(u * (R² - r²) + r²)
    // preserves equal area density at every radius — without the sqrt
    // more points would cluster near the inner edge.
    //
    // Heading continuity (2026-06-10): the first 8 attempts only accept
    // targets inside a ±60° forward cone around `headingAngle` AND at
    // least WANDER_MIN_LEG away, so consecutive legs read as one
    // continuous stroll instead of "stop, sense something, turn around"
    // (uniform sampling reversed direction on most replans — measured 90
    // reversals/min across 10 NPCs on staging). The last 4 attempts fall
    // back to the old unconstrained sample so an NPC heading into the
    // annulus boundary or a blocked corridor can still turn and escape.
    //
    // Retry up to 12 times per plan call so a single blocked sample near a
    // town-center prop doesn't freeze movement for a full planning cycle.
    const WANDER_MIN_LEG_SQ = 800 * 800;
    const FORWARD_CONE = Math.PI / 3; // ±60°
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(
        Math.random() * (FREE_ROAMER_MAX_RADIUS_SQ - FREE_ROAMER_MIN_RADIUS_SQ) + FREE_ROAMER_MIN_RADIUS_SQ,
      );
      const tx = TOWN_CENTER_X + Math.cos(angle) * radius;
      const ty = TOWN_CENTER_Y + Math.sin(angle) * radius;
      if (attempt < 8) {
        const legDx = tx - npc.x;
        const legDy = ty - npc.y;
        if (legDx * legDx + legDy * legDy < WANDER_MIN_LEG_SQ) continue;
        let turn = Math.atan2(legDy, legDx) - npc.headingAngle;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        if (Math.abs(turn) > FORWARD_CONE) continue;
      }
      // Reject targets with < 3 tiles of clearance from any blocked tile —
      // prevents NPCs pathfinding to the edge of a building exclusion zone
      // where they then stop pressed against the visible wall.
      // 2026-05-22: also reject targets inside any pixel-accurate AABB
      // (covers town-center props like shisha-oasis halfX=420 wu that
      // wouldn't show up in the coarse A* grid for the FREE_ROAMER ring).
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Strolling the town ring';
        npc.behaviorCooldown = 80 + Math.floor(Math.random() * 60);
        return;
      }
    }
    // All 12 samples blocked — give up this tick but replan soon.
    npc.behaviorCooldown = 10;
  }

  // Free-roamer approach: only considers NPCs that are ALSO inside the
  // outer ring bound (MAX_RADIUS), so a Milady never chases a building
  // resident past the building ring. Approach targets may be closer to
  // center than MIN_RADIUS (e.g. another wanderer passing through the
  // inner circle) — the approacher's next planCenterWander will snap
  // them back out to the ring. Falls back to a center-wander if no
  // suitable target.
  //
  // IMPORTANT: pathfinds to a STAND-OFF position 80wu from the target,
  // not the target's exact position. Without the offset, multiple
  // approachers all converge to a single world coordinate — observed
  // 2026-04-24 with Driftwood/Marlin/Riptide all frozen at exactly
  // x=4195.9919, y=2823.1967, so Marlin and Riptide rendered INSIDE
  // Driftwood's mesh and looked missing. Each approacher picks a random
  // angle around the target so multiple approachers spread around the
  // target instead of stacking.
  private planApproachNearbyNpc(npc: NpcRuntimeState) {
    // Candidate targets MUST be inside the FREE_ROAMER annulus — never the
    // inner core (town-center props live there) and never outside the outer
    // ring (buildings live there). Restricting to the annulus prevents an
    // approach chain from dragging the cluster into the town-center pile-up.
    const others = Array.from(this.npcs.values()).filter((o) => {
      if (o.id === npc.id) return false;
      if (o.isDead || o.inCombat || o.inConversation) return false;
      if (o.activity === 'sleeping') return false;
      const dx = o.x - TOWN_CENTER_X;
      const dy = o.y - TOWN_CENTER_Y;
      const distSq = dx * dx + dy * dy;
      return distSq >= FREE_ROAMER_MIN_RADIUS_SQ && distSq <= FREE_ROAMER_MAX_RADIUS_SQ;
    });
    if (others.length === 0) { this.planCenterWander(npc); return; }
    const target = others[Math.floor(Math.random() * others.length)];
    // 2026-05-26: stand-off bumped 250 → 400 wu. The 250 setting let 8
    // free-roamers chain-approach into a ~300wu cluster against the town
    // directory sign even when each individual approach landed at the right
    // distance — once everyone was clustered the next planApproachNearbyNpc
    // tick picked a fresh "nearby" target that was also inside the cluster.
    // 400wu is 1.6× a Milady's visible height and is enough that individual
    // labels stay legible.
    const standOff = 400;
    const dx0 = target.x - npc.x; const dy0 = target.y - npc.y;
    const distToTargetSq = dx0 * dx0 + dy0 * dy0;
    if (distToTargetSq <= standOff * standOff) {
      this.planCenterWander(npc);
      return;
    }
    // Try up to 8 stand-off angles before giving up. Reject targets without
    // ≥3 tiles of clearance OR that land outside the FREE_ROAMER annulus —
    // either keeps approachers in the safe commons zone.
    for (let attempt = 0; attempt < 8; attempt++) {
      const approachAngle = Math.random() * Math.PI * 2;
      const tx = target.x + Math.cos(approachAngle) * standOff;
      const ty = target.y + Math.sin(approachAngle) * standOff;
      // Annulus gate: reject stand-off points that would push the approacher
      // into the inner-core props or outside the outer-ring buildings.
      const sdx = tx - TOWN_CENTER_X;
      const sdy = ty - TOWN_CENTER_Y;
      const sDistSq = sdx * sdx + sdy * sdy;
      if (sDistSq < FREE_ROAMER_MIN_RADIUS_SQ || sDistSq > FREE_ROAMER_MAX_RADIUS_SQ) continue;
      // Combined clearance + pixel-accurate AABB test (2026-05-22).
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Approaching ${target.name}`;
        npc.behaviorCooldown = 80;
        return;
      }
    }
    {
      // Pathfinding failed (stand-off point may be inside a blocked tile or
      // off-map). Fall back to a center-wander instead of sitting idle —
      // otherwise the NPC just loops back into the same failing approach.
      this.planCenterWander(npc);
    }
  }

  // --- Activity Duration ---

  private handleActivityDurations() {
    const now = Date.now();
    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation || npc.inCombat) continue;

      // Arrived at destination — start building activity
      if (npc.activity === 'walking' && npc.path.length > 0 && npc.pathIndex >= npc.path.length) {
        if (npc.destinationBuildingId) {
          const activities = BUILDING_ACTIVITIES[npc.destinationBuildingId] ?? ['thinking'];
          const picked = activities[Math.floor(Math.random() * activities.length)];
          npc.activity = picked;
          npc.activityEmoji = ACTIVITY_EMOJIS[picked];
          npc.activityEndsAt = now + 8000 + Math.random() * 12000;
          npc.intentDescription = `${picked} at ${npc.destinationBuildingId}`;
          npc.path = []; npc.pathIndex = 0;
        } else {
          npc.activity = 'idle'; npc.activityEmoji = '';
          npc.path = []; npc.pathIndex = 0;
          // 2026-06-10: wander arrivals used to ALWAYS stand 4–8s
          // (20+rand(20) ticks @5Hz) before replanning — combined with the
          // uniform-random next target this produced the constant
          // stop-stand-turn-around rhythm the user flagged. Now 60% of
          // arrivals chain into the next leg after a natural beat
          // (0.4–0.8s); 40% keep a shorter believable pause (2–5s).
          // 60% of wander arrivals chain IMMEDIATELY into the next leg
          // (cooldown 1 = replan this same tick after the decrement) — with
          // heading-cone continuity the stroll flows through the turn with no
          // visible stop. The 0.4–0.8s "beat" variant read as constant
          // stop-start stutter (user 2026-06-10). 40% keep a real 2–5s pause.
          npc.behaviorCooldown = Math.random() < 0.6
            ? 1
            : 11 + Math.floor(Math.random() * 15);
        }
      }

      // Activity expired
      if (npc.activityEndsAt > 0 && now >= npc.activityEndsAt) {
        npc.activity = 'idle'; npc.activityEmoji = '';
        npc.activityEndsAt = 0; npc.destinationBuildingId = null;
        npc.behaviorCooldown = 10 + Math.floor(Math.random() * 20);
        npc.intentDescription = '';
      }
    }
  }

  private moveNpcs() {
    // World-mode baseStep × tickRate = wu/s.
    // 2026-04-25: tick rate moved 2Hz → 5Hz, baseStep scaled 110 → 44 to keep
    // speed at 220 wu/s (44 / 0.2s = 220). Smaller per-tick deltas = smoother
    // client lerp = motion reads closer to Nori (who has zero net translation).
    // 2026-06-10: briefly raised to 110 (550 wu/s) chasing a perceived
    // stride/speed mismatch — REVERTED same day. 110-unit ticks overwhelmed
    // the client entity-interp (visible stepping/glitch), and the perceived
    // mismatch was actually the world-stream client interp stalling (rendered
    // speed << server speed), NOT this constant. 44 @ 5Hz = 220 wu/s is the
    // tuned value: small per-tick deltas the client lerp absorbs smoothly,
    // and the walk clip at timeScale 1 visually matches ~220 (user-confirmed
    // perfect in client-side demo-wander mode). Do NOT re-raise this to fix
    // "NPCs look slow/sliding" — fix the client interp instead.
    const baseStep = this.arenaMode ? (14 + Math.random() * 4) * this.arenaSettings.moveSpeed : 44;

    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation) continue;
      // Owner is driving this proxy in 'player' mode — freeze its server body so
      // the hidden NPC can't keep walking an already-assigned path.
      if (this.isHumanControlledOpenClawNpc(npc.id)) continue;

      // In-combat NPCs in approach phase move toward their target at 1.5x speed
      if (npc.inCombat && npc.combatTargetId) {
        const target = this.npcs.get(npc.combatTargetId);
        if (target && !target.isDead) {
          const dx = target.x - npc.x;
          const dy = target.y - npc.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 40) {
            const approachStep = Math.min(baseStep * 1.5, dist);
            const desiredX = npc.x + (dx / dist) * approachStep;
            const desiredY = npc.y + (dy / dist) * approachStep;
            if (!this.arenaMode) {
              const clamped = clampPosition2D(
                desiredX - WORLD_COLLIDER_MAP_HALF,
                desiredY - WORLD_COLLIDER_MAP_HALF,
                30,
              );
              npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
              npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));
            } else {
              npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, desiredX));
              npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, desiredY));
            }
            npc.direction = dx > 0 ? 'right' : 'left';
          }
        }
        continue;
      }

      if (npc.inCombat) continue;
      if (npc.activity !== 'idle' && npc.activity !== 'walking') continue;

      if (this.arenaMode) {
        const nearest = this.findNearestAliveNpc(npc);
        if (nearest) {
          const jitterX = (Math.random() - 0.5) * 40;
          const jitterY = (Math.random() - 0.5) * 40;
          npc.targetX = nearest.x + jitterX;
          npc.targetY = nearest.y + jitterY;
        }
        this.moveTowardTarget(npc, baseStep);
        continue;
      }

      // World mode: follow A* path
      if (npc.path.length > 0 && npc.pathIndex < npc.path.length) {
        // Consume the FULL per-tick step across waypoint boundaries
        // (2026-06-10 — the server-cadence root cause). The old code burned
        // an entire 200ms tick on every `dist < 4` waypoint arrival (index
        // advance, ZERO movement that tick). A* waypoints arrive every 3–5
        // ticks of travel, so ~1/3 of walking ticks emitted no position —
        // measured live as ~2.5–3.3Hz effective cadence / a walking NPC
        // frozen 38% of its screen time ("NPCs move in spurts"). Walk the
        // tick's distance along the path polyline through as many waypoints
        // as it covers, then run the SAME collision pipeline as before on
        // the single final desired point.
        let walkRemaining = baseStep;
        let walkX = npc.x;
        let walkY = npc.y;
        let walkIdx = npc.pathIndex;
        let guard = 0;
        while (walkIdx < npc.path.length && walkRemaining > 0.001 && guard++ < 64) {
          const wpt = npc.path[walkIdx];
          const sdx = wpt.x - walkX; const sdy = wpt.y - walkY;
          const segDist = Math.sqrt(sdx * sdx + sdy * sdy);
          if (segDist <= walkRemaining || segDist < 4) {
            walkX = wpt.x; walkY = wpt.y;
            walkRemaining -= segDist;
            walkIdx++;
          } else {
            walkX += (sdx / segDist) * walkRemaining;
            walkY += (sdy / segDist) * walkRemaining;
            walkRemaining = 0;
          }
        }
        const dx = walkX - npc.x; const dy = walkY - npc.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.5) {
          // Degenerate path remainder (all waypoints within rounding) —
          // treat as arrival, same as the old dist<4 terminal branch.
          npc.pathIndex = walkIdx;
          if (npc.pathIndex >= npc.path.length) npc.direction = 'idle';
          npc.stuckTicks = 0;
        } else {
          const desiredX = walkX;
          const desiredY = walkY;

          // AABB world-collider clamp — convert game-px to world-space, clamp,
          // then convert back. entityHalf=30 (NPC capsule half-width in wu).
          const prevX = npc.x;
          const prevY = npc.y;
          if (!isCollisionFreeWorld(desiredX, desiredY, 30)) {
            npc.path = [];
            npc.pathIndex = 0;
            npc.activity = 'idle';
            npc.activityEmoji = '';
            npc.destinationBuildingId = null;
            npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
            npc.stuckTicks = 0;
            npc.direction = 'idle';
            continue;
          }
          const wx = desiredX - WORLD_COLLIDER_MAP_HALF;
          const wz = desiredY - WORLD_COLLIDER_MAP_HALF;
          const clamped = clampPosition2D(wx, wz, 30);
          npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
          npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));

          // Track stuck state (2026-05-22). The existing single-frame "abandon
          // on first clamp hit" is good, but path-following can produce
          // wedge-walks where the clamp shaves a little distance off and the
          // NPC creeps along the wall. stuckTicks catches that residual case.
          const moved = Math.abs(npc.x - prevX) + Math.abs(npc.y - prevY);
          if (moved < 2) {
            npc.stuckTicks++;
          } else {
            npc.stuckTicks = 0;
            // Applied-step heading for wander continuity (see headingAngle doc).
            npc.headingAngle = Math.atan2(npc.y - prevY, npc.x - prevX);
          }

          // If collider blocked this step, abandon current path and pick a new
          // patrol target — prevents NPCs humping a wall for the whole path.
          if (clamped.hit || npc.stuckTicks >= 4) {
            npc.path = [];
            npc.pathIndex = 0;
            npc.activity = 'idle';
            npc.activityEmoji = '';
            npc.destinationBuildingId = null;
            npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
            npc.stuckTicks = 0;
          } else {
            // Commit the waypoints consumed by this tick's polyline walk —
            // but ONLY if the clamp applied the full move. A shaved move means
            // the NPC is short of the consumed waypoints; advancing the index
            // anyway would straight-line toward a later waypoint next tick and
            // cut the corner the path was routing around. Keep the old index
            // (retry the same waypoint) in that case — old-code semantics.
            const shavedDx = npc.x - desiredX; const shavedDy = npc.y - desiredY;
            if (shavedDx * shavedDx + shavedDy * shavedDy < 1) {
              npc.pathIndex = walkIdx;
            }
            if (npc.pathIndex >= npc.path.length) {
              npc.direction = 'idle';
            } else {
              npc.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            }
          }
        }
      } else if (npc.activity === 'idle' && npc.path.length === 0) {
        npc.direction = 'idle';
        npc.stuckTicks = 0;
      }
    }
  }

  private moveTowardTarget(npc: NpcRuntimeState, baseStep: number) {
    const dx = npc.targetX - npc.x; const dy = npc.targetY - npc.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < (this.arenaMode ? 35 : 10)) {
      npc.direction = 'idle';
      npc.stuckTicks = 0;
    } else {
      const step = Math.min(baseStep, dist);
      const desiredX = npc.x + (dx / dist) * step;
      const desiredY = npc.y + (dy / dist) * step;
      if (!this.arenaMode) {
        const prevX = npc.x;
        const prevY = npc.y;
        if (!isCollisionFreeWorld(desiredX, desiredY, 30)) {
          npc.path = [];
          npc.pathIndex = 0;
          npc.activity = 'idle';
          npc.activityEmoji = '';
          npc.destinationBuildingId = null;
          npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
          npc.stuckTicks = 0;
          npc.direction = 'idle';
          return;
        }
        const clamped = clampPosition2D(
          desiredX - WORLD_COLLIDER_MAP_HALF,
          desiredY - WORLD_COLLIDER_MAP_HALF,
          30,
        );
        npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
        npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));

        // Mirror of path-step abandon at L~1062 — direct-target walkers also
        // need stuck-recovery (2026-05-22). Without this, an NPC whose target
        // sits inside an AABB wedges against the wall forever — activity stays
        // 'walking', behaviorCooldown never re-arms, planNpcBehaviors skips
        // them on every tick (gated on activity === 'idle').
        const moved = Math.abs(npc.x - prevX) + Math.abs(npc.y - prevY);
        if (clamped.hit || moved < 2) {
          npc.stuckTicks++;
        } else {
          npc.stuckTicks = 0;
          // Applied-step heading for wander continuity (see headingAngle doc).
          npc.headingAngle = Math.atan2(npc.y - prevY, npc.x - prevX);
        }
        if (clamped.hit || npc.stuckTicks >= 4) {
          npc.path = [];
          npc.pathIndex = 0;
          npc.activity = 'idle';
          npc.activityEmoji = '';
          npc.destinationBuildingId = null;
          npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
          npc.stuckTicks = 0;
          npc.direction = 'idle';
          return;
        }
      } else {
        npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, desiredX));
        npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, desiredY));
      }
      npc.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  }

  private findNearestAliveNpc(npc: NpcRuntimeState): NpcRuntimeState | null {
    let nearest: NpcRuntimeState | null = null;
    let nearestDist = Infinity;
    const now = Date.now();
    for (const other of this.npcs.values()) {
      if (other.id === npc.id || other.isDead || now < other.invulnerableUntil) continue;
      const dx = other.x - npc.x; const dy = other.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearest = other; }
    }
    return nearest;
  }

  private getIdleAliveNpcs(): NpcRuntimeState[] {
    const now = Date.now();
    return Array.from(this.npcs.values()).filter(
      (n) =>
        !this.isHumanControlledOpenClawNpc(n.id, now) &&
        !this.isSelfManagedOpenClawNpc(n) && // N4: never an ambient-conversation subject
        !n.isDead && !n.inConversation && !n.inCombat && now >= n.conversationCooldownUntil
    );
  }

  private findNearestIdleNpc(npc: NpcRuntimeState, maxDist: number): NpcRuntimeState | null {
    let nearest: NpcRuntimeState | null = null;
    let nearestDist = maxDist;
    const now = Date.now();
    for (const other of this.npcs.values()) {
      if (this.isHumanControlledOpenClawNpc(other.id, now)) continue;
      if (this.isSelfManagedOpenClawNpc(other)) continue; // N4: not an ambient-conversation partner
      if (other.id === npc.id || other.isDead || other.inConversation || other.inCombat || now < other.invulnerableUntil || now < other.conversationCooldownUntil) continue;
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearest = other; }
    }
    return nearest;
  }

  private async tryStartConversation() {
    const idle = this.getIdleAliveNpcs();
    if (idle.length < 2) return;

    const initiator = idle[Math.floor(Math.random() * idle.length)];
    // 2500 game-px partner-search radius — tuned for the Phase 6.2 world
    // (was 11520×11520; now 22528² after the 576→704 land-builder grow — the
    // ring footprint is unchanged by the uniform recenter, so the 2500 radius
    // still spans adjacent ring residents). Earlier 400px value
    // was sized for the ~5120 world and
    // was too tight after the expansion: NPCs scattered across 12 ring slots
    // (each ~2680px apart on the ring) almost never landed within 400px, so
    // tryStartConversation kept exiting without a partner and no bubbles
    // appeared. 2500px lets adjacent ring residents + town-center wanderers
    // find each other while still requiring meaningful proximity.
    const partner = this.findNearestIdleNpc(initiator, 2500);
    if (!partner) return;

    initiator.inConversation = true; partner.inConversation = true;
    initiator.activity = 'socializing'; initiator.activityEmoji = ACTIVITY_EMOJIS.socializing;
    initiator.path = []; initiator.pathIndex = 0;
    partner.activity = 'socializing'; partner.activityEmoji = ACTIVITY_EMOJIS.socializing;
    partner.path = []; partner.pathIndex = 0;
    this.conversationCooldown = 40;

    const resetNpcsOnFailure = () => {
      initiator.inConversation = false; initiator.activity = 'idle'; initiator.activityEmoji = '';
      partner.inConversation = false; partner.activity = 'idle'; partner.activityEmoji = '';
    };

    try {
      const def1 = NPC_DEFINITIONS.find((d: NpcDefinition) => d.id === initiator.id) ?? this.buildAvatarDef(initiator);
      const def2 = NPC_DEFINITIONS.find((d: NpcDefinition) => d.id === partner.id) ?? this.buildAvatarDef(partner);
      const client1 = this.getAgentBotClient(initiator.id);
      const client2 = this.getAgentBotClient(partner.id);

      // Build conversation context with crypto speciality
      const npc1Theme = BUILDING_OPENCLAW_THEMES[def1.buildingId ?? ''];
      const npc2Theme = BUILDING_OPENCLAW_THEMES[def2.buildingId ?? ''];
      const cryptoContext = [
        npc1Theme ? `${def1.name} specializes in ${npc1Theme.focus.split(',')[0]}` : '',
        npc2Theme ? `${def2.name} specializes in ${npc2Theme.focus.split(',')[0]}` : '',
      ].filter(Boolean).join('. ') || undefined;

      // Watcher gate (2026-07-13): `watched` evaluated ONCE so the branches and
      // the log below can't disagree if a heartbeat lands mid-generation.
      // - Paid legs = LLM requests for participants WITHOUT a client (the paid
      //   `default` inference route). Only these are budgeted — and per
      //   REQUEST, not per conversation (Codex round 3: a mixed conversation
      //   makes up to two paid calls, so per-conversation consumption
      //   understated spend 2×).
      // - Agent legs (client.chat — hatcher-proxy / hermes-local server-managed
      //   cognition) are NEVER gated: ambient conversations ARE those bodies'
      //   cognition + [ACTION:] path, so gating them would cut a live partner
      //   agent's actions whenever no human is watching (Codex round 2,
      //   HIGH #2). Their inference is partner-hosted/local, not our OpenAI.
      // - An empty world or an all-agent pair never consumes budget.
      const watched = this.hasActiveWatchers();
      const isAgentConvo = !!(client1 || client2);
      const hasPaidLeg = !client1 || !client2;
      let paidLegs = 0;
      let refusedLegs = 0;
      const tryConsumePaidLeg = () => {
        const ok = watched && this.tryConsumeBanterLlmBudget();
        if (ok) paidLegs++;
        else refusedLegs++;
        return ok;
      };

      let messages;
      if (isAgentConvo) {
        messages = await generateOpenClawConversation(
          def1,
          def2,
          client1,
          client2,
          this.arenaMode,
          cryptoContext,
          // Server-hosted cognition: parse + dispatch [ACTION:] tags (and strip
          // them from speech) for EVERY server-hosted-cognition protocol
          // ({hatcher-proxy, hermes-local}) — not just Hatcher (P3 slice 6
          // [ACTION:] parity). `dispatchHatcherActions` is the generic whitelist
          // executor (keyed on npcId, human-control-suppressed); its name is
          // historical. BYO/unknown protocols return the reply unchanged
          // (fail-closed via the capability table). hermes-local emits no reply
          // until the deferred inference flip lands, so this path is inert for it
          // today but wired for the instant it does.
          (npcId, client, rawReply) =>
            protocolEmitsInWorldActions(client.getProtocol())
              ? this.dispatchHatcherActions(npcId, rawReply)
              : rawReply,
          // Watcher gate: agent legs always run; each non-agent leg pays for
          // its own request or falls back to a canned line.
          { tryConsumePaidLeg },
        );
      } else if (tryConsumePaidLeg()) {
        // Pure NPC↔NPC pair: ONE chat completion generates the whole 2-4 line
        // conversation, so one unit here IS one paid request — exact.
        messages = await generateNpcConversation(def1, def2, this.arenaMode, cryptoContext);
      } else {
        // No visible-tab audience, or the hourly LLM budget is spent — don't
        // burn inference on dialogue no one sees. Canned lines keep the
        // conversation existing so bubbles/perception behave identically.
        messages = generateCannedConversation(def1, def2);
      }

      const firstSpeaker = messages.length > 0 ? messages[0].npcId : null;
      const conversation: NpcConversation = {
        id: this.nextId(), npc1Id: initiator.id, npc2Id: partner.id,
        messages, currentIndex: 0, nextMessageAt: Date.now() + 2500,
        state: 'active', typingNpcId: firstSpeaker, typingUntil: Date.now() + 2500,
      };
      this.conversations.set(conversation.id, conversation);
      // Burn-meter log: `paid=N` = paid LLM requests this conversation;
      // '(canned, …)' = fully canned; '(npc-legs canned, …)' = agent cognition
      // ran but one or more paid legs were refused.
      let gateMarker = '';
      if (hasPaidLeg && refusedLegs > 0) {
        const reason = watched ? 'capped' : 'unwatched';
        gateMarker = isAgentConvo ? ` (npc-legs canned, ${reason})` : ` (canned, ${reason})`;
      }
      console.log(`[NPC Simulation] Conversation started${gateMarker} paid=${paidLegs}: ${initiator.name} <-> ${partner.name}`);
    } catch (err) {
      console.error(`[NPC Simulation] Conversation generation failed, resetting NPCs:`, err);
      resetNpcsOnFailure();
    }
  }

  /** Build a minimal NpcDefinition for OpenClaw avatar NPCs */
  private buildAvatarDef(npc: NpcRuntimeState): NpcDefinition {
    return {
      id: npc.id,
      name: npc.name,
      species: npc.species as any,
      color: npc.color,
      buildingId: '',
      patrolRadius: npc.patrolRadius,
      homeX: npc.homeX,
      homeY: npc.homeY,
      stats: { hp: npc.maxHp, attack: npc.attack, defense: npc.defense, speed: npc.speed },
      personality: 'An OpenClaw-powered bot with a unique personality.',
    };
  }

  private progressConversations() {
    const now = Date.now();
    for (const convo of this.conversations.values()) {
      if (convo.state !== 'active') continue;
      if (now < convo.nextMessageAt) continue;

      if (convo.typingNpcId && now >= convo.typingUntil) convo.typingNpcId = null;

      convo.currentIndex++;
      if (convo.currentIndex >= convo.messages.length) {
        convo.state = 'done'; convo.typingNpcId = null;
        const npc1 = this.npcs.get(convo.npc1Id);
        const npc2 = this.npcs.get(convo.npc2Id);
        const convoCooldownMs = 15000 + Math.random() * 20000;
        if (npc1) { npc1.inConversation = false; npc1.activity = 'idle'; npc1.activityEmoji = ''; npc1.path = []; npc1.pathIndex = 0; npc1.behaviorCooldown = 3; npc1.conversationCooldownUntil = Date.now() + convoCooldownMs; }
        if (npc2) { npc2.inConversation = false; npc2.activity = 'idle'; npc2.activityEmoji = ''; npc2.path = []; npc2.pathIndex = 0; npc2.behaviorCooldown = 3; npc2.conversationCooldownUntil = Date.now() + convoCooldownMs; }
      } else {
        const nextMsg = convo.messages[convo.currentIndex];
        const typingDuration = 2000 + Math.random() * 1500;
        convo.typingNpcId = nextMsg.npcId;
        convo.typingUntil = now + typingDuration;
        convo.nextMessageAt = now + typingDuration + 2000;
      }
    }
  }

  private tryStartCombat() {
    // Don't start combat during intermission or after arena completion
    if (this.arenaRound && this.arenaRound.state !== 'fighting') return;

    const activeCombats = Array.from(this.combats.values()).filter((c) => c.state === 'active');
    if (activeCombats.length >= this.arenaSettings.maxFights) return;

    const now = Date.now();
    const idle = this.getIdleAliveNpcs().filter((n) => now >= n.invulnerableUntil);
    if (idle.length < 2) return;
    const initiator = idle[Math.floor(Math.random() * idle.length)];
    const target = this.findNearestIdleNpc(initiator, 400);
    if (!target) return;

    initiator.inCombat = true; target.inCombat = true;
    initiator.combatTargetId = target.id;
    target.combatTargetId = initiator.id;
    this.combatCooldown = 4;
    if (target.x > initiator.x) { initiator.direction = 'right'; target.direction = 'left'; }
    else { initiator.direction = 'left'; target.direction = 'right'; }

    const combat: NpcCombat = {
      id: this.nextId(), attacker: initiator.id, defender: target.id,
      rounds: [], state: 'active', winner: null, lootTransferred: [],
      startedAt: now, nextRoundAt: now + 1500, phase: 'approach',
    };
    this.combats.set(combat.id, combat);
  }

  private selectCombatAction(): NpcRuntimeState['combatAction'] {
    const roll = Math.random();
    if (roll < 0.50) return 'attack';
    if (roll < 0.65) return 'heavy';
    if (roll < 0.80) return 'block';
    if (roll < 0.90) return 'dodge';
    return 'combo';
  }

  private progressCombats() {
    const now = Date.now();
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active' || now < combat.nextRoundAt) continue;
      const attacker = this.npcs.get(combat.attacker);
      const defender = this.npcs.get(combat.defender);

      if (!attacker || !defender) {
        combat.state = 'done'; combat.phase = 'done';
        const survivor = attacker || defender;
        if (survivor) { survivor.inCombat = false; survivor.combatTargetId = null; survivor.combatAction = null; }
        continue;
      }

      if (attacker.isDead || defender.isDead || now < attacker.invulnerableUntil || now < defender.invulnerableUntil) {
        combat.state = 'done'; combat.phase = 'done';
        attacker.inCombat = false; attacker.combatTargetId = null; attacker.combatAction = null;
        defender.inCombat = false; defender.combatTargetId = null; defender.combatAction = null;
        continue;
      }

      if (combat.phase === 'approach') {
        combat.phase = 'fighting';
        combat.nextRoundAt = now + Math.round(800 / this.arenaSettings.combatSpeed);
        continue;
      }

      const faster = attacker.speed >= defender.speed ? attacker : defender;
      const slower = attacker.speed >= defender.speed ? defender : attacker;

      const fasterAction = faster.combatAction ?? this.selectCombatAction();
      const slowerAction = slower.combatAction ?? this.selectCombatAction();
      faster.combatAction = fasterAction;
      faster.combatActionAt = now;
      slower.combatAction = slowerAction;
      slower.combatActionAt = now;

      // Faster attacks first
      if (fasterAction === 'combo') {
        for (let i = 0; i < 3; i++) {
          const hit = this.calculateAttack(faster, slower, now, 0.6, slowerAction);
          combat.rounds.push(hit);
          if (slower.hp <= 0) { this.resolveCombatDeath(combat, faster, slower); break; }
        }
        if ((combat as any).state === 'done') continue;
      } else if (fasterAction === 'block' || fasterAction === 'dodge') {
        // Defensive action — no attack from faster this round
      } else {
        const damageMultiplier = fasterAction === 'heavy' ? 1.5 : 1.0;
        const hit = this.calculateAttack(faster, slower, now, damageMultiplier, slowerAction);
        combat.rounds.push(hit);
        if (slower.hp <= 0) { this.resolveCombatDeath(combat, faster, slower); continue; }
      }

      // Slower retaliates
      if (slowerAction === 'combo') {
        for (let i = 0; i < 3; i++) {
          const hit = this.calculateAttack(slower, faster, now, 0.6, fasterAction);
          combat.rounds.push(hit);
          if (faster.hp <= 0) { this.resolveCombatDeath(combat, slower, faster); break; }
        }
        if ((combat as any).state === 'done') continue;
      } else if (slowerAction === 'block' || slowerAction === 'dodge') {
        // Defensive — no attack
      } else {
        const damageMultiplier = slowerAction === 'heavy' ? 1.5 : 1.0;
        const hit = this.calculateAttack(slower, faster, now, damageMultiplier, fasterAction);
        combat.rounds.push(hit);
        if (faster.hp <= 0) { this.resolveCombatDeath(combat, slower, faster); continue; }
      }

      combat.nextRoundAt = now + Math.round(2000 / this.arenaSettings.combatSpeed);
    }
  }

  private calculateAttack(
    attacker: NpcRuntimeState, defender: NpcRuntimeState, now: number,
    damageMultiplier: number = 1.0,
    defenderAction?: NpcRuntimeState['combatAction']
  ): { attacker: string; damage: number; defenderHpAfter: number; isCrit?: boolean; isDodge?: boolean; isBlocked?: boolean } {
    if (defenderAction === 'dodge') {
      return { attacker: attacker.id, damage: 0, defenderHpAfter: defender.hp, isDodge: true };
    }

    const critChance = Math.min(0.35, 0.05 + Math.max(0, attacker.speed - defender.speed) * 0.02);
    const isCrit = Math.random() < critChance;
    const critMultiplier = isCrit ? 1.5 : 1.0;
    const rawDamage = attacker.attack * (0.8 + Math.random() * 0.4);
    const mitigated = defender.defense * 0.8;
    let damage = Math.max(1, Math.round((rawDamage - mitigated) * critMultiplier * damageMultiplier));

    const isBlocked = defenderAction === 'block';
    if (isBlocked) {
      damage = Math.max(1, Math.round(damage * 0.5));
    }

    defender.hp = Math.max(0, defender.hp - damage);
    attacker.lastAttackAt = now;
    defender.lastHitAt = now;
    return { attacker: attacker.id, damage, defenderHpAfter: defender.hp, isCrit: isCrit || undefined, isDodge: undefined, isBlocked: isBlocked || undefined };
  }

  private resolveCombatDeath(combat: NpcCombat, winner: NpcRuntimeState, loser: NpcRuntimeState) {
    combat.state = 'done'; combat.phase = 'done'; combat.winner = winner.id;
    if (loser.inventory.length > 0) {
      combat.lootTransferred = [...loser.inventory];
      winner.inventory.push(...loser.inventory);
      loser.inventory = [];
    }
    winner.inventory.push(`loot-${this.nextId()}`);

    // XP and leveling
    winner.kills++;
    const xpGained = 30 + loser.level * 15;
    winner.xp += xpGained;
    const xpToNext = () => 50 * winner.level;
    while (winner.xp >= xpToNext()) {
      winner.xp -= xpToNext();
      winner.level++;
      winner.attack = winner.baseAttack + (winner.level - 1);
      winner.defense = winner.baseDefense + (winner.level - 1);
      winner.speed = winner.baseSpeed + (winner.level - 1);
      winner.maxHp = winner.baseMaxHp + (winner.level - 1) * 5;
      winner.hp = Math.min(winner.maxHp, winner.hp + 10);
      this.pendingEvents.push({
        id: this.nextId(), type: 'level_up',
        npcId: winner.id, npcName: winner.name,
        data: { newLevel: winner.level }, timestamp: Date.now(),
      });
      console.log(`[NPC Simulation] ${winner.name} leveled up to Lv${winner.level}!`);
    }

    winner.inCombat = false; winner.combatTargetId = null; winner.combatAction = null;
    loser.isDead = true; loser.inCombat = false; loser.combatTargetId = null; loser.combatAction = null;
    loser.respawnAt = Date.now() + this.arenaSettings.respawnTime * 1000;
    console.log(`[NPC Simulation] ${winner.name} (Lv${winner.level}) defeated ${loser.name} (Lv${loser.level})! +${xpGained}XP`);
  }

  private cleanupNpcFromCombats(npcId: string) {
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      if (combat.attacker !== npcId && combat.defender !== npcId) continue;
      combat.state = 'done'; combat.phase = 'done';
      const opponentId = combat.attacker === npcId ? combat.defender : combat.attacker;
      const opponent = this.npcs.get(opponentId);
      if (opponent) { opponent.inCombat = false; opponent.combatTargetId = null; opponent.combatAction = null; }
    }
  }

  private sweepOrphanedCombatFlags() {
    const activeCombatNpcs = new Set<string>();
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      activeCombatNpcs.add(combat.attacker);
      activeCombatNpcs.add(combat.defender);
    }
    for (const npc of this.npcs.values()) {
      if (npc.inCombat && !activeCombatNpcs.has(npc.id)) {
        npc.inCombat = false;
        npc.combatTargetId = null;
      }
    }
  }

  // --- Round System ---

  private initRounds() {
    this.arenaRound = {
      round: 1,
      maxRounds: DEFAULT_MAX_ROUNDS,
      state: 'fighting',
      roundStartedAt: Date.now(),
      intermissionEndsAt: 0,
    };
    this.pendingEvents.push({
      id: this.nextId(), type: 'round_start',
      npcId: '', npcName: '',
      data: { round: 1, maxRounds: DEFAULT_MAX_ROUNDS },
      timestamp: Date.now(),
    });
    console.log(`[Arena] Round 1/${DEFAULT_MAX_ROUNDS} started`);
  }

  private tickRounds() {
    if (!this.arenaRound) return;
    const now = Date.now();
    if (this.arenaRound.state === 'fighting') {
      if (now - this.arenaRound.roundStartedAt >= ROUND_DURATION_MS) this.endRound();
    } else if (this.arenaRound.state === 'intermission') {
      if (now >= this.arenaRound.intermissionEndsAt) this.startNextRound();
    }
  }

  private endRound() {
    if (!this.arenaRound) return;
    const now = Date.now();
    const currentRound = this.arenaRound.round;

    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      combat.state = 'done'; combat.phase = 'done';
      const a = this.npcs.get(combat.attacker);
      const d = this.npcs.get(combat.defender);
      if (a) { a.inCombat = false; a.combatTargetId = null; }
      if (d) { d.inCombat = false; d.combatTargetId = null; }
    }

    for (const npc of this.npcs.values()) {
      npc.hp = npc.maxHp;
      npc.isDead = false; npc.respawnAt = 0;
      npc.inCombat = false; npc.combatTargetId = null;
      npc.x = npc.homeX; npc.y = npc.homeY;
      npc.targetX = npc.homeX; npc.targetY = npc.homeY;
      npc.direction = 'idle';
    }

    this.pendingEvents.push({
      id: this.nextId(), type: 'round_end',
      npcId: '', npcName: '', data: { round: currentRound }, timestamp: now,
    });

    if (currentRound >= this.arenaRound.maxRounds) {
      const winner = this.getArenaWinner();
      this.arenaRound.state = 'complete';
      this.pendingEvents.push({
        id: this.nextId(), type: 'arena_complete',
        npcId: winner?.id ?? '', npcName: winner?.name ?? 'Nobody',
        // B1 ROOT-FIX: `winner.id` for an avatar body is the non-secret
        // `ocb-<base64url(agentId)>` now, so it is safe to emit directly.
        data: { winnerId: winner?.id, winnerName: winner?.name, winnerKills: winner?.kills ?? 0, winnerLevel: winner?.level ?? 1 },
        timestamp: now,
      });
      console.log(`[Arena] Complete! Winner: ${winner?.name ?? 'Nobody'} (Lv${winner?.level}, ${winner?.kills} kills)`);
    } else {
      this.arenaRound.state = 'intermission';
      this.arenaRound.intermissionEndsAt = now + INTERMISSION_MS;
      for (const npc of this.npcs.values()) {
        npc.invulnerableUntil = this.arenaRound.intermissionEndsAt;
      }
      console.log(`[Arena] Round ${currentRound} ended. Intermission...`);
    }
  }

  private startNextRound() {
    if (!this.arenaRound) return;
    const now = Date.now();
    this.arenaRound.round++;
    this.arenaRound.state = 'fighting';
    this.arenaRound.roundStartedAt = now;
    this.arenaRound.intermissionEndsAt = 0;

    this.pendingEvents.push({
      id: this.nextId(), type: 'round_start',
      npcId: '', npcName: '',
      data: { round: this.arenaRound.round, maxRounds: this.arenaRound.maxRounds },
      timestamp: now,
    });
    console.log(`[Arena] Round ${this.arenaRound.round}/${this.arenaRound.maxRounds} started`);
  }

  private getArenaWinner(): NpcRuntimeState | null {
    let best: NpcRuntimeState | null = null;
    for (const npc of this.npcs.values()) {
      if (!best || npc.kills > best.kills || (npc.kills === best.kills && npc.level > best.level)) {
        best = npc;
      }
    }
    return best;
  }

  private cleanup() {
    // Remove done conversations/combats older than 15s
    const cutoff = Date.now() - 15000;
    for (const [id, convo] of this.conversations) {
      if (convo.state === 'done' && convo.nextMessageAt < cutoff) {
        this.conversations.delete(id);
      }
    }
    for (const [id, combat] of this.combats) {
      if (combat.state === 'done' && combat.startedAt < cutoff) {
        this.combats.delete(id);
      }
    }
  }

  private broadcast() {
    // Phase 1 multiplayer — we run the registry's GC pass here so empty
    // rooms / stale players are reaped at the same 5 Hz cadence as the
    // snapshot publish, then broadcast per-room (the /game path) AND the
    // legacy global bucket (the npc-sse shim).
    roomRegistry.tick();

    // Are there ANY connected SSE consumers (room OR legacy global)?
    let hasRoomListeners = false;
    for (const bucket of this.roomListeners.values()) {
      if (bucket.size > 0) { hasRoomListeners = true; break; }
    }
    const hasGlobalListeners = this.listeners.size > 0;
    if (!hasRoomListeners && !hasGlobalListeners) return;

    // COLLAB FIX: drain the broker queue EXACTLY ONCE per tick, here, then
    // share the SAME array across every per-room snapshot AND the global
    // snapshot. Previously the drain lived only in buildBroadcastSnapshot()
    // (the legacy global path), which no /game client consumes after the SSE
    // room swap, so the COLLAB tab + the agent.collaboration.turn signal
    // were invisible. Draining once and sharing is safe: the client store
    // dedupes collab entries by id, and we drain only when at least one
    // listener exists so entries are preserved for a late-connecting client.
    // The per-tick initial-connect snapshot in world.ts intentionally does
    // NOT drain (it would steal entries destined for the room broadcast).
    const collab: CollaborationLogEntry[] = getCollaborationBroker().drainLogEntries();

    // Per-room broadcast — pre-serialize ONCE per room (B6 punch list).
    // SSE consumers in the same room share the same string; we don't
    // re-stringify the same object N times.
    for (const [roomId, bucket] of this.roomListeners) {
      if (bucket.size === 0) continue;
      const snapshot = this.getRoomSnapshot(roomId);
      // getRoomSnapshot hardcodes `collaborationEvents: []`; attach the
      // shared drained array before serializing so room consumers see collab.
      snapshot.collaborationEvents = collab;
      const json = JSON.stringify(snapshot);
      for (const listener of bucket) {
        try {
          listener(json);
        } catch {
          bucket.delete(listener);
        }
      }
    }

    if (!hasGlobalListeners) return;
    // Legacy global bucket (npc-sse shim): getSnapshot() + the SAME shared
    // collab array. We deliberately do NOT call buildBroadcastSnapshot() here
    // anymore: it would drain the broker a SECOND time and the second drain
    // returns [] (queue already emptied above), so the global stream would
    // never see collab. One drain site per tick is the invariant.
    const globalSnapshot = this.getSnapshot();
    globalSnapshot.collaborationEvents = collab;
    const globalJson = JSON.stringify(globalSnapshot);
    for (const listener of this.listeners) {
      try {
        listener(globalJson);
      } catch {
        // Listener may have disconnected
        this.listeners.delete(listener);
      }
    }
  }
}

export const npcSimulation = new NpcSimulation();

export function startSimulation(arenaMode: boolean) {
  npcSimulation.start(arenaMode);
}

export function stopSimulation() {
  npcSimulation.stop();
}
