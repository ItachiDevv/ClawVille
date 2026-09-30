import { beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import { ClawPumpWriterError, type ClawPumpCreatedAgent } from '../clawpump-writer';
import {
  ARENA_CLAWPUMP_PERSONA,
  ARENA_CLAWPUMP_SYSTEM_PROMPT,
  ARENA_PROVISION_MAX_ATTEMPTS,
  ARENA_PROVISION_RETRY_MS,
  _resetArenaProvisioningForTest,
  arenaClawPumpAgentName,
  arenaSkillSynced,
  ensureAddonSkill,
  provisionArenaAgent,
  runArenaProvisioningTick,
  type ArenaProvisionDeps,
} from '../floor-arena/provisioning';
import { ArenaClawPumpOwnedError, type ArenaAgentRecord } from '../floor-arena/queries';

const NOW = new Date('2026-09-30T20:00:00Z');
const AGENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CP_ID = '99999999-8888-4777-8666-555555555555';
const WALLET = 'Wa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PROD = { CLAWVILLE_ENV: 'production' };
const STAGING = { CLAWVILLE_ENV: 'staging' };

function record(overrides: Partial<ArenaAgentRecord> = {}): ArenaAgentRecord {
  return {
    id: AGENT_ID, kind: 'user', ownerUserId: 'owner', avatarId: 'avatar', name: 'Bob',
    templateId: 'genesis', params: FLOOR_ARENA_TEMPLATES[0]!.params, paramsVersion: 1, mode: 'paper',
    status: 'active', seated: false, seatIndex: null, seatedAt: null, clawpumpAgentId: null, clawpumpWallet: null,
    provisionState: 'pending', provisionError: null, provisionAttempts: 0, provisionNextAt: null, addons: [],
    autoApplySuggestions: false, contestId: 'arena-week-1', createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function cpAgent(overrides: Partial<ClawPumpCreatedAgent> = {}): ClawPumpCreatedAgent {
  return {
    id: CP_ID, name: arenaClawPumpAgentName('Bob', AGENT_ID, PROD), status: 'running', walletAddress: WALLET,
    enabledSkills: [], isPublic: false, acceptingBids: true, ...overrides,
  };
}

function harness(initial: ArenaAgentRecord, env: Record<string, string | undefined> = PROD) {
  const rows = new Map<string, ArenaAgentRecord>([[initial.id, initial]]);
  const log: string[] = [];
  const created: string[] = [];
  const events: string[] = [];
  const taken = new Set<string>();
  const ownedElsewhere = new Set<string>();
  let listResult: ClawPumpCreatedAgent[] = [];
  let createImpl: () => Promise<ClawPumpCreatedAgent> = async () => cpAgent();
  let updateImpl: (patch: Record<string, unknown>) => Promise<ClawPumpCreatedAgent> =
    async (patch) => cpAgent({ acceptingBids: patch.accepting_bids as boolean, isPublic: patch.is_public as boolean });
  const deps: ArenaProvisionDeps = {
    now: () => NOW,
    env,
    store: {
      read: async (id) => rows.get(id) ?? null,
      claim: async (id, now, maxAttempts, leaseMs) => {
        // Mirrors claimArenaProvision's WHERE clause; JS runs it atomically.
        const row = rows.get(id);
        if (!row || row.kind !== 'user' || !['pending', 'failed', 'creating'].includes(row.provisionState)) return null;
        if (row.provisionAttempts >= maxAttempts) return null;
        if (row.provisionNextAt && row.provisionNextAt > now) return null;
        log.push('claim');
        const claimed = { ...row, provisionState: 'creating' as const, provisionNextAt: new Date(now.getTime() + leaseMs) };
        rows.set(id, claimed);
        return claimed;
      },
      listDue: async (now, maxAttempts) => [...rows.values()]
        .filter((row) => row.kind === 'user' && ['pending', 'failed', 'creating'].includes(row.provisionState)
          && row.provisionAttempts < maxAttempts && (!row.provisionNextAt || row.provisionNextAt <= now))
        .map((row) => row.id),
      isClawPumpIdTaken: async (id) => taken.has(id),
      saveClawPumpAgent: async (id, cpId, wallet) => {
        log.push(`save ${cpId}`);
        if (ownedElsewhere.has(cpId)) throw new ArenaClawPumpOwnedError();
        const row = rows.get(id)!;
        if (!row.clawpumpAgentId) rows.set(id, { ...row, clawpumpAgentId: cpId, clawpumpWallet: wallet });
        const stored = rows.get(id)!;
        return { clawpumpAgentId: stored.clawpumpAgentId, clawpumpWallet: stored.clawpumpWallet };
      },
      // Both writes mirror the SQL fence: provision_state 'creating' AND provision_next_at = the claim's lease.
      markReady: async (id, cpId, wallet, lease) => {
        const row = rows.get(id)!;
        if (row.clawpumpAgentId !== cpId || row.provisionState !== 'creating' || row.provisionNextAt?.getTime() !== lease.getTime()) {
          log.push('ready fenced');
          return false;
        }
        log.push('ready');
        rows.set(id, { ...row, provisionState: 'ready', clawpumpWallet: wallet, provisionError: null, provisionNextAt: null });
        return true;
      },
      markFailed: async (id, error, attempts, nextAt, lease) => {
        const row = rows.get(id)!;
        if (row.provisionState !== 'creating' || row.provisionNextAt?.getTime() !== lease.getTime()) {
          log.push('failed fenced');
          return false;
        }
        log.push(`failed ${error} ${attempts}`);
        rows.set(id, { ...row, provisionState: 'failed', provisionError: error, provisionAttempts: attempts, provisionNextAt: nextAt });
        return true;
      },
      insertEvent: async (_id, event) => { events.push(event.summary); },
    },
    writer: {
      listAgentsByName: async (name) => { log.push(`list ${name}`); return listResult; },
      createAgent: async (input) => {
        created.push(input.name);
        log.push(`create ${JSON.stringify(input.enabled_skills)} public=${input.is_public}`);
        return createImpl();
      },
      updateAgent: async (id, patch) => { log.push(`update ${id} ${JSON.stringify(patch)}`); return updateImpl(patch as Record<string, unknown>); },
      getWalletBalances: async () => [],
      x402Pay: async () => { throw new Error('not used'); },
      getWallet: async () => { log.push('getWallet'); return WALLET; },
    },
  };
  return {
    deps, rows, log, created, events, taken, ownedElsewhere,
    setList: (list: ClawPumpCreatedAgent[]) => { listResult = list; },
    setCreate: (impl: typeof createImpl) => { createImpl = impl; },
    setUpdate: (impl: typeof updateImpl) => { updateImpl = impl; },
  };
}

beforeEach(() => _resetArenaProvisioningForTest());

describe('arena ClawPump agent name', () => {
  test('is ASCII-safe, carries the arena id, and fits 48 chars', () => {
    expect(arenaClawPumpAgentName('Bob', AGENT_ID, PROD)).toBe('CV Arena · Bob #a1b2c3d40000');
    const long = arenaClawPumpAgentName('Ünïcødé 🚀 a very very very long display name indeed', AGENT_ID, PROD);
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.startsWith('CV Arena · ')).toBe(true);
    expect(long.endsWith(' #a1b2c3d40000')).toBe(true);
    expect(arenaClawPumpAgentName('🚀🚀', AGENT_ID, PROD)).toBe('CV Arena · Agent #a1b2c3d40000');
  });

  test('D16: every non-production env marks the name (staging), still under the CV Arena prefix and 48 chars', () => {
    for (const env of [STAGING, {}, { CLAWVILLE_ENV: 'Production' }]) {
      expect(arenaClawPumpAgentName('Bob', AGENT_ID, env)).toBe('CV Arena (staging) · Bob #a1b2c3d40000');
      const long = arenaClawPumpAgentName('a very very very long display name indeed', AGENT_ID, env);
      expect(long.length).toBeLessThanOrEqual(48);
      expect(long.startsWith('CV Arena (staging) · ')).toBe(true);
      expect(long.endsWith(' #a1b2c3d40000')).toBe(true);
    }
  });
});

describe('provisionArenaAgent state machine', () => {
  test('pending -> list by name -> create (private, no skills) -> save id -> update (no bids) -> ready', async () => {
    const h = harness(record());
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log).toEqual([
      'claim',
      'list CV Arena · Bob #a1b2c3d40000',
      'create [] public=false',
      `save ${CP_ID}`,
      `update ${CP_ID} {"accepting_bids":false,"is_public":false,"enabled_skills":[]}`,
      'ready',
    ]);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', clawpumpAgentId: CP_ID, clawpumpWallet: WALLET });
    expect(h.events.at(-1)).toContain('Execution wallet ready');
    expect(arenaSkillSynced(AGENT_ID)).toBe(false);
  });

  test('D16: provisioning on staging lists and creates the (staging) name', async () => {
    const h = harness(record(), STAGING);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log[1]).toBe('list CV Arena (staging) · Bob #a1b2c3d40000');
    expect(h.created[0]).toBe('CV Arena (staging) · Bob #a1b2c3d40000');
    const prod = harness(record(), PROD);
    await provisionArenaAgent(AGENT_ID, prod.deps);
    expect(prod.created[0]).toBe('CV Arena · Bob #a1b2c3d40000');
  });

  test('asks for the x402 skill only when an add-on is enabled', async () => {
    const h = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    await provisionArenaAgent(AGENT_ID, h.deps);
    expect(h.log[2]).toBe('create ["x402"] public=false');
    expect(h.log[4]).toContain('"enabled_skills":["x402"]');
    expect(arenaSkillSynced(AGENT_ID)).toBe(true);
  });

  test('adopts an existing agent with the exact name instead of creating a second one', async () => {
    const h = harness(record());
    h.setList([cpAgent()]);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log.some((line) => line.startsWith('create'))).toBe(false);
  });

  test('never adopts an id another arena row already holds', async () => {
    const h = harness(record());
    h.setList([cpAgent()]);
    h.taken.add(CP_ID);
    h.setCreate(async () => cpAgent({ id: 'fresh-id-0000-4000-8000-000000000000' }));
    await provisionArenaAgent(AGENT_ID, h.deps);
    expect(h.log.some((line) => line.startsWith('create'))).toBe(true);
  });

  test('a failed create -> failed, attempt 1, next try in 10 min, and paper trading is not blocked', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new ClawPumpWriterError('http_error', 502); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({
      provisionState: 'failed',
      provisionError: 'clawpump_http_error_502',
      provisionAttempts: 1,
      provisionNextAt: new Date(NOW.getTime() + ARENA_PROVISION_RETRY_MS),
      status: 'active',
    });
    expect(h.events.at(-1)).toContain('attempt 1 of 5');
  });

  test('a failed UPDATE keeps the saved id, so the retry updates the same agent and never re-creates', async () => {
    const h = harness(record());
    h.setUpdate(async () => { throw new ClawPumpWriterError('timeout'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)!.clawpumpAgentId).toBe(CP_ID);
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    h.log.length = 0;
    // Not due yet: the failure set a 10-minute retry.
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('skipped');
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(h.log.some((line) => line.startsWith('create') || line.startsWith('list'))).toBe(false);
  });

  test('fails when ClawPump still reports accepting bids or public after the update', async () => {
    const h = harness(record());
    h.setUpdate(async () => cpAgent({ acceptingBids: true }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)!.provisionError).toBe('accepting_bids_not_cleared');
    const h2 = harness(record());
    h2.setUpdate(async () => cpAgent({ acceptingBids: false, isPublic: true }));
    await provisionArenaAgent(AGENT_ID, h2.deps);
    expect(h2.rows.get(AGENT_ID)!.provisionError).toBe('agent_still_public');
  });

  test('stops after 5 attempts and says so', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: ARENA_PROVISION_MAX_ATTEMPTS - 1 }));
    h.setCreate(async () => { throw new ClawPumpWriterError('network_error'); });
    await provisionArenaAgent(AGENT_ID, h.deps);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 5, provisionNextAt: null });
    expect(h.events.at(-1)).toContain('after 5 attempts');
    h.log.length = 0;
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('exhausted');
    expect(h.log).toEqual([]);
  });

  test('never touches a house agent, and a ready agent is a no-op', async () => {
    const house = harness(record({ id: 'house:genesis', kind: 'house', ownerUserId: null }));
    expect(await provisionArenaAgent('house:genesis', house.deps)).toBe('skipped');
    expect(await ensureAddonSkill('house:genesis', house.deps)).toBe(false);
    expect(house.log).toEqual([]);
    const ready = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    expect(await provisionArenaAgent(AGENT_ID, ready.deps)).toBe('ready');
    expect(ready.log).toEqual([]);
  });

  test('losing a cross-process race continues with the winner id and wallet, never a mix', async () => {
    const h = harness(record());
    const WINNER = '77777777-6666-4555-8444-333333333333';
    // Another container saved its agent between our list and our save.
    h.setCreate(async () => {
      h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, clawpumpAgentId: WINNER, clawpumpWallet: 'WinnerWallet' });
      return cpAgent();
    });
    h.setUpdate(async () => cpAgent({ id: WINNER, walletAddress: 'WinnerWallet', acceptingBids: false }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ clawpumpAgentId: WINNER, clawpumpWallet: 'WinnerWallet', provisionState: 'ready' });
    expect(h.log).toContain(`update ${WINNER} {"accepting_bids":false,"is_public":false,"enabled_skills":[]}`);
  });

  test('Codex r2 #4: only the claimer creates; a second process inside the lease does nothing', async () => {
    const h = harness(record());
    let creates = 0;
    h.setCreate(async () => { creates += 1; return cpAgent(); });
    // The first process claimed, then died before saving anything.
    h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, provisionState: 'creating', provisionNextAt: new Date(NOW.getTime() + 60_000) });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('skipped');
    expect(creates).toBe(0);
    expect(h.log).not.toContain('claim');
    // After the lease, the row is due again and exactly one process takes it.
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 61_000) };
    expect(await h.deps.store.listDue(new Date(NOW.getTime() + 61_000), 5, 10)).toEqual([AGENT_ID]);
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(creates).toBe(1);
  });

  test('Codex r3 #11: a claimant whose lease was re-claimed cannot write ready OR failed', async () => {
    const readyCase = harness(record());
    const takeOver = () => {
      // Another process re-claims after our lease expired: same state, NEWER lease.
      const row = readyCase.rows.get(AGENT_ID)!;
      readyCase.rows.set(AGENT_ID, { ...row, provisionNextAt: new Date(NOW.getTime() + 20 * 60_000) });
    };
    readyCase.setUpdate(async () => { takeOver(); return cpAgent({ acceptingBids: false }); });
    expect(await provisionArenaAgent(AGENT_ID, readyCase.deps)).toBe('skipped');
    expect(readyCase.log).toContain('ready fenced');
    expect(readyCase.rows.get(AGENT_ID)!.provisionState).toBe('creating');
    expect(readyCase.events.some((line) => line.includes('Execution wallet ready'))).toBe(false);

    const failCase = harness(record({ provisionState: 'ready' }));
    failCase.rows.set(AGENT_ID, { ...failCase.rows.get(AGENT_ID)!, provisionState: 'pending' });
    failCase.setCreate(async () => {
      // The newer claimant already finished: the row is READY with its own result.
      failCase.rows.set(AGENT_ID, { ...failCase.rows.get(AGENT_ID)!, provisionState: 'ready', provisionNextAt: null });
      throw new ClawPumpWriterError('timeout');
    });
    expect(await provisionArenaAgent(AGENT_ID, failCase.deps)).toBe('skipped');
    expect(failCase.log).toContain('failed fenced');
    expect(failCase.rows.get(AGENT_ID)!.provisionState).toBe('ready');
    expect(failCase.events).toEqual([]);
  });

  test('Codex r2 #4: a ClawPump id another arena row owns (unique index) fails with clawpump_agent_owned', async () => {
    const h = harness(record());
    h.setList([cpAgent()]);
    h.ownedElsewhere.add(CP_ID);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'failed', provisionError: 'clawpump_agent_owned', provisionAttempts: 1 });
  });

  test('concurrent calls for one agent create at most one ClawPump agent', async () => {
    const h = harness(record());
    let creates = 0;
    h.setCreate(async () => {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return cpAgent();
    });
    await Promise.all([provisionArenaAgent(AGENT_ID, h.deps), provisionArenaAgent(AGENT_ID, h.deps)]);
    expect(creates).toBe(1);
  });

  test('the tick retries only due rows', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: 1, provisionNextAt: new Date(NOW.getTime() + 60_000) }));
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.log).toEqual([]);
    await runArenaProvisioningTick(new Date(NOW.getTime() + 61_000), h.deps);
    expect(h.rows.get(AGENT_ID)!.provisionState).toBe('ready');
  });

  test('ensureAddonSkill turns x402 on for a ready agent with an enabled add-on', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    expect(await ensureAddonSkill(AGENT_ID, h.deps)).toBe(true);
    expect(h.log).toEqual([`update ${CP_ID} {"accepting_bids":false,"is_public":false,"enabled_skills":["x402"]}`]);
    expect(arenaSkillSynced(AGENT_ID)).toBe(true);
  });

  test('the persona and prompt forbid trading', () => {
    expect(ARENA_CLAWPUMP_PERSONA).toContain('does not trade');
    expect(ARENA_CLAWPUMP_SYSTEM_PROMPT).toContain('Do not trade');
  });
});
