/**
 * Round 1b regression: a user-owned body driven by agentAutonomyDriver is live
 * work even when its bearer activity timestamp is stale. The exemption lasts
 * exactly as long as the user enrollment; Controlled handback restores normal
 * idle-despawn eligibility without changing the session row or TTL fields.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import {
  bodyIdleSweeperSeams,
  sweepIdleAgentBodies,
} from '../agent-body-idle-sweeper';
import { buildHostedAvatarAgentConfig } from '../hosted-avatar-agent-session-plan';
import { npcSimulation } from '../npc-simulation';

const AGENT_ID = 'round1b-stale-user-agent';
const SESSION_ID = 'oc-round1b-stale-user-session';
const OWNER_ID = 'round1b-owner';
const AVATAR_ID = 'round1b-avatar';
const BODY_ID = `ocb-${Buffer.from(AGENT_ID, 'utf8').toString('base64url')}`;

const originalReadRows = bodyIdleSweeperSeams.readRows;
const originalGetAvatarPosition = npcSimulation.getAgentBotAvatarPosition;
const originalIdleWindow = process.env.AGENT_BODY_IDLE_DESPAWN_MS;

function clearDriver(): void {
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
}

function registerStaleUserBody(): void {
  const config = buildHostedAvatarAgentConfig({
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    ownerUserId: OWNER_ID,
    modelKey: 'milady_official_1',
    name: 'Round1bAgent',
  });
  const client = { getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient;
  npcSimulation.registerAgentBot(config, client);
  expect(agentAutonomyDriver.registerUserAgent({
    agentId: AGENT_ID,
    bodyId: BODY_ID,
    platformAgentId: AGENT_ID,
    systemUserId: OWNER_ID,
    houseUserId: OWNER_ID,
    avatarId: AVATAR_ID,
  })).toEqual({ ok: true, reused: false });
}

beforeEach(() => {
  npcSimulation.stop();
  for (const { sessionId } of npcSimulation.getActiveAgentSessionPairs()) {
    npcSimulation.unregisterAgentBot(sessionId);
  }
  clearDriver();
  process.env.AGENT_BODY_IDLE_DESPAWN_MS = String(5 * 60 * 1000);
  bodyIdleSweeperSeams.readRows = async (agentIds) => {
    expect(agentIds).toContain(AGENT_ID);
    return [{
      agentId: AGENT_ID,
      lastSeenAt: new Date(Date.now() - 31 * 60 * 1000),
      isHouse: false,
    }];
  };
  // Position persistence is orthogonal here. Returning null keeps this focused
  // lifecycle test DB-free while the real sweeper still performs the real body
  // unregister below.
  npcSimulation.getAgentBotAvatarPosition = () => null;
});

afterEach(() => {
  bodyIdleSweeperSeams.readRows = originalReadRows;
  npcSimulation.getAgentBotAvatarPosition = originalGetAvatarPosition;
  if (originalIdleWindow === undefined) {
    delete process.env.AGENT_BODY_IDLE_DESPAWN_MS;
  } else {
    process.env.AGENT_BODY_IDLE_DESPAWN_MS = originalIdleWindow;
  }
  clearDriver();
  npcSimulation.unregisterAgentBot(SESSION_ID);
});

describe('user-agent idle body lifecycle', () => {
  it('keeps a stale driver-enrolled body, then despawns it after unenrollment', async () => {
    registerStaleUserBody();
    expect(npcSimulation.getNpcById(BODY_ID)).not.toBeNull();

    expect(await sweepIdleAgentBodies()).toBe(0);
    expect(npcSimulation.getAgentBotConfig(SESSION_ID)).not.toBeNull();
    expect(npcSimulation.getNpcById(BODY_ID)).not.toBeNull();

    agentAutonomyDriver.unregisterUserAgent(AGENT_ID);

    expect(await sweepIdleAgentBodies()).toBe(1);
    expect(npcSimulation.getAgentBotConfig(SESSION_ID)).toBeNull();
    expect(npcSimulation.getNpcById(BODY_ID)).toBeNull();
  });
});
