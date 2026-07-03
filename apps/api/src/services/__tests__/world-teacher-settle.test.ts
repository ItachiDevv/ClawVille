/**
 * Agent-metaverse P1 slice 4 — the autonomous settle loop.
 *
 * Locks, without a DB or live LLM (the driver's `teacherTurn` / `arrivalSettle`
 * instance seams are mocked):
 *   1. SETTLE-ONLY-ON-REPLY — the driver conducts the teacher turn with the
 *      parsed talk message; a SUCCESSFUL turn stamps the per-(agent, building)
 *      60-min cooldown + feeds the lesson into the next decision context; a
 *      FAILED turn (null) stamps NOTHING (retry allowed).
 *   2. COOLDOWN — a second arrival at the same building within the window skips
 *      the talk LLM entirely (decide never called) AND conducts no turn.
 *   3. NO PARSEABLE TAG — no talk_to_npc message in the reply ⇒ no turn.
 *   4. ARRIVAL SETTLE — the walking→arrived transition fires the arrival settle
 *      (building.visited + once-per-day building_visit CT) with the dedicated
 *      avatarId, and walking stays LLM-free.
 *   5. extractTalkMessage parse contract (mirrors the executor's param split).
 *   6. FAIL-CLOSED PROXIMITY in world-teacher-chat: a far / missing body / bad
 *      building conducts NOTHING (returns null before any DB call).
 *   7. LEADERBOARD CARVE-OUT SHAPE — both CTEs in routes/leaderboard.ts exclude
 *      house agents via a DURABLE subject-level JOIN against openclaw_bots.is_house
 *      (the FLAG itself, not a payload tag — a forgotten emitter tag can never
 *      rank a house agent). Source-level lock; no query-shape harness for the SQL.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NPC_BUILDING_CENTERS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver, extractTalkMessage } from '../agent-autonomy-driver';
import { conductTeacherTurn, settleBuildingArrival } from '../world-teacher-chat';
import type { TeacherTurnInput, TeacherTurnResult, BuildingArrivalInput } from '../world-teacher-chat';

type Sim = {
  npcs: Map<string, any>;
  openClawBots: Map<string, any>;
  npcOverrides: Map<string, string>;
  pendingEvents: any[];
  initNpcs: () => void;
};
const asSim = () => npcSimulation as unknown as Sim;

type DriverInternals = {
  houseAgents: Map<string, any>;
  talkCooldownUntil: Map<string, number>;
  teacherTurn: (input: TeacherTurnInput) => Promise<TeacherTurnResult | null>;
  arrivalSettle: (input: BuildingArrivalInput) => Promise<void>;
};
const asDriver = () => agentAutonomyDriver as unknown as DriverInternals;

function makeBody(id: string, x: number, y: number) {
  return {
    id,
    name: 'Coralia-Test',
    x,
    y,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [] as string[],
    activity: 'idle',
    activityEmoji: '',
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: 'idle',
    species: 'milady_official_1',
    isOpenClaw: true,
    autonomyMode: 'self-managed' as const,
    inConversation: false,
    conversationCooldownUntil: 0,
    invulnerableUntil: 0,
    path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0,
    destinationBuildingId: null as string | null,
    behaviorCooldown: 0,
  };
}

function registerBody(bodyId: string, sessionId: string, x: number, y: number) {
  const sim = asSim();
  const npc = makeBody(bodyId, x, y);
  sim.npcs.set(bodyId, npc);
  sim.openClawBots.set(sessionId, {
    config: { agentId: bodyId, mode: 'avatar' },
    client: { getProtocol: () => 'nanoclaw' },
  });
  sim.npcOverrides.set(bodyId, sessionId);
  return npc;
}

function registerHouse(bodyId: string) {
  agentAutonomyDriver.registerHouseAgent({
    agentId: bodyId,
    bodyId,
    platformAgentId: `pa-${bodyId}`,
    systemUserId: `sys-${bodyId}`,
    houseUserId: `hu-${bodyId}`,
    avatarId: `av-${bodyId}`,
  });
  return asDriver().houseAgents.get(bodyId);
}

const TARGET = 'api-integrations';
const REAL_TEACHER_TURN = asDriver().teacherTurn;
const REAL_ARRIVAL_SETTLE = asDriver().arrivalSettle;

beforeEach(() => {
  (npcSimulation as unknown as { stop: () => void }).stop();
  asSim().initNpcs();
  asSim().openClawBots.clear();
  asSim().npcOverrides.clear();
  asSim().pendingEvents = [];
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  asDriver().talkCooldownUntil.clear();
  asDriver().teacherTurn = REAL_TEACHER_TURN;
  asDriver().arrivalSettle = REAL_ARRIVAL_SETTLE;
});

describe('slice 4 — driver conducts + settles the teacher turn', () => {
  it('conducts the turn with the parsed message; success stamps the cooldown + the lesson feeds the next decision', async () => {
    const bodyId = 'ocb-s4-a';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-a', center.x + 100, center.y);
    const entry = registerHouse(bodyId);
    entry.phase = 'arrived';
    entry.targetBuildingId = TARGET;

    const turns: TeacherTurnInput[] = [];
    asDriver().teacherTurn = async (input) => {
      turns.push(input);
      return { reply: 'Lesson: webhooks beat polling for event-driven APIs.', teacherName: 'Sandy', tokenAwarded: 1 };
    };

    await agentAutonomyDriver.driveOnce(
      bodyId,
      async () => `Hello! [ACTION: talk_to_npc(buildingId=${TARGET}, message=teach me about webhooks)]`,
    );

    expect(turns.length).toBe(1);
    expect(turns[0]).toMatchObject({
      agentId: bodyId,
      bodyId,
      avatarId: `av-${bodyId}`,
      buildingId: TARGET,
      message: 'teach me about webhooks',
    });
    expect(entry.phase).toBe('talking');
    expect(entry.lastLesson).toContain('webhooks');
    // Cooldown stamped → a re-arrival at the SAME building conducts nothing and
    // never calls the LLM.
    entry.phase = 'arrived';
    entry.targetBuildingId = TARGET;
    let decideCalled = 0;
    await agentAutonomyDriver.driveOnce(bodyId, async () => {
      decideCalled++;
      return '';
    });
    expect(decideCalled).toBe(0); // cooldown skips the talk LLM entirely
    expect(turns.length).toBe(1); // no second conducted turn
    expect(entry.phase).toBe('talking');
  });

  it('a FAILED turn (null) stamps NO cooldown — the next arrival retries', async () => {
    const bodyId = 'ocb-s4-b';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-b', center.x + 100, center.y);
    const entry = registerHouse(bodyId);

    let turnCalls = 0;
    asDriver().teacherTurn = async () => {
      turnCalls++;
      return null; // teacher runtime down / empty reply → NOT a conversed turn
    };

    for (let i = 0; i < 2; i++) {
      entry.phase = 'arrived';
      entry.targetBuildingId = TARGET;
      await agentAutonomyDriver.driveOnce(
        bodyId,
        async () => `[ACTION: talk_to_npc(buildingId=${TARGET}, message=hello teacher)]`,
      );
    }
    expect(turnCalls).toBe(2); // no cooldown on failure → retried
    expect(entry.lastLesson).toBeNull(); // nothing learned, nothing fed back
  });

  it('no parseable talk_to_npc message ⇒ NO conducted turn (no settle path reached)', async () => {
    const bodyId = 'ocb-s4-c';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-c', center.x + 100, center.y);
    const entry = registerHouse(bodyId);
    entry.phase = 'arrived';
    entry.targetBuildingId = TARGET;

    let turnCalls = 0;
    asDriver().teacherTurn = async () => {
      turnCalls++;
      return null;
    };

    await agentAutonomyDriver.driveOnce(bodyId, async () => 'Just musing, no action tag.');
    expect(turnCalls).toBe(0);
    expect(entry.phase).toBe('talking'); // phase machine still advances
  });

  it('walking→arrived fires the arrival settle with the dedicated avatarId, and walking stays LLM-free', async () => {
    const bodyId = 'ocb-s4-d';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-d', center.x + 100, center.y); // already inside radius
    const entry = registerHouse(bodyId);
    entry.phase = 'walking';
    entry.targetBuildingId = TARGET;

    const settles: BuildingArrivalInput[] = [];
    asDriver().arrivalSettle = async (input) => {
      settles.push(input);
    };
    let decideCalled = 0;
    await agentAutonomyDriver.driveOnce(bodyId, async () => {
      decideCalled++;
      return '';
    });

    expect(decideCalled).toBe(0); // walking never calls the LLM
    expect(entry.phase).toBe('arrived');
    expect(settles.length).toBe(1);
    expect(settles[0]).toMatchObject({
      agentId: bodyId,
      bodyId,
      avatarId: `av-${bodyId}`,
      buildingId: TARGET,
    });
  });
});

describe('extractTalkMessage — executor-parity param parse', () => {
  it('extracts the message param from a talk_to_npc tag', () => {
    expect(
      extractTalkMessage('Hi! [ACTION: talk_to_npc(buildingId=api-integrations, message=teach me webhooks)]'),
    ).toBe('teach me webhooks');
  });
  it('returns null when there is no tag, no message param, or an empty message', () => {
    expect(extractTalkMessage('no tags here')).toBeNull();
    expect(extractTalkMessage('[ACTION: enter_building(buildingId=api-integrations)]')).toBeNull();
    expect(extractTalkMessage('[ACTION: talk_to_npc(buildingId=api-integrations)]')).toBeNull();
    expect(extractTalkMessage('[ACTION: talk_to_npc(buildingId=x, message=)]')).toBeNull();
  });
});

describe('world-teacher-chat — fail-closed proximity (no walk → no reward)', () => {
  it('conductTeacherTurn returns null for a FAR body (gated before any teacher/DB work)', async () => {
    const bodyId = 'ocb-s4-far';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-far', center.x + 6000, center.y); // way outside
    const result = await conductTeacherTurn({
      agentId: bodyId,
      bodyId,
      avatarId: 'av-far',
      buildingId: TARGET,
      message: 'teach me',
    });
    expect(result).toBeNull();
  });

  it('conductTeacherTurn returns null for a MISSING body and an UNKNOWN/prototype building', async () => {
    expect(
      await conductTeacherTurn({
        agentId: 'ghost',
        bodyId: 'ocb-not-in-world',
        avatarId: 'av-x',
        buildingId: TARGET,
        message: 'hi',
      }),
    ).toBeNull();

    const bodyId = 'ocb-s4-proto';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-proto', center.x, center.y);
    expect(
      await conductTeacherTurn({
        agentId: bodyId,
        bodyId,
        avatarId: 'av-x',
        buildingId: 'constructor', // inherited prototype key — must never resolve
        message: 'hi',
      }),
    ).toBeNull();
  });

  it('settleBuildingArrival never throws and settles nothing for a far body', async () => {
    const bodyId = 'ocb-s4-far2';
    const center = NPC_BUILDING_CENTERS[TARGET];
    registerBody(bodyId, 'oc-s4-far2', center.x + 6000, center.y);
    // Far → proximity gate returns before any ledger/event write; resolves void.
    await settleBuildingArrival({
      agentId: bodyId,
      bodyId,
      avatarId: 'av-x',
      buildingId: TARGET,
    });
  });
});

describe('leaderboard — house-agent public-board carve-out (P4 gate (a), landed early)', () => {
  it('both daily CTEs exclude house agents via a DURABLE subject-level JOIN against openclaw_bots.is_house (not a payload tag)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../routes/leaderboard.ts', import.meta.url)),
      'utf-8',
    );
    // Slice the two daily CTEs so each exclusion is asserted in the right leg.
    const agentCte = src.slice(src.indexOf('agent_daily AS ('), src.indexOf('avatar_daily AS ('));
    const avatarCte = src.slice(src.indexOf('avatar_daily AS ('), src.indexOf('agent_scores AS ('));

    // agent_daily: exclude the house agent SUBJECT by joining its agent_id to
    // openclaw_bots and testing the is_house FLAG itself — durable against a
    // future emitter that forgets the payload.isHouse tag.
    expect(agentCte).toContain('NOT EXISTS');
    expect(agentCte).toContain('openclaw_bots ob');
    expect(agentCte).toContain('ob.agent_id = events.agent_id');
    expect(agentCte).toContain('ob.is_house');

    // avatar_daily: belt-and-braces — these rows have agent_id IS NULL, so reach
    // is_house through the avatar's owning user (exclude any avatar whose user
    // also owns a house bot row). KEEP IN LOCKSTEP with agent_daily.
    expect(avatarCte).toContain('NOT EXISTS');
    expect(avatarCte).toContain('JOIN openclaw_bots ob ON ob.user_id = a2.user_id');
    expect(avatarCte).toContain('ob.is_house');
    expect(avatarCte).toContain('a2.id = events.avatar_id');

    // The old payload-tag exclusion is GONE from both daily CTEs — the FLAG join
    // replaced it (the payload.isHouse tag stays on emissions for forensics
    // only, never as the scoring gate).
    expect(agentCte).not.toContain("(payload->>'isHouse') IS DISTINCT FROM 'true'");
    expect(avatarCte).not.toContain("(payload->>'isHouse') IS DISTINCT FROM 'true'");
  });
});
