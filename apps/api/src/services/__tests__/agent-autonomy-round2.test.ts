import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MAP_LOCATIONS, type AutonomyStatusThought } from '@clawville/shared';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { npcSimulation } from '../npc-simulation';
import type {
  AgentDirectiveState,
  CurrentDirective,
  DirectiveActedClaim,
} from '../agent-autonomy-state';
import type { CovenantActionInput } from '../covenant-action-recorder';

interface TestEntry {
  phase: 'deciding' | 'walking' | 'arrived' | 'talking';
  phaseSince: number;
  targetBuildingId: string | null;
  cursorSeeded: boolean;
  recentThoughts: AutonomyStatusThought[];
}

interface DriverInternals {
  userAgents: Map<string, TestEntry>;
  readDirectiveBounded: () => Promise<CurrentDirective | null>;
  directiveStateRead: () => Promise<AgentDirectiveState>;
  directiveActedShaClaim: () => Promise<DirectiveActedClaim>;
  readRecentLessons: () => Promise<string[]>;
}

interface SimInternals {
  npcs: Map<string, ReturnType<typeof makeBody>>;
  initNpcs: () => void;
}

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;
const OWNER = 'round2-owner';
const AGENT = 'round2-agent';
const BODY = 'round2-body';
const AVATAR = 'round2-avatar';

const originalDirectiveRead = driver.readDirectiveBounded;
const originalDirectiveStateRead = driver.directiveStateRead;
const originalDirectiveActedShaClaim = driver.directiveActedShaClaim;
const originalLessonRead = driver.readRecentLessons;
const originalCovenantRecord = agentAutonomyDriver.covenantRecord;

function makeBody(id: string, x = 11264, y = 11264) {
  return {
    id,
    name: 'RoundTwoAgent',
    x,
    y,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [] as string[],
    activity: 'idle' as const,
    activityEmoji: '',
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: 'idle' as const,
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

function enroll(): TestEntry {
  sim.npcs.set(BODY, makeBody(BODY));
  agentAutonomyDriver.registerUserAgent({
    agentId: AGENT,
    bodyId: BODY,
    platformAgentId: 'round2-platform',
    systemUserId: OWNER,
    houseUserId: OWNER,
    avatarId: AVATAR,
  });
  const entry = driver.userAgents.get(AGENT)!;
  entry.cursorSeeded = true;
  return entry;
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
  driver.readRecentLessons = async () => [];
});

afterEach(() => {
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.directiveStateRead = originalDirectiveStateRead;
  driver.directiveActedShaClaim = originalDirectiveActedShaClaim;
  driver.readRecentLessons = originalLessonRead;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
});

describe('round 2 owner status and thought feed', () => {
  it('returns the exact public-safe owner shape and no private ids', () => {
    expect(agentAutonomyDriver.getOwnerStatus(OWNER)).toEqual({ enrolled: false });
    enroll();
    const status = agentAutonomyDriver.getOwnerStatus(OWNER);
    expect(status).toEqual({
      enrolled: true,
      phase: 'deciding',
      targetBuildingId: null,
      targetLabel: null,
      bodyId: BODY,
      phaseSince: expect.any(Number),
      thoughts: [],
    });
    expect(JSON.stringify(status)).not.toContain(AGENT);
    expect(JSON.stringify(status)).not.toContain('round2-platform');
  });

  it('records a new directive once, acts once per sha, and caps thoughts at 20', async () => {
    enroll();
    const directive: CurrentDirective = {
      text: 'go play cards',
      setAt: new Date().toISOString(),
      setBy: 'api',
    };
    driver.readDirectiveBounded = originalDirectiveRead;
    driver.directiveStateRead = async () => ({
      directive,
      lastActedDirectiveSha: null,
    });
    driver.directiveActedShaClaim = async () => 'claimed';
    const records: CovenantActionInput[] = [];
    agentAutonomyDriver.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };

    for (let i = 0; i < 22; i++) {
      await agentAutonomyDriver.driveOnce(
        AGENT,
        async () => `[ACTION: emote(name=${i % 2 === 0 ? 'think' : 'scan'})]`,
      );
    }

    expect(records.filter((record) => record.action === 'agent.directive.received')).toHaveLength(1);
    expect(records.filter((record) => record.action === 'agent.directive.acted')).toHaveLength(1);
    expect(records[0].subjectId).toBe(AVATAR);
    expect(records[0].actorKind).toBe('agent');
    expect(records[0].payload).toEqual({
      directiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      len: directive.text.length,
    });
    expect(JSON.stringify(records)).not.toContain(directive.text);
    const receivedSha = records.find(
      (record) => record.action === 'agent.directive.received',
    )!.payload.directiveSha256;
    expect(records.find((record) => record.action === 'agent.directive.acted')?.payload).toEqual({
      directiveSha256: receivedSha,
      action: 'emote',
    });

    const status = agentAutonomyDriver.getOwnerStatus(OWNER);
    expect(status.enrolled).toBe(true);
    if (!status.enrolled) throw new Error('expected enrollment');
    expect(status.thoughts).toHaveLength(20);
    expect(status.thoughts.every((thought) => thought.type === 'decision')).toBe(true);
  });

  it('narrates empty decisions and walk timeouts as observations', async () => {
    const entry = enroll();
    driver.readDirectiveBounded = async () => null;
    await agentAutonomyDriver.driveOnce(AGENT, async () => '');
    expect(entry.recentThoughts.at(-1)?.text).toBe('Decision timed out — retrying');

    entry.phase = 'walking';
    entry.targetBuildingId = 'cove';
    entry.phaseSince = Date.now() - 121_000;
    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });
    expect(entry.recentThoughts.at(-1)?.text).toBe('Walk timed out — re-deciding');
  });

  it('records one cove arrival and retains the target label through linger', async () => {
    const entry = enroll();
    const cove = MAP_LOCATIONS.find((location) => location.id === 'cove')!;
    const body = sim.npcs.get(BODY)!;
    body.x = cove.positionX + cove.width / 2;
    body.y = cove.positionY + cove.height / 2;
    entry.phase = 'walking';
    entry.targetBuildingId = 'cove';
    entry.phaseSince = Date.now();
    const records: CovenantActionInput[] = [];
    agentAutonomyDriver.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'visit', deduped: false };
    };

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('arrival must not decide');
    });

    expect(records).toEqual([
      expect.objectContaining({
        action: 'agent.visit',
        subjectId: AVATAR,
        actorKind: 'agent',
        payload: { destination: 'cove' },
      }),
    ]);
    const status = agentAutonomyDriver.getOwnerStatus(OWNER);
    expect(status).toEqual(expect.objectContaining({
      enrolled: true,
      phase: 'talking',
      targetBuildingId: 'cove',
      targetLabel: 'the Cove',
    }));
    if (!status.enrolled) throw new Error('expected enrollment');
    expect(status.thoughts.at(-1)).toEqual(expect.objectContaining({
      type: 'arrival',
      text: 'Arrived at the Cove',
    }));
  });
});
