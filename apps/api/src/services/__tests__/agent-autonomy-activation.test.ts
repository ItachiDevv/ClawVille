/**
 * §B.1 — user-owned autonomy enrollment (activation lifecycle + driver registry).
 *
 * DB-free, service-level coverage following the hosted-avatar-agent-session /
 * agent-control-handback pattern (the route graph crashes at module load
 * without FINGERPRINT_SECRET, and @clawville/database is lazy so importing the
 * modules is safe — only the seams would hit a DB, and we swap them).
 *
 * What is asserted (each maps to a paid-for trap from the adversarial pre-read):
 *  (1) FREEZE BUG — activation releases BOTH the human-control until-entry AND
 *      the durable launch binding, so the 5 Hz position refresh can no longer
 *      re-suppress (and path-wipe) the driver body.
 *  (2) IDEMPOTENCY — a repeat activation is `reused:true`, keeps ONE body, ONE
 *      registry entry, no extra capacity, and does not reset the phase machine.
 *  (3) CAPACITY — over-cap is a TYPED rejection (`autonomy_capacity`) and the
 *      §B.2 session/body is NEVER minted for a rejected not-yet-enrolled owner
 *      (no orphan bodies).
 *  (4) BRIDGE MUTUAL EXCLUSION — activation unregisters the idle-avatar bridge
 *      for the owner (`autonomous_visit` faucet can't double-credit).
 *  (5) DEACTIVATION HANDBACK — unenrolls + re-establishes binding AND an
 *      immediate suppression window; idempotent.
 *  (6) HOUSE-PATH ISOLATION — house registration/behavior unchanged
 *      (`isHouse:true` warm input, cap 64 untouched), and user teardown can
 *      never remove a house agent.
 *  (7) ELIGIBILITY GUARDS — no-avatar / guest / no-agent / not-eligible codes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import {
  activationSeams,
  activateAutonomyForOwner,
  deactivateAutonomyForOwner,
} from '../agent-autonomy-activation';
import { buildHostedAvatarAgentConfig } from '../hosted-avatar-agent-session-plan';

const OWNER = '11111111-1111-4111-8111-111111111111';
const AVATAR_ID = '33333333-3333-4333-8333-333333333333';
const PLATFORM_AGENT_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_KEY = 'milady_official_1';

const bodyIdFor = (agentId: string) =>
  `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;

type Sim = {
  npcs: Map<string, unknown>;
  agentBotSessions: Map<string, unknown>;
  npcOverrides: Map<string, string>;
  avatarBodyOwners: Map<string, string>;
  humanControlledOpenClawUntil: Map<string, number>;
  humanControlledOpenClawLaunchesByUser: Map<string, Set<string>>;
  initNpcs: () => void;
  stop: () => void;
};
const asSim = () => npcSimulation as unknown as Sim;

type DriverInternals = {
  houseAgents: Map<string, { isHouse: boolean; bodyId: string; phase: string }>;
  userAgents: Map<string, { isHouse: boolean; bodyId: string; avatarId: string; phase: string }>;
};
const asDriver = () => agentAutonomyDriver as unknown as DriverInternals;

const stubClient = () =>
  ({ getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient);

/** Register a REAL ocb- body through the actual registerAgentBot path (nanoclaw
 *  fail-soft wire — no network, no DB), exactly like the §B.2 mint does. */
function registerHostedBody(platformAgentId: string, bearer: string, owner = OWNER) {
  const config = buildHostedAvatarAgentConfig({
    agentId: platformAgentId,
    sessionId: bearer,
    ownerUserId: owner,
    modelKey: MODEL_KEY,
    name: 'AutonomyTestAgent',
  });
  npcSimulation.registerAgentBot(config, stubClient());
  return bodyIdFor(platformAgentId);
}

// ── seams -------------------------------------------------------------------
const originalResolveActiveAvatar = activationSeams.resolveActiveAvatar;
const originalEnsureSession = activationSeams.ensureSession;
const originalSetFlag = activationSeams.setEnrolledFlag;
const originalClearFlag = activationSeams.clearEnrolledFlagForOwner;
const originalKickDriver = activationSeams.kickDriver;

let ensureSessionCalls = 0;
let bearerCounter = 0;
// §B.1 durable-autonomy flag recorders (the real seams are DB writes; DB-free
// here we record the calls so we can assert the flag lifecycle).
let flagSetCalls: string[] = [];
let flagClearCalls: string[] = [];
let kickCalls: string[] = [];

/** Default happy-path seams: a real owner avatar + a real registered body. */
function installHappySeams(platformAgentId = PLATFORM_AGENT_ID) {
  activationSeams.resolveActiveAvatar = async () => ({
    id: AVATAR_ID,
    platformAgentId,
    isGuest: false,
  });
  activationSeams.ensureSession = async (paid: string) => {
    ensureSessionCalls++;
    // Reuse a live body when present (mirrors the real ensure()'s fast path).
    const bodyId = bodyIdFor(paid);
    if (asSim().npcs.has(bodyId)) {
      return { bearer: `oc-test-${bearerCounter}`, agentId: paid, bodyId, reused: true };
    }
    bearerCounter++;
    const bearer = `oc-test-${bearerCounter}`;
    registerHostedBody(paid, bearer);
    return { bearer, agentId: paid, bodyId, reused: false };
  };
}

function clearDriver() {
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
}

beforeEach(() => {
  const sim = asSim();
  sim.stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.avatarBodyOwners.clear();
  sim.humanControlledOpenClawUntil.clear();
  sim.humanControlledOpenClawLaunchesByUser.clear();
  clearDriver();
  npcSimulation.avatarAutonomyManager.unregister(OWNER);
  ensureSessionCalls = 0;
  bearerCounter = 0;
  flagSetCalls = [];
  flagClearCalls = [];
  kickCalls = [];
  // Swap the durable-flag DB writes for recorders (DB-free).
  activationSeams.setEnrolledFlag = async (agentId: string) => {
    flagSetCalls.push(agentId);
  };
  activationSeams.clearEnrolledFlagForOwner = async (ownerUserId: string) => {
    flagClearCalls.push(ownerUserId);
  };
  activationSeams.kickDriver = (agentId: string) => {
    kickCalls.push(agentId);
  };
  installHappySeams();
});

afterEach(() => {
  activationSeams.resolveActiveAvatar = originalResolveActiveAvatar;
  activationSeams.ensureSession = originalEnsureSession;
  activationSeams.setEnrolledFlag = originalSetFlag;
  activationSeams.clearEnrolledFlagForOwner = originalClearFlag;
  activationSeams.kickDriver = originalKickDriver;
  clearDriver();
});

// ---------------------------------------------------------------------------
// (1) FREEZE BUG — activation releases suppression at the source
// ---------------------------------------------------------------------------
describe('(1) activate releases the Controlled-mode suppression (freeze bug)', () => {
  it('clears BOTH the until-entry and the launch binding; the 5 Hz refresh cannot re-suppress', async () => {
    // Controlled-mode state as the launch route + heartbeat leave it:
    npcSimulation.bindHumanControlledOpenClawLaunch(OWNER, PLATFORM_AGENT_ID);
    npcSimulation.markHumanControlledOpenClaw(PLATFORM_AGENT_ID, 60_000);
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(true);

    const result = await activateAutonomyForOwner(OWNER);
    expect(result.ok).toBe(true);

    // Immediate window lifted…
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(false);
    // …and the DURABLE binding is gone, so the unconditional /api/world/position
    // refresh is a no-op for this agent (this is the actual freeze-bug fix: a
    // surviving binding would re-mark + path-wipe the driver body 5×/sec).
    npcSimulation.refreshHumanControlledOpenClawForUser(OWNER);
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(false);
  });

  it('kicks one immediate drive only after suppression is released', async () => {
    npcSimulation.bindHumanControlledOpenClawLaunch(OWNER, PLATFORM_AGENT_ID);
    npcSimulation.markHumanControlledOpenClaw(PLATFORM_AGENT_ID, 60_000);
    activationSeams.kickDriver = (agentId: string) => {
      expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(false);
      kickCalls.push(agentId);
    };

    expect((await activateAutonomyForOwner(OWNER)).ok).toBe(true);
    expect(kickCalls).toEqual([PLATFORM_AGENT_ID]);

    // A keepalive re-activation reuses both body + enrollment and does not spend
    // a second decision.
    expect((await activateAutonomyForOwner(OWNER)).ok).toBe(true);
    expect(kickCalls).toEqual([PLATFORM_AGENT_ID]);
  });
});

// ---------------------------------------------------------------------------
// (2) IDEMPOTENCY
// ---------------------------------------------------------------------------
describe('(2) activation idempotency', () => {
  it('second activate → reused:true, ONE body, ONE entry, phase machine untouched', async () => {
    const first = await activateAutonomyForOwner(OWNER);
    if (!first.ok) throw new Error(`first activate failed: ${first.code}`);
    expect(first.reused).toBe(false);
    expect(first.bodyId).toBe(bodyIdFor(PLATFORM_AGENT_ID));
    expect(agentAutonomyDriver.userAgentCount()).toBe(1);

    // Simulate a mid-walk phase so we can prove re-activation does not reset it.
    const entry = asDriver().userAgents.get(PLATFORM_AGENT_ID)!;
    entry.phase = 'walking';

    const second = await activateAutonomyForOwner(OWNER);
    if (!second.ok) throw new Error(`second activate failed: ${second.code}`);
    expect(second.reused).toBe(true);
    expect(second.bodyId).toBe(first.bodyId);
    expect(agentAutonomyDriver.userAgentCount()).toBe(1);
    // The keepalive fast-path kept the LIVE entry (no phase reset to 'deciding').
    expect(asDriver().userAgents.get(PLATFORM_AGENT_ID)!.phase).toBe('walking');

    // Exactly ONE ocb- body in the sim.
    const ocbBodies = [...asSim().npcs.keys()].filter((k) => k.startsWith('ocb-'));
    expect(ocbBodies).toEqual([bodyIdFor(PLATFORM_AGENT_ID)]);
  });

  it('one-per-owner: rebinding the avatar to a NEW platform agent drops the stale enrollment', async () => {
    const first = await activateAutonomyForOwner(OWNER);
    expect(first.ok).toBe(true);

    const NEW_AGENT = '44444444-4444-4444-8444-444444444444';
    installHappySeams(NEW_AGENT);
    const second = await activateAutonomyForOwner(OWNER);
    expect(second.ok).toBe(true);

    expect(agentAutonomyDriver.userAgentCount()).toBe(1);
    expect(agentAutonomyDriver.getEnrolledAgentForOwner(OWNER)).toBe(NEW_AGENT);
    expect(asDriver().userAgents.has(PLATFORM_AGENT_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (3) CAPACITY — typed rejection, no orphan mint
// ---------------------------------------------------------------------------
describe('(3) capacity', () => {
  it('over-cap activation → {ok:false, code:autonomy_capacity} and the §B.2 mint is NEVER called', async () => {
    const cap = agentAutonomyDriver.getUserAgentCapacity();
    expect(cap).toBeGreaterThanOrEqual(1);
    // Fill the registry with distinct owners via the driver API directly.
    for (let i = 0; i < cap; i++) {
      const r = agentAutonomyDriver.registerUserAgent({
        agentId: `cap-agent-${i}`,
        bodyId: `ocb-cap-${i}`,
        platformAgentId: `cap-agent-${i}`,
        systemUserId: `cap-owner-${i}`,
        houseUserId: `cap-owner-${i}`,
        avatarId: `cap-avatar-${i}`,
      });
      expect(r.ok).toBe(true);
    }
    expect(agentAutonomyDriver.userAgentCount()).toBe(cap);
    expect(agentAutonomyDriver.canEnrollUser('a-fresh-agent')).toBe(false);
    // Already-enrolled agents still pass the pre-check (idempotent re-arm).
    expect(agentAutonomyDriver.canEnrollUser('cap-agent-0')).toBe(true);

    const result = await activateAutonomyForOwner(OWNER);
    expect(result).toEqual({ ok: false, code: 'autonomy_capacity' });
    // Pre-check ran BEFORE the mint → no orphan session/body.
    expect(ensureSessionCalls).toBe(0);
    const ocbBodies = [...asSim().npcs.keys()].filter((k) => k.startsWith('ocb-'));
    expect(ocbBodies).toEqual([]);
  });

  it('direct registerUserAgent over cap is a typed rejection, and idempotent re-register never trips it', () => {
    const cap = agentAutonomyDriver.getUserAgentCapacity();
    for (let i = 0; i < cap; i++) {
      agentAutonomyDriver.registerUserAgent({
        agentId: `cap-agent-${i}`,
        bodyId: `ocb-cap-${i}`,
        platformAgentId: `cap-agent-${i}`,
        systemUserId: `cap-owner-${i}`,
        houseUserId: `cap-owner-${i}`,
        avatarId: `cap-avatar-${i}`,
      });
    }
    const over = agentAutonomyDriver.registerUserAgent({
      agentId: 'one-too-many',
      bodyId: 'ocb-one-too-many',
      platformAgentId: 'one-too-many',
      systemUserId: 'owner-over',
      houseUserId: 'owner-over',
      avatarId: 'avatar-over',
    });
    expect(over).toEqual({ ok: false, reason: 'capacity' });

    // Re-registering an ALREADY-ENROLLED agent at full cap succeeds (reused).
    const again = agentAutonomyDriver.registerUserAgent({
      agentId: 'cap-agent-0',
      bodyId: 'ocb-cap-0',
      platformAgentId: 'cap-agent-0',
      systemUserId: 'cap-owner-0',
      houseUserId: 'cap-owner-0',
      avatarId: 'cap-avatar-0',
    });
    expect(again).toEqual({ ok: true, reused: true });
    expect(agentAutonomyDriver.userAgentCount()).toBe(cap);
  });
});

// ---------------------------------------------------------------------------
// (4) BRIDGE MUTUAL EXCLUSION
// ---------------------------------------------------------------------------
describe('(4) bridge/driver mutual exclusion', () => {
  it('activation unregisters the idle-avatar bridge for the owner + marks the owner enrolled', async () => {
    // Seed the bridge the way the heartbeat does (stateStore directly — the
    // public register() would lazily boot the whole SimulationRuntime).
    const bridge = npcSimulation.avatarAutonomyManager as unknown as {
      stateStore: {
        register: (i: Record<string, unknown>) => void;
      };
    };
    bridge.stateStore.register({
      avatarId: AVATAR_ID,
      userId: OWNER,
      name: 'Owner',
      species: MODEL_KEY,
      color: '#fff',
      archetype: 'curious',
      positionX: 100,
      positionY: 100,
    });
    expect(npcSimulation.avatarAutonomyManager.isRegistered(OWNER)).toBe(true);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);

    const result = await activateAutonomyForOwner(OWNER);
    expect(result.ok).toBe(true);
    expect(npcSimulation.avatarAutonomyManager.isRegistered(OWNER)).toBe(false);
    // The heartbeat's C1 guard keys off THIS signal — it must flip with enrollment.
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (5) DEACTIVATION HANDBACK
// ---------------------------------------------------------------------------
describe('(5) deactivation', () => {
  it('unenrolls + re-establishes binding AND an immediate suppression window', async () => {
    await activateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(true);
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(false);

    await deactivateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
    // Immediate window (body frozen/hidden NOW)…
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(true);
    // …AND the durable binding, so the position refresh keeps it alive.
    expect(
      asSim().humanControlledOpenClawLaunchesByUser.get(OWNER)?.has(PLATFORM_AGENT_ID),
    ).toBe(true);
    // The §B.2 body was NOT torn down (D6 — the session stays for reuse).
    expect(asSim().npcs.has(bodyIdFor(PLATFORM_AGENT_ID))).toBe(true);
  });

  it('is idempotent — a repeat deactivate is a safe no-op', async () => {
    await activateAutonomyForOwner(OWNER);
    await deactivateAutonomyForOwner(OWNER);
    await deactivateAutonomyForOwner(OWNER); // no throw, state unchanged
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    expect(npcSimulation.isAgentHumanControlled(PLATFORM_AGENT_ID)).toBe(true);
  });

  it('deactivate for a never-enrolled owner is a no-op (no phantom suppression)', async () => {
    await deactivateAutonomyForOwner('never-enrolled-owner');
    expect(asSim().humanControlledOpenClawLaunchesByUser.has('never-enrolled-owner')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (6) HOUSE-PATH ISOLATION
// ---------------------------------------------------------------------------
describe('(6) house-path isolation', () => {
  const houseEntry = {
    agentId: 'house-agent-1',
    bodyId: 'ocb-house-1',
    platformAgentId: 'house-platform-1',
    systemUserId: 'system-user',
    houseUserId: 'house-user-1',
    avatarId: 'house-avatar-1',
  };

  it('registerHouseAgent still works and warms isHouse:true; user entries warm isHouse:false', async () => {
    expect(agentAutonomyDriver.registerHouseAgent(houseEntry)).toBe(true);
    expect(agentAutonomyDriver.hasHouseAgent('house-agent-1')).toBe(true);
    // The warm input flag (`{ isHouse: entry.isHouse }`) — house true, user false.
    expect(asDriver().houseAgents.get('house-agent-1')!.isHouse).toBe(true);

    await activateAutonomyForOwner(OWNER);
    expect(asDriver().userAgents.get(PLATFORM_AGENT_ID)!.isHouse).toBe(false);
  });

  it('unregisterUserAgent can NEVER remove a house agent (disjoint registries)', () => {
    agentAutonomyDriver.registerHouseAgent(houseEntry);
    agentAutonomyDriver.unregisterUserAgent('house-agent-1');
    expect(agentAutonomyDriver.hasHouseAgent('house-agent-1')).toBe(true);
  });

  it('a user enrollment colliding with a house agentId is refused loudly', () => {
    agentAutonomyDriver.registerHouseAgent(houseEntry);
    const r = agentAutonomyDriver.registerUserAgent({
      agentId: 'house-agent-1',
      bodyId: 'ocb-house-1',
      platformAgentId: 'house-platform-1',
      systemUserId: OWNER,
      houseUserId: OWNER,
      avatarId: AVATAR_ID,
    });
    expect(r.ok).toBe(false);
    expect(agentAutonomyDriver.hasHouseAgent('house-agent-1')).toBe(true);
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
  });

  it('user enrollments never consume house capacity (registerHouseAgent unaffected)', async () => {
    await activateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.userAgentCount()).toBe(1);
    // House registration still succeeds — the caps are independent.
    expect(agentAutonomyDriver.registerHouseAgent(houseEntry)).toBe(true);
    // And house ids never leak into the user enumeration (or vice versa).
    expect(agentAutonomyDriver.getUserAgentIds()).toEqual([PLATFORM_AGENT_ID]);
    expect(agentAutonomyDriver.getHouseAgentIds()).toEqual(['house-agent-1']);
  });
});

// ---------------------------------------------------------------------------
// (7) ELIGIBILITY GUARDS
// ---------------------------------------------------------------------------
describe('(7) eligibility guards', () => {
  it('no active avatar → no_avatar', async () => {
    activationSeams.resolveActiveAvatar = async () => null;
    expect(await activateAutonomyForOwner(OWNER)).toEqual({ ok: false, code: 'no_avatar' });
    expect(ensureSessionCalls).toBe(0);
  });

  it('guest avatar → guest_forbidden (demo economy never goes autonomous)', async () => {
    activationSeams.resolveActiveAvatar = async () => ({
      id: AVATAR_ID,
      platformAgentId: PLATFORM_AGENT_ID,
      isGuest: true,
    });
    expect(await activateAutonomyForOwner(OWNER)).toEqual({
      ok: false,
      code: 'guest_forbidden',
    });
    expect(ensureSessionCalls).toBe(0);
  });

  it('avatar without a bound platform agent → no_agent', async () => {
    activationSeams.resolveActiveAvatar = async () => ({
      id: AVATAR_ID,
      platformAgentId: null,
      isGuest: false,
    });
    expect(await activateAutonomyForOwner(OWNER)).toEqual({ ok: false, code: 'no_agent' });
    expect(ensureSessionCalls).toBe(0);
  });

  it('§B.2 refusal (null session) → not_eligible, nothing enrolled', async () => {
    activationSeams.ensureSession = async () => {
      ensureSessionCalls++;
      return null;
    };
    expect(await activateAutonomyForOwner(OWNER)).toEqual({ ok: false, code: 'not_eligible' });
    expect(ensureSessionCalls).toBe(1);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (8) ENROLLMENT MUST NOT OUTLIVE ITS SESSION — the logout CT-leak + TTL-zombie
//     fix (money-path teardown found in the staging browser pass).
//     These exercise the exact primitives the two authoritative server-side
//     teardowns call: POST /api/auth/logout → deactivateAutonomyForOwner(userId)
//     (cookie-INDEPENDENT), and the 24h TTL sweep → unregisterUserAgent(agentId).
//     The route + sweeper wiring itself is staging-verified (the route graph +
//     the DB sweep can't load DB-free); here we lock the teardown SEMANTICS.
// ---------------------------------------------------------------------------
describe('(8) enrollment must not outlive its session (logout + TTL teardown)', () => {
  it('logout-unenrolls: deactivate keyed by userId tears down WITHOUT any cookie/bearer', async () => {
    await activateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(true);
    // The logout route calls exactly this, keyed on the Lucia user id — no
    // session/bearer needed, so it works even after the cookie is (about to be)
    // invalidated. The driver stops settling CT the instant the entry is gone.
    await deactivateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
  });

  it('ttl-expiry-unenrolls: the sweep primitive (unregisterUserAgent by agentId) drops the entry', async () => {
    await activateAutonomyForOwner(OWNER);
    expect(agentAutonomyDriver.getEnrolledAgentForOwner(OWNER)).toBe(PLATFORM_AGENT_ID);
    // The 24h TTL sweep calls this for every genuinely-expired agentId (after its
    // two reconnect guards), so a dead session can't leave a live driver entry.
    agentAutonomyDriver.unregisterUserAgent(PLATFORM_AGENT_ID);
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
  });

  it('browser-close-persists (regression): NO passive op unenrolls — only explicit teardown does', async () => {
    await activateAutonomyForOwner(OWNER);
    // A raw tab close fires NO server teardown (it hits /world/leave, not
    // /logout, and never expires the TTL). Simulate the passive per-tick signals
    // that keep running while the world stream is open — none must unenroll.
    npcSimulation.refreshHumanControlledOpenClawForUser(OWNER); // 5 Hz position tick
    npcSimulation.avatarAutonomyManager.unregister(OWNER); // idempotent bridge op
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(true);
    expect(agentAutonomyDriver.userAgentCount()).toBe(1);
  });

  it('teardown is idempotent + house-safe (the sweep calls it for EVERY swept agentId)', () => {
    agentAutonomyDriver.registerHouseAgent({
      agentId: 'house-agent-ttl',
      bodyId: 'ocb-house-ttl',
      platformAgentId: 'house-platform-ttl',
      systemUserId: 'system-user',
      houseUserId: 'house-user-ttl',
      avatarId: 'house-avatar-ttl',
    });
    // Swept a house session's agentId → must NOT remove the house driver entry.
    agentAutonomyDriver.unregisterUserAgent('house-agent-ttl');
    expect(agentAutonomyDriver.hasHouseAgent('house-agent-ttl')).toBe(true);
    // Swept an unknown / never-enrolled agentId → no throw, no effect.
    expect(() => agentAutonomyDriver.unregisterUserAgent('unknown-agent')).not.toThrow();
    // Over-calling on a real user entry is idempotent.
    // (no user entry enrolled here → still a safe no-op)
    expect(agentAutonomyDriver.userAgentCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (9) DURABLE AUTONOMY — the persisted enrollment intent (deploy-survival).
//     activate SETS the flag (so the server-side reconcile re-enrolls across a
//     restart with NO client); EVERY teardown CLEARS it. The reconcile itself is
//     covered in agent-autonomy-reconcile.test.ts; the TTL-sweep + logout clears
//     ride the sweeper mark-swept UPDATE + deactivate (staging-verified DB path).
// ---------------------------------------------------------------------------
describe('(9) durable enrollment flag lifecycle', () => {
  it('activate PERSISTS the flag (by the session agentId) after a successful enroll', async () => {
    const result = await activateAutonomyForOwner(OWNER);
    expect(result.ok).toBe(true);
    expect(flagSetCalls).toEqual([PLATFORM_AGENT_ID]);
  });

  it('a REJECTED activation (guest) never persists the flag', async () => {
    activationSeams.resolveActiveAvatar = async () => ({
      id: AVATAR_ID,
      platformAgentId: PLATFORM_AGENT_ID,
      isGuest: true,
    });
    const r = await activateAutonomyForOwner(OWNER);
    expect(r).toEqual({ ok: false, code: 'guest_forbidden' });
    expect(flagSetCalls).toEqual([]);
  });

  it('deactivate CLEARS the flag (by owner userId)', async () => {
    await activateAutonomyForOwner(OWNER);
    flagClearCalls = [];
    await deactivateAutonomyForOwner(OWNER);
    expect(flagClearCalls).toEqual([OWNER]);
  });

  it('deactivate/logout CLEARS the flag EVEN when not in-memory-enrolled (logout after restart)', async () => {
    // No prior activation this process (registry wiped by a restart) — deactivate
    // must STILL clear the durable intent so the reconcile cannot re-enroll a
    // logged-out user. This is the money-path guarantee (keyed by userId).
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
    await deactivateAutonomyForOwner(OWNER);
    expect(flagClearCalls).toEqual([OWNER]);
  });

  it('clears the flag BEFORE the in-memory teardown (crash-safe ordering)', async () => {
    // The clear must precede unregister so a crash between them can never leave
    // flag=true + not-enrolled (which the reconcile would resurrect).
    const order: string[] = [];
    activationSeams.clearEnrolledFlagForOwner = async () => {
      order.push('flag-clear');
    };
    await activateAutonomyForOwner(OWNER);
    // Spy the in-memory unregister via the enrolled-check flip.
    const origUnregister = agentAutonomyDriver.unregisterUserAgent.bind(agentAutonomyDriver);
    (agentAutonomyDriver as unknown as { unregisterUserAgent: (id: string) => void }).unregisterUserAgent = (
      id: string,
    ) => {
      order.push('unregister');
      origUnregister(id);
    };
    try {
      await deactivateAutonomyForOwner(OWNER);
    } finally {
      (agentAutonomyDriver as unknown as { unregisterUserAgent: (id: string) => void }).unregisterUserAgent =
        origUnregister;
    }
    expect(order).toEqual(['flag-clear', 'unregister']);
  });

  it('RETRIES a transient flag-clear failure then persists (money-safe, not a silent swallow)', async () => {
    await activateAutonomyForOwner(OWNER);
    let calls = 0;
    activationSeams.clearEnrolledFlagForOwner = async () => {
      calls++;
      if (calls < 2) throw new Error('transient DB blip');
    };
    await deactivateAutonomyForOwner(OWNER);
    expect(calls).toBe(2); // failed once, succeeded on retry — flag IS cleared
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
  });

  it('exhausts retries on a persistent clear failure but STILL tears down in-memory (loud CRITICAL, never re-enroll-silently)', async () => {
    await activateAutonomyForOwner(OWNER);
    let calls = 0;
    activationSeams.clearEnrolledFlagForOwner = async () => {
      calls++;
      throw new Error('persistent DB failure');
    };
    await deactivateAutonomyForOwner(OWNER); // must NOT throw
    expect(calls).toBe(3); // CLEAR_FLAG_MAX_ATTEMPTS — bounded, loud on exhaustion
    // Driving still stops NOW; the CRITICAL log + a later successful clear/teardown
    // are the durable-flag backstops if the row genuinely can't be written (the
    // TTL sweep alone is not reliable — a re-enrolled row slides its own TTL).
    expect(agentAutonomyDriver.isOwnerEnrolled(OWNER)).toBe(false);
  });
});
