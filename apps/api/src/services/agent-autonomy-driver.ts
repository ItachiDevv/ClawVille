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
  /** system user id that owns the platform_agents row — for lazy runtime warm. */
  systemUserId: string;
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
}

/** A single decision generator — real LLM in prod, canned in tests. */
type DecideFn = (prompt: string) => Promise<string>;

// Cadence + safety constants.
const TICK_MS = 30_000; // driver interval — NOT the 200ms sim tick
const LLM_TIMEOUT_MS = 15_000; // hard ceiling on one decision
const WALK_TIMEOUT_MS = 120_000; // give up walking + replan if not arrived
const TALK_COOLDOWN_MS = 60_000; // linger after a conversation before re-deciding
const MAX_HOUSE_AGENTS = 64; // bound the registry
const DECIDE_MAX_TOKENS = 200;
// R2: if a runtime warm has been in-flight longer than this, evict it from the
// `warming` map so a fresh warm can launch — a never-settling warm must not wedge
// the agent bodyless forever behind the overlap guard.
const WARM_WATCHDOG_MS = 90_000;
// R4: consecutive empty decide() replies past this threshold WARN — a persistent
// empty (OpenAI 429 / quota exhausted / bad key) otherwise spins the deciding phase
// silently, since withTimeout maps a timeout/error to '' by contract.
const EMPTY_DECIDE_WARN_THRESHOLD = 3;

class AgentAutonomyDriver {
  private houseAgents = new Map<string, HouseAgentEntry>(); // agentId -> entry
  private inFlight = new Set<string>(); // agentIds mid-decision (overlap guard)
  private warming = new Map<string, number>(); // agentId -> warmingSince ms (overlap guard + R2 watchdog)
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
    systemUserId: string;
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
      systemUserId: entry.systemUserId,
      phase: 'deciding',
      phaseSince: Date.now(),
      targetBuildingId: null,
      lastBuildingId: null,
      consecutiveEmptyDecides: 0,
    });
    console.log(
      `[AutonomyDriver] registered house agent ${sessionDigest(entry.agentId)} (${this.houseAgents.size} total)`,
    );
    return true;
  }

  unregisterHouseAgent(agentId: string): void {
    this.houseAgents.delete(agentId);
    this.inFlight.delete(agentId);
    this.warming.delete(agentId);
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
    // Human-presence INDEPENDENT cadence: the agent runs the SAME decision loop
    // whether or not a human is in the world. ClawVille's premise is that hosted
    // agents ARE the living economy — they must act continuously with ZERO
    // external users present, not dial themselves down when nobody is watching
    // (founder, 2026-07-02). Cost is controlled by the tick cadence + the planned
    // migration to open-source/free decision models, NOT by gating on humans.
    for (const entry of this.houseAgents.values()) {
      if (this.inFlight.has(entry.agentId)) continue;
      const runtime = agentOrchestrator.getRunningAgentRuntime(entry.platformAgentId);
      if (!runtime) {
        // Brain not warmed yet. The seeder no longer warms at boot (that raced a
        // 30s plugin-init timeout in the boot crush and could leave the agent
        // bodyless). LAZY-warm HERE, off the boot crush, on the driver's own tick
        // — fire-and-forget + a `warming` overlap guard so a slow/failed warm
        // NEVER blocks the tick loop or launches duplicate warms. Skip driving
        // this tick; retry next tick once the runtime is ready. `{isHouse:true}`
        // preserves the inactivity-sweep exemption through the lazy path.
        // R2: warming watchdog. A never-settling warm (its `.finally` never fires)
        // would keep the agentId in `warming` forever, permanently blocking the
        // overlap guard below so a fresh warm can never launch → the agent wedges
        // bodyless. If a warm has been in-flight past WARM_WATCHDOG_MS, evict it so
        // THIS tick relaunches. (R1 now makes ensureAgentRuntime REJECT on a hung
        // init, so the `.finally` should fire — this watchdog is belt-and-suspenders.)
        const warmingSince = this.warming.get(entry.agentId);
        if (
          warmingSince !== undefined &&
          Date.now() - warmingSince > WARM_WATCHDOG_MS
        ) {
          console.warn(
            `[AutonomyDriver] warm watchdog: ${sessionDigest(entry.agentId)} stuck warming ${Math.round((Date.now() - warmingSince) / 1000)}s (> ${WARM_WATCHDOG_MS}ms) — evicting stale warm, relaunching`,
          );
          this.warming.delete(entry.agentId);
        }
        if (!this.warming.has(entry.agentId)) {
          const warmToken = Date.now();
          this.warming.set(entry.agentId, warmToken);
          void agentOrchestrator
            .ensureAgentRuntime(entry.platformAgentId, entry.systemUserId, { isHouse: true })
            .catch((err) =>
              console.warn(
                `[AutonomyDriver] runtime warm failed for ${sessionDigest(entry.agentId)} — retry next tick:`,
                err instanceof Error ? err.message : err,
              ),
            )
            .finally(() => {
              // Compare-and-delete: only clear if THIS warm is still current. A
              // watchdog eviction may have replaced it with a newer warm whose
              // timestamp we must not clobber (else a duplicate warm could launch).
              if (this.warming.get(entry.agentId) === warmToken) {
                this.warming.delete(entry.agentId);
              }
            });
        }
        continue;
      }
      // TEMP DEBUG (agent-metaverse-p1 silent-'deciding' diagnosis, 2026-07-01):
      // one line per drive so a SILENT success path is observable — confirms the
      // drive is reached with a LIVE runtime (rules out candidate b) + the
      // throttle state. Stripped by the follow-up parse fix.
      console.log(
        `[AutonomyDriver][debug] drive t=${this.tickCount} ${sessionDigest(entry.agentId)} phase=${entry.phase} runtime=yes`,
      );
      this.inFlight.add(entry.agentId);
      void this.driveOnce(
        entry.agentId,
        (prompt) => this.withTimeout(runtime.decide(prompt, { maxTokens: DECIDE_MAX_TOKENS })),
      )
        .catch((err) =>
          console.error(
            `[AutonomyDriver] drive failed for ${sessionDigest(entry.agentId)}:`,
            err instanceof Error ? err.message : err,
          ),
        )
        .finally(() => this.inFlight.delete(entry.agentId));
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

    // Phase: arrived → converse with the teacher (LLM). The proximity gate in
    // executeHatcherAction PASSES because we only reach 'arrived' once within
    // BUILDING_INTERACTION_RADIUS of the target.
    if (entry.phase === 'arrived' && entry.targetBuildingId) {
      const building = perception.nearbyBuildings.find(
        (b) => b.buildingId === entry.targetBuildingId,
      );
      const prompt = this.buildTalkPrompt(entry.targetBuildingId, building?.label, building?.cryptoFocus);
      const reply = await decide(prompt);
      // TEMP DEBUG (see above): the RAW talk reply — reveals whether gpt-4o-mini
      // emits a parseable [ACTION: talk_to_npc(...)] tag.
      console.log(
        `[AutonomyDriver][debug] talk ${sessionDigest(entry.agentId)} replyLen=${reply.length} reply=${JSON.stringify(reply.slice(0, 240))}`,
      );
      npcSimulation.dispatchHatcherActions(entry.bodyId, reply);
      entry.phase = 'talking';
      entry.phaseSince = now;
      return;
    }

    // Phase: deciding (default) → choose a teacher by need + walk (LLM).
    const prompt = this.buildDecisionPrompt(perception, entry);
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
      entry.consecutiveEmptyDecides++;
      if (entry.consecutiveEmptyDecides >= EMPTY_DECIDE_WARN_THRESHOLD) {
        console.warn(
          `[AutonomyDriver] ${sessionDigest(entry.agentId)} model returned empty ${entry.consecutiveEmptyDecides} times in a row — check OPENAI_API_KEY / quota / 429`,
        );
      }
    } else {
      entry.consecutiveEmptyDecides = 0;
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
    // Learn the CHOSEN target from the body itself: enter_building →
    // setNpcPath(..., buildingId) stamps destinationBuildingId. If the reply
    // emitted no valid enter_building (invalid/garbage id dropped by the
    // executor), destinationBuildingId stays null → we retry deciding next tick.
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
    if (!building) return false;
    // Edge-distance (footprint), NOT center-distance — the same metric the
    // interaction gates use. Center-distance is unsatisfiable for the larger
    // buildings, so a center-based hasArrived would leave the driver walking
    // forever (then WALK_TIMEOUT replans) and never reach 'arrived'/'talking'.
    return building.edgeDistance <= BUILDING_INTERACTION_RADIUS;
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
