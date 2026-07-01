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
 * `ocb-${base64url(agentId)}`, so the bearer is structurally ABSENT from every
 * wire path — present and future — and cannot be re-leaked by a new serializer.
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
// Mirrors npc-simulation.ts `avatarBodyId()` EXACTLY — the non-secret, DOM-safe,
// deterministic body id (`ocb-<base64url(agentId)>`), never `oc-<sessionId>`.
const BODY_ID = `ocb-${Buffer.from(AGENT_ID, 'utf8').toString('base64url')}`;

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
  it('registers the body under `ocb-<base64url(agentId)>`, never `oc-<sessionId>`', () => {
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

  it('conversations[]/combats[] participant ids stay CONSISTENT with npcs[].id (speech-bubble correlation)', () => {
    // The web correlates speech bubbles by matching a message/participant id to a
    // rendered npc's id (npc-speech-bubbles.tsx). The 2026-06-03 leak class was a
    // wire-projection that remapped npcs[].id but MISSED a projection — so this
    // asserts every participant id the snapshot emits equals the SAME bodyId as
    // npcs[].id (they all read the runtime npc's `.id`, which is now the bodyId).
    registerAvatar();
    const sim = npcSimulation as unknown as {
      conversations: Map<string, unknown>;
      combats: Map<string, unknown>;
    };
    // Inject a conversation + combat referencing the avatar body BY ITS bodyId —
    // exactly what the sim stores (initiator.id === `ocb-<base64url(agentId)>`).
    sim.conversations.set('convo-leaktest', {
      id: 'convo-leaktest', npc1Id: BODY_ID, npc2Id: 'some-resident',
      messages: [{ npcId: BODY_ID, npcName: 'LeakTestBot', text: 'hi' }],
      currentIndex: 0, nextMessageAt: 0, state: 'active', typingNpcId: BODY_ID, typingUntil: 0,
    });
    sim.combats.set('combat-leaktest', {
      id: 'combat-leaktest', attacker: BODY_ID, defender: 'some-resident',
      rounds: [{ attacker: BODY_ID, damage: 1, defenderHpAfter: 99 }],
      state: 'active', winner: null, lootTransferred: [], startedAt: 0, nextRoundAt: 0, phase: 'fighting',
    });
    try {
      const snap = npcSimulation.getSnapshot();
      const body = snap.npcs.find((n) => n.id === BODY_ID);
      expect(body).toBeDefined();

      const convo = snap.conversations.find((c) => c.id === 'convo-leaktest');
      expect(convo?.npc1Id).toBe(body!.id);            // participant id === npcs[].id
      expect(convo?.messages[0]?.npcId).toBe(body!.id); // speech-bubble correlation
      expect(convo?.typingNpcId).toBe(body!.id);

      const combat = snap.combats.find((c) => c.id === 'combat-leaktest');
      expect(combat?.attacker).toBe(body!.id);
      expect(combat?.rounds[0]?.attacker).toBe(body!.id);

      // …and still no bearer anywhere in the derived participant surfaces.
      expect(JSON.stringify({ convo, combat }).includes(SECRET_MARKER)).toBe(false);
    } finally {
      sim.conversations.delete('convo-leaktest');
      sim.combats.delete('combat-leaktest');
    }
  });
});
