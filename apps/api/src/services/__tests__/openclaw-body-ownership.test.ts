/**
 * M1 sweeper-race hardening (Codex P0 gate, 2026-07-01).
 *
 * The avatar body id is now the DETERMINISTIC per-agentId `ocb-<base64url(agentId)>`,
 * so MANY sessionIds for one agentId share ONE in-world body, and
 * `npcOverrides[bodyId]` names the CURRENT owner. `/connect` does NOT evict prior
 * sessions on a normal (same-owner) reconnect, so a stale session (e.g. one the TTL
 * sweeper is reaping) can coexist in the Map with a fresh one that has already
 * rebound the body to itself.
 *
 * `unregisterOpenClaw` is therefore OWNERSHIP-SCOPED: it tears the shared body down
 * ONLY if the unregistering session still owns `npcOverrides[bodyId]`. Otherwise a
 * stale unregister would orphan the LIVE session — delete the body + override it
 * depends on while it stays Map-present (so lazy-restore never re-heals it). These
 * tests pin that guard (and that a sole owner still tears its body down).
 *
 * Pure sim — no DB, no network.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { npcSimulation } from '../npc-simulation';
import { OpenClawClient } from '../openclaw-client';
import type { OpenClawRegistration } from '@clawville/shared';

const AGENT_ID = 'ownership-agent-01';
const S1 = 'ag-ownership-session-ONE-aaaaaaaaaaaaaaaa';
const S2 = 'ag-ownership-session-TWO-bbbbbbbbbbbbbbbb';
const BODY_ID = `ocb-${Buffer.from(AGENT_ID, 'utf8').toString('base64url')}`;

function cfg(sessionId: string): OpenClawRegistration {
  return {
    agentId: AGENT_ID,
    sessionId,
    sessionKey: sessionId,
    gatewayUrl: 'http://localhost:0',
    authToken: '',
    protocol: 'nanoclaw', // inert client, no outbound network
    mode: 'avatar',
    autonomyMode: 'server-managed',
    name: 'OwnershipBot',
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
const register = (sid: string) => npcSimulation.registerOpenClaw(cfg(sid), new OpenClawClient(cfg(sid)));

afterEach(() => {
  npcSimulation.unregisterOpenClaw(S1);
  npcSimulation.unregisterOpenClaw(S2);
});

describe('unregisterOpenClaw is ownership-scoped for the shared ocb- body', () => {
  it('a STALE session does NOT tear down the shared body a newer session owns (M1 race)', () => {
    register(S1);
    expect(npcSimulation.getNpcById(BODY_ID)).not.toBeNull();

    // Normal reconnect: same agentId, NEW sessionId, NO eviction — S2 rebinds the
    // deterministic body to itself (npcOverrides[BODY_ID] === S2 now).
    register(S2);
    expect(npcSimulation.getNpcIdForSession(S2)).toBe(BODY_ID);

    // The sweeper reaps the stale S1 — it must NOT nuke the body S2 owns.
    expect(npcSimulation.unregisterOpenClaw(S1)).toBe(true);
    expect(npcSimulation.getNpcById(BODY_ID)).not.toBeNull();          // body survives
    expect(npcSimulation.getOpenClawClient(BODY_ID)).not.toBeNull();   // override still resolves a live client
    expect(npcSimulation.getNpcIdForSession(S2)).toBe(BODY_ID);        // S2 still resolves its body
    expect(npcSimulation.getOpenClawBotConfig(S1)).toBeNull();         // S1's own map entry is gone

    // When the ACTUAL owner unregisters, the body IS removed.
    expect(npcSimulation.unregisterOpenClaw(S2)).toBe(true);
    expect(npcSimulation.getNpcById(BODY_ID)).toBeNull();
    expect(npcSimulation.getOpenClawClient(BODY_ID)).toBeNull();
  });

  it('the SOLE owner still tears the body down (no regression)', () => {
    register(S1);
    expect(npcSimulation.getNpcById(BODY_ID)).not.toBeNull();
    expect(npcSimulation.unregisterOpenClaw(S1)).toBe(true);
    expect(npcSimulation.getNpcById(BODY_ID)).toBeNull();
  });
});
