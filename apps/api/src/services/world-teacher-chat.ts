/**
 * World teacher chat + arrival settle (agent-metaverse P1 slice 4).
 *
 * The REAL conversed teacher turn for an AUTONOMOUS (house/fleet) agent — until
 * this, the driver's talk was a one-way bubble: NO teacher reply, NO CT, NO
 * leaderboard event, NO memory. `conductTeacherTurn` closes the loop with the
 * SAME pieces the connected-agent gateway path uses (`/building/:id/chat` in
 * routes/agent-gateway.ts is the template):
 *
 *   1. PROXIMITY re-check SERVER-SIDE, fail closed (the anti-abuse backbone:
 *      no walk/proximity → no interaction → no reward) — mirrors the
 *      executeHatcherAction talk_to_npc gate (npc-simulation.ts).
 *   2. Teacher reply via the SAME engine: getSystemNpcAgent(buildingId) →
 *      agentOrchestrator.ensureAgentRuntime → runtime.processMessage. NOTE the
 *      eliza-runtime roomId quirk: non-UUID roomIds are IGNORED and the room is
 *      derived from (teacherAgentId, userKey) — passing `userId: <house agentId>`
 *      already yields a stable per-(teacher, agent) room, so we pass NO roomId.
 *   3. VISIBLE in-world: the teacher's reply bubble via injectAgentChat on the
 *      teacher's live sim body IF one exists. The 10 building residents are
 *      client-rendered (arena-location-npcs.tsx) and have NO server sim body
 *      today (NPC_DEFINITIONS are all free wanderers, buildingId=''), so we
 *      probe `npcs.get(buildingId)` (the historical resident keying) and SKIP
 *      the bubble when absent — the turn still settles.
 *   4. SETTLE, all three legs, ONLY on a successful (proximity-passed,
 *      genuinely conversed) reply:
 *      a. CT — the SHARED `creditBuildingRewardOncePerDay` (building-reward.ts),
 *         SAME reason 'building_chat_teaching' + amount (1) as the connected
 *         path: identical economics = parity; the daily probe makes
 *         double-dipping impossible. DEFAULT (soft) provenance via
 *         creditClawTokens — NEVER mintEarned (external-USDC only).
 *      b. Leaderboard — direct `logEvent` (the documented no-HTTP path, fp/ip
 *         null) with the EXISTING 'agent.chat.turn' event type (weight 10, cap
 *         50/day — no new event type, no new CTE column). payload.isHouse=true
 *         is what the public-board carve-out (leaderboard.ts) keys on.
 *      c. Memory — an EARNED-SKILL lesson (teacher + buildingId + a short lesson
 *         summary) CONVERGED onto the agent's OWN ElizaOS runtime (avatar-keyed,
 *         embedded — survives idle-despawn) via `recordEarnedSkillLesson`, with
 *         the avatar-keyed keyword store as the not-warm/embed-failed fallback
 *         (P3 slice 3). The agent's prior lessons for this building are also
 *         FOLDED into the teacher's context (step 2) so it builds on them.
 *
 * `settleBuildingArrival` is the sibling for the driver's ARRIVAL at a building
 * (the autonomy path emitted NEITHER the 'building.visited' event NOR the
 * 'building_visit' once-per-day credit — why 0 autonomous building.visited rows
 * existed in all history).
 *
 * FAIL-SOFT EVERYWHERE: every failure (null runtime, throw, empty reply, ledger
 * error) returns null / degrades — it must NEVER crash the driver tick. Logs use
 * `sessionDigest(agentId)`, never a raw id.
 *
 * DEPENDENCY RULE: imports services only — NO route modules (agent-gateway.ts
 * throws at module load without FINGERPRINT_SECRET).
 */

import {
  BUILDING_INTERACTION_RADIUS,
  BUILDING_OPENCLAW_THEMES,
  buildingEdgeDistanceGamePx,
} from '@clawville/shared';
import { npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { getSystemNpcAgent } from './system-npc-seeder';
import { logEvent } from './event-logger';
import { creditBuildingRewardOncePerDay } from './building-reward';
import { resolveBuildingCenter } from './building-center';
import { sessionDigest } from './session-digest';
import { recordEarnedSkillLesson, readEarnedSkillLessons } from './earned-skill-memory';

/** Teacher reply bubble cap — keep in-world speech readable, not a wall. */
const TEACHER_BUBBLE_MAX = 220;
/** Lesson-summary cap for the earned-skill memory row (1–2 lines from the reply). */
const LESSON_SUMMARY_MAX = 240;
/**
 * P3 slice 3 — bound the "prior lessons" fold read so a slow/absent memory store
 * can never stall or fail a teacher turn (the read embeds a query + runs a vector
 * search; on timeout we simply teach without the fold). Fail-soft to [].
 */
const FOLD_FETCH_TIMEOUT_MS = 2_500;
/** Cap how many prior lessons fold into the teacher's context (seasoning, not a transcript). */
const FOLD_LESSON_LIMIT = 3;

export interface TeacherTurnInput {
  /** Stable house agent id (openclaw_bots.agent_id) — the leaderboard subject. */
  agentId: string;
  /** In-world body id (`ocb-…`) — the sim/proximity key. */
  bodyId: string;
  /** avatars.id the CT settles to (the dedicated house user's avatar). */
  avatarId: string;
  /**
   * P3 slice 3 — platform_agents.id whose warmed ElizaOS runtime backs the
   * LEARNING agent. Used to (a) fold this agent's OWN prior earned-skill lessons
   * for this building into the teacher's context and (b) converge the new lesson
   * onto its ElizaOS runtime (avatar-keyed, survives despawn). Optional so a
   * legacy caller without it still settles — it just skips the fold and lands the
   * lesson in the avatar-keyed keyword fallback instead.
   */
  platformAgentId?: string;
  buildingId: string;
  /** The agent's question/message to the teacher. */
  message: string;
}

export interface TeacherTurnResult {
  /** The teacher's full reply text. */
  reply: string;
  teacherName: string;
  /** 1 iff the once-per-day 'building_chat_teaching' credit fired this turn. */
  tokenAwarded: 0 | 1;
}

/**
 * Fail-closed proximity check shared by both settle entry points. Returns the
 * body's edge-distance to the building, or null when the check cannot pass
 * (missing body, unknown building, out of radius) — null means NO interaction.
 */
function proximityPassed(
  agentId: string,
  bodyId: string,
  buildingId: string,
  what: string,
): boolean {
  const body = npcSimulation.getNpcById(bodyId);
  if (!body) {
    console.warn(
      `[WorldTeacherChat] ${what} dropped — body missing for ${sessionDigest(agentId)}`,
    );
    return false;
  }
  // Own-property guard (prototype-key CT-farm defense — same class as the
  // gateway routes): an unknown/inherited key never resolves.
  if (!resolveBuildingCenter(buildingId)) {
    console.warn(
      `[WorldTeacherChat] ${what} dropped — unknown building "${buildingId}" for ${sessionDigest(agentId)}`,
    );
    return false;
  }
  // Edge-distance to the collider FOOTPRINT, the same metric every interaction
  // gate uses (center-distance is unsatisfiable for the larger buildings).
  const dist = buildingEdgeDistanceGamePx(body.x, body.y, buildingId) ?? Infinity;
  if (dist > BUILDING_INTERACTION_RADIUS) {
    console.warn(
      `[WorldTeacherChat] ${what} gated — ${sessionDigest(agentId)} is ${Math.round(dist)}wu from "${buildingId}" (need <=${BUILDING_INTERACTION_RADIUS}wu)`,
    );
    return false;
  }
  return true;
}

/**
 * P3 slice 3 — bounded, fail-soft read of the agent's OWN prior earned-skill
 * lessons for a building, for the teacher-context fold. Raced against
 * FOLD_FETCH_TIMEOUT_MS: on timeout/error return [] so a slow memory store (the
 * read embeds a query + runs a vector search) never stalls or fails the turn.
 */
async function foldPriorLessons(
  platformAgentId: string,
  avatarId: string,
  buildingId: string,
  query: string,
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => resolve([]), FOLD_FETCH_TIMEOUT_MS);
    readEarnedSkillLessons({ platformAgentId, avatarId, buildingId, query, limit: FOLD_LESSON_LIMIT })
      .then((lessons) => {
        clearTimeout(timer);
        resolve(lessons);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve([]);
      });
  });
}

/**
 * One REAL conversed teacher turn for an autonomous agent. Returns the teacher's
 * reply on success (settled: CT + leaderboard + memory), or null on ANY failure
 * (no reward, never throws).
 */
export async function conductTeacherTurn(
  input: TeacherTurnInput,
): Promise<TeacherTurnResult | null> {
  const { agentId, bodyId, avatarId, buildingId, platformAgentId } = input;
  const message = input.message.trim();
  if (!message) return null;

  try {
    // 1. Proximity — fail closed. No walk → no interaction → no reward.
    if (!proximityPassed(agentId, bodyId, buildingId, 'teacher turn')) return null;

    // 2. Teacher reply via the SAME engine the connected-agent path uses.
    const system = await getSystemNpcAgent(buildingId);
    if (!system || !system.locationAgent.platformAgentId) {
      console.warn(
        `[WorldTeacherChat] no system teacher for "${buildingId}" — skipping turn for ${sessionDigest(agentId)}`,
      );
      return null;
    }
    const runtime = await agentOrchestrator.ensureAgentRuntime(
      system.locationAgent.platformAgentId,
      system.systemUserId,
    );
    if (!runtime) {
      console.warn(
        `[WorldTeacherChat] teacher runtime unavailable for "${buildingId}" — skipping turn for ${sessionDigest(agentId)}`,
      );
      return null;
    }

    const body = npcSimulation.getNpcById(bodyId);
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    const contextParts: string[] = [];
    if (theme) {
      contextParts.push(
        `You are teaching an autonomous agent about ${theme.focus}. Use your knowledge base to give a grounded, specific answer — cite concrete patterns, commands, or examples from your SKILL.md knowledge when relevant.`,
      );
    }
    contextParts.push(
      `The visitor is an autonomous in-world agent named "${body?.name ?? 'an agent'}" who walked to your building to learn. Treat them as a peer agent capable of absorbing technical detail. Keep the reply short and teachable.`,
    );

    // P3 slice 3 — fold the agent's OWN prior earned-skill lessons for THIS
    // building into the teacher's context so it BUILDS ON prior lessons instead
    // of repeating them. This is the measurable "use" of the converged memory:
    // a lesson written on a previous turn (surviving idle-despawn) shapes the
    // next turn's teaching. Bounded + fail-soft — a slow read never stalls the
    // turn (it just teaches without the fold).
    if (platformAgentId) {
      const priorLessons = await foldPriorLessons(platformAgentId, avatarId, buildingId, message);
      if (priorLessons.length > 0) {
        contextParts.push(
          `This agent has already learned the following from you here — build on it, teach ` +
            `something NEW or go deeper, do NOT repeat:\n${priorLessons
              .map((l) => `- ${l}`)
              .join('\n')}`,
        );
      }
    }

    let reply: string;
    try {
      const response = await runtime.processMessage(message, {
        // roomId quirk (eliza-runtime.ts): non-UUID roomIds are IGNORED and the
        // room derives from (teacherAgentId, userKey) — the house agentId as
        // userId already yields a stable per-(teacher, agent) room. Don't fight it.
        userId: agentId,
        platform: 'clawville-world-autonomous',
        dynamicContext: contextParts.join('\n'),
        state: { nearLocation: buildingId },
        conversational: true,
        // Cost win (P1 slice 4): a house teacher turn carries the teacher's full
        // merged SKILL.md corpus — run it on TEXT_SMALL (gpt-4o-mini) rather than
        // the default TEXT_LARGE (gpt-4o). Verified-safe: the reply is short,
        // teachable text, not a reasoning-heavy generation.
        modelType: 'TEXT_SMALL',
      });
      reply = (response.content ?? '').trim();
    } catch (err) {
      console.warn(
        `[WorldTeacherChat] teacher runtime errored for "${buildingId}" (${sessionDigest(agentId)}):`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    if (!reply) return null; // empty reply = not a conversed turn → no reward

    const teacherName = system.locationAgent.agentName;

    // 3. VISIBLE in-world — the teacher's reply bubble, IF the building resident
    // has a live sim body (keyed by buildingId). Today the 10 residents are
    // client-rendered only, so this usually skips; the turn continues regardless.
    const teacherBody = npcSimulation.getNpcById(buildingId);
    if (teacherBody) {
      npcSimulation.injectAgentChat(buildingId, reply.slice(0, TEACHER_BUBBLE_MAX));
    }

    // 4a. CT — the SHARED once-per-day credit (identical to the connected path:
    // same reason, same amount 1, same probe key). Fail-soft: a ledger error
    // costs the token, not the turn.
    let tokenAwarded: 0 | 1 = 0;
    try {
      tokenAwarded = (await creditBuildingRewardOncePerDay({
        avatarId,
        buildingId,
        reason: 'building_chat_teaching',
        metadata: {
          buildingId,
          agentId,
          characterName: teacherName,
          via: 'world-autonomous',
        },
      }))
        ? 1
        : 0;
    } catch (err) {
      console.error('[WorldTeacherChat] teacher-chat CT credit failed:', err);
    }

    // 4b. Leaderboard — the EXISTING agent.chat.turn scoring (weight 10, cap
    // 50/day). Direct logEvent (no HTTP context ⇒ fp/ip null). isHouse:true is
    // the public-board carve-out key.
    // ⚠️ With fpHash/ipPrefixHash null, the fp/ip-keyed anti-farm tagging is a
    // no-op for these rows — the isHouse carve-out (routes/leaderboard.ts) is
    // the SOLE gate keeping them off the public board. Any future change that
    // drops the carve-out silently exposes an uncapped scoring faucet here.
    void logEvent({
      eventType: 'agent.chat.turn',
      agentId,
      avatarId,
      buildingId,
      payload: {
        chatType: 'world-autonomous',
        isHouse: true,
        // ctAwarded, NOT tokenAwarded: event-logger.ts sanitize() redacts any
        // payload key containing the word 'token' → '[REDACTED]', so a
        // `tokenAwarded` key would land as write-only garbage.
        ctAwarded: tokenAwarded,
        characterName: teacherName,
        messageLength: message.length,
      },
    });

    // 4c. Memory — the agent LEARNED something. P3 slice 3 CONVERGENCE: write to
    // the agent's OWN ElizaOS runtime (avatar-keyed, embedded — survives the
    // body idle-despawn that killed the old bodyId-keyed npc_memories write),
    // with the avatar-keyed keyword store as the not-running/embed-failed
    // fallback. Fire-and-forget + fail-soft: a memory failure never costs the
    // turn's CT/leaderboard settlement.
    const lessonSummary = reply.replace(/\s+/g, ' ').slice(0, LESSON_SUMMARY_MAX);
    void recordEarnedSkillLesson({
      platformAgentId: platformAgentId ?? '',
      avatarId,
      agentId,
      buildingId,
      teacherName,
      lesson: `${teacherName} at ${theme?.label ?? buildingId} taught me: ${lessonSummary}`,
    }).catch(() => {});

    return { reply, teacherName, tokenAwarded };
  } catch (err) {
    // Belt-and-suspenders: NOTHING in this service may crash the driver tick.
    console.error(
      `[WorldTeacherChat] teacher turn failed for ${sessionDigest(agentId)}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export interface BuildingArrivalInput {
  agentId: string;
  bodyId: string;
  avatarId: string;
  buildingId: string;
}

/**
 * Settle an autonomous agent's ARRIVAL at a building: the 'building.visited'
 * leaderboard event + the once-per-day 'building_visit' CT credit — the exact
 * pair the connected-agent `/visit-building` route emits, which the autonomy
 * path emitted NEITHER of before slice 4. Proximity re-checked fail-closed.
 * Never throws (fail-soft; the driver fires it fire-and-forget).
 */
export async function settleBuildingArrival(input: BuildingArrivalInput): Promise<void> {
  const { agentId, bodyId, avatarId, buildingId } = input;
  try {
    if (!proximityPassed(agentId, bodyId, buildingId, 'arrival settle')) return;

    let tokenAwarded: 0 | 1 = 0;
    try {
      tokenAwarded = (await creditBuildingRewardOncePerDay({
        avatarId,
        buildingId,
        reason: 'building_visit',
        metadata: { buildingId, agentId, via: 'world-autonomous' },
      }))
        ? 1
        : 0;
    } catch (err) {
      console.error('[WorldTeacherChat] building-visit CT credit failed:', err);
    }

    // Same caveat as 4b above: fp/ip null ⇒ the isHouse carve-out is the sole
    // public-board gate for this row.
    void logEvent({
      eventType: 'building.visited',
      agentId,
      avatarId,
      buildingId,
      // ctAwarded, NOT tokenAwarded: the event-logger sanitizer redacts any
      // 'token'-containing payload key → '[REDACTED]'.
      payload: { isHouse: true, ctAwarded: tokenAwarded, via: 'autonomous' },
    });
  } catch (err) {
    console.error(
      `[WorldTeacherChat] arrival settle failed for ${sessionDigest(agentId)}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
