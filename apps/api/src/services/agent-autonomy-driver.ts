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
 *     the conducted teacher turn (each turn is a gpt-4o call carrying the
 *     teacher's full skill corpus; the once-per-day CT probe does NOT bound
 *     LLM cost by itself).
 *   - Memory is behaviorally LIVE, not inert: the ~3 most relevant earned-skill
 *     lessons (P3 slice 3 — semantic RAG from the agent's OWN ElizaOS runtime,
 *     keyword-store fallback when cold) are folded into the decide prompt, and
 *     the teacher's latest reply feeds the next decision context.
 *   - Leak: logs use `sessionDigest(agentId)` — NEVER the raw agentId/sessionId.
 */

import {
  BUILDING_INTERACTION_RADIUS,
  BUILDING_OPENCLAW_THEMES,
  AUTONOMY_ENTERABLE_PLACES,
  DECISION_SCOPE,
  HATCHER_ACTION_MENU,
  MAP_LOCATIONS,
  type AutonomyStatusResponse,
  type AutonomyStatusThought,
} from '@clawville/shared';
import { createHash } from 'crypto';
import { npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { sessionDigest } from './session-digest';
import { readEarnedSkillLessons } from './earned-skill-memory';
import { conductTeacherTurn, settleBuildingArrival } from './world-teacher-chat';
import {
  getAgentDirective,
  getAutonomyCursor,
  setAutonomyCursor,
  formatDirectiveContext,
  summarizeAutonomyEvents,
  type CurrentDirective,
} from './agent-autonomy-state';
import { queryDurableAgentEventsNewest } from './agent-event-query';
import { recordCovenantAction } from './covenant-action-recorder';
import { resolveBuildingId } from './building-center';

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
  /** Last directive content hash observed (text itself never enters a record). */
  lastDirectiveSha: string | null;
  /** Last directive hash for which a parsed action was recorded. */
  lastActedDirectiveSha: string | null;
  /** A new human directive landed and has not yet been consumed by a decide. */
  directivePending: boolean;
}

/** A single decision generator — real LLM in prod, canned in tests. */
type DecideFn = (prompt: string) => Promise<string>;

// Cadence + safety constants.
const TICK_MS = 30_000; // driver interval — NOT the 200ms sim tick
// §B.1 durable autonomy — run the server-side re-enrollment reconcile every N
// driver ticks (10 × 30s = ~5 min), AND on tick 1 (~30s after start/boot) so a
// deploy re-enrolls browser-closed persisting agents promptly with no client.
// The periodic cadence also heals a crash mid-teardown. The reconcile carries its
// own overlap guard, so a slow pass never stacks.
const RECONCILE_EVERY_N_TICKS = 10;
const LLM_TIMEOUT_MS = 15_000; // hard ceiling on one decision
const WALK_TIMEOUT_MS = 120_000; // give up walking + replan if not arrived
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
// Slice 4 LLM-spend bound: a conducted teacher turn is a gpt-4o call carrying the
// teacher's FULL skill corpus, and the once-per-day CT probe does NOT bound LLM
// cost by itself — so each (agentId, buildingId) pair may conduct at most one
// turn per hour. In-memory (resets on restart — acceptable; the daily CT probe
// is the money bound), bounded by TALK_COOLDOWN_MAP_MAX with expired-first eviction.
const TALK_BUILDING_COOLDOWN_MS = 60 * 60 * 1000;
// §B.1: sized for BOTH registries — (house + user caps) × ~12 buildings of
// headroom, floored at the pre-§B.1 1024 so a small user cap can never SHRINK
// the bound below what the house fleet was already provisioned for.
const TALK_COOLDOWN_MAP_MAX = Math.max(
  1024,
  (MAX_HOUSE_AGENTS + MAX_AUTONOMOUS_USER_AGENTS) * 12,
);
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

interface ParsedDriverAction {
  verb: string;
  params: Record<string, string>;
}

function parseDriverAction(reply: string): ParsedDriverAction | null {
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

function decisionThought(action: ParsedDriverAction): string {
  switch (action.verb) {
    case 'enter_cove':
    case 'enter_poker_room':
      return 'Heading to the Cove';
    case 'enter_kelp_forest':
      return 'Heading to the Kelp Forest';
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
  private warming = new Map<string, number>(); // agentId -> warmingSince ms (overlap guard + R2 watchdog)
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  // Slice 4: `${agentId}:${buildingId}` -> epoch-ms until which conducted
  // teacher turns at that building are suppressed (LLM-spend bound).
  private talkCooldownUntil = new Map<string, number>();

  // Slice 4 seams — instance properties (not bare imports) so the unit tests can
  // swap in mocks (settle-only-on-reply + cooldown are tested without a DB/LLM).
  // Production values are the real world-teacher-chat functions.
  teacherTurn: typeof conductTeacherTurn = conductTeacherTurn;
  arrivalSettle: typeof settleBuildingArrival = settleBuildingArrival;
  covenantRecord: typeof recordCovenantAction = recordCovenantAction;

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
      lastBuildingId: null,
      consecutiveEmptyDecides: 0,
      lastLesson: null,
      cursorSeeded: false,
      recentEventSummary: null,
      recentThoughts: [],
      lastDirectiveSha: null,
      lastActedDirectiveSha: null,
      directivePending: false,
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
    if (!this.houseAgents.delete(agentId)) return;
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
      lastBuildingId: null,
      consecutiveEmptyDecides: 0,
      lastLesson: null,
      cursorSeeded: false,
      recentEventSummary: null,
      recentThoughts: [],
      lastDirectiveSha: null,
      lastActedDirectiveSha: null,
      directivePending: false,
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
    if (!this.userAgents.delete(agentId)) return;
    // The owning async drive/warm releases these guards. Clearing them during a
    // quick Controlled→Autonomous re-register would permit same-id overlap.
    for (const [ownerUserId, enrolledAgentId] of this.enrolledOwners) {
      if (enrolledAgentId === agentId) this.enrolledOwners.delete(ownerUserId);
    }
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
      let runtime = agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
      if (!runtime) runtime = await this.warmRuntimeBounded(entry);
      if (!runtime) return false;

      console.log(
        `[AutonomyDriver][debug] drive t=${this.tickCount} ${sessionDigest(entry.agentId)} phase=${entry.phase} runtime=yes`,
      );
      await this.driveOnce(
        entry.agentId,
        (prompt) => this.withTimeout(runtime.decide(prompt, {
          maxTokens: DECIDE_MAX_TOKENS,
          localAttemptTimeoutMs: 6_000,
        })),
      );
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
   * Kick the actively-enrolled agent for an owner after a new directive lands.
   * The expected platform id prevents a stale/rebound enrollment from consuming
   * a directive written to a different agent row.
   */
  kickEnrolledOwnerNow(ownerUserId: string, expectedPlatformAgentId: string): boolean {
    const agentId = this.enrolledOwners.get(ownerUserId);
    const entry = agentId ? this.userAgents.get(agentId) : null;
    if (!agentId || !entry || entry.platformAgentId !== expectedPlatformAgentId) return false;
    entry.directivePending = true;
    void this.driveAgentNow(agentId).catch((err) =>
      console.error(
        `[AutonomyDriver] directive kick failed for ${sessionDigest(agentId)}:`,
        err instanceof Error ? err.message : err,
      ),
    );
    return true;
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
    this.interval = setInterval(() => this.tick(), TICK_MS);
    console.log(`[AutonomyDriver] started — driving every ${TICK_MS}ms`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
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
    try {
      const { reconcileDurableAutonomy } = await import('./agent-autonomy-reconcile');
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
    this.tickCount++;
    // §B.1 durable autonomy: re-enroll persisted-flag agents with NO client.
    // Tick 1 (~30s after start) covers the "on driver start" case (a deploy
    // re-enrolls away-agents promptly); every RECONCILE_EVERY_N_TICKS after also
    // heals a crash mid-teardown. Fire-and-forget — a slow DB read must never
    // delay the drive loop; the reconcile module guards its own overlap.
    if (this.tickCount % RECONCILE_EVERY_N_TICKS === 1) {
      void this.runReconcile();
    }
    // Human-presence INDEPENDENT cadence: the agent runs the SAME decision loop
    // whether or not a human is in the world. ClawVille's premise is that hosted
    // agents ARE the living economy — they must act continuously with ZERO
    // external users present, not dial themselves down when nobody is watching
    // (founder, 2026-07-02). Cost is controlled by the tick cadence + the planned
    // migration to open-source/free decision models, NOT by gating on humans.
    // §B.1: drive BOTH registries — house fleet first (unchanged order), then
    // user-owned enrollments. Same phase machine, same guards; the ONLY
    // house/user divergence inside the loop is the warm flag (`entry.isHouse`).
    for (const entry of [...this.houseAgents.values(), ...this.userAgents.values()]) {
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
      // Body not in world (e.g. transient despawn). A boot re-register re-spawns
      // it; nothing to drive this tick. Reset to deciding so we replan on return.
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      return;
    }

    const now = Date.now();

    // P5: a fresh human directive outranks the autonomous plan — interrupt the
    // current walk/linger/arrival and replan NOW instead of waiting out the
    // phase machine (measured 30-180s of dead time without this).
    if (entry.directivePending && entry.phase !== 'deciding') {
      this.pushThought(entry, 'directive', 'New directive — replanning now', now);
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      entry.phaseSince = now;
    }

    // Phase: walking — cheap arrival poll, NO llm.
    if (entry.phase === 'walking') {
      if (this.hasArrived(perception, entry)) {
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
          // Slice 4: settle only a TEACHING-BUILDING arrival. Places such as the
          // cove are visible navigation outcomes, never teacher settlement.
          void this.arrivalSettle({
            agentId: entry.agentId,
            bodyId: entry.bodyId,
            avatarId: entry.avatarId,
            buildingId: entry.targetBuildingId,
          }).catch((err) =>
            console.warn(
              `[AutonomyDriver] arrival settle failed for ${sessionDigest(entry.agentId)}:`,
              err instanceof Error ? err.message : err,
            ),
          );
        } else {
          // A non-teaching destination (cove / poker room) has been reached.
          // Linger without another LLM call, then return to deciding; never emit
          // an invalid talk_to_npc(buildingId=cove) or teacher reward.
          entry.phase = 'talking';
          entry.phaseSince = now;
          // Retain the reached place through the talking/linger phase so the
          // owner HUD truthfully reads "At the Cove" until the next re-decide.
        }
      } else if (now - entry.phaseSince > WALK_TIMEOUT_MS) {
        // Stuck / no progress — abandon this target and replan next tick.
        this.pushThought(entry, 'observation', 'Walk timed out — re-deciding', now);
        entry.phase = 'deciding';
        entry.targetBuildingId = null;
        entry.phaseSince = now;
      }
      return; // walking never calls the LLM
    }

    // Phase: talking cooldown — NO llm.
    if (entry.phase === 'talking') {
      if (now - entry.phaseSince < TALK_COOLDOWN_MS) return;
      entry.phase = 'deciding';
      entry.targetBuildingId = null;
      entry.phaseSince = now;
    }

    // Phase: arrived → converse with the teacher (LLM). The proximity gate in
    // executeHatcherAction PASSES because we only reach 'arrived' once within
    // BUILDING_INTERACTION_RADIUS of the target.
    if (entry.phase === 'arrived' && entry.targetBuildingId) {
      const buildingId = entry.targetBuildingId;
      // Slice 4 LLM-spend bound: at most one CONDUCTED turn per (agent, building)
      // per hour. On cooldown → skip the talk LLM entirely (no question, no
      // teacher call), linger, then re-decide (the decision prompt lists the
      // cooled-down teachers so the agent favors somewhere new).
      if (this.isTalkCooldownActive(entry.agentId, buildingId, now)) {
        console.log(
          `[AutonomyDriver][debug] talk skipped (cooldown) ${sessionDigest(entry.agentId)} building=${buildingId}`,
        );
        entry.phase = 'talking';
        entry.phaseSince = now;
        return;
      }
      const building = perception.nearbyBuildings.find(
        (b) => b.buildingId === buildingId,
      );
      const prompt = this.buildTalkPrompt(buildingId, building?.label, building?.cryptoFocus);
      const reply = await decide(prompt);
      // TEMP DEBUG (see above): the RAW talk reply — reveals whether gpt-4o-mini
      // emits a parseable [ACTION: talk_to_npc(...)] tag.
      console.log(
        `[AutonomyDriver][debug] talk ${sessionDigest(entry.agentId)} replyLen=${reply.length} reply=${JSON.stringify(reply.slice(0, 240))}`,
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
        const turn = await this.teacherTurn({
          agentId: entry.agentId,
          bodyId: entry.bodyId,
          avatarId: entry.avatarId,
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
    // current directive as a top-priority bias. All three are soft-timeout +
    // fail-soft — a slow/absent DB must never stall the tick.
    await this.seedFromCursorOnce(entry);
    // P3 slice 3: read the directive FIRST so it can bias the semantic-RAG lesson
    // retrieval (lessons relevant to what the human asked surface first); both
    // reads are bounded + fail-soft so a slow store never stalls the tick.
    const directive = await this.readDirectiveBounded(entry.platformAgentId);
    entry.directivePending = false;
    let directiveSha: string | null = null;
    if (directive?.text) {
      directiveSha = createHash('sha256').update(directive.text, 'utf8').digest('hex');
      if (directiveSha !== entry.lastDirectiveSha) {
        // Stamp before the best-effort write: an outage must not cause repeated
        // record attempts on every tick or block decision-making.
        entry.lastDirectiveSha = directiveSha;
        this.pushThought(
          entry,
          'directive',
          `Directive: "${directive.text.slice(0, 80)}"`,
        );
        await this.recordDriverAction(entry, 'agent.directive.received', {
          directiveSha256: directiveSha,
          len: directive.text.length,
        });
      }
    }
    const lessons = await this.readRecentLessons(entry, directive?.text ?? null);
    const prompt = this.buildDecisionPrompt(perception, entry, lessons, directive?.text ?? null);
    const reply = await decide(prompt);
    // TEMP DEBUG (see tick()): the RAW decision reply — the smoking gun for
    // candidate (a). If this has content but no [ACTION: enter_building(...)] the
    // executor recognizes, the parse — not the model call — is the stall.
    console.log(
      `[AutonomyDriver][debug] decide ${sessionDigest(entry.agentId)} replyLen=${reply.length} reply=${JSON.stringify(reply.slice(0, 240))}`,
    );
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
    if (parsedAction) {
      this.pushThought(entry, 'decision', decisionThought(parsedAction), now);
      if (directiveSha && entry.lastActedDirectiveSha !== directiveSha) {
        entry.lastActedDirectiveSha = directiveSha;
        await this.recordDriverAction(entry, 'agent.directive.acted', {
          directiveSha256: directiveSha,
          action: parsedAction.verb,
        });
      }
    }
    // N3: clear any STALE destination from a PRIOR turn BEFORE dispatching, so
    // post-dispatch destinationBuildingId is non-null ONLY if THIS turn's
    // enter_building actually succeeded. Without this, a dropped enter_building
    // (e.g. no path found) would leave a stale value and the driver would
    // "walk" to a building it did not choose this turn. A valid enter_building
    // re-stamps the field via setNpcPath; a re-pick of the same building still
    // works (it is simply re-set).
    npcSimulation.clearDestinationBuilding(entry.bodyId);
    npcSimulation.dispatchHatcherActions(entry.bodyId, reply);
    // Learn the CHOSEN destination from the body itself. enter_building stamps a
    // teacher id; gateway verbs stamp their shared place destination. move/emote/talk do
    // not stamp a destination and deliberately leave the phase at `deciding`
    // for the next steady tick after their visible one-shot effect.
    const body = npcSimulation.getNpcById(entry.bodyId);
    const chosen = body?.destinationBuildingId ?? null;
    // TEMP DEBUG (see tick()): did dispatch stamp a destination? destSet=false with
    // a non-empty reply above ⇒ candidate (a) (no parseable enter_building) OR (c)
    // (a valid tag that dispatchHatcherActions no-op'd for the ocb- body).
    console.log(
      `[AutonomyDriver][debug] postDispatch ${sessionDigest(entry.agentId)} destinationBuildingId=${chosen ?? 'null'}`,
    );
    if (chosen) {
      entry.phase = 'walking';
      entry.phaseSince = now;
      entry.targetBuildingId = chosen;
      entry.lastBuildingId = chosen;
    }
  }

  /** True once the body is within the interaction radius of its target building. */
  private hasArrived(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    entry: HouseAgentEntry,
  ): boolean {
    if (!entry.targetBuildingId) return false;
    const building = perception.nearbyBuildings.find(
      (b) => b.buildingId === entry.targetBuildingId,
    );
    if (building) {
      // Edge-distance (footprint), NOT center-distance — the same metric the
      // interaction gates use. Center-distance is unsatisfiable for the larger
      // buildings, so a center-based hasArrived would leave the driver walking
      // forever (then WALK_TIMEOUT replans) and never reach 'arrived'/'talking'.
      return building.edgeDistance <= BUILDING_INTERACTION_RADIUS;
    }
    // Shared places (Cove, poker, Kelp portal) resolve through the same
    // destinationId + center-derived distance contract.
    const place = perception.places.find(
      (candidate) => candidate.destinationId === entry.targetBuildingId,
    );
    return place ? place.distance <= BUILDING_INTERACTION_RADIUS : false;
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
  ): string {
    const now = Date.now();
    const options = perception.nearbyBuildings
      .map((b) => {
        const cooled = this.isTalkCooldownActive(entry.agentId, b.buildingId, now);
        return `- ${b.buildingId}: "${b.label}"${b.cryptoFocus ? ` — teaches ${b.cryptoFocus}` : ''}${cooled ? ' (you learned here very recently — pick somewhere else)' : ''}`;
      })
      .join('\n');
    const places = perception.places
      .map((place) =>
        `- ${place.placeId}: "${place.label}" — ${place.description} — ${place.actionSyntax} — ${place.distance}wu away`,
      )
      .join('\n');
    const actionMenu = HATCHER_ACTION_MENU
      .map((action) => `- ${action.syntax} — ${action.whenToUse}`)
      .join('\n');
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
    // P3 slice 2: the human's directive (top priority) + the wake-up event seed.
    // Both are conditional spreads so the prompt is byte-identical to pre-slice-2
    // when neither is present.
    const directiveBlock = formatDirectiveContext(directiveText); // '' when null/blank
    return [
      ...(directiveBlock ? [directiveBlock, ''] : []),
      ...DECISION_SCOPE,
      '',
      directiveBlock
        ? "Directive rule: if the directive names an activity or destination satisfy it before learning. Fall back to a teacher only when the directive is about learning."
        : 'No human directive is active. Choose a useful action; visit a teacher when learning is the best next goal.',
      '',
      'Available actions (choose exactly one and copy its call syntax):',
      actionMenu,
      '',
      'Teachers (buildingId: name — focus):',
      options,
      avoid,
      learned,
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
   * P3 slice 2 — read the agent's current directive (config.currentDirective),
   * raced against DIRECTIVE_FETCH_TIMEOUT_MS. Null on timeout/error so a slow or
   * absent DB never stalls or breaks a decide tick.
   */
  private readDirectiveBounded(platformAgentId: string): Promise<CurrentDirective | null> {
    return new Promise<CurrentDirective | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), DIRECTIVE_FETCH_TIMEOUT_MS);
      getAgentDirective(platformAgentId)
        .then((d) => {
          clearTimeout(timer);
          resolve(d);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
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
    const seed = await this.seedRead(entry.platformAgentId, entry.agentId);
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
    agentId: string,
  ): Promise<{ summary: string; maxId: bigint } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), SEED_FETCH_TIMEOUT_MS);
      (async () => {
        const cursor = await getAutonomyCursor(platformAgentId);
        const newestFirst = await queryDurableAgentEventsNewest(
          agentId,
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
   */
  private buildTalkPrompt(
    buildingId: string,
    label?: string,
    cryptoFocus?: string,
  ): string {
    return [
      `You have arrived at "${label ?? buildingId}"${cryptoFocus ? `, which teaches ${cryptoFocus}` : ''}.`,
      'Greet the teacher and ask ONE focused question about their topic.',
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
