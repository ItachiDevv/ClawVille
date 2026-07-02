/**
 * Agent Autonomy Driver (agent-metaverse P1 slice 3)
 * ──────────────────────────────────────────────────
 * The perceive → decide → act loop for ClawVille-HOSTED "house" agents — the
 * first member of the eventual autonomous fleet. It runs on its OWN ~30s
 * interval, SEPARATE from the 200ms NpcSimulation tick, so a slow LLM brain can
 * NEVER stall the shared single-threaded world sim.
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
 *   - Money: this driver NEVER settles CT (slice 4 deferred). The executor it
 *     calls does not touch the ledger.
 *   - Leak: logs use `sessionDigest(agentId)` — NEVER the raw agentId/sessionId.
 *
 * NOT money/leaderboard: slice 4 (award on a proximity-passed conversed turn)
 * is deferred — the agent earns NOTHING this dispatch. The visible walk +
 * conversation is the non-money loop P1 proves.
 */

import { BUILDING_INTERACTION_RADIUS } from '@clawville/shared';
import { npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { sessionDigest } from './session-digest';

/** Per-agent phase in the perceive→decide→act loop. */
type DrivePhase = 'deciding' | 'walking' | 'arrived' | 'talking';

interface HouseAgentEntry {
  /** Stable public agent id (openclaw_bots.agent_id). */
  agentId: string;
  /** In-world body id (`ocb-<base64url(agentId)>`) — the sim/perception key. */
  bodyId: string;
  /** platform_agents.id whose warmed ElizaOS runtime backs the decision. */
  platformAgentId: string;
  phase: DrivePhase;
  /** epoch-ms the current phase was entered (for walk/talk timeouts). */
  phaseSince: number;
  /** Building the agent is walking toward / conversing at (null when deciding). */
  targetBuildingId: string | null;
  /** Last building chosen — favor variety, don't re-pick immediately. */
  lastBuildingId: string | null;
}

/** A single decision generator — real LLM in prod, canned in tests. */
type DecideFn = (prompt: string) => Promise<string>;

// Cadence + safety constants.
const TICK_MS = 30_000; // driver interval — NOT the 200ms sim tick
const LLM_TIMEOUT_MS = 15_000; // hard ceiling on one decision
const WALK_TIMEOUT_MS = 120_000; // give up walking + replan if not arrived
const TALK_COOLDOWN_MS = 60_000; // linger after a conversation before re-deciding
const IDLE_DECIDE_EVERY = 4; // when no humans: only LLM-decide every Nth tick
const MAX_HOUSE_AGENTS = 64; // bound the registry
const DECIDE_MAX_TOKENS = 200;

class AgentAutonomyDriver {
  private houseAgents = new Map<string, HouseAgentEntry>(); // agentId -> entry
  private inFlight = new Set<string>(); // agentIds mid-decision (overlap guard)
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;

  /**
   * Register a boot-seeded house agent for autonomous driving. Bounded: past
   * MAX_HOUSE_AGENTS the registration is dropped (loudly) rather than growing
   * the map unbounded. Idempotent per agentId (re-register replaces).
   */
  registerHouseAgent(entry: {
    agentId: string;
    bodyId: string;
    platformAgentId: string;
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
      bodyId: entry.bodyId,
      platformAgentId: entry.platformAgentId,
      phase: 'deciding',
      phaseSince: Date.now(),
      targetBuildingId: null,
      lastBuildingId: null,
    });
    console.log(
      `[AutonomyDriver] registered house agent ${sessionDigest(entry.agentId)} (${this.houseAgents.size} total)`,
    );
    return true;
  }

  unregisterHouseAgent(agentId: string): void {
    this.houseAgents.delete(agentId);
    this.inFlight.delete(agentId);
  }

  /** Server-side enumeration of the active house agent ids (never on the wire). */
  getHouseAgentIds(): string[] {
    return [...this.houseAgents.keys()];
  }

  hasHouseAgent(agentId: string): boolean {
    return this.houseAgents.has(agentId);
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
   * One driver tick. Fires each house agent's drive fire-and-forget (never
   * awaited — a slow brain must not delay the next agent or the next tick). The
   * in-flight guard skips an agent whose previous decision is still running.
   */
  private tick(): void {
    this.tickCount++;
    // Idle-throttle: when the world is empty, only run the LLM-bearing decision
    // cadence every IDLE_DECIDE_EVERY ticks (cheap walk/cooldown polls still run
    // every tick so the body keeps arriving / cooling down). This is a per-tick
    // gate, not a per-agent one, so it is O(1) here.
    const humansPresent = npcSimulation.getActiveHumanCount() > 0;
    const throttledIdle = !humansPresent && this.tickCount % IDLE_DECIDE_EVERY !== 0;

    for (const entry of this.houseAgents.values()) {
      if (this.inFlight.has(entry.agentId)) continue;
      const runtime = agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
      if (!runtime) continue; // runtime not warmed yet — try next tick
      this.inFlight.add(entry.agentId);
      void this.driveOnce(entry.agentId, (prompt) =>
        this.withTimeout(runtime.decide(prompt, { maxTokens: DECIDE_MAX_TOKENS })),
      )
        .catch((err) =>
          console.error(
            `[AutonomyDriver] drive failed for ${sessionDigest(entry.agentId)}:`,
            err instanceof Error ? err.message : err,
          ),
        )
        .finally(() => this.inFlight.delete(entry.agentId));
      // NOTE: throttledIdle only suppresses the LLM-bearing phases INSIDE
      // driveOnce (via the flag passed below) — walking/cooldown polls are free
      // and always run so the body keeps progressing.
      void throttledIdle;
    }
  }

  /**
   * Drive ONE house agent through one step of the phase machine. Exposed
   * (agentId + injectable `decide`) so tests can drive it with a canned reply
   * instead of a live model. Production passes the timeout-wrapped runtime
   * decider. `throttledIdle` (default false) suppresses the LLM-bearing phases
   * when the world is empty; the cheap walking/cooldown polls always run.
   */
  async driveOnce(
    agentId: string,
    decide: DecideFn,
    throttledIdle = false,
  ): Promise<void> {
    const entry = this.houseAgents.get(agentId);
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

    // Phase: walking — cheap arrival poll, NO llm.
    if (entry.phase === 'walking') {
      if (this.hasArrived(perception, entry)) {
        entry.phase = 'arrived';
        entry.phaseSince = now;
      } else if (now - entry.phaseSince > WALK_TIMEOUT_MS) {
        // Stuck / no progress — abandon this target and replan next tick.
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

    // Beyond here every phase calls the LLM — honor the idle throttle.
    if (throttledIdle) return;

    // Phase: arrived → converse with the teacher (LLM). The proximity gate in
    // executeHatcherAction PASSES because we only reach 'arrived' once within
    // BUILDING_INTERACTION_RADIUS of the target.
    if (entry.phase === 'arrived' && entry.targetBuildingId) {
      const building = perception.nearbyBuildings.find(
        (b) => b.buildingId === entry.targetBuildingId,
      );
      const prompt = this.buildTalkPrompt(entry.targetBuildingId, building?.label, building?.cryptoFocus);
      const reply = await decide(prompt);
      npcSimulation.dispatchHatcherActions(entry.bodyId, reply);
      entry.phase = 'talking';
      entry.phaseSince = now;
      return;
    }

    // Phase: deciding (default) → choose a teacher by need + walk (LLM).
    const prompt = this.buildDecisionPrompt(perception, entry);
    const reply = await decide(prompt);
    npcSimulation.dispatchHatcherActions(entry.bodyId, reply);
    // Learn the CHOSEN target from the body itself: enter_building →
    // setNpcPath(..., buildingId) stamps destinationBuildingId. If the reply
    // emitted no valid enter_building (invalid/garbage id dropped by the
    // executor), destinationBuildingId stays null → we retry deciding next tick.
    const body = npcSimulation.getNpcById(entry.bodyId);
    const chosen = body?.destinationBuildingId ?? null;
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
    if (!building) return false;
    return building.distance <= BUILDING_INTERACTION_RADIUS;
  }

  /**
   * Prompt the agent to CHOOSE a teacher by NEED (real inference from each
   * building's label + cryptoFocus), not nearest, and emit the exact
   * enter_building action tag the executor whitelist accepts.
   */
  private buildDecisionPrompt(
    perception: NonNullable<ReturnType<typeof npcSimulation.buildPerception>>,
    entry: HouseAgentEntry,
  ): string {
    const options = perception.nearbyBuildings
      .map(
        (b) =>
          `- ${b.buildingId}: "${b.label}"${b.cryptoFocus ? ` — teaches ${b.cryptoFocus}` : ''}`,
      )
      .join('\n');
    const avoid = entry.lastBuildingId
      ? `\nYou just visited "${entry.lastBuildingId}" — favor a DIFFERENT teacher to broaden your skills.`
      : '';
    return [
      'You are an autonomous agent living in ClawVille, a world of teaching buildings.',
      'You want to LEARN. Choose the ONE teacher whose focus is most useful for you to learn next.',
      '',
      'Teachers (buildingId: name — focus):',
      options,
      avoid,
      '',
      'Reply with ONE short sentence about what you want to learn, then EXACTLY this action tag',
      'with the buildingId you chose (copy an id verbatim from the list):',
      '[ACTION: enter_building(buildingId=<one of the ids above>)]',
    ].join('\n');
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
