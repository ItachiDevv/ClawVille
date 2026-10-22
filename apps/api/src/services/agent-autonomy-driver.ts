/**
 * Agent Autonomy Driver (agent-metaverse P1 slice 3)
 * ──────────────────────────────────────────────────
 * The perceive → decide → act loop for ClawVille-HOSTED "house" agents — the
 * first member of the eventual autonomous fleet. It runs on its OWN ~30s
 * interval, SEPARATE from the 200ms NpcSimulation tick, so a slow LLM brain can
 * NEVER stall the shared single-threaded world sim.
 *
 * §B.1 (2026-07-08): the SAME loop now also drives USER-OWNED hosted
 * avatar-agents (Autonomous mode) via a PARALLEL `userAgents` registry —
 * separate cap (`MAX_AUTONOMOUS_USER_AGENTS`), typed capacity rejection,
 * one-enrollment-per-owner, `isHouse:false` runtime warm (hosted-user inference
 * route + normal orchestrator sweep), teardown that can never touch the house
 * fleet. Settlement was ALREADY generic on `entry.avatarId`, so a user entry
 * settles real CT + leaderboard to the OWNER's active avatar with zero changes
 * to the money path. Enrollment lifecycle lives in `agent-autonomy-activation.ts`.
 *
 * Per house agent, per drive:
 *   1. `npcSimulation.buildPerception(bodyId)` — the SAME shared perception the
 *      authed gateway serves (self pose + nearby npcs + all buildings + focus).
 *   2. DECIDE via the agent's warmed ElizaOS runtime (`ElizaRuntime.decide` →
 *      `useModel(TEXT_SMALL)`, gpt-4o-mini, provider-swappable for the fleet).
 *   3. ACT — the reply's `[ACTION:]` tags are dispatched via
 *      `npcSimulation.dispatchHatcherActions(bodyId, reply)` (the SAME strict
 *      whitelist executor Hatcher uses; move/enter_building/talk_to_npc/…).
 *
 * FIRST BEHAVIOR (a real inference-driven loop, NOT nearest):
 *   deciding → agent CHOOSES a teacher by NEED (from the building label +
 *   cryptoFocus in perception) → `enter_building` (walk) →
 *   walking (cheap arrival poll, NO llm) → arrived → `talk_to_npc` (converse) →
 *   talking (cooldown) → deciding (pick a NEW teacher).
 *
 * SAFETY / DoS discipline (designed-out, not audited-in):
 *   - Own 30s interval; NEVER touches the 200ms tick.
 *   - Per-agent in-flight guard + a hard LLM timeout: one slow/hung brain can
 *     never block the tick OR another agent's drive.
 *   - Idle-throttle: when NO humans are in the world, the LLM-bearing phases
 *     back off to a slower cadence (cost control — one agent ≈ $1–2/day).
 *   - Every Map/Set is bounded (`MAX_HOUSE_AGENTS`).
 *   - Money (slice 4, 2026-07-03): the [ACTION:] executor STILL never touches
 *     the ledger. Settlement runs through `world-teacher-chat.ts` ONLY — the
 *     arrival ('building.visited' + once-per-day 'building_visit' CT) and the
 *     REAL conversed teacher turn ('agent.chat.turn' + once-per-day
 *     'building_chat_teaching' CT + an EARNED-SKILL lesson converged onto the
 *     agent's OWN ElizaOS runtime — P3 slice 3), both proximity-gated
 *     fail-closed and idempotent per (avatar, building, reason, UTC-day).
 *   - LLM-spend bound: a per-(agentId, buildingId) 60-min talk cooldown gates
 *     the conducted teacher turn (each turn is a model call with bounded top-5
 *     retrieval from the teacher's embedded skill corpus; the once-per-day CT
 *     probe does NOT bound LLM cost by itself).
 *   - Memory is behaviorally LIVE, not inert: the ~3 most relevant earned-skill
 *     lessons plus book/building-visit knowledge (semantic RAG from the agent's
 *     OWN ElizaOS runtime, authoritative-store fallbacks when cold) are folded
 *     into the decide prompt; the teacher's latest reply feeds the next context.
 *   - Leak: logs use `sessionDigest(agentId)` — NEVER the raw agentId/sessionId.
 */

import {
  BUILDING_INTERACTION_RADIUS,
  BUILDING_OPENCLAW_THEMES,
  AUTONOMY_ENTERABLE_PLACES,
  DECISION_SCOPE,
  HATCHER_ACTION_MENU,
  HOUSE_PLAY_COVE_GAME_MENU_ITEM,
  MAP_LOCATIONS,
  type AutonomyStatusResponse,
  type AutonomyStatusThought,
  WORLD_COLLIDER_MAP_HALF,
} from '@clawville/shared';
import { createHash } from 'crypto';
import { NPC_WORLD_WALK_SPEED_WU_PER_S, npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { sessionDigest } from './session-digest';
import { readEarnedSkillLessons } from './earned-skill-memory';
import { readHostedAgentKnowledge } from './hosted-agent-knowledge';
import { conductTeacherTurn, settleBuildingArrival } from './world-teacher-chat';
import {
  clearAgentDirective,
  claimLastActedDirectiveSha,
  getAgentDirectiveState,
  getAutonomyCursor,
  setAutonomyCursor,
  formatDirectiveContext,
  summarizeAutonomyEvents,
  type AgentDirectiveState,
  type CurrentDirective,
  type DirectiveActedClaim,
} from './agent-autonomy-state';
import { queryDurableAgentEventsNewest, type AgentHistoryScope } from './agent-event-query';
import { recordCovenantAction } from './covenant-action-recorder';
import { resolveBuildingId } from './building-center';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from './house-refused-verbs';
import { directiveFastPathAction } from './autonomy-directive-fastpath';
import { armAutonomy, isAutonomyActive } from './autonomy-standby';
import {
  readAutonomousLandTargets,
  type AutonomousLandTargets,
} from './autonomous-land-targets';
import {
  readAutonomousSalvageTargets,
  type AutonomousSalvageTargets,
} from './autonomous-salvage-targets';
import {
  EMPTY_AUTONOMOUS_BUILD_TARGETS,
  readAutonomousBuildTargets,
  type AutonomousBuildTargets,
} from './autonomous-build-targets';
import {
  EMPTY_TRADING_DESK,
  formatAutonomousTradingDesk,
  readAutonomousTradingTargets,
  type AutonomousTradingDesk,
} from './autonomous-trading-targets';

/**
 * The "nothing to offer" salvage projection. Used for HOUSE agents (which the
 * salvage service refuses outright, so advertising nodes to them would be
 * teaching an action that can only fail) and whenever the read errors.
 */
const EMPTY_SALVAGE_TARGETS: AutonomousSalvageTargets = {
  nodes: [],
  materialBalance: 0,
  claimsRemainingToday: 0,
  ownerClaimsRemainingToday: 0,
};
// Bounded server-derived claimable-quest ids for the decide prompt. Without it
// the agent can form a `claim_tutorial_quest` call but cannot know which ids
// are valid (world-scope consumption mandate).
import {
  readAutonomousQuestTargets,
  type AutonomousQuestTarget,
} from './autonomous-quest-targets';
// Bounded server-derived sku ids for equip_cosmetic / buy_cosmetic (same
// consumption-mandate reason as the quest block above).
import {
  EMPTY_AUTONOMOUS_COSMETIC_TARGETS,
  readAutonomousCosmeticTargets,
  type AutonomousCosmeticTargets,
} from './autonomous-cosmetic-targets';

/** Per-agent phase in the perceive→decide→act loop. */
type DrivePhase = 'deciding' | 'walking' | 'arrived' | 'talking';

interface HouseAgentEntry {
  /** Stable public agent id (openclaw_bots.agent_id). */
  agentId: string;
  /**
   * §B.1 (2026-07-08): true for boot-seeded HOUSE fleet agents, false for
   * USER-OWNED hosted avatar-agents enrolled via `registerUserAgent`. Drives the
   * lazy runtime-warm flag verbatim (`{ isHouse: entry.isHouse }`): house stays
   * `isHouse:true` (fleet inference route + 30-min sweep exemption, byte-identical
   * to pre-§B.1), user entries warm `isHouse:false` so they take the
   * 'hosted-user' inference route and keep the normal orchestrator sweep.
   */
  isHouse: boolean;
  /** In-world body id (`ocb-<base64url(agentId)>`) — the sim/perception key. */
  bodyId: string;
  /** platform_agents.id whose warmed ElizaOS runtime backs the decision. */
  platformAgentId: string;
  /** system user id that owns the platform_agents row — for lazy runtime warm. */
  systemUserId: string;
  /**
   * Slice 4 settle target — the DEDICATED internal user that owns the house
   * agent's openclaw_bots row + avatar (NOT the shared systemUserId above).
   */
  houseUserId: string;
  /** avatars.id the once-per-day building rewards settle to. */
  avatarId: string;
  phase: DrivePhase;
  /** epoch-ms the current phase was entered (for walk/talk timeouts). */
  phaseSince: number;
  /** Building the agent is walking toward / conversing at (null when deciding). */
  targetBuildingId: string | null;
  /**
   * epoch-ms this walk LEG must reach its target by, sized from the stamped
   * route length. 0 → not driver-stamped (legacy entry / phase forced by a
   * test), in which case the driver falls back to `phaseSince +
   * WALK_BUDGET_FLOOR_MS` AND performs no free re-routing — today's exact
   * behavior (see `agent-autonomy-round2.test.ts:177-190`).
   */
  walkDeadline: number;
  /**
   * HARD cumulative ceiling for the whole episode, set ONCE at walk-start and
   * never extended by a re-route. 0 when not walking.
   */
  walkEpisodeDeadline: number;
  /** Free (no-LLM) re-routes already spent this episode (cap MAX_WALK_REPLANS). */
  walkReplans: number;
  /**
   * Remaining route length observed on the previous driver tick. null resets the
   * baseline (walk start / after a re-route) so the first tick never wedges.
   */
  lastRemainingWu: number | null;
  /** Last building chosen — favor variety, don't re-pick immediately. */
  lastBuildingId: string | null;
  /**
   * R4: count of consecutive empty/whitespace decide() replies in the deciding
   * phase. `withTimeout` collapses a timeout OR a decide() error to '' (contract
   * unchanged), so a persistent empty (e.g. OpenAI 429/quota) would spin the
   * deciding phase with no signal. Incremented on an empty deciding reply, reset to
   * 0 on a non-empty one; a WARN fires past EMPTY_DECIDE_WARN_THRESHOLD. Health
   * SIGNAL only — it does NOT change drive behavior.
   */
  consecutiveEmptyDecides: number;
  /**
   * Slice 4 memory read-back — a short snippet of the LAST teacher reply, fed
   * into the next decision prompt so the conversation actually informs the
   * agent's next choice (memory made behaviorally live, not inert).
   */
  lastLesson: string | null;
  /**
   * P3 slice 2 — one-time wake-up seed guard. On the first deciding drive after
   * (re)start we read the durable whitelisted events since the persisted cursor
   * (config.autonomyCursor) so the agent resumes from "since I last looked"
   * instead of a bare snapshot. Set true after the attempt (success OR fail) so
   * it runs exactly once per process lifetime, not every tick.
   */
  cursorSeeded: boolean;
  /**
   * P3 slice 2 — compact one-line summary of the events replayed on wake, folded
   * into the decision prompt. Null until seeded / when nothing new happened.
   */
  recentEventSummary: string | null;
  /** Public-safe, bounded driver narration used by the owner HUD. */
  recentThoughts: AutonomyStatusThought[];
  /** Last directive issuance hash observed (text itself never enters a record). */
  lastDirectiveSha: string | null;
  /** Last directive hash for which a parsed action was recorded. */
  lastActedDirectiveSha: string | null;
  /**
   * False after a fresh/re-seat registration until the first bounded directive
   * snapshot hydrates the durable acted marker. UNKNOWN must stay distinct from
   * a known-null marker so a DB timeout cannot duplicate directive events.
   */
  directiveShaHydrated: boolean;
  /** A new human directive landed and has not yet been consumed by a decide. */
  directivePending: boolean;
  /** Monotonic owner-kick revision; async work cannot consume a newer kick. */
  directiveRevision: number;
  /**
   * epoch-ms the phase-edge poll last woke this entry's TALKING edge (that drive
   * leaves the linger and decides). 0 = never. tick() reads it to keep decides
   * at least DECIDE_MIN_SPACING_MS apart (see phaseEdgePoll).
   */
  edgeDecideAt: number;
  /**
   * Teacher-talk prefetch started by phaseEdgePoll during the final approach
   * (see TALK_PREFETCH_LEAD_MS). The arrived branch uses `promise` only when
   * buildingId, the byte-identical prompt and directiveRevision all still match
   * and it is at most TALK_PREFETCH_MAX_AGE_MS old. null = none.
   */
  talkPrefetch: {
    buildingId: string;
    prompt: string;
    directiveRevision: number;
    startedAt: number;
    promise: Promise<string>;
  } | null;
}

/** A single decision generator — real LLM in prod, canned in tests. */
type DecideFn = (prompt: string) => Promise<string>;
type TargetReaderName = 'land' | 'quests' | 'salvage' | 'build' | 'trading' | 'cosmetics';
const TARGET_READ_TIMEOUT_MS = 10_000;

// Cadence + safety constants.
const TICK_MS = 30_000; // driver interval — NOT the 200ms sim tick
// Phase-edge poll (founder 2026-10-20: "faster path, same decision"). Wakes an
// agent between ticks ONLY at a phase edge; see phaseEdgePoll for the rules.
const PHASE_EDGE_POLL_MS = 5_000;
// After a poll-woken decide that leaves the entry 'deciding' (empty reply or a
// non-navigation action), the next tick may land only 5 s later. tick() skips
// that entry until this much time has passed, so decide-to-decide spacing stays
// at one tick. 25 s < TICK_MS, so a tick-driven retry (30 s apart) never skips.
const DECIDE_MIN_SPACING_MS = TICK_MS - PHASE_EDGE_POLL_MS;
// Teacher-talk prefetch (founder 2026-10-20: "faster path, same decision").
// phaseEdgePoll starts the arrival talk call once the walk ETA to a teaching
// building is at most this long, so the 1-7 s talk call overlaps the last
// seconds of walking. See maybeStartTalkPrefetch for why it is the same call.
const TALK_PREFETCH_LEAD_MS = 10_000;
// A prefetch older than this at arrival is not used (a fresh talk call runs).
const TALK_PREFETCH_MAX_AGE_MS = 60_000;
// Upper bound on how long the teacher talk waits for a running arrival settle.
// The settle is a DB transaction with FOR UPDATE and no statement timeout; a
// hung pool must not hold the agent in 'arrived' forever. Past this age the
// talk goes ahead (the settle's own finally still clears its guard later).
const ARRIVAL_SETTLE_WAIT_MS = 15_000;
// §B.1 durable autonomy — run the server-side re-enrollment reconcile every N
// driver ticks (10 × 30s = ~5 min), AND on tick 1 (~30s after start/boot) so a
// deploy re-enrolls browser-closed persisting agents promptly with no client.
// The periodic cadence also heals a crash mid-teardown. The reconcile carries its
// own overlap guard, so a slow pass never stacks.
const RECONCILE_EVERY_N_TICKS = 10;
const LLM_TIMEOUT_MS = 15_000; // hard ceiling on one decision
// Walk give-up budget, scaled to the ACTUAL route length (2026-07-26). Was a flat
// WALK_TIMEOUT_MS = 120_000 for every trip — generous for a 2,000 wu hop, far too
// tight for a cross-map one. FLOOR keeps today's exact value, so every route
// <= 11,000 wu is byte-identical to before. Arithmetic: §4 of the spec.
export const WALK_BUDGET_FLOOR_MS = 120_000;
export const WALK_BUDGET_CEIL_MS = 180_000;
export const WALK_BUDGET_SAFETY = 2;
export const WALK_BUDGET_SLACK_MS = 20_000;
/** Free (no-LLM) re-routes allowed per walk episode. */
export const MAX_WALK_REPLANS = 2;
/**
 * HARD cumulative ceiling on ONE walk episode (first walk-start → real
 * re-decide), never reset by a re-route. Without it, N replans each granting a
 * fresh route-sized deadline compound into ~16.5 min of no re-decide.
 */
export const MAX_WALK_EPISODE_MS = 300_000;
/**
 * Minimum remaining-length decrease that counts as progress across one 30 s
 * driver tick. A healthy body covers ~6,600 wu in 30 s; 220 wu is 1 second of
 * walking (3.3% of nominal), so anything below it is a genuine wedge.
 */
export const WALK_PROGRESS_EPSILON_WU = 220;

/** Pure, deterministic. Exported for direct unit test. */
export function walkBudgetMsForRouteLength(lengthWu: number): number {
  const safeLength = Number.isFinite(lengthWu) && lengthWu > 0 ? lengthWu : 0;
  const raw = WALK_BUDGET_SLACK_MS
    + (safeLength / NPC_WORLD_WALK_SPEED_WU_PER_S) * 1000 * WALK_BUDGET_SAFETY;
  return Math.min(WALK_BUDGET_CEIL_MS, Math.max(WALK_BUDGET_FLOOR_MS, Math.round(raw)));
}
const TALK_COOLDOWN_MS = 60_000; // linger after a conversation before re-deciding
const MAX_HOUSE_AGENTS = 64; // bound the registry
// §B.1 — SEPARATE bound for user-owned autonomous agents (never shares the house
// cap: a wave of user activations can never crowd out the fleet, and the fleet
// can never consume user capacity). Env-overridable; default 12; floor 1. Over
// cap is a LOUD, TYPED rejection (`{ok:false, reason:'capacity'}` → HTTP 429
// `autonomy_capacity`), never a silent drop — a user must be able to see WHY
// their agent didn't go autonomous.
const MAX_AUTONOMOUS_USER_AGENTS = (() => {
  const raw = Number.parseInt(process.env.MAX_AUTONOMOUS_USER_AGENTS ?? '', 10);
  if (!Number.isFinite(raw)) return 12;
  return Math.max(1, raw);
})();
const DECIDE_MAX_TOKENS = 200;
// Maximum time one immediate cycle waits for a cold runtime. On timeout the
// drive skips, but the non-cancellable warm remains tracked until it settles so
// no later tick/kick can launch overlapping work for the same agent.
const WARM_TIMEOUT_MS = 90_000;
// Round-2 review fix (warm-guard wedge): if the underlying ensureAgentRuntime
// promise NEVER settles (hung DB call / stuck plugin init), the `warming` guard
// would be held forever and every future tick/kick for that agent would skip —
// a silent permanent stall. WARM_TIMEOUT_MS only bounds the WAIT, not the
// guard. Past this age the guard is force-evicted with a loud warn so the next
// drive can re-warm. Safe because `clearWarm` is token-guarded (it deletes only
// its OWN captured token), so a late settle of the evicted warm can never erase
// a newer warm's guard. Far above any legitimate warm (90s bound + boot crush).
const WARM_GUARD_EVICT_MS = 10 * 60 * 1000;
// R4: consecutive empty decide() replies past this threshold WARN — a persistent
// empty (OpenAI 429 / quota exhausted / bad key) otherwise spins the deciding phase
// silently, since withTimeout maps a timeout/error to '' by contract.
const EMPTY_DECIDE_WARN_THRESHOLD = 3;
// Missing-body watchdog (2026-10-20 staging wedge): an unregistered session
// deletes the agent's `ocb-` body, and the driver used to return silently on a
// null perception every tick, forever (a house body is only re-registered by
// `ensureHouseAgent` at boot). Fails-safe must also be fails-visible: a missing
// body WARNs at most once per agent per BODY_MISSING_WARN_INTERVAL_MS. A HOUSE
// agent whose body stays missing for HOUSE_BODY_HEAL_AFTER_MISSES consecutive
// drives re-runs the existing boot activation path, with an exponential
// per-agent backoff (floor 1 min, cap 15 min) so a persistent failure can never
// hot-loop DB writes + runtime restarts. USER agents are never re-registered
// here: their session belongs to the owner (activation / reconcile own it).
const BODY_MISSING_WARN_INTERVAL_MS = 5 * 60 * 1000;
const HOUSE_BODY_HEAL_AFTER_MISSES = 2;
const HOUSE_BODY_HEAL_BACKOFF_MS = 60_000;
const HOUSE_BODY_HEAL_BACKOFF_MAX_MS = 15 * 60 * 1000;
// Slice 4 LLM-spend bound: a conducted teacher turn is a model call with bounded
// top-5 retrieval from the teacher's embedded skill corpus, and the once-per-day
// CT probe does NOT bound LLM cost by itself — so each (agentId, buildingId) pair
// may conduct at most one turn per hour. In-memory (resets on restart — acceptable;
// the daily CT probe is the money bound), bounded by TALK_COOLDOWN_MAP_MAX with
// expired-first eviction.
const TALK_BUILDING_COOLDOWN_MS = 60 * 60 * 1000;
// §B.1: sized for BOTH registries — (house + user caps) × ~12 buildings of
// headroom, floored at the pre-§B.1 1024 so a small user cap can never SHRINK
// the bound below what the house fleet was already provisioned for.
const TALK_COOLDOWN_MAP_MAX = Math.max(
  1024,
  (MAX_HOUSE_AGENTS + MAX_AUTONOMOUS_USER_AGENTS) * 12,
);
// Prior teacher questions per (agent, building) kept for the talk prompt, and
// the per-question length cap (founder 2026-10-22: no repeated questions).
const PRIOR_TALK_QUESTIONS_MAX = 4;
const PRIOR_TALK_QUESTION_MAX_CHARS = 160;
// Memory read-back bound. P3 slice 3: readRecentLessons now converges onto the
// agent's OWN ElizaOS runtime (semantic RAG — embed a query + vector search),
// falling back to the keyword store only when the runtime isn't warm. The RAG
// path is heavier than the old keyword read (an embedding round-trip), so give it
// a slightly larger ceiling than slice-2's 1.5s DB reads — still far under the
// 15s LLM timeout + 30s tick, and fail-soft to [] on timeout (decide without the
// lessons). This runs once per DECIDING phase (per learn-cycle), NOT every tick.
const LESSON_RAG_TIMEOUT_MS = 4_000;
const LESSON_SNIPPET_MAX = 200;
// Default RAG query when the human has set no directive to bias the retrieval —
// surfaces the agent's most central recent lessons as decision seasoning.
const DEFAULT_LESSON_QUERY =
  'recent lessons I learned from ClawVille teachers about agent development skills';
// P3 slice 2: bound the directive + wake-up-seed reads (same fail-soft rationale
// as the lesson fetch — a slow/absent DB must never stall a decide tick).
const DIRECTIVE_FETCH_TIMEOUT_MS = 1_500;
/** Bound on the directive fast-path used-issuance map (oldest key evicted first). */
export const FAST_PATH_USED_MAX = 1024;
export const DEFAULT_DIRECTIVE_TTL_MS = 6 * 60 * 60 * 1_000;
export const MIN_DIRECTIVE_TTL_MS = 15 * 60 * 1_000;

/** Strict env parsing: malformed values use the default; valid small values clamp. */
export function resolveDirectiveTtlMs(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DIRECTIVE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_DIRECTIVE_TTL_MS;
  return Math.max(MIN_DIRECTIVE_TTL_MS, parsed);
}

const DIRECTIVE_TTL_MS = resolveDirectiveTtlMs(process.env.AGENT_DIRECTIVE_TTL_MS);

/** Invalid timestamps fail stale; a directive expires only once older than TTL. */
export function isDirectiveExpired(
  directive: CurrentDirective,
  nowMs: number = Date.now(),
  ttlMs: number = DIRECTIVE_TTL_MS,
): boolean {
  const setAtMs = Date.parse(directive.setAt);
  if (!Number.isFinite(setAtMs)) return true;
  return nowMs - setAtMs > ttlMs;
}

/** Hash the issuance, not text alone, so the same instruction can be reissued. */
export function directiveInstanceSha(directive: CurrentDirective): string {
  return createHash('sha256')
    .update(directive.setAt, 'utf8')
    .update('\0', 'utf8')
    .update(directive.text, 'utf8')
    .digest('hex');
}

const SEED_FETCH_TIMEOUT_MS = 1_500;
// Cap the durable events replayed once on wake to seed "since I last acted"
// context — this is prompt seasoning, not a transcript.
const SEED_EVENT_LIMIT = 20;
const RECENT_THOUGHTS_MAX = 20;

/** Matches the executor's HATCHER_ACTION_REGEX (npc-simulation.ts) — used to
 * pull the `message` param out of the model's talk_to_npc tag so the SAME text
 * the in-world bubble shows is what the teacher turn conducts. */
const TALK_ACTION_RE = /\[ACTION:\s*talk_to_npc\(([^)]*)\)\]/;
const DRIVER_ACTION_RE = /\[ACTION:\s*(\w+)\(([^)]*)\)\]/;

export interface ParsedDriverAction {
  verb: string;
  params: Record<string, string>;
}

export function parseDriverAction(reply: string): ParsedDriverAction | null {
  const match = DRIVER_ACTION_RE.exec(reply);
  if (!match || !HATCHER_ACTION_MENU.some((action) => action.verb === match[1])) return null;
  const params: Record<string, string> = {};
  for (const part of match[2].split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) params[key] = part.slice(eq + 1).trim();
  }
  return { verb: match[1], params };
}

function destinationLabel(destination: string | null): string | null {
  if (!destination) return null;
  if (destination === 'cove') return 'the Cove';
  const place = AUTONOMY_ENTERABLE_PLACES.find((candidate) => candidate.destinationId === destination);
  if (place) return place.label;
  const canonical = resolveBuildingId(destination) ?? destination;
  return BUILDING_OPENCLAW_THEMES[canonical]?.label
    ?? MAP_LOCATIONS.find((location) => location.id === canonical)?.name
    ?? canonical;
}

function positiveIntegerParam(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyParam(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function decisionThought(action: ParsedDriverAction): string {
  switch (action.verb) {
    case 'enter_cove':
    case 'enter_poker_room':
      return 'Heading to the Cove';
    case 'enter_kelp_forest':
      return 'Heading to the Kelp Forest';
    case 'enter_trading_floor':
      return 'Heading to the Trading Floor';
    case 'enter_building':
      return `Heading to ${destinationLabel(action.params.buildingId) ?? 'a building'}`;
    case 'move': {
      const x = Number(action.params.x);
      const y = Number(action.params.y);
      return Number.isFinite(x) && Number.isFinite(y)
        ? `Moving to (${Math.round(x)}, ${Math.round(y)})`
        : 'Moving through town';
    }
    case 'talk_to_npc': {
      const target = action.params.target
        ?? action.params.npcId
        ?? action.params.buildingId
        ?? 'someone nearby';
      return `Talking to ${destinationLabel(target) ?? target}`;
    }
    case 'emote':
      return `Emoting: ${action.params.name ?? 'reacting'}`;
    case 'play_cove_game': {
      const game = action.params.game;
      const wager = positiveIntegerParam(action.params.wager);
      const bet = action.params.bet;
      if (game === 'baccarat') {
        return wager !== null && (bet === 'player' || bet === 'banker' || bet === 'tie')
          ? `Playing baccarat at the Cove — ${wager} vCLAW on ${bet}`
          : 'Playing at the Cove';
      }
      return (game === 'slots' || game === 'blackjack') && wager !== null
        ? `Playing ${game} at the Cove — wagering ${wager} vCLAW`
        : 'Playing at the Cove';
    }
    case 'place_kit_piece':
      return `Placing ${action.params.pieceKey ?? 'a piece'} in the home yard (materials)`;
    case 'claim_tutorial_quest':
      return 'Claiming a quest reward';
    case 'salvage_node':
      return 'Salvaging materials from a seabed node';
    case 'view_wallet':
      return 'Checking my wallet';
    case 'equip_cosmetic':
      return 'Putting on a cosmetic';
    case 'buy_cosmetic':
      return 'Buying a cosmetic';
    case 'claim_parcel': {
      const parcelCode = nonEmptyParam(action.params.parcelCode);
      const parcel = parcelCode ? ` ${parcelCode}` : '';
      if (action.params.door === 'hold') {
        return `Claiming parcel${parcel} (hold — no vCLAW spent)`;
      }
      if (action.params.door === 'rent') {
        return `Renting parcel${parcel} — paying week 1 now`;
      }
      return `Claiming parcel${parcel}`.trimEnd();
    }
    case 'prepay_rent': {
      const parcelCode = nonEmptyParam(action.params.parcelCode);
      const weeks = positiveIntegerParam(action.params.weeks);
      return weeks !== null
        ? `Prepaying ${weeks} week(s) of rent on ${parcelCode ?? 'a parcel'}`
        : `Prepaying rent on ${parcelCode ?? 'a parcel'}`;
    }
    case 'release_parcel': {
      const parcelCode = nonEmptyParam(action.params.parcelCode);
      return `Releasing parcel${parcelCode ? ` ${parcelCode}` : ''}`.trimEnd();
    }
    default:
      return 'Choosing the next action';
  }
}

/** Extract the talk_to_npc message param from a reply, or null if none. Mirrors
 * the executor's parsing: `message` is free text and documented LAST, so it is
 * captured from its `message=` marker to the END of the param string — never
 * comma-split (a comma-split truncates "Hello, teacher" at the comma, and loses
 * the message entirely when the model separates params with SPACES instead of
 * commas — live drop observed on staging 2026-07-15). */
export function extractTalkMessage(reply: string): string | null {
  const m = TALK_ACTION_RE.exec(reply);
  if (!m) return null;
  const msg = /(?:^|[,\s])message\s*=\s*(.+)$/.exec(m[1]);
  if (!msg) return null;
  const v = msg[1].trim();
  return v.length > 0 ? v : null;
}

class AgentAutonomyDriver {
  private houseAgents = new Map<string, HouseAgentEntry>(); // agentId -> entry
  // §B.1 — PARALLEL registry for user-owned hosted avatar-agents. Kept SEPARATE
  // from `houseAgents` on purpose: independent cap, independent teardown
  // (`unregisterUserAgent` can NEVER remove a house agent), and the house path
  // stays byte-identical. Same entry shape — `driveOnce`/settlement are already
  // generic on `entry.avatarId`, so a user entry settles to the OWNER's avatar.
  private userAgents = new Map<string, HouseAgentEntry>(); // agentId -> entry
  // §B.1 — ownerUserId -> enrolled agentId. O(1) `isOwnerEnrolled` for the
  // heartbeat hot path + the one-enrollment-per-owner invariant (an owner has
  // exactly ONE active avatar, so at most one autonomous agent).
  private enrolledOwners = new Map<string, string>();
  private inFlight = new Set<string>(); // agentIds mid-decision (overlap guard)
  // A timed-out read still owns this guard until its underlying promise settles.
  // Keep it across unregister/re-seat so retries cannot accumulate stuck queries.
  private pendingTargetReads = new Map<string, Set<TargetReaderName>>();
  private warming = new Map<string, number>(); // agentId -> warmingSince ms (overlap guard + R2 watchdog)
  // agentId -> token of the arrival settle still running for it. The settle is
  // fire-and-forget (outside inFlight), so the ARRIVED branch (talk + teacher
  // turn) waits for it, up to ARRIVAL_SETTLE_WAIT_MS (isArrivalSettlePending).
  // Token-guarded like `warming`: an older settle that finishes late never
  // clears a newer one's entry. `warned` makes the expiry WARN fire once.
  private arrivalSettling = new Map<string, { startedAt: number; warned: boolean }>();
  // platformAgentId -> directive issuance sha that already used the directive
  // fast path in this process. Driver-level and keyed by platformAgentId (stable
  // across re-enrollment), and NEVER cleared on unregister, so autonomy off/on
  // cannot replay the fast path for the same issuance. Bounded by
  // FAST_PATH_USED_MAX with oldest-first eviction (see markFastPathUsed).
  private fastPathUsedSha = new Map<string, string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private phaseEdgeInterval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private lastTickAt: number | null = null;
  /** Edge-trigger the standby skip log instead of emitting it every 30s. */
  private wasActive = true;
  /** Lazy loader kept as an instance seam for deterministic standby-race tests. */
  private loadReconcileModule = () => import('./agent-autonomy-reconcile');
  // Slice 4: `${agentId}:${buildingId}` -> epoch-ms until which conducted
  // teacher turns at that building are suppressed (LLM-spend bound).
  private talkCooldownUntil = new Map<string, number>();
  // Founder 2026-10-22: `${agentId}:${buildingId}` -> the agent's own last
  // PRIOR_TALK_QUESTIONS_MAX questions to that teacher (newest last), fed into
  // buildTalkPrompt so it stops asking the same question on every visit.
  // Driver-level like talkCooldownUntil, so it survives autonomy off/on of the
  // same agent and is never cleaned per agent (same as talkCooldownUntil).
  // Bounded by TALK_COOLDOWN_MAP_MAX with oldest-first eviction (see
  // recordPriorQuestion). Written ONLY at the talk mutation point.
  private priorTalkQuestions = new Map<string, string[]>();
  // Missing-body watchdog state, keyed by agentId. Kept OFF the entry on purpose:
  // the house self-heal re-registers (replaces) the entry, and the backoff +
  // warn rate-limit must survive that. Cleared on unregister (bounded by the two
  // registry caps). `misses`/`healAttempts` reset when the body is seen again;
  // the warn timestamp does not, so a flapping body still warns at most once
  // per interval.
  private bodyMissing = new Map<
    string,
    { misses: number; healAttempts: number; lastHealAt: number; healDisabled: boolean }
  >();
  private bodyMissingWarnedAt = new Map<string, number>();
  /**
   * House self-heal seam: the EXISTING boot activation path (re-mints the house
   * session + body and re-registers the driver entry). LAZY-imported because
   * house-agent-seeder statically imports this driver (a static edge would form
   * a cycle; same pattern as `loadReconcileModule`). Swappable so tests never
   * reach the DB.
   */
  houseReactivate: () => Promise<{ agentId: string; bodyId: string } | null> = async () => {
    const { ensureHouseAgent } = await import('./house-agent-seeder');
    return ensureHouseAgent();
  };

  // Slice 4 seams — instance properties (not bare imports) so the unit tests can
  // swap in mocks (settle-only-on-reply + cooldown are tested without a DB/LLM).
  // Production values are the real world-teacher-chat functions.
  teacherTurn: typeof conductTeacherTurn = conductTeacherTurn;
  arrivalSettle: typeof settleBuildingArrival = settleBuildingArrival;
  covenantRecord: typeof recordCovenantAction = recordCovenantAction;
  // D4 seams: one coherent config snapshot, compare-and-clear expiry cleanup,
  // and persist-before-event acted dedupe. Kept swappable for DB-free tests.
  directiveStateRead: typeof getAgentDirectiveState = getAgentDirectiveState;
  directiveClear: typeof clearAgentDirective = clearAgentDirective;
  directiveActedShaClaim: typeof claimLastActedDirectiveSha = claimLastActedDirectiveSha;

  /**
   * Register a boot-seeded house agent for autonomous driving. Bounded: past
   * MAX_HOUSE_AGENTS the registration is dropped (loudly) rather than growing
   * the map unbounded. Idempotent per agentId (re-register replaces).
   */
  registerHouseAgent(entry: {
    agentId: string;
    bodyId: string;
    platformAgentId: string;
    systemUserId: string;
    /** Slice 4: dedicated internal user that owns the settle avatar. */
    houseUserId: string;
    /** Slice 4: avatars.id the building rewards settle to. */
    avatarId: string;
  }): boolean {
    if (
      !this.houseAgents.has(entry.agentId) &&
      this.houseAgents.size >= MAX_HOUSE_AGENTS
    ) {
      console.warn(
        `[AutonomyDriver] house-agent registry full (${MAX_HOUSE_AGENTS}) — dropping ${sessionDigest(entry.agentId)}`,
      );
      return false;
    }
    this.houseAgents.set(entry.agentId, {
      agentId: entry.agentId,
      isHouse: true,
      bodyId: entry.bodyId,
      platformAgentId: entry.platformAgentId,
      systemUserId: entry.systemUserId,
      houseUserId: entry.houseUserId,
      avatarId: entry.avatarId,
      phase: 'deciding',
      phaseSince: Date.now(),
      targetBuildingId: null,
      walkDeadline: 0,
      walkEpisodeDeadline: 0,
      walkReplans: 0,
      lastRemainingWu: null,
      lastBuildingId: null,
      consecutiveEmptyDecides: 0,
      lastLesson: null,
      cursorSeeded: false,
      recentEventSummary: null,
      recentThoughts: [],
      lastDirectiveSha: null,
      lastActedDirectiveSha: null,
      directiveShaHydrated: false,
      directivePending: false,
      directiveRevision: 0,
      edgeDecideAt: 0,
      talkPrefetch: null,
    });
    console.log(
      `[AutonomyDriver] registered house agent ${sessionDigest(entry.agentId)} (${this.houseAgents.size} total)`,
    );
    return true;
  }

  unregisterHouseAgent(agentId: string): void {
    // §B.1 registry isolation: a caller passing a user agentId here must not
    // remove that user entry. Async overlap guards are deliberately preserved
    // below until their owning non-cancellable work settles.
    const removed = this.houseAgents.get(agentId);
    if (!removed) return;
    this.houseAgents.delete(agentId);
    // Drop any talk prefetch; its promise already has a no-op catch.
    removed.talkPrefetch = null;
    this.bodyMissing.delete(agentId);
    this.bodyMissingWarnedAt.delete(agentId);
    // Ordering guard only (not an overlap guard): safe to drop; a late finally
    // checks its token identity and never clears a newer settle.
    this.arrivalSettling.delete(agentId);
    // Do NOT clear inFlight/warming here: their underlying promises are not
    // cancellable. A same-id re-register must remain blocked until the owning
    // promise/token cleanup releases its guard, otherwise old + new drives can
    // overlap and the old finally can erase the new guard.
  }

  /** Server-side enumeration of the active house agent ids (never on the wire). */
  getHouseAgentIds(): string[] {
    return [...this.houseAgents.keys()];
  }

  hasHouseAgent(agentId: string): boolean {
    return this.houseAgents.has(agentId);
  }

  // ── §B.1 user-owned autonomous agents (parallel registry) ──────────────────

  /**
   * Capacity pre-check for the activation path — TRUE when `agentId` is already
   * enrolled (idempotent re-activation never trips the cap) OR a slot is free.
   * The activation service calls this BEFORE minting the §B.2 session/body so a
   * full registry never produces an orphan body.
   */
  canEnrollUser(agentId: string): boolean {
    return this.userAgents.has(agentId) || this.userAgents.size < MAX_AUTONOMOUS_USER_AGENTS;
  }

  /** The user-agent cap (env `MAX_AUTONOMOUS_USER_AGENTS`, default 12, floor 1). */
  getUserAgentCapacity(): number {
    return MAX_AUTONOMOUS_USER_AGENTS;
  }

  /**
   * Enroll a USER-OWNED hosted avatar-agent for autonomous driving.
   *
   *  - IDEMPOTENT by agentId: a re-activation of an already-enrolled agent whose
   *    body/avatar are unchanged KEEPS the live entry (phase machine untouched —
   *    a client keepalive must not reset a mid-walk agent back to 'deciding')
   *    and reports `reused:true` without consuming capacity. A changed bodyId
   *    (§B.2 re-mint spawned a fresh body) or avatarId re-seats a fresh entry.
   *  - ONE PER OWNER: if this owner already has a DIFFERENT agent enrolled
   *    (avatar re-bound to a new platform agent), the stale one is unregistered
   *    first so an owner can never drive two autonomous bodies.
   *  - CAP: over `MAX_AUTONOMOUS_USER_AGENTS` → LOUD typed rejection
   *    (`{ok:false, reason:'capacity'}`), which the endpoint maps to HTTP 429
   *    `code:'autonomy_capacity'`. Never a silent drop (D1/D2).
   *  - House isolation: never touches `houseAgents`; a (theoretically impossible)
   *    agentId collision with a house agent is refused loudly rather than letting
   *    a user enrollment shadow a fleet entry.
   */
  registerUserAgent(entry: {
    agentId: string;
    bodyId: string;
    platformAgentId: string;
    /** The OWNER's userId (runtime warm runs as the owner, isHouse:false). */
    systemUserId: string;
    /** Same owner userId — kept for entry-shape parity with the house path. */
    houseUserId: string;
    /** The OWNER's ACTIVE avatars.id — the settle target for CT + leaderboard. */
    avatarId: string;
  }): { ok: true; reused: boolean } | { ok: false; reason: 'capacity' } {
    if (this.houseAgents.has(entry.agentId)) {
      console.error(
        `[AutonomyDriver] refusing user enrollment for ${sessionDigest(entry.agentId)} — id collides with a HOUSE agent`,
      );
      return { ok: false, reason: 'capacity' };
    }

    const existing = this.userAgents.get(entry.agentId);

    // One-per-owner: unregister a stale DIFFERENT agent this owner had enrolled.
    const priorAgentId = this.enrolledOwners.get(entry.houseUserId);
    if (priorAgentId && priorAgentId !== entry.agentId) {
      console.log(
        `[AutonomyDriver] owner re-enrolled with a new agent — dropping stale ${sessionDigest(priorAgentId)}`,
      );
      this.unregisterUserAgent(priorAgentId);
    }

    if (existing) {
      if (existing.bodyId === entry.bodyId && existing.avatarId === entry.avatarId) {
        // Keepalive fast-path: live entry, phase machine untouched.
        this.enrolledOwners.set(entry.houseUserId, entry.agentId);
        return { ok: true, reused: true };
      }
      // Body/avatar rotated (re-mint / avatar switch) → re-seat a fresh entry
      // below. Still `reused:true` (the ENROLLMENT persisted; no cap consumption).
    } else if (this.userAgents.size >= MAX_AUTONOMOUS_USER_AGENTS) {
      console.warn(
        `[AutonomyDriver] user-agent registry full (${MAX_AUTONOMOUS_USER_AGENTS}) — rejecting ${sessionDigest(entry.agentId)} (typed capacity rejection, surfaced as 429 autonomy_capacity)`,
      );
      return { ok: false, reason: 'capacity' };
    }

    this.userAgents.set(entry.agentId, {
      agentId: entry.agentId,
      isHouse: false,
      bodyId: entry.bodyId,
      platformAgentId: entry.platformAgentId,
      systemUserId: entry.systemUserId,
      houseUserId: entry.houseUserId,
      avatarId: entry.avatarId,
      phase: 'deciding',
      phaseSince: Date.now(),
      targetBuildingId: null,
      walkDeadline: 0,
      walkEpisodeDeadline: 0,
      walkReplans: 0,
      lastRemainingWu: null,
      lastBuildingId: null,
      consecutiveEmptyDecides: 0,
      lastLesson: null,
      cursorSeeded: false,
      recentEventSummary: null,
      recentThoughts: [],
      lastDirectiveSha: null,
      lastActedDirectiveSha: null,
      // Registration remains synchronous. The first deciding tick hydrates this
      // marker before any event comparison, preserving sync callers while making
      // deploy/body/avatar re-seats durable. Mode flips intentionally do NOT
      // clear currentDirective: a fresh instruction survives a quick handback.
      directiveShaHydrated: false,
      directivePending: false,
      directiveRevision: 0,
      edgeDecideAt: 0,
      talkPrefetch: null,
    });
    this.enrolledOwners.set(entry.houseUserId, entry.agentId);
    console.log(
      `[AutonomyDriver] registered user agent ${sessionDigest(entry.agentId)} (${this.userAgents.size}/${MAX_AUTONOMOUS_USER_AGENTS} user, ${this.houseAgents.size} house)`,
    );
    return { ok: true, reused: !!existing };
  }

  /**
   * Remove a USER enrollment (Autonomous → Controlled handback, or a stale
   * one-per-owner replacement). Cleans the owner index; any active async work
   * retains its overlap guards until its owning promise settles. GUARANTEED
   * no-op for house agents — the registries are disjoint and this only acts when
   * the id was present in `userAgents`.
   */
  unregisterUserAgent(agentId: string): void {
    const removed = this.userAgents.get(agentId);
    if (!removed) return;
    this.userAgents.delete(agentId);
    removed.talkPrefetch = null; // see unregisterHouseAgent
    this.bodyMissing.delete(agentId);
    this.bodyMissingWarnedAt.delete(agentId);
    this.arrivalSettling.delete(agentId); // ordering guard only; see unregisterHouseAgent
    // The owning async drive/warm releases these guards. Clearing them during a
    // quick Controlled→Autonomous re-register would permit same-id overlap.
    for (const [ownerUserId, enrolledAgentId] of this.enrolledOwners) {
      if (enrolledAgentId === agentId) this.enrolledOwners.delete(ownerUserId);
    }
  }

  /** A shared Nori turn must affect the next choice even when RAG ranks it lower. */
  rememberSystemChatReply(agentId: string, avatarId: string, reply: string): void {
    const entry = this.userAgents.get(agentId);
    if (!entry || entry.avatarId !== avatarId) return;
    entry.lastLesson = `Nori: ${reply.replace(/\s+/g, ' ').slice(0, LESSON_SNIPPET_MAX)}`;
  }

  /**
   * A server-written action result (view_wallet balances, a buy_cosmetic or
   * equip_cosmetic outcome) must reach the next choice. Same slot and fence as
   * rememberSystemChatReply: user entries only, exact avatar match. The text is
   * server-built, and tags are stripped anyway, so it can never act.
   */
  rememberActionResult(agentId: string, avatarId: string, text: string): void {
    const entry = this.userAgents.get(agentId);
    if (!entry || entry.avatarId !== avatarId) return;
    entry.lastLesson = text.replace(/\[ACTION:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, LESSON_SNIPPET_MAX) || null;
  }

  /** O(1): does this owner currently have a driver-enrolled autonomous agent?
   *  Consulted on the heartbeat hot path (bridge double-drive exclusion, C1). */
  isOwnerEnrolled(userId: string): boolean {
    return this.enrolledOwners.has(userId);
  }

  /** The agentId enrolled for this owner, or null. Server-side only. */
  getEnrolledAgentForOwner(userId: string): string | null {
    return this.enrolledOwners.get(userId) ?? null;
  }

  /** Public-safe owner status for the Autonomous HUD. */
  getOwnerStatus(ownerUserId: string): AutonomyStatusResponse {
    const agentId = this.enrolledOwners.get(ownerUserId);
    const entry = agentId ? this.userAgents.get(agentId) : null;
    if (!entry) return { enrolled: false };
    return {
      enrolled: true,
      phase: entry.phase,
      targetBuildingId: entry.targetBuildingId,
      targetLabel: destinationLabel(entry.targetBuildingId),
      bodyId: entry.bodyId,
      phaseSince: entry.phaseSince,
      thoughts: entry.recentThoughts.map((thought) => ({ ...thought })),
      wallet: null,
    };
  }

  private pushThought(
    entry: HouseAgentEntry,
    type: AutonomyStatusThought['type'],
    text: string,
    at: number = Date.now(),
  ): void {
    entry.recentThoughts.push({ at, type, text });
    if (entry.recentThoughts.length > RECENT_THOUGHTS_MAX) {
      entry.recentThoughts.splice(0, entry.recentThoughts.length - RECENT_THOUGHTS_MAX);
    }
  }

  private async recordDriverAction(
    entry: HouseAgentEntry,
    action: 'agent.visit' | 'agent.directive.received' | 'agent.directive.acted',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.covenantRecord({
      action,
      subjectType: 'avatar',
      subjectId: entry.avatarId,
      actorKind: 'agent',
      payload,
    }).catch((err: unknown) => {
      console.warn(
        `[AutonomyDriver] covenant ${action} record failed for ${sessionDigest(entry.agentId)}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  /** Current user-agent enrollment count (capacity introspection). */
  userAgentCount(): number {
    return this.userAgents.size;
  }

  /** Server-side enumeration of enrolled user agent ids (never on the wire). */
  getUserAgentIds(): string[] {
    return [...this.userAgents.keys()];
  }

  /**
   * Immediately run one perceive -> decide -> dispatch cycle for an enrolled
   * agent. The atomic per-agent guard spans runtime warming AND driving, so an
   * enrollment/directive kick can never overlap the steady-state tick. A busy
   * agent is skipped rather than queued.
   */
  async driveAgentNow(agentId: string, allowDirectiveFollowup = true): Promise<boolean> {
    const entry = this.houseAgents.get(agentId) ?? this.userAgents.get(agentId);
    if (!entry || this.inFlight.has(agentId)) return false;
    // Watchdog: a warm whose promise never settles must not wedge this agent
    // forever — evict a stale guard loudly (see WARM_GUARD_EVICT_MS).
    const warmingSince = this.warming.get(agentId);
    if (warmingSince !== undefined) {
      if (Date.now() - warmingSince <= WARM_GUARD_EVICT_MS) return false;
      console.warn(
        `[AutonomyDriver] evicting stale warm guard for ${sessionDigest(agentId)} — ` +
          `runtime warm never settled after ${Date.now() - warmingSince}ms`,
      );
      this.warming.delete(agentId);
    }

    this.inFlight.add(agentId);
    try {
      // M3 (2026-07-26): the walking phase NEVER calls decide(), so it must not
      // be gated on a warm cognition runtime. Before this, a persistent runtime
      // outage stranded a body in phase 'walking' forever — arrival, wedge
      // recovery, and the re-decide fallback all live there. A pending directive
      // is excluded: that must take the full cycle so the directive is acted on.
      if (entry.phase === 'walking' && !entry.directivePending) {
        console.log(
          `[AutonomyDriver][debug] drive t=${this.tickCount} ${sessionDigest(entry.agentId)} phase=walking runtime=not-required`,
        );
        const perception = npcSimulation.buildPerception(entry.bodyId);
        if (!perception) {
          entry.phase = 'deciding';
          entry.targetBuildingId = null;
          entry.talkPrefetch = null;
          await this.handleMissingBody(entry, Date.now());
        } else {
          this.bodyMissing.delete(entry.agentId);
          await this.stepWalkingPhase(entry, perception, Date.now());
        }
      } else {
        let runtime = agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
        if (!runtime) runtime = await this.warmRuntimeBounded(entry);
        if (!runtime) return false;
        console.log(
          `[AutonomyDriver][debug] drive t=${this.tickCount} ${sessionDigest(entry.agentId)} phase=${entry.phase} runtime=yes`,
        );
        await this.driveOnce(entry.agentId, this.runtimeDecideFn(runtime));
      }
    } finally {
      this.inFlight.delete(agentId);
    }

    // P5: a directive that arrived during this cycle (after driveOnce passed the
    // preemption gate) would otherwise wait for the next 30s tick. The kick's
    // overlapping drive returns false, then this successful cycle runs ONE
    // follow-up to consume the surviving flag. A directive that lands before the
    // gate is consumed by this cycle instead, so no follow-up is needed.
    const currentEntry = this.houseAgents.get(agentId) ?? this.userAgents.get(agentId);
    if (allowDirectiveFollowup && currentEntry?.directivePending) {
      // The follow-up cannot recursively enqueue another follow-up. If the body
      // is absent and driveOnce cannot reach the consumption point, the flag
      // remains for the next steady-state tick instead of hot-looping here.
      void this.driveAgentNow(agentId, false).catch(() => {});
    }
    return true;
  }

  /**
   * Human-triggered enrollment/directive kick. Unlike the generic drive seam,
   * this explicitly arms a bounded staging window before starting the cycle.
   */
  kickAgentNow(agentId: string, options: { autoArm?: boolean } = {}): boolean {
    if (!this.houseAgents.has(agentId) && !this.userAgents.has(agentId)) return false;
    if (!isAutonomyActive()) {
      // Human enrollment/directive kicks intentionally wake staging. Durable
      // reconcile uses autoArm:false so an operator's emergency brake always
      // wins even when it lands during an already-running reconcile pass.
      if (options.autoArm === false) return false;
      armAutonomy(30, 'kick auto-arm');
    }
    void this.driveAgentNow(agentId).catch((err) =>
      console.error(
        `[AutonomyDriver] kick failed for ${sessionDigest(agentId)}:`,
        err instanceof Error ? err.message : err,
      ),
    );
    return true;
  }

  /**
   * Kick the actively-enrolled agent for an owner after a new directive lands.
   * The expected platform id prevents a stale/rebound enrollment from consuming
   * a directive written to a different agent row.
   */
  kickEnrolledOwnerNow(ownerUserId: string, expectedPlatformAgentId: string): boolean {
    const agentId = this.enrolledOwners.get(ownerUserId);
    const entry = agentId ? this.userAgents.get(agentId) : null;
    if (!agentId || !entry || entry.platformAgentId !== expectedPlatformAgentId) return false;
    entry.directiveRevision++;
    entry.directivePending = true;
    // The directive replans this agent; a talk prefetch from the old plan is void.
    entry.talkPrefetch = null;
    return this.kickAgentNow(agentId);
  }

  /**
   * Warm one cold runtime, bounded to 90 seconds, then return it so the SAME
   * tick/kick can drive immediately. The underlying warm remains tracked until
   * it actually settles; after a timeout a later kick cannot launch an
   * overlapping warm.
   */
  private async warmRuntimeBounded(
    entry: HouseAgentEntry,
  ): Promise<ReturnType<typeof agentOrchestrator.getRunningAgentRuntime>> {
    if (this.warming.has(entry.agentId)) return null;

    const warmToken = Date.now();
    this.warming.set(entry.agentId, warmToken);
    const warmPromise = agentOrchestrator.ensureAgentRuntime(
      entry.platformAgentId,
      entry.systemUserId,
      { isHouse: entry.isHouse },
    );
    const clearWarm = () => {
      if (this.warming.get(entry.agentId) === warmToken) this.warming.delete(entry.agentId);
    };
    // Attach both handlers to the ORIGINAL promise so even a rejection that
    // arrives after our 90s timeout is observed and releases the warm guard.
    void warmPromise.then(clearWarm, clearWarm);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      warmPromise.then(
        (runtime) => ({ kind: 'settled' as const, runtime }),
        (error: unknown) => ({ kind: 'failed' as const, runtime: null, error }),
      ),
      new Promise<{ kind: 'timeout'; runtime: null }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout', runtime: null }), WARM_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (outcome.kind === 'timeout') {
      console.warn(
        `[AutonomyDriver] runtime warm timed out for ${sessionDigest(entry.agentId)} after ${WARM_TIMEOUT_MS}ms — skipping drive`,
      );
      return null;
    }
    if (outcome.kind === 'failed') {
      console.warn(
        `[AutonomyDriver] runtime warm failed for ${sessionDigest(entry.agentId)} — retry next tick:`,
        outcome.error instanceof Error ? outcome.error.message : outcome.error,
      );
      return null;
    }
    if (!outcome.runtime) {
      console.warn(
        `[AutonomyDriver] runtime warm failed for ${sessionDigest(entry.agentId)} — retry next tick`,
      );
      return null;
    }
    return outcome.runtime;
  }

  start(): void {
    if (this.interval) return;
    // Seed the watchdog heartbeat at start so the first 30s interval is not
    // mistaken for a stalled driver during boot.
    this.lastTickAt = Date.now();
    this.interval = setInterval(() => this.tick(), TICK_MS);
    this.phaseEdgeInterval = setInterval(() => this.phaseEdgePoll(), PHASE_EDGE_POLL_MS);
    console.log(
      `[AutonomyDriver] started - driving every ${TICK_MS}ms, phase-edge poll every ${PHASE_EDGE_POLL_MS}ms`,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.phaseEdgeInterval) {
      clearInterval(this.phaseEdgeInterval);
      this.phaseEdgeInterval = null;
    }
  }

  /**
   * Phase-edge poll (every PHASE_EDGE_POLL_MS). The 30 s tick notices a phase
   * edge up to 30 s late: an arrived walk waits a tick, the teacher talk waits
   * another, and the 60 s linger becomes 60-90 s. This poll only wakes an agent
   * that sits AT an edge, via the same `driveAgentNow` the tick calls, so the
   * drive it starts is exactly the one the next tick would run. One edge = one
   * drive the next tick would run, so the decision count per cycle does not
   * grow; cycles get shorter. It never builds a prompt or calls decide() itself.
   *
   * Edges (each is safe because the drive moves the entry off the edge, so the
   * next poll skips it):
   * - walking + hasArrived: stepWalkingPhase takes its arrival branch (no LLM,
   *   no runtime) and sets 'arrived' or 'talking'. A walk that has NOT arrived
   *   is never woken: the wedge check compares remaining path length drive to
   *   drive and is tuned to the 30 s tick, so a 5 s drive would false-trigger it.
   *   For a not-arrived walk to a TEACHING building the poll may instead start
   *   the arrival talk call early (maybeStartTalkPrefetch). That starts no drive
   *   and changes no phase; the arrived branch later uses the reply.
   * - arrived (with a target) + warm runtime + no arrival settle still
   *   pending: driveOnce runs the teacher talk (or the talk-cooldown skip) and
   *   sets 'talking'. The arrival settle is fire-and-forget, so driveOnce's
   *   arrived branch itself returns (phase unchanged) while it runs, for a poll
   *   OR a tick drive: the visit settles before the teacher turn starts. The
   *   wait is bounded by ARRIVAL_SETTLE_WAIT_MS; a hung settle then gets one
   *   WARN and the talk goes ahead. The poll checks it too only to avoid a
   *   wake that would do nothing.
   * - talking past TALK_COOLDOWN_MS + warm runtime: driveOnce leaves the linger
   *   and runs the deciding step the tick would run. The poll stamps
   *   `edgeDecideAt`; if that decide leaves the entry 'deciding' (empty reply or
   *   a non-navigation action), tick() skips the entry until
   *   DECIDE_MIN_SPACING_MS has passed, so the retry stays one tick away instead
   *   of landing on a tick only 5 s later.
   * A cold runtime keeps the steady 30 s path (warming is the tick's job).
   * Never woken: 'deciding' (the tick owns decide and retry pacing), an agent
   * in flight or warming, and any entry with a pending directive (directives
   * already kick at once via kickEnrolledOwnerNow; their retries stay on the
   * tick). Returns the woken agentIds (test seam). A talk prefetch is not a
   * wake and is not in the returned list.
   */
  phaseEdgePoll(nowMs: number = Date.now()): string[] {
    if (!isAutonomyActive()) return [];
    const woken: string[] = [];
    for (const entry of [...this.houseAgents.values(), ...this.userAgents.values()]) {
      if (this.inFlight.has(entry.agentId) || this.warming.has(entry.agentId)) continue;
      if (entry.directivePending) continue;
      let edge = false;
      if (entry.phase === 'talking') {
        edge = nowMs - entry.phaseSince >= TALK_COOLDOWN_MS
          && !!agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
      } else if (entry.phase === 'arrived') {
        // Same guard as driveOnce's arrived branch: an arrived entry with no
        // target would fall through to deciding, which this poll never wakes.
        edge = !!entry.targetBuildingId
          && !this.isArrivalSettlePending(entry.agentId, nowMs, false)
          && !!agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
      } else if (entry.phase === 'walking') {
        // buildPerception is the only source of the edge/place distances that
        // hasArrived reads, so the arrival test stays identical to the drive's.
        const perception = npcSimulation.buildPerception(entry.bodyId);
        edge = !!perception && this.hasArrived(perception, entry);
        if (perception && !edge) this.maybeStartTalkPrefetch(entry, perception, nowMs);
      }
      if (!edge) continue;
      if (entry.phase === 'talking') entry.edgeDecideAt = nowMs;
      woken.push(entry.agentId);
      void this.driveAgentNow(entry.agentId).catch((err) =>
        console.error(
          `[AutonomyDriver] phase-edge drive failed for ${sessionDigest(entry.agentId)}:`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
    return woken;
  }

  /**
   * The ONE runtime decide call shape (timeout, token cap, local attempt
   * timeout). driveAgentNow and the talk prefetch both use it, so a prefetched
   * talk reply comes from exactly the call the arrived branch would make.
   */
  private runtimeDecideFn(
    runtime: NonNullable<ReturnType<typeof agentOrchestrator.getRunningAgentRuntime>>,
  ): DecideFn {
    return (prompt) => this.withTimeout(runtime.decide(prompt, {
      maxTokens: DECIDE_MAX_TOKENS,
      localAttemptTimeoutMs: 6_000,
    }));
  }

  /**
   * Teacher-talk prefetch (founder 2026-10-20: "faster path, same decision").
   * Called by phaseEdgePoll for a walk that has NOT arrived. When the target is
   * a teaching building and the walk ETA is at most TALK_PREFETCH_LEAD_MS, it
   * starts the arrival talk call now and stores the promise on the entry.
   *
   * Why it is the same decision:
   * - buildTalkPrompt reads only buildingId, the building's static label and
   *   cryptoFocus, and the agent's prior questions to that teacher (a sync
   *   map read), never position. The prior-question list changes only at the
   *   talk mutation point in the arrived branch (recordPriorQuestion, after
   *   this prefetch was consumed), so the prompt built now equals the one the
   *   arrived branch builds. The arrived branch still rebuilds it and uses the
   *   prefetch only on byte equality.
   * - Same model call: runtimeDecideFn, the shape driveAgentNow passes in.
   * - Directive fence: the prefetch records directiveRevision; any directive
   *   kick bumps it (and clears the prefetch), so a reply from the old plan
   *   is never used. Same parser, executor, teacher turn and cooldown after.
   * Same gates as the arrived talk: a talk cooldown means no prefetch (the
   * arrived branch would skip the talk). Same rule for house and user agents.
   * The caller already skipped in-flight, warming and directive-pending
   * entries. It never starts a drive, so the walk wedge check stays tick-paced.
   * Cost bound: at most ONE extra talk call per walk (one prefetch per target;
   * a discarded or stale prefetch is not replaced for the same building).
   */
  private maybeStartTalkPrefetch(
    entry: HouseAgentEntry,
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    nowMs: number,
  ): void {
    const buildingId = entry.targetBuildingId;
    if (!buildingId) return;
    if (entry.talkPrefetch && entry.talkPrefetch.buildingId === buildingId) return;
    // Same teaching test as stepWalkingPhase's teachingTarget: shared places
    // (cove, poker, kelp, trading floor) are never in nearbyBuildings.
    const building = perception.nearbyBuildings.find((b) => b.buildingId === buildingId);
    if (!building) return;
    if (this.isTalkCooldownActive(entry.agentId, buildingId, nowMs)) return;
    const remainingWu = npcSimulation.getRemainingPathLengthWu(entry.bodyId);
    // An empty path on a walk that has not arrived is a stuck body, not an ETA of 0.
    if (remainingWu === null || remainingWu <= 0) return;
    const etaMs = (remainingWu / NPC_WORLD_WALK_SPEED_WU_PER_S) * 1000;
    if (etaMs > TALK_PREFETCH_LEAD_MS) return;
    const runtime = agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
    if (!runtime) return;
    // Built exactly as the arrived branch builds it.
    const prompt = this.buildTalkPrompt(
      buildingId,
      building.label,
      building.cryptoFocus,
      this.getPriorQuestions(entry.agentId, buildingId),
    );
    const promise = this.runtimeDecideFn(runtime)(prompt);
    // withTimeout never rejects; this keeps a discarded prefetch from ever
    // surfacing as an unhandled rejection.
    promise.catch(() => {});
    entry.talkPrefetch = {
      buildingId,
      prompt,
      directiveRevision: entry.directiveRevision,
      startedAt: nowMs,
      promise,
    };
    console.log(
      `[AutonomyDriver][debug] talk prefetch ${sessionDigest(entry.agentId)} building=${buildingId}`,
    );
  }

  /**
   * True while this agent's arrival settle is running AND younger than
   * ARRIVAL_SETTLE_WAIT_MS. An older guard reads as not pending (the talk goes
   * ahead) but stays in the map: the settle's own finally owns its removal.
   * With `warnIfExpired`, the first expired read per settle WARNs (digest only).
   */
  private isArrivalSettlePending(agentId: string, now: number, warnIfExpired: boolean): boolean {
    const settle = this.arrivalSettling.get(agentId);
    if (!settle) return false;
    if (now - settle.startedAt < ARRIVAL_SETTLE_WAIT_MS) return true;
    if (warnIfExpired && !settle.warned) {
      settle.warned = true;
      console.warn(
        `[AutonomyDriver] arrival settle still running after ${ARRIVAL_SETTLE_WAIT_MS}ms for ${sessionDigest(agentId)}; talking anyway`,
      );
      // A hung settle never reaches its finally: drop the expired token here.
      this.arrivalSettling.delete(agentId);
    }
    return false;
  }

  /**
   * §B.1 durable autonomy — run one reconcile pass (re-enroll persisted-flag
   * agents). LAZY-imported so the driver keeps NO static import of the reconcile
   * module (which imports the activation service, which imports THIS driver) — a
   * static edge would form a cycle; the runtime import resolves cleanly since the
   * driver + activation singletons are already constructed by first tick. Never
   * throws into the tick loop.
   */
  private async runReconcile(): Promise<void> {
    // Re-check here as well as in tick(): an operator may apply standby between
    // scheduling this fire-and-forget pass and its dynamic import executing.
    if (!isAutonomyActive()) return;
    try {
      const { reconcileDurableAutonomy } = await this.loadReconcileModule();
      // The lazy import is an await boundary. A manual emergency brake applied
      // while it resolves must still win; otherwise reconcile may enroll an
      // agent whose kick immediately auto-arms autonomy again.
      if (!isAutonomyActive()) return;
      await reconcileDurableAutonomy();
    } catch (err) {
      console.warn(
        '[AutonomyDriver] durable-autonomy reconcile failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * One driver tick. Fires each house agent's drive fire-and-forget (never
   * awaited — a slow brain must not delay the next agent or the next tick). The
   * in-flight guard skips an agent whose previous decision is still running.
   */
  private tick(): void {
    // Heartbeat before the standby gate: standby is intentional liveness, not a
    // stalled interval. The canary separately checks whether agents are enrolled.
    this.lastTickAt = Date.now();
    if (!isAutonomyActive()) {
      if (this.wasActive) {
        console.log('[AutonomyDriver] standby — skipping autonomy tick and reconcile');
      }
      this.wasActive = false;
      return;
    }
    this.wasActive = true;
    this.tickCount++;
    // §B.1 durable autonomy: re-enroll persisted-flag agents with NO client.
    // Tick 1 (~30s after start) covers the "on driver start" case (a deploy
    // re-enrolls away-agents promptly); every RECONCILE_EVERY_N_TICKS after also
    // heals a crash mid-teardown. Fire-and-forget — a slow DB read must never
    // delay the drive loop; the reconcile module guards its own overlap.
    if (this.tickCount % RECONCILE_EVERY_N_TICKS === 1) {
      void this.runReconcile();
    }
    // Standby returned above; this human-presence-independent cadence applies
    // only while the operator switch is ACTIVE.
    // Human-presence INDEPENDENT cadence: the agent runs the SAME decision loop
    // whether or not a human is in the world. ClawVille's premise is that hosted
    // agents ARE the living economy — they must act continuously with ZERO
    // external users present, not dial themselves down when nobody is watching
    // (founder, 2026-07-02). Cost is controlled by the tick cadence + the planned
    // migration to open-source/free decision models, NOT by gating on humans.
    // §B.1: drive BOTH registries — house fleet first (unchanged order), then
    // user-owned enrollments. Same phase machine, same guards; the ONLY
    // house/user divergence inside the loop is the warm flag (`entry.isHouse`).
    const now = Date.now();
    for (const entry of [...this.houseAgents.values(), ...this.userAgents.values()]) {
      // Decide spacing after a poll-woken decide (see DECIDE_MIN_SPACING_MS).
      // A pending directive bypasses it; directive kicks never pass here anyway.
      if (
        entry.phase === 'deciding'
        && !entry.directivePending
        && entry.edgeDecideAt > 0
        && now - entry.edgeDecideAt < DECIDE_MIN_SPACING_MS
      ) {
        continue;
      }
      // Every agent gets an independent promise. A cold 90-second warm cannot
      // serialize warm agents later in this loop, and the helper's atomic guard
      // skips any enrollment/directive kick already driving this same agent.
      void this.driveAgentNow(entry.agentId)
        .catch((err) =>
          console.error(
            `[AutonomyDriver] drive failed for ${sessionDigest(entry.agentId)}:`,
            err instanceof Error ? err.message : err,
          ),
        );
    }
  }

  getLivenessSnapshot(): { enrolledCount: number; lastTickAt: number | null } {
    return {
      enrolledCount: this.houseAgents.size + this.userAgents.size,
      lastTickAt: this.lastTickAt,
    };
  }

  /**
   * Missing-body watchdog for one drive (see BODY_MISSING_WARN_INTERVAL_MS).
   * WARNs at most once per agent per interval (digest only, never a session id
   * or body id). For a HOUSE agent missing for HOUSE_BODY_HEAL_AFTER_MISSES
   * consecutive drives, re-runs the existing boot activation (`houseReactivate`)
   * under an exponential per-agent backoff. The attempt is stamped BEFORE the
   * await so an overlapping caller backs off too. Never throws.
   */
  private async handleMissingBody(entry: HouseAgentEntry, now: number): Promise<void> {
    const digest = sessionDigest(entry.agentId);
    let state = this.bodyMissing.get(entry.agentId);
    if (!state) {
      state = { misses: 0, healAttempts: 0, lastHealAt: 0, healDisabled: false };
      this.bodyMissing.set(entry.agentId, state);
    }
    state.misses++;

    const lastWarnAt = this.bodyMissingWarnedAt.get(entry.agentId);
    if (lastWarnAt === undefined || now - lastWarnAt >= BODY_MISSING_WARN_INTERVAL_MS) {
      this.bodyMissingWarnedAt.set(entry.agentId, now);
      console.warn(
        `[AutonomyDriver] body missing for ${digest} (${entry.isHouse ? 'house' : 'user'}, ` +
          `${state.misses} consecutive drive(s)) - ` +
          (entry.isHouse
            ? 'house self-heal re-runs activation'
            : 'user agent is not re-registered by the driver'),
      );
    }

    if (!entry.isHouse || state.healDisabled || state.misses < HOUSE_BODY_HEAL_AFTER_MISSES) return;
    if (state.healAttempts > 0) {
      const backoffMs = Math.min(
        HOUSE_BODY_HEAL_BACKOFF_MAX_MS,
        HOUSE_BODY_HEAL_BACKOFF_MS * 2 ** (state.healAttempts - 1),
      );
      if (now - state.lastHealAt < backoffMs) return;
    }
    state.healAttempts++;
    state.lastHealAt = now;
    try {
      const result = await this.houseReactivate();
      if (!result) {
        console.warn(`[AutonomyDriver] house self-heal for ${digest} returned no agent - retry after backoff`);
      } else if (result.agentId !== entry.agentId) {
        // The activation path is single-agent. Re-running it for a different
        // agent would re-mint THAT agent's session each attempt, so stop here.
        state.healDisabled = true;
        console.error(
          `[AutonomyDriver] house self-heal for ${digest} re-activated a different agent ` +
            `(${sessionDigest(result.agentId)}) - self-heal disabled for ${digest}`,
        );
      } else {
        console.log(`[AutonomyDriver] house self-heal re-activated ${digest} (attempt ${state.healAttempts})`);
      }
    } catch (err) {
      console.warn(
        `[AutonomyDriver] house self-heal failed for ${digest} - retry after backoff:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Drive ONE house agent through one step of the phase machine. Exposed
   * (agentId + injectable `decide`) so tests can drive it with a canned reply
   * instead of a live model. Production passes the timeout-wrapped runtime
   * decider. Runs the SAME cadence regardless of human presence — the agent
   * acts continuously whether or not anyone is watching.
   */
  async driveOnce(
    agentId: string,
    decide: DecideFn,
  ): Promise<void> {
    // §B.1: an agent lives in exactly ONE of the two disjoint registries.
    const entry = this.houseAgents.get(agentId) ?? this.userAgents.get(agentId);
    if (!entry) return;

    const perception = npcSimulation.buildPerception(entry.bodyId);
    if (!perception) {
      // Body not in world (e.g. its session was unregistered). Nothing to drive
      // this tick. Reset to deciding so we replan on return, WARN (rate-limited),
      // and for a HOUSE agent re-run activation after consecutive misses (see
      // handleMissingBody): nothing else re-spawns a house body until boot.
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      entry.talkPrefetch = null;
      await this.handleMissingBody(entry, Date.now());
      return;
    }
    this.bodyMissing.delete(entry.agentId);

    const now = Date.now();

    // P5: a fresh human directive outranks the autonomous plan — interrupt the
    // current walk/linger/arrival and replan NOW instead of waiting out the
    // phase machine (measured 30-180s of dead time without this).
    if (entry.directivePending && entry.phase !== 'deciding') {
      this.pushThought(entry, 'directive', 'New directive — replanning now', now);
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      entry.talkPrefetch = null;
      entry.phaseSince = now;
    }

    // Phase: walking — cheap arrival poll, NO llm. Extracted so `driveAgentNow`
    // can run it WITHOUT a warm cognition runtime (M3).
    if (entry.phase === 'walking') {
      await this.stepWalkingPhase(entry, perception, now);
      return; // walking never calls the LLM
    }

    // Phase: talking cooldown — NO llm.
    if (entry.phase === 'talking') {
      if (now - entry.phaseSince < TALK_COOLDOWN_MS) return;
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      entry.talkPrefetch = null;
      entry.phaseSince = now;
    }

    // Phase: arrived → converse with the teacher (LLM). The proximity gate in
    // executeHatcherAction PASSES because we only reach 'arrived' once within
    // BUILDING_INTERACTION_RADIUS of the target.
    if (entry.phase === 'arrived' && entry.targetBuildingId) {
      // The arrival settle still runs (bounded wait): keep 'arrived' so the visit
      // settles before the teacher turn; the next poll or tick retries the talk.
      if (this.isArrivalSettlePending(agentId, now, true)) return;
      const buildingId = entry.targetBuildingId;
      // Slice 4 LLM-spend bound: at most one CONDUCTED turn per (agent, building)
      // per hour. On cooldown → skip the talk LLM entirely (no question, no
      // teacher call), linger, then re-decide (the decision prompt lists the
      // cooled-down teachers so the agent favors somewhere new).
      if (this.isTalkCooldownActive(entry.agentId, buildingId, now)) {
        console.log(
          `[AutonomyDriver][debug] talk skipped (cooldown) ${sessionDigest(entry.agentId)} building=${buildingId}`,
        );
        entry.talkPrefetch = null;
        entry.phase = 'talking';
        entry.phaseSince = now;
        return;
      }
      const building = perception.nearbyBuildings.find(
        (b) => b.buildingId === buildingId,
      );
      const priorQuestions = this.getPriorQuestions(entry.agentId, buildingId);
      const priorCount = priorQuestions.length;
      const prompt = this.buildTalkPrompt(
        buildingId,
        building?.label,
        building?.cryptoFocus,
        priorQuestions,
      );
      const talkDirectiveRevision = entry.directiveRevision;
      // Talk prefetch (see maybeStartTalkPrefetch): use it only for the same
      // building, the byte-identical prompt and the same directive revision,
      // and only while fresh. Cleared either way before any await.
      const prefetch = entry.talkPrefetch;
      entry.talkPrefetch = null;
      let reply: string;
      if (
        prefetch
        && prefetch.buildingId === buildingId
        && prefetch.prompt === prompt
        && prefetch.directiveRevision === entry.directiveRevision
        && now - prefetch.startedAt <= TALK_PREFETCH_MAX_AGE_MS
      ) {
        const waitStartedAt = Date.now();
        reply = await prefetch.promise;
        console.log(
          `[AutonomyDriver][debug] talk prefetch used ${sessionDigest(entry.agentId)} waitedMs=${Date.now() - waitStartedAt}`,
        );
      } else {
        reply = await decide(prompt);
      }
      if (entry.directiveRevision !== talkDirectiveRevision
        || (this.houseAgents.get(agentId) ?? this.userAgents.get(agentId)) !== entry) return;
      // TEMP DEBUG (see above): the RAW talk reply — reveals whether gpt-4o-mini
      // emits a parseable [ACTION: talk_to_npc(...)] tag.
      console.log(
        `[AutonomyDriver][debug] talk ${sessionDigest(entry.agentId)} replyLen=${reply.length} prior=${priorCount} reply=${JSON.stringify(reply.slice(0, 240))}`,
      );
      // The agent's OWN visible bubble — the existing [ACTION:] path (the
      // executor's proximity gate re-checks server-side).
      npcSimulation.dispatchHatcherActions(entry.bodyId, reply);
      // Slice 4: the REAL conversed turn — teacher reply + settle (CT +
      // leaderboard + memory), ONLY when the model emitted a parseable talk
      // message. The settle service re-checks proximity fail-closed and is
      // fail-soft on every error, so a failed turn just earns nothing.
      const message = extractTalkMessage(reply);
      if (message) {
        // Talk mutation point (founder 2026-10-22): the bubble was dispatched,
        // so the question was asked; record it whether or not the teacher turn
        // succeeds. This is the ONLY writer of priorTalkQuestions, and it runs
        // after the prefetch was consumed and after the fence above.
        this.recordPriorQuestion(entry.agentId, buildingId, message);
        const turn = await this.teacherTurn({
          agentId: entry.agentId,
          bodyId: entry.bodyId,
          avatarId: entry.avatarId,
          // Owner attribution (security pass 2026-10-04): the enrolled owner of
          // avatarId, the same id seedFromCursorOnce reads history with.
          userId: entry.houseUserId,
          // P3 slice 3: the LEARNING agent's runtime — folds its prior lessons
          // into the teacher's context AND converges the new lesson onto ElizaOS.
          platformAgentId: entry.platformAgentId,
          buildingId,
          message,
        });
        if (turn) {
          // Success ⇒ start the per-building cooldown + feed the lesson into
          // the next decision context (memory made behaviorally live).
          this.stampTalkCooldown(entry.agentId, buildingId, now);
          entry.lastLesson = turn.reply.replace(/\s+/g, ' ').slice(0, LESSON_SNIPPET_MAX);
        }
      }
      entry.phase = 'talking';
      entry.phaseSince = now;
      return;
    }

    // Phase: deciding (default) → choose a teacher by need + walk (LLM).
    // P3 slice 2: on the first deciding drive after (re)start, seed "since I last
    // acted" context from the durable event cursor. Slice 4 memory read-back:
    // fold the most recent lessons in too. Slice 2 directive: read the human's
    // current directive as a top-priority bias. Reads are bounded; an unknown
    // directive defers this decision instead of assuming no instruction exists.
    await this.seedFromCursorOnce(entry);
    // P3 slice 3: read the directive FIRST so it can bias the semantic-RAG lesson
    // retrieval (lessons relevant to what the human asked surface first); both
    // reads are bounded so a slow store never stalls the tick.
    const directiveRevision = entry.directiveRevision;
    const directive = await this.readDirectiveBounded(entry.platformAgentId, entry);
    // Keep a newer kick pending. The caller permits only one immediate follow-up;
    // further failures wait for the steady tick rather than spinning here.
    if (directive === undefined || entry.directiveRevision !== directiveRevision) return;
    entry.directivePending = false;
    let directiveSha: string | null = null;
    let directiveWasNew = false;
    if (directive?.text) {
      directiveSha = directiveInstanceSha(directive);
      if (entry.directiveShaHydrated && directiveSha !== entry.lastDirectiveSha) {
        // Defer the seen stamp until the received event is actually recorded (or
        // a durable claimant says it was already recorded elsewhere).
        directiveWasNew = true;
        this.pushThought(
          entry,
          'directive',
          `Directive: "${directive.text.slice(0, 80)}"`,
        );
      }
    }
    const [lessons, knowledge, landTargets, questTargets, salvageTargets, buildTargets, tradingDesk, cosmeticTargets] = await Promise.all([
      this.readRecentLessons(entry, directive?.text ?? null),
      this.readRecentKnowledge(entry, directive?.text ?? null),
      this.readTargetBounded(agentId, 'land', () => readAutonomousLandTargets({
        avatarId: entry.avatarId,
        x: perception.self.x,
        y: perception.self.y,
      }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} land targets unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return { claimable: [], owned: [] } satisfies AutonomousLandTargets;
      })),
      // House agents never claim quests (the executor drops claim_tutorial_quest
      // for house actors: "house fleets never claim faucets"). Advertising ids
      // to them only teaches a no-op the model then repeats (staging 2026-10-20:
      // 8 picks in a row). Same skip as salvage and build below.
      entry.isHouse
        ? Promise.resolve([] as AutonomousQuestTarget[])
        : this.readTargetBounded(agentId, 'quests', () => readAutonomousQuestTargets({ avatarId: entry.avatarId, userId: entry.houseUserId }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} quest targets unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return [] as AutonomousQuestTarget[];
      })),
      // House agents never salvage (pure faucet, server-owned actor), so skip
      // four queries per tick for the whole fleet rather than discarding the
      // result later.
      entry.isHouse
        ? Promise.resolve(EMPTY_SALVAGE_TARGETS)
        : this.readTargetBounded(agentId, 'salvage', () => readAutonomousSalvageTargets({
        avatarId: entry.avatarId,
        userId: entry.houseUserId,
        x: perception.self.x,
        y: perception.self.y,
        mapHalfWu: WORLD_COLLIDER_MAP_HALF,
      }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} salvage targets unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return EMPTY_SALVAGE_TARGETS;
      })),
      // House agents cannot earn materials (both faucets exclude them), so a
      // build block would only ever offer calls they can never pay. Same skip
      // as the salvage read above: save the queries per tick for the fleet.
      entry.isHouse
        ? Promise.resolve(EMPTY_AUTONOMOUS_BUILD_TARGETS)
        : this.readTargetBounded(agentId, 'build', () => readAutonomousBuildTargets({ avatarId: entry.avatarId }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} build targets unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return EMPTY_AUTONOMOUS_BUILD_TARGETS;
      })),
      this.readTargetBounded(agentId, 'trading', () => readAutonomousTradingTargets({ avatarId: entry.avatarId }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} trading desk unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return EMPTY_TRADING_DESK;
      })),
      // House agents are refused all three cosmetic/wallet verbs
      // (HOUSE_REFUSED_AUTONOMY_VERBS) and their menu omits them, so skip the
      // read for the fleet, like quests, salvage and build above.
      entry.isHouse
        ? Promise.resolve(EMPTY_AUTONOMOUS_COSMETIC_TARGETS)
        : this.readTargetBounded(agentId, 'cosmetics', () => readAutonomousCosmeticTargets({
        avatarId: entry.avatarId,
        userId: entry.houseUserId,
      }).catch((err: unknown) => {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} cosmetic targets unavailable (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        return EMPTY_AUTONOMOUS_COSMETIC_TARGETS;
      })),
    ]);
    // Target reads can also outlive the owner instruction or enrollment.
    if (entry.directiveRevision !== directiveRevision
      || (this.houseAgents.get(agentId) ?? this.userAgents.get(agentId)) !== entry) return;
    if (landTargets === undefined || questTargets === undefined || salvageTargets === undefined
      || buildTargets === undefined || tradingDesk === undefined || cosmeticTargets === undefined) {
      // Unknown target state cannot become an invented empty world or desk.
      // One immediate follow-up is already bounded by driveAgentNow; unresolved
      // readers stay guarded, then the steady tick retries after they settle.
      entry.directivePending = true;
      return;
    }
    const prompt = this.buildDecisionPrompt(
      perception,
      entry,
      lessons,
      directive?.text ?? null,
      knowledge,
      landTargets,
      questTargets,
      salvageTargets,
      buildTargets,
      tradingDesk,
      cosmeticTargets,
    );
    // Directive fast path (founder 2026-10-20: "faster path, same decision").
    // Skips one ~5 s model call ONLY when the decision is already fixed: the
    // directive is nothing but "go to <one destination>" (any other wording
    // returns null), it is used AT MOST ONCE PER DIRECTIVE ISSUANCE PER PROCESS
    // (fastPathUsedSha, keyed by platformAgentId, is stamped before any await
    // and survives unregister + re-register, so neither an unknown, failed or
    // timed-out acted claim that leaves directiveWasNew true nor an autonomy
    // off/on can reuse it; later decisions on a standing directive go to the
    // model, so the agent never loops back to the same place), and the agent is
    // not already there (the prompt's "you are HERE, do not enter again" case
    // stays with the model). The line is the exact call the prompt shows for
    // that destination and runs through the same claim, events, and executor
    // below.
    const fastReply = directiveWasNew && directiveSha && directive?.text
      && this.fastPathUsedSha.get(entry.platformAgentId) !== directiveSha
      ? this.directiveFastPathReply(perception, entry, directive.text)
      : null;
    if (fastReply && directiveSha) {
      this.markFastPathUsed(entry.platformAgentId, directiveSha);
      console.log(
        `[AutonomyDriver][debug] directive fast path ${sessionDigest(entry.agentId)} action=${parseDriverAction(fastReply)?.verb ?? 'unknown'}`,
      );
    }
    const reply = fastReply ?? await decide(prompt);
    // This also fences decisions based on known-null state, which have no
    // directive SHA claim to detect a new instruction received during inference.
    if (entry.directiveRevision !== directiveRevision) return;
    // TEMP DEBUG (see tick()): the RAW decision reply — the smoking gun for
    // candidate (a). If this has content but no [ACTION: enter_building(...)] the
    // executor recognizes, the parse — not the model call — is the stall.
    // R4: empty-decide health signal (see HouseAgentEntry.consecutiveEmptyDecides).
    // withTimeout maps a timeout/error to '' — a persistent empty (OpenAI 429 /
    // quota / bad key) would spin here silently. Count consecutive empties and WARN
    // past the threshold. This does NOT alter drive behavior: an empty reply still
    // just fails to stamp a destination and we retry deciding next tick.
    if (reply.trim().length === 0) {
      this.pushThought(entry, 'observation', 'Decision timed out — retrying', now);
      entry.consecutiveEmptyDecides++;
      if (entry.consecutiveEmptyDecides >= EMPTY_DECIDE_WARN_THRESHOLD) {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} model returned empty ${entry.consecutiveEmptyDecides} times in a row — check OPENAI_API_KEY / quota / 429`,
        );
      }
    } else {
      entry.consecutiveEmptyDecides = 0;
    }
    const parsedAction = parseDriverAction(reply);
    let moneyDirective: { id: string; ordinal: number } | null = null;
    if (parsedAction) {
      this.pushThought(entry, 'decision', decisionThought(parsedAction), now);
      if (
        directiveSha &&
        directive &&
        entry.directiveShaHydrated &&
        entry.lastActedDirectiveSha !== directiveSha
      ) {
        // The durable marker MUST succeed before the acted event/in-memory stamp.
        // On timeout/error the action still dispatches, but the marker/event retry
        // on a later tick rather than falsely claiming durable dedupe.
        const claim = await this.claimActedDirectiveShaBounded(entry, directiveSha, directive);
        if (claim === 'claimed') {
          if (parsedAction.verb === 'trade_token') moneyDirective = { id: directiveSha, ordinal: 0 };
          entry.lastActedDirectiveSha = directiveSha;
          if (directiveWasNew) {
            await this.recordDriverAction(entry, 'agent.directive.received', {
              directiveSha256: directiveSha,
              len: directive.text.length,
            });
            entry.lastDirectiveSha = directiveSha;
          }
          await this.recordDriverAction(entry, 'agent.directive.acted', {
            directiveSha256: directiveSha,
            action: parsedAction.verb,
          });
        } else if (claim === 'superseded') {
          // The human replaced this issuance while the model was deciding.
          // Never dispatch an action biased by the stale directive.
          return;
        } else if (claim === 'already_recorded') {
          if (parsedAction.verb === 'trade_token') return;
          // Durable SHA dedupes EVENTS, not standing-directive behavior. Stamp
          // the process cache and continue the baseline action dispatch.
          entry.lastDirectiveSha = directiveSha;
          entry.lastActedDirectiveSha = directiveSha;
        } else {
          if (parsedAction.verb === 'trade_token') return;
          // Marker durability is UNKNOWN. Preserve the driver's established
          // fail-soft action behavior, but emit/mark nothing. A previously
          // recorded received event stays stamped; a first observation remains
          // null and retries the received+acted pair after a successful claim.
        }
      }
    } else if (directiveSha && directiveWasNew) {
      // A directive can be observed even when the model returns no parseable
      // action. There is no acted marker to claim yet, so record only received.
      await this.recordDriverAction(entry, 'agent.directive.received', {
        directiveSha256: directiveSha,
        len: directive?.text.length ?? 0,
      });
      entry.lastDirectiveSha = directiveSha;
    }
    // Claim/event persistence above also awaits. A newer owner instruction or
    // replacement enrollment invalidates this reply at the final dispatch edge.
    if (entry.directiveRevision !== directiveRevision
      || (this.houseAgents.get(agentId) ?? this.userAgents.get(agentId)) !== entry) return;
    // N3: clear any STALE destination from a PRIOR turn BEFORE dispatching, so
    // post-dispatch destinationBuildingId is non-null ONLY if THIS turn's
    // enter_building actually succeeded. Without this, a dropped enter_building
    // (e.g. no path found) would leave a stale value and the driver would
    // "walk" to a building it did not choose this turn. A valid enter_building
    // re-stamps the field via setNpcPath; a re-pick of the same building still
    // works (it is simply re-set).
    npcSimulation.clearDestinationBuilding(entry.bodyId);
    npcSimulation.dispatchHatcherActions(entry.bodyId, reply, moneyDirective);
    // Learn the CHOSEN destination from the body itself. enter_building stamps a
    // teacher id; gateway verbs stamp their shared place destination. move/emote/talk do
    // not stamp a destination and deliberately leave the phase at `deciding`
    // for the next steady tick after their visible one-shot effect.
    const body = npcSimulation.getNpcById(entry.bodyId);
    const chosen = body?.destinationBuildingId ?? null;
    // TEMP DEBUG (see tick()): did dispatch stamp a destination? destSet=false with
    // a non-empty reply above ⇒ candidate (a) (no parseable enter_building) OR (c)
    // (a valid tag that dispatchHatcherActions no-op'd for the ocb- body).
    if (chosen) {
      entry.phase = 'walking';
      entry.phaseSince = now;
      entry.targetBuildingId = chosen;
      entry.talkPrefetch = null; // new walk: no prefetch from a prior target
      entry.lastBuildingId = chosen;
      // Size the give-up budget to the route the executor just stamped, and open
      // ONE episode window that re-routes may not extend.
      entry.walkReplans = 0;
      entry.walkDeadline = now + walkBudgetMsForRouteLength(
        npcSimulation.getRemainingPathLengthWu(entry.bodyId) ?? 0,
      );
      entry.walkEpisodeDeadline = now + MAX_WALK_EPISODE_MS;
      entry.lastRemainingWu = null; // first walking tick records the baseline
    }
  }

  /** Bound only read waits, never the action lifecycle. Late data is discarded. */
  private readTargetBounded<T>(
    agentId: string,
    name: TargetReaderName,
    read: () => Promise<T>,
  ): Promise<T | undefined> {
    let readers = this.pendingTargetReads.get(agentId);
    if (readers?.has(name)) return Promise.resolve(undefined);
    if (!readers) {
      // Failed transports plus enrollment churn must not grow this map forever.
      if (this.pendingTargetReads.size >= MAX_HOUSE_AGENTS + MAX_AUTONOMOUS_USER_AGENTS) {
        return Promise.resolve(undefined);
      }
      readers = new Set();
      this.pendingTargetReads.set(agentId, readers);
    }
    readers.add(name);
    const pending = readers;
    return new Promise<T | undefined>((resolve) => {
      let settled = false;
      const finish = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        console.warn(`[AutonomyDriver] target read timed out reader=${name} agent=${sessionDigest(agentId)}`);
        finish(undefined);
      }, TARGET_READ_TIMEOUT_MS);
      const release = () => {
        pending.delete(name);
        if (pending.size === 0 && this.pendingTargetReads.get(agentId) === pending) {
          this.pendingTargetReads.delete(agentId);
        }
      };
      void Promise.resolve().then(read).then(
        (value) => { release(); finish(value); },
        () => { release(); finish(undefined); },
      );
    });
  }

  /** True once the body is within the interaction radius of its target building. */
  private hasArrived(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    entry: HouseAgentEntry,
  ): boolean {
    if (!entry.targetBuildingId) return false;
    const distance = this.destinationDistance(perception, entry.targetBuildingId);
    return distance !== null && distance <= BUILDING_INTERACTION_RADIUS;
  }

  /**
   * Arrival distance to a destination id, or null when perception does not list
   * it. The ONE metric for hasArrived and the directive fast path.
   */
  private destinationDistance(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    destinationId: string,
  ): number | null {
    const building = perception.nearbyBuildings.find(
      (b) => b.buildingId === destinationId,
    );
    if (building) {
      // Edge-distance (footprint), NOT center-distance — the same metric the
      // interaction gates use. Center-distance is unsatisfiable for the larger
      // buildings, so a center-based hasArrived would leave the driver walking
      // forever (then WALK_TIMEOUT replans) and never reach 'arrived'/'talking'.
      return building.edgeDistance;
    }
    // Shared places (Cove, poker, Kelp portal) resolve through the same
    // destinationId + center-derived distance contract.
    const place = perception.places.find(
      (candidate) => candidate.destinationId === destinationId,
    );
    return place ? place.distance : null;
  }

  /**
   * Record that this platform agent's directive issuance used the fast path.
   * Delete-then-set moves the key to the newest position; past
   * FAST_PATH_USED_MAX the oldest keys (insertion order) are evicted.
   */
  private markFastPathUsed(platformAgentId: string, directiveSha: string): void {
    this.fastPathUsedSha.delete(platformAgentId);
    this.fastPathUsedSha.set(platformAgentId, directiveSha);
    while (this.fastPathUsedSha.size > FAST_PATH_USED_MAX) {
      const oldest = this.fastPathUsedSha.keys().next().value;
      if (oldest === undefined) break;
      this.fastPathUsedSha.delete(oldest);
    }
  }

  /**
   * The directive fast-path reply, or null to let the model decide. Null when
   * the directive is not a plain single-destination go-to, when the destination
   * is missing from perception (unknown distance), or when the agent is already
   * within BUILDING_INTERACTION_RADIUS of it (hasArrived's metric).
   */
  private directiveFastPathReply(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    entry: HouseAgentEntry,
    directiveText: string,
  ): string | null {
    const line = directiveFastPathAction({ text: directiveText, isHouse: entry.isHouse });
    if (!line) return null;
    const action = parseDriverAction(line);
    if (!action) return null;
    const destinationId = action.verb === 'enter_building'
      ? action.params.buildingId
      : perception.places.find((place) => place.actionVerb === action.verb)?.destinationId;
    if (!destinationId) return null;
    const distance = this.destinationDistance(perception, destinationId);
    if (distance === null || !Number.isFinite(distance)) return null;
    return distance > BUILDING_INTERACTION_RADIUS ? line : null;
  }

  /** A zero `walkDeadline` (legacy/hand-set entry) keeps the pre-2026-07-26 flat 120 s. */
  private walkDeadlineFor(entry: HouseAgentEntry): number {
    return entry.walkDeadline > 0 ? entry.walkDeadline : entry.phaseSince + WALK_BUDGET_FLOOR_MS;
  }

  /**
   * One walking-phase step: arrival, wedge recovery, deadline. NEVER calls
   * decide() — that is what lets `driveAgentNow` run it without a runtime.
   */
  private async stepWalkingPhase(
    entry: HouseAgentEntry,
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    now: number,
  ): Promise<void> {
    if (this.hasArrived(perception, entry)) {
      entry.walkDeadline = 0;
      entry.walkEpisodeDeadline = 0;
      entry.walkReplans = 0;
      entry.lastRemainingWu = null;
      const arrivedDestination = entry.targetBuildingId;
      if (arrivedDestination) {
        this.pushThought(
          entry,
          'arrival',
          `Arrived at ${destinationLabel(arrivedDestination) ?? arrivedDestination}`,
          now,
        );
        await this.recordDriverAction(entry, 'agent.visit', {
          destination: arrivedDestination,
        });
      }
      const teachingTarget = entry.targetBuildingId
        ? perception.nearbyBuildings.some((building) =>
            building.buildingId === entry.targetBuildingId)
        : false;
      if (teachingTarget && entry.targetBuildingId) {
        entry.phase = 'arrived';
        entry.phaseSince = now;
        const settleAgentId = entry.agentId;
        const settleToken = { startedAt: now, warned: false };
        this.arrivalSettling.set(settleAgentId, settleToken);
        // Slice 4: settle only a TEACHING-BUILDING arrival. Places such as the
        // cove are visible navigation outcomes, never teacher settlement.
        void this.arrivalSettle({
          agentId: entry.agentId,
          bodyId: entry.bodyId,
          avatarId: entry.avatarId,
          userId: entry.houseUserId,
          buildingId: entry.targetBuildingId,
        }).catch((err) =>
          console.warn(
            `[AutonomyDriver] arrival settle failed for ${sessionDigest(entry.agentId)}:`,
            err instanceof Error ? err.message : err,
          ),
        ).finally(() => {
          if (this.arrivalSettling.get(settleAgentId) === settleToken) {
            this.arrivalSettling.delete(settleAgentId);
          }
        });
      } else {
        // A non-teaching destination (cove / poker room) has been reached.
        // Linger without another LLM call, then return to deciding; never emit
        // an invalid talk_to_npc(buildingId=cove) or teacher reward.
        entry.talkPrefetch = null; // never set for a place; cleared defensively
        entry.phase = 'talking';
        entry.phaseSince = now;
        // Retain the reached place through the talking/linger phase so the
        // owner HUD truthfully reads "At the Cove" until the next re-decide.
      }
    } else {
      // --- not arrived ---------------------------------------------------
      // `stamped` gates BOTH new behaviors on a real driver-stamped walk, so a
      // legacy/hand-set entry (walkDeadline 0) keeps the exact pre-2026-07-26
      // flat-120s full-re-decide path (B3 / round2.test.ts:177-190).
      const stamped = entry.walkDeadline > 0;
      const remaining = npcSimulation.getRemainingPathLengthWu(entry.bodyId);
      const previous = entry.lastRemainingWu;
      // A body whose valid route clips a collider wall-slides without closing
      // distance. One 30 s tick of < 220 wu progress (nominal is ~6,600) is a
      // wedge — recover in ~one tick instead of waiting out the whole deadline.
      const wedged = stamped
        && remaining !== null
        && previous !== null
        && remaining > previous - WALK_PROGRESS_EPSILON_WU;
      entry.lastRemainingWu = remaining;

      if (wedged || now > this.walkDeadlineFor(entry)) {
        const canFreeReroute = stamped
          && !!entry.targetBuildingId
          && entry.walkReplans < MAX_WALK_REPLANS
          && now < entry.walkEpisodeDeadline
          && npcSimulation.repathToDestination(entry.bodyId, entry.targetBuildingId);

        if (canFreeReroute) {
          entry.walkReplans += 1;
          entry.phaseSince = now;
          entry.walkDeadline = now + walkBudgetMsForRouteLength(
            npcSimulation.getRemainingPathLengthWu(entry.bodyId) ?? 0,
          );
          // Episode deadline is deliberately NOT extended (M2).
          entry.lastRemainingWu = npcSimulation.getRemainingPathLengthWu(entry.bodyId);
          this.pushThought(
            entry,
            'observation',
            wedged ? 'Path blocked — re-routing to the same destination'
                   : 'Walk overran — re-routing to the same destination',
            now,
          );
        } else {
          // Terminal fallback — the pre-2026-07-26 full LLM re-decide.
          this.pushThought(entry, 'observation', 'Walk timed out — re-deciding', now);
          entry.phase = 'deciding';
          entry.targetBuildingId = null;
          entry.talkPrefetch = null;
          entry.phaseSince = now;
          entry.walkDeadline = 0;
          entry.walkEpisodeDeadline = 0;
          entry.walkReplans = 0;
          entry.lastRemainingWu = null;
        }
      }
    }
  }

  /**
   * Prompt the agent to CHOOSE a teacher by NEED (real inference from each
   * building's label + cryptoFocus), not nearest, and emit the exact
   * enter_building action tag the executor whitelist accepts.
   */
  buildDecisionPrompt(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    entry: HouseAgentEntry,
    recentLessons: string[] = [],
    directiveText: string | null = null,
    recentKnowledge: string[] = [],
    landTargets: AutonomousLandTargets = { claimable: [], owned: [] },
    questTargets: AutonomousQuestTarget[] = [],
    salvageTargets: AutonomousSalvageTargets = EMPTY_SALVAGE_TARGETS,
    buildTargets: AutonomousBuildTargets = EMPTY_AUTONOMOUS_BUILD_TARGETS,
    tradingDesk: AutonomousTradingDesk = EMPTY_TRADING_DESK,
    cosmeticTargets: AutonomousCosmeticTargets = EMPTY_AUTONOMOUS_COSMETIC_TARGETS,
  ): string {
    const now = Date.now();
    const options = perception.nearbyBuildings
      .map((b) => {
        const cooled = this.isTalkCooldownActive(entry.agentId, b.buildingId, now);
        return `- ${b.buildingId}: "${b.label}"${b.cryptoFocus ? ` — teaches ${b.cryptoFocus}` : ''}${cooled ? ' (you learned here very recently — pick somewhere else)' : ''}`;
      })
      .join('\n');
    const inRangePlaces = perception.places.filter(
      (place) => place.distance <= BUILDING_INTERACTION_RADIUS,
    );
    // Consumption mandate: the menu equals what the executor runs for THIS
    // actor. The executor refuses HOUSE_REFUSED_AUTONOMY_VERBS for a house
    // actor, so a house menu omits them, and it refuses a house actor for
    // play_cove_game(game=baccarat), so a house menu offers slots and
    // blackjack only. Every other entry gets the full menu.
    const actorMenu = HATCHER_ACTION_MENU
      .filter((action) => !entry.isHouse || !HOUSE_REFUSED_AUTONOMY_VERBS.has(action.verb))
      .map((action) =>
        entry.isHouse && action.verb === 'play_cove_game' ? HOUSE_PLAY_COVE_GAME_MENU_ITEM : action,
      );
    const covePlaySyntax = actorMenu.find(
      (action) => action.verb === 'play_cove_game',
    )!.syntax;
    const hereNow =
      inRangePlaces.length > 0
        ? [
            'You are HERE now (within range — act directly; do NOT enter again):',
            ...inRangePlaces.map((place) =>
              place.placeId === 'cove'
                ? `- ${place.label}: you can play right now — [ACTION: ${covePlaySyntax}]`
                : `- ${place.label}: you have arrived — you may act here now`,
            ),
          ]
        : [];
    const places = perception.places
      .map(
        (place) =>
          `- ${place.placeId}: "${place.label}" — ${place.description} — ${place.actionSyntax} — ${place.distance}wu away${place.distance <= BUILDING_INTERACTION_RADIUS ? ' (you are HERE — no need to enter again)' : ''}`,
      )
      .join('\n');
    const actionMenu = actorMenu
      .map((action) => `- ${action.syntax} — ${action.whenToUse}`)
      .join('\n');
    // The scope preamble also teaches two of those verbs by example syntax.
    const decisionScope = entry.isHouse
      ? DECISION_SCOPE.filter(
          (line) => ![...HOUSE_REFUSED_AUTONOMY_VERBS].some((verb) => line.includes(`[ACTION: ${verb}(`)),
        )
      : DECISION_SCOPE;
    const avoid = entry.lastBuildingId
      ? `\nYou just visited destination "${entry.lastBuildingId}" — avoid repeating it unless the directive requires it.`
      : '';
    // Slice 4 memory read-back: recent lessons + the last teacher reply shape
    // the next choice (learn what you DON'T know yet).
    const lessonLines: string[] = [];
    if (entry.lastLesson) lessonLines.push(`- (latest) ${entry.lastLesson}`);
    for (const lesson of recentLessons) {
      if (lessonLines.length >= 4) break;
      lessonLines.push(`- ${lesson.replace(/\s+/g, ' ').slice(0, LESSON_SNIPPET_MAX)}`);
    }
    const learned =
      lessonLines.length > 0
        ? `\nWhat you learned recently (avoid repeating — build on it or learn something NEW):\n${lessonLines.join('\n')}\n`
        : '';
    const knowledgeLines = recentKnowledge
      .slice(0, 3)
      .map(
        (knowledge) =>
          `- ${knowledge.replace(/\s+/g, ' ').slice(0, LESSON_SNIPPET_MAX)}`,
      );
    const knowledgeHeld =
      knowledgeLines.length > 0
        ? `\nKnowledge you already hold (from books and visits — apply it; prefer learning what you do NOT know):\n${knowledgeLines.join('\n')}\n`
        : '';
    const landBlock = [
      'Land targets (server-derived; copy parcelCode exactly):',
      'Owned parcels:',
      ...(landTargets.owned.length > 0
        ? landTargets.owned.map((parcel) =>
            `- ${parcel.displayName} (${parcel.parcelCode}): tier=${parcel.tier}, tenure=${parcel.tenure}, weeklyRent=${parcel.weeklyRentVclaw ?? 'none'} vCLAW, prepaidWeeks=${parcel.prepaidWeeksRemaining ?? 'n/a'}, holdThreshold=${parcel.holdThresholdClv ?? 'n/a'} CLV, grace=${parcel.grace}`,
          )
        : ['- none']),
      'Claimable parcels (nearest first):',
      ...(landTargets.claimable.length > 0
        ? landTargets.claimable.map((parcel) =>
            `- ${parcel.displayName} (${parcel.parcelCode}): tier=${parcel.tier}, holdThreshold=${parcel.holdThresholdClv ?? 'unavailable'} CLV, weeklyRent=${parcel.weeklyRentVclaw ?? 'unavailable'} vCLAW, distance=${parcel.distanceWu}wu`,
          )
        : ['- none available']),
    ].join('\n');
    // The claimable-quest block. Without it the agent can FORM a
    // `claim_tutorial_quest` call but cannot know which ids are valid — the
    // manual names only the four land quests. Server-derived, bounded, and
    // advisory: the executor re-runs the real proof-of-engagement gate, so an
    // unqualified suggestion costs one refused action, never a wrong payout.
    // Each line carries the exact call, like the cosmetics block: with only a
    // bare id the hosted model invented verbs (`claim_quest`, `complete_quest`,
    // dropped as not whitelisted on prod and staging 2026-10-22). Only a READY
    // quest (its proof already met) carries the call; an unfinished one is
    // listed with what is still missing and no call, because a listed call
    // invited blind claims (staging 2026-10-22: five `not_qualified` claims
    // while two finished quests sat unclaimed).
    const questUnit = (quest: AutonomousQuestTarget) => `${quest.reward} ${quest.rail === 'materials' ? 'materials' : 'vCLAW'}`;
    const questBlock = [
      'Claimable quests (server-derived; READY ones have their proof; copy one exact call):',
      ...(questTargets.length > 0
        ? [
            ...questTargets.map((quest) => (quest.ready
              ? `- [ACTION: claim_tutorial_quest(questId=${quest.questId})] READY "${quest.title}" pays ${questUnit(quest)}`
              : `- ${quest.questId}: "${quest.title}" pays ${questUnit(quest)} — not done yet: ${quest.requirement}`)),
            ...(questTargets.some((quest) => quest.ready)
              ? []
              : ['- none ready yet; do the step a quest requires first.']),
          ]
        : ['- none claimable right now']),
    ].join('\n');
    // The salvage block. Same reasoning as the quest block above, and the same
    // failure it prevents: `salvage_node` takes an id from a frozen 48-node
    // layout, so without this the model can form the call but cannot know a
    // single valid id. Nodes are listed READY-first then nearest, with the
    // caps, so "is another trip worth it" is answerable from the prompt.
    const salvageBlock = [
      `Salvage nodes (server-derived; copy nodeId exactly). You hold ${salvageTargets.materialBalance} materials; ${salvageTargets.claimsRemainingToday} claims left today (your account has ${salvageTargets.ownerClaimsRemainingToday} left across all its avatars):`,
      ...(salvageTargets.nodes.length > 0
        ? salvageTargets.nodes.map((node) =>
            `- ${node.nodeId} (${node.band}): distance=${node.distanceWu}wu, ${node.ready ? 'READY now' : `cooling until ${node.nextClaimAt}`}`,
          )
        : ['- none in range']),
      'Materials build home yards. salvage_node walks you there if you are far, then claims when you arrive — call it again on arrival.',
    ].join('\n');
    // Parcels with zero valid placements (full yard, drifted catalog row) are
    // omitted entirely — a header with no calls under it is prompt noise.
    const buildableParcels = buildTargets.parcels.filter(
      (parcel) => parcel.placements.length > 0,
    );
    const buildBlock = [
      `BUILD TARGETS (server-derived HOME-yard placements; copy one exact call). You hold ${buildTargets.materialBalance} materials; small pieces cost ${buildTargets.costs.small}, large pieces cost ${buildTargets.costs.large}:`,
      ...buildableParcels.flatMap((parcel) => [
        `- ${parcel.parcelCode} (HOME level ${parcel.structureLevel}):`,
        ...parcel.placements.map((placement) =>
          `  - ${placement.call} costs ${placement.costMaterials} materials`,
        ),
      ]),
      'If you lack materials for a piece, salvage_node gathers more.',
    ].join('\n');
    // The cosmetics block. equip_cosmetic / buy_cosmetic take a uuid the model
    // cannot guess, so list the valid ones (owned-but-unworn first, then the
    // cheapest buyable). Server-derived and advisory: the buy service re-runs
    // every check, so a stale row costs one refused action, never a wrong debit.
    // Omitted when both lists are empty and no buy lock is set (and always for
    // a house actor, which never sees these verbs). The daily buy cap (one
    // purchase per avatar per 24 hours) empties the buy list and says why, so
    // the model equips instead of guessing a uuid; the executor enforces it.
    const buyLockedUntil = cosmeticTargets.buyLockedUntil || null;
    const cosmeticBlock = [
      `Cosmetics (server-derived; copy skuId exactly). You hold ${cosmeticTargets.vclawBalance} vCLAW and ${cosmeticTargets.cosmeticCredit} cosmetic credit (credit pays first, then vCLAW):`,
      ...(cosmeticTargets.ownedUnequipped.length > 0
        ? [
            'Owned, not worn (free to wear):',
            ...cosmeticTargets.ownedUnequipped.map((item) =>
              `- [ACTION: equip_cosmetic(skuId=${item.skuId})] "${item.displayName}" (${item.category})`,
            ),
          ]
        : []),
      ...(cosmeticTargets.purchasable.length > 0
        ? [
            'Buyable (cheapest first):',
            ...cosmeticTargets.purchasable.map((item) =>
              `- [ACTION: buy_cosmetic(skuId=${item.skuId})] "${item.displayName}" (${item.category}) costs ${item.priceVclaw} vCLAW — ${item.creditCovers ? 'your credit covers it' : item.affordable ? 'you can afford it' : 'you cannot afford it yet'}`,
            ),
          ]
        : []),
      ...(buyLockedUntil
        ? [`This avatar bought a cosmetic in the last 24 hours (one buy per 24 hours); the next buy opens after ${buyLockedUntil}. Equip a cosmetic you own instead.`]
        : []),
    ].join('\n');
    const showCosmeticBlock = !entry.isHouse
      && (cosmeticTargets.ownedUnequipped.length > 0 || cosmeticTargets.purchasable.length > 0 || buyLockedUntil !== null);
    // P3 slice 2: the human's directive (top priority) + the wake-up event seed.
    // Both are conditional spreads so the prompt is byte-identical to pre-slice-2
    // when neither is present.
    const directiveBlock = formatDirectiveContext(directiveText); // '' when null/blank
    const tradingDeskBlock = formatAutonomousTradingDesk(tradingDesk);
    return [
      ...(directiveBlock ? [directiveBlock, ''] : []),
      ...decisionScope,
      '',
      directiveBlock
        ? "Directive rule: if the directive names an activity or destination satisfy it before learning. Fall back to a teacher only when the directive is about learning."
        : 'No human directive is active. Choose a useful action; visit a teacher when learning is the best next goal.',
      '',
      'Available actions (choose exactly one and copy its call syntax):',
      actionMenu,
      ...(tradingDeskBlock ? ['', tradingDeskBlock] : []),
      '',
      'Teachers (buildingId: name — focus):',
      options,
      avoid,
      learned,
      ...(knowledgeHeld ? [knowledgeHeld] : []),
      ...hereNow,
      landBlock,
      ...(salvageTargets.nodes.length > 0 ? [salvageBlock] : []),
      ...(buildableParcels.length > 0 ? [buildBlock] : []),
      ...(showCosmeticBlock ? ['', cosmeticBlock] : []),
      '',
      questBlock,
      '',
      'Places (placeId: name — purpose — exact action — distance):',
      places,
      '',
      ...(entry.recentEventSummary ? [`Since you last acted: ${entry.recentEventSummary}`, ''] : []),
      'Reply with one short reason sentence followed by exactly one [ACTION: ...] line.',
      'Use one available action and copy all ids and parameter names exactly.',
    ].join('\n');
  }

  // ── Slice 4 helpers ────────────────────────────────────────────────────────

  private cooldownKey(agentId: string, buildingId: string): string {
    return `${agentId}:${buildingId}`;
  }

  private isTalkCooldownActive(agentId: string, buildingId: string, now: number): boolean {
    const until = this.talkCooldownUntil.get(this.cooldownKey(agentId, buildingId));
    return until !== undefined && now < until;
  }

  private stampTalkCooldown(agentId: string, buildingId: string, now: number): void {
    // Bounded map: evict EXPIRED entries first when full; if still full (all
    // live), drop the oldest — a lost cooldown only risks an extra LLM call,
    // never a money leak (the daily CT probe is the money bound).
    if (this.talkCooldownUntil.size >= TALK_COOLDOWN_MAP_MAX) {
      for (const [k, until] of this.talkCooldownUntil) {
        if (now >= until) this.talkCooldownUntil.delete(k);
      }
      if (this.talkCooldownUntil.size >= TALK_COOLDOWN_MAP_MAX) {
        const oldest = this.talkCooldownUntil.keys().next().value;
        if (oldest !== undefined) this.talkCooldownUntil.delete(oldest);
      }
    }
    this.talkCooldownUntil.set(this.cooldownKey(agentId, buildingId), now + TALK_BUILDING_COOLDOWN_MS);
  }

  /** Sync read of the agent's prior questions to this teacher (oldest first). */
  private getPriorQuestions(agentId: string, buildingId: string): readonly string[] {
    return this.priorTalkQuestions.get(this.cooldownKey(agentId, buildingId)) ?? [];
  }

  /**
   * Record a question the agent asked this teacher. Called ONLY from the
   * arrived branch, after extractTalkMessage returned a message (so after the
   * prefetch was consumed and after the post-await fence). Normalized: all
   * whitespace collapses to single spaces, trimmed, capped at
   * PRIOR_TALK_QUESTION_MAX_CHARS. An equal prior entry moves to newest
   * instead of being stored twice. Bounded like stampTalkCooldown, but there
   * is no expiry here, so only the oldest-first drop applies.
   */
  private recordPriorQuestion(agentId: string, buildingId: string, raw: string): void {
    const question = raw.replace(/\s+/g, ' ').trim().slice(0, PRIOR_TALK_QUESTION_MAX_CHARS);
    if (!question) return;
    const key = this.cooldownKey(agentId, buildingId);
    const prior = this.priorTalkQuestions.get(key);
    const next = [...(prior ?? []).filter((q) => q !== question), question].slice(
      -PRIOR_TALK_QUESTIONS_MAX,
    );
    // delete + set keeps Map insertion order oldest-updated first for eviction.
    this.priorTalkQuestions.delete(key);
    if (this.priorTalkQuestions.size >= TALK_COOLDOWN_MAP_MAX) {
      const oldest = this.priorTalkQuestions.keys().next().value;
      if (oldest !== undefined) this.priorTalkQuestions.delete(oldest);
    }
    this.priorTalkQuestions.set(key, next);
  }

  /**
   * P3 slice 3 — fetch the agent's most recent EARNED-SKILL lessons via the
   * CONVERGED store: semantic RAG from the agent's OWN warmed ElizaOS runtime
   * (avatar-keyed, survives idle-despawn), falling back to the keyword store when
   * the runtime isn't warm (readEarnedSkillLessons owns that selection + the
   * D8 no-lazy-start guardrail). `queryHint` (the human's directive when set)
   * biases the retrieval; otherwise a generic learning query is used. Soft-timeout
   * + fail-soft: on ANY error/timeout return [] so a slow store can never stall
   * the decide tick (also keeps the DB-less unit tests fast — no warm runtime →
   * keyword fallback → [] on the missing DB).
   */
  private async readRecentLessons(
    entry: HouseAgentEntry,
    queryHint: string | null,
  ): Promise<string[]> {
    const query = queryHint && queryHint.trim().length > 0 ? queryHint : DEFAULT_LESSON_QUERY;
    try {
      return await new Promise<string[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), LESSON_RAG_TIMEOUT_MS);
        readEarnedSkillLessons({
          platformAgentId: entry.platformAgentId,
          avatarId: entry.avatarId,
          query,
          limit: 3,
        })
          .then((lessons) => {
            clearTimeout(timer);
            resolve(lessons);
          })
          .catch(() => {
            clearTimeout(timer);
            resolve([]);
          });
      });
    } catch {
      return [];
    }
  }

  /**
   * Fetch book/building-visit knowledge without lazy-starting a runtime. The
   * service owns warm-RAG versus authoritative JSONB fallback selection; this
   * driver adds the same per-read soft timeout used for earned-skill lessons.
   */
  private async readRecentKnowledge(
    entry: HouseAgentEntry,
    queryHint: string | null,
  ): Promise<string[]> {
    const query = queryHint && queryHint.trim().length > 0 ? queryHint : DEFAULT_LESSON_QUERY;
    try {
      return await new Promise<string[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), LESSON_RAG_TIMEOUT_MS);
        readHostedAgentKnowledge({
          platformAgentId: entry.platformAgentId,
          query,
          limit: 3,
        })
          .then((knowledge) => {
            clearTimeout(timer);
            resolve(knowledge);
          })
          .catch(() => {
            clearTimeout(timer);
            resolve([]);
          });
      });
    } catch {
      return [];
    }
  }

  /**
   * P3 slice 2 — read the agent's current directive (config.currentDirective),
   * raced against DIRECTIVE_FETCH_TIMEOUT_MS. Undefined means unavailable;
   * null means a successful read found no current directive.
   */
  private readDirectiveBounded(
    platformAgentId: string,
    entry?: HouseAgentEntry,
  ): Promise<CurrentDirective | null | undefined> {
    return new Promise<CurrentDirective | null | undefined>((resolve) => {
      let settled = false;
      const finish = (directive: CurrentDirective | null | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(directive);
      };
      const timer = setTimeout(() => finish(undefined), DIRECTIVE_FETCH_TIMEOUT_MS);
      this.directiveStateRead(platformAgentId)
        .then((state: AgentDirectiveState) => {
          if (settled) return;
          const currentDirectiveSha = state.directive
            ? directiveInstanceSha(state.directive)
            : null;
          if (entry && !entry.directiveShaHydrated) {
            entry.lastActedDirectiveSha = state.lastActedDirectiveSha;
            // An already-acted directive must suppress BOTH received and acted
            // after a deploy/re-seat, not just the acted half of the pair.
            entry.lastDirectiveSha = state.lastActedDirectiveSha;
            entry.directiveShaHydrated = true;
          } else if (
            entry &&
            currentDirectiveSha !== null &&
            state.lastActedDirectiveSha === currentDirectiveSha
          ) {
            // Another process may have claimed between our ticks. Reconcile the
            // coherent snapshot every successful read, not only on first seat.
            entry.lastDirectiveSha = currentDirectiveSha;
            entry.lastActedDirectiveSha = currentDirectiveSha;
          }
          const directive = state.directive;
          if (directive && isDirectiveExpired(directive)) {
            // Compare-and-clear the exact issuance. A newer chat-bar write that
            // races this fire-and-forget cleanup is preserved.
            void this.directiveClear(platformAgentId, directive).catch((err: unknown) => {
              console.warn(
                `[AutonomyDriver] expired directive cleanup failed for ${sessionDigest(platformAgentId)}:`,
                err instanceof Error ? err.message : err,
              );
            });
            finish(null);
            return;
          }
          finish(directive);
        })
        .catch(() => {
          finish(undefined);
        });
    });
  }

  /** Persist the acted issuance under the same fail-soft deadline as its read. */
  private claimActedDirectiveShaBounded(
    entry: HouseAgentEntry,
    directiveSha: string,
    directive: CurrentDirective,
  ): Promise<DirectiveActedClaim | 'unknown'> {
    return new Promise<DirectiveActedClaim | 'unknown'>((resolve) => {
      let settled = false;
      const finish = (result: DirectiveActedClaim | 'unknown') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish('unknown'), DIRECTIVE_FETCH_TIMEOUT_MS);
      this.directiveActedShaClaim(entry.platformAgentId, directiveSha, directive)
        .then((result) => finish(result))
        .catch((err: unknown) => {
          console.warn(
            `[AutonomyDriver] directive acted marker failed for ${sessionDigest(entry.agentId)}:`,
            err instanceof Error ? err.message : err,
          );
          finish('unknown');
        });
    });
  }

  /**
   * P3 slice 2 — ONE-TIME wake-up seed. Read the durable whitelisted events since
   * the persisted cursor (config.autonomyCursor), summarize them into the next
   * decision prompt, and advance the cursor. Runs exactly once per process
   * lifetime per agent (guarded by `cursorSeeded`). Fully bounded + fail-soft:
   * the guard is set BEFORE the read so a failure can't retry-spin, and a
   * timed-out cursor read aborts WITHOUT advancing (so a degraded DB never
   * corrupts the cursor forward).
   */
  private async seedFromCursorOnce(entry: HouseAgentEntry): Promise<void> {
    if (entry.cursorSeeded) return;
    entry.cursorSeeded = true;
    // Owner-period scope (security pass 2026-10-04): the row owner this entry was
    // enrolled under (house user for a house agent, the owner for a user agent).
    // The query re-checks it against the row's CURRENT owner and returns only
    // that owner's period (openclaw_bots.owner_since), so the agent a new owner
    // talks to is never seeded with a prior owner's directives or settlements,
    // and a stale entry whose row moved to another owner reads nothing.
    const seed = await this.seedRead(entry.platformAgentId, {
      agentId: entry.agentId,
      ownerUserId: entry.houseUserId,
    });
    if (seed) {
      entry.recentEventSummary = seed.summary;
      // Advance + persist the cursor so a restart resumes from here. Fail-soft:
      // a failed write just re-reads the same window next start (idempotent seed).
      await setAutonomyCursor(entry.platformAgentId, seed.maxId).catch(() => {});
    }
  }

  /**
   * Bounded read of {cursor → durable events → summary + max id}, or null on
   * timeout/error/empty. The whole cursor+query pair is inside ONE timeout so a
   * partial (cursor read OK, event read hung) can't advance the cursor on stale
   * data — null aborts the seed and leaves the cursor untouched.
   *
   * Resume from the NEWEST tail, not the oldest gap: we fetch the newest ≤20
   * whitelisted rows since the cursor (DESC) so the summary reflects RECENT
   * activity (seasoning, not a transcript), and advance the cursor to the TRUE
   * max id (`newestFirst[0].id`) so a restart with a large backlog does not
   * re-walk the skipped older events one window at a time.
   */
  private seedRead(
    platformAgentId: string,
    scope: AgentHistoryScope,
  ): Promise<{ summary: string; maxId: bigint } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), SEED_FETCH_TIMEOUT_MS);
      (async () => {
        const cursor = await getAutonomyCursor(platformAgentId);
        const newestFirst = await queryDurableAgentEventsNewest(
          scope,
          cursor ?? 0n,
          SEED_EVENT_LIMIT,
        );
        if (newestFirst.length === 0) return null;
        // DESC → [0] is the global max id since the cursor; re-sort ascending
        // (oldest→newest) so the summary reads chronologically.
        const maxId = newestFirst[0]!.id;
        const ascending = [...newestFirst].reverse();
        return { summary: summarizeAutonomyEvents(ascending), maxId };
      })()
        .then((r) => {
          clearTimeout(timer);
          resolve(r);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  /**
   * Prompt the agent to converse with the teacher it has arrived at. The
   * message must be a single short clause WITHOUT commas or parentheses — the
   * [ACTION:] param parser splits on `,` and ends the action at `)`.
   *
   * `priorQuestions` (founder 2026-10-22) is the agent's own earlier questions
   * to this teacher (getPriorQuestions, a sync read). When non-empty, a block
   * listing them and asking for a different part of the topic follows the
   * "ask ONE focused question" line. When empty, the prompt is byte-identical
   * to the pre-2026-10-22 prompt. The list changes only at the talk mutation
   * point (recordPriorQuestion); map eviction can also drop it, and then the
   * byte-equality check at arrival rejects the prefetch and asks again.
   */
  private buildTalkPrompt(
    buildingId: string,
    label: string | undefined,
    cryptoFocus: string | undefined,
    priorQuestions: readonly string[],
  ): string {
    const priorBlock = priorQuestions.length > 0
      ? [
        'You already asked this teacher:',
        ...priorQuestions.map((q) => `- ${q}`),
        'Ask about a DIFFERENT part of the topic. Do not repeat or rephrase these questions.',
      ]
      : [];
    return [
      `You have arrived at "${label ?? buildingId}"${cryptoFocus ? `, which teaches ${cryptoFocus}` : ''}.`,
      'Greet the teacher and ask ONE focused question about their topic.',
      ...priorBlock,
      'Reply with EXACTLY this action tag (the message must be a single short clause',
      'with NO commas and NO parentheses):',
      `[ACTION: talk_to_npc(buildingId=${buildingId}, message=your short question here)]`,
    ].join('\n');
  }

  /**
   * Race a decision against a hard timeout so a hung/slow model can never block
   * the tick. On timeout we resolve to '' (the executor drops an empty reply
   * safely) rather than reject, so the .catch in tick() only logs genuine errors.
   */
  private withTimeout(p: Promise<string>): Promise<string> {
    return new Promise<string>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[AutonomyDriver] decision timed out after ${LLM_TIMEOUT_MS}ms`);
        resolve('');
      }, LLM_TIMEOUT_MS);
      p.then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          console.warn(
            `[AutonomyDriver] decision errored:`,
            err instanceof Error ? err.message : err,
          );
          resolve('');
        },
      );
    });
  }
}

export const agentAutonomyDriver = new AgentAutonomyDriver();

/** Minimal read-only seam consumed by the DB canary watchdog. */
export function getDriverLivenessSnapshot(): {
  enrolledCount: number;
  lastTickAt: number | null;
} {
  return agentAutonomyDriver.getLivenessSnapshot();
}
