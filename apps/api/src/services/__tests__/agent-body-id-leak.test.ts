/**
 * B1 ROOT-FIX regression (P0 lifecycle-truth, 2026-07-01).
 *
 * THE VULN: an avatar-mode connected agent's in-world body was keyed by
 * `oc-${sessionId}`, where `sessionId` IS the `X-Clawville-Agent-Session` bearer
 * the cove trusts for REAL-CT settlement. That id was spread verbatim onto the
 * PUBLIC unauth `/api/npc/state|stream` + `/api/world/:room/stream` snapshots AND
 * the authenticated `/perception` harvest path — so anyone could read a live
 * bearer and drain a victim's ClawTokens.
 *
 * THE ROOT-FIX (not a boundary-sanitize): the body id is now the non-secret
 * `body-${agentId}`, so the bearer is structurally ABSENT from every wire path —
 * present and future — and cannot be re-leaked by a new serializer.
 *
 * This test asserts the bearer NEVER appears in any sim serializer OR in the
 * primitives `buildPerception` (agent-gateway.ts) derives its npc-id fields from
 * (`getAllNpcs` → nearbyNpcs, `getActiveConversations` → participants,
 * `getActiveCombats` → attacker/defender/round). Per this repo's test convention
 * (npc-overlap-deadlock.test.ts) we do NOT export the private route helper just
 * to test it; asserting its exclusive npc-id sources is the faithful guard.
 */

import { describe, expect, it, afterEach } from 'bun:test';

import { npcSimulation } from '../npc-simulation';
import { OpenClawClient } from '../openclaw-client';
import type { OpenClawRegistration } from '@clawville/shared';

// The sessionId (bearer) carries a UNIQUE marker so any leak is unambiguous.
const SECRET_MARKER = 'SUPER_SECRET_BEARER_must_not_leak_9f8e7d6c5b4a';
const SECRET_BEARER = `oc-${SECRET_MARKER}`;
const AGENT_ID = 'leaktest-agent-01';
const BODY_ID = `body-${AGENT_ID}`;

function makeAvatarConfig(): OpenClawRegistration {
  return {
    agentId: AGENT_ID,
    sessionId: SECRET_BEARER,
    sessionKey: SECRET_BEARER,
    gatewayUrl: 'http://localhost:0',
    authToken: '',
    protocol: 'nanoclaw', // inert client, no outbound network
    mode: 'avatar',
    autonomyMode: 'server-managed',
    name: 'LeakTestBot',
    species: 'default-species',
    color: 0x888888,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: false,
    boundUserId: null,
  } as OpenClawRegistration;
}

function registerAvatar(): void {
  const cfg = makeAvatarConfig();
  npcSimulation.registerOpenClaw(cfg, new OpenClawClient(cfg));
}

afterEach(() => {
  // Idempotent — safe whether or not the test registered it.
  npcSimulation.unregisterOpenClaw(SECRET_BEARER);
});

describe('B1 root-fix — avatar body id is decoupled from the bearer sessionId', () => {
  it('registers the body under `body-<agentId>`, never `oc-<sessionId>`', () => {
    registerAvatar();
    expect(npcSimulation.getNpcIdForSession(SECRET_BEARER)).toBe(BODY_ID);
    const body = npcSimulation.getNpcById(BODY_ID);
    expect(body).not.toBeNull();
    expect(body!.id).toBe(BODY_ID);
    expect(body!.id.startsWith('oc-')).toBe(false);
    // The `oc-<sessionId>` id must NOT be a resolvable body.
    expect(npcSimulation.getNpcById(SECRET_BEARER)).toBeNull();
  });

  it('reverse lookups still resolve via the bodyId ↔ sessionId map', () => {
    registerAvatar();
    // bodyId → client (npcOverrides[bodyId] → sessionId → client)
    expect(npcSimulation.getOpenClawClient(BODY_ID)).not.toBeNull();
    // sessionId → config + position (config.agentId → bodyId)
    expect(npcSimulation.getOpenClawBotConfig(SECRET_BEARER)?.agentId).toBe(AGENT_ID);
    expect(npcSimulation.getOpenClawAvatarPosition(SECRET_BEARER)).not.toBeNull();
  });

  it('NO sim serializer OR perception-input leaks the bearer for an avatar body', () => {
    registerAvatar();

    const surfaces: Record<string, string> = {
      getSnapshot: JSON.stringify(npcSimulation.getSnapshot()),
      // Unknown rooms (incl. the npc-sse `solo-*` alias) fall to the full-roster path.
      getRoomSnapshot_room: JSON.stringify(npcSimulation.getRoomSnapshot('room-leaktest')),
      getRoomSnapshot_solo: JSON.stringify(npcSimulation.getRoomSnapshot('solo-leaktest')),
      getActiveOpenClawBots: JSON.stringify(npcSimulation.getActiveOpenClawBots()),
      // buildPerception (agent-gateway) derives every exposed npc-id field ONLY from
      // these three primitives, so covering them covers the perception harvest path.
      getAllNpcs: JSON.stringify(npcSimulation.getAllNpcs()),
      getActiveConversations: JSON.stringify(npcSimulation.getActiveConversations()),
      getActiveCombats: JSON.stringify(npcSimulation.getActiveCombats()),
    };

    for (const [name, json] of Object.entries(surfaces)) {
      expect(json.includes(SECRET_MARKER), `${name} leaked the raw bearer`).toBe(false);
      expect(json.includes(SECRET_BEARER), `${name} leaked the oc-<sessionId> bearer`).toBe(false);
    }

    // Positive: the body IS present, under its non-secret public id.
    const snap = npcSimulation.getSnapshot();
    expect(snap.npcs.some((n) => n.id === BODY_ID)).toBe(true);
  });

  it('unregister removes the body and leaves no trace in the snapshot', () => {
    registerAvatar();
    expect(npcSimulation.unregisterOpenClaw(SECRET_BEARER)).toBe(true);
    const json = JSON.stringify(npcSimulation.getSnapshot());
    expect(json.includes(SECRET_MARKER)).toBe(false);
    expect(json.includes(BODY_ID)).toBe(false);
    expect(npcSimulation.getNpcById(BODY_ID)).toBeNull();
    expect(npcSimulation.getNpcIdForSession(SECRET_BEARER)).toBeNull();
  });
});
