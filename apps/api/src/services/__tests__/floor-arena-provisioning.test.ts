import { beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS, FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import {
  CLAWPUMP_WRITER_BURST,
  CLAWPUMP_WRITER_REMOVAL_RESERVE,
  ClawPumpWriterError,
  type ClawPumpCallPriority,
  type ClawPumpCreatedAgent,
} from '../clawpump-writer';
import {
  ARENA_CLAWPUMP_PERSONA,
  ARENA_CLAWPUMP_SYSTEM_PROMPT,
  ARENA_PRIVACY_CHECKS_PER_TICK,
  ARENA_PROVISION_LEASE_MS,
  ARENA_PROVISION_MAX_ATTEMPTS,
  ARENA_PROVISION_RETRY_MS,
  ARENA_PROVISION_THROTTLE_RETRY_MS,
  _resetArenaProvisioningForTest,
  arenaClawPumpAgentName,
  ensureArenaAgentPrivate,
  provisionArenaAgent,
  readArenaX402Ready,
  runArenaPrivacyRepair,
  runArenaProvisioningTick,
  type ArenaProvisionDeps,
} from '../floor-arena/provisioning';
import { ArenaClawPumpOwnedError, type ArenaAgentRecord } from '../floor-arena/queries';

const NOW = new Date('2026-11-19T20:00:00Z');
const AGENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CP_ID = '99999999-8888-4777-8666-555555555555';
const WALLET = 'Wa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PROD = { CLAWVILLE_ENV: 'production' };
const STAGING = { CLAWVILLE_ENV: 'staging' };
/** The v1 default bundle a create gets (rest-contract lane, 2026-11-18): ClawVille keeps it. */
const V1_DEFAULT_SKILLS = [
  'portfolio', 'market-intelligence', 'wallet', 'image-generation', 'x402', 'perps', 'news', 'bitget-intel',
  'trading', 'action-plans', 'web-browsing', 'private-transfers', 'self-learning', 'skill-management',
];

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

/** One ClawPump agent as the fake holds it. A v1 create comes back public and accepting bids. */
interface FakeCp {
  isPublic: boolean | null;
  acceptingBids: boolean | null;
  status: string;
  skills: string[];
  walletAddress: string | null;
}

function cpAgent(id: string, cp: FakeCp): ClawPumpCreatedAgent {
  return {
    id, name: arenaClawPumpAgentName('Bob', AGENT_ID, PROD), status: cp.status, walletAddress: cp.walletAddress,
    skills: [...cp.skills], isPublic: cp.isPublic,
  };
}

function harness(initial: ArenaAgentRecord, env: Record<string, string | undefined> = PROD) {
  const rows = new Map<string, ArenaAgentRecord>([[initial.id, initial]]);
  const log: string[] = [];
  /** The arena row each update named (writer ownership proof). */
  const seq: string[] = [];
  /** Budget priority of each ClawPump call, in order. */
  const priorities: string[] = [];
  const created: string[] = [];
  const createInputs: Array<Record<string, unknown>> = [];
  const events: Array<{ summary: string; data: unknown }> = [];
  const ownedElsewhere = new Set<string>();
  const cps = new Map<string, FakeCp>();
  const fresh = (): FakeCp => ({ isPublic: true, acceptingBids: true, status: 'stopped', skills: [...V1_DEFAULT_SKILLS], walletAddress: WALLET });
  const cpOf = (id: string): FakeCp => {
    if (!cps.has(id)) cps.set(id, fresh());
    return cps.get(id)!;
  };
  let createImpl: () => Promise<ClawPumpCreatedAgent> = async () => cpAgent(CP_ID, cpOf(CP_ID));
  /** Runs before an update is applied; a throw fails the update. `ignore` = ClawPump answers 200 but keeps the field. */
  let updateHook: (patch: Record<string, unknown>, id: string) => Promise<{ ignore?: boolean } | void> = async () => {};
  const deps: ArenaProvisionDeps = {
    now: () => NOW,
    env,
    paused: () => false,
    store: {
      read: async (id) => rows.get(id) ?? null,
      claim: async (id, now, maxAttempts, leaseMs) => {
        // Mirrors claimArenaProvision's WHERE clause; JS runs it atomically.
        const row = rows.get(id);
        if (!row || !['user', 'house'].includes(row.kind) || !['pending', 'failed', 'creating'].includes(row.provisionState)) return null;
        if (row.provisionAttempts >= maxAttempts) return null;
        if (row.provisionNextAt && row.provisionNextAt > now) return null;
        log.push('claim');
        const claimed = { ...row, provisionState: 'creating' as const, provisionNextAt: new Date(now.getTime() + leaseMs) };
        rows.set(id, claimed);
        return claimed;
      },
      listDue: async (now, maxAttempts) => [...rows.values()]
        .filter((row) => ['user', 'house'].includes(row.kind) && ['pending', 'failed', 'creating'].includes(row.provisionState)
          && row.provisionAttempts < maxAttempts && (!row.provisionNextAt || row.provisionNextAt <= now))
        .map((row) => row.id),
      // Mirrors readArenaClawPumpSweepAgents.
      listClawPumpSweepAgents: async (afterId, limit) => [...rows.values()]
        .filter((row) => ['user', 'house'].includes(row.kind) && ['ready', 'failed'].includes(row.provisionState) && row.clawpumpAgentId !== null
          && row.id > afterId)
        .map((row) => row.id)
        .sort()
        .slice(0, limit),
      saveClawPumpAgent: async (id, cpId, wallet) => {
        log.push(`save ${cpId}`);
        if (ownedElsewhere.has(cpId)) throw new ArenaClawPumpOwnedError();
        const row = rows.get(id)!;
        if (!row.clawpumpAgentId) rows.set(id, { ...row, clawpumpAgentId: cpId, clawpumpWallet: wallet });
        const stored = rows.get(id)!;
        return { clawpumpAgentId: stored.clawpumpAgentId, clawpumpWallet: stored.clawpumpWallet };
      },
      // Mirrors countArenaCreateAttempt: the claim fence AND attempts < max, then attempts + 1.
      countCreateAttempt: async (id, lease, maxAttempts) => {
        const row = rows.get(id)!;
        if (row.provisionState !== 'creating' || row.provisionNextAt?.getTime() !== lease.getTime()
          || row.provisionAttempts >= maxAttempts) {
          log.push('count fenced');
          return null;
        }
        const attempts = row.provisionAttempts + 1;
        log.push(`count ${attempts}`);
        rows.set(id, { ...row, provisionAttempts: attempts });
        return attempts;
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
      insertEvent: async (_id, event) => { events.push({ summary: event.summary, data: event.data }); },
    },
    writer: {
      createAgent: async (input) => {
        created.push(input.name);
        createInputs.push({ ...input });
        log.push('create');
        return createImpl();
      },
      updateAgent: async (id, patch, arenaAgentId, priority?: ClawPumpCallPriority) => {
        log.push(`update ${id} ${JSON.stringify(patch)}`);
        seq.push(`update for ${arenaAgentId}`);
        priorities.push(`update:${priority ?? 'normal'}`);
        const result = await updateHook(patch as Record<string, unknown>, id);
        if (result?.ignore) return;
        const cp = cpOf(id);
        if ('is_public' in patch) cp.isPublic = patch.is_public;
        if ('accepting_bids' in patch) cp.acceptingBids = patch.accepting_bids;
      },
      readListing: async (id, priority?: ClawPumpCallPriority) => {
        log.push(`listing ${id}`);
        priorities.push(`listing:${priority ?? 'normal'}`);
        const cp = cpOf(id);
        return { id, isPublic: cp.isPublic, acceptingBids: cp.acceptingBids };
      },
      readAgent: async (id, priority?: ClawPumpCallPriority) => {
        log.push(`read ${id}`);
        priorities.push(`read:${priority ?? 'normal'}`);
        return cpAgent(id, cpOf(id));
      },
      getWalletBalances: async () => [],
      x402Pay: async () => { throw new Error('not used'); },
      getWallet: async (id) => { log.push('getWallet'); return cpOf(id).walletAddress; },
    },
  };
  return {
    deps, rows, log, seq, priorities, created, createInputs, events, ownedElsewhere, cps, cpOf,
    setCreate: (impl: typeof createImpl) => { createImpl = impl; },
    setUpdateHook: (impl: typeof updateHook) => { updateHook = impl; },
    /** ClawPump calls only (no store lines). */
    calls: () => log.filter((line) => /^(create|update|listing|read|getWallet)/.test(line)),
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

describe('provisionArenaAgent state machine (ClawPump v1, 2026-11-19)', () => {
  test('pending -> create (flat body) -> save id -> private + closed to bids, proved by a read -> ready', async () => {
    const h = harness(record());
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log).toEqual([
      'claim',
      // Codex r2 B2 follow-up: the attempt is counted before the create request.
      'count 1',
      'create',
      `save ${CP_ID}`,
      // The privacy step comes AFTER the save, so a retry never creates a second public agent.
      `listing ${CP_ID}`,
      `update ${CP_ID} {"is_public":false}`,
      `update ${CP_ID} {"accepting_bids":false}`,
      `listing ${CP_ID}`,
      'ready',
    ]);
    // Only the documented flat fields: no skills, no strategy, no visibility field.
    expect(h.createInputs[0]).toEqual({
      name: 'CV Arena · Bob #a1b2c3d40000', persona: ARENA_CLAWPUMP_PERSONA, system_prompt: ARENA_CLAWPUMP_SYSTEM_PROMPT,
    });
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', clawpumpAgentId: CP_ID, clawpumpWallet: WALLET });
    expect(h.cpOf(CP_ID)).toMatchObject({ isPublic: false, acceptingBids: false });
    expect(h.events.at(-1)!.summary).toContain('Execution wallet ready');
    expect(h.events.at(-1)!.data).toEqual({ provisionState: 'ready', paymentAddress: WALLET });
  });

  test('founder 2026-11-19: the skills ClawPump gave the agent stay exactly as they are (no skill write at all)', async () => {
    const h = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.cpOf(CP_ID).skills).toEqual(V1_DEFAULT_SKILLS);
    const bodies = h.log.filter((line) => line.startsWith('update')).map((line) => line.slice(line.indexOf('{')));
    expect(bodies).toEqual(['{"is_public":false}', '{"accepting_bids":false}']);
    expect(h.log.some((line) => /skill|x402/i.test(line))).toBe(false);
  });

  test('D16: provisioning on staging creates the (staging) name', async () => {
    const h = harness(record(), STAGING);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.created[0]).toBe('CV Arena (staging) · Bob #a1b2c3d40000');
    const prod = harness(record(), PROD);
    await provisionArenaAgent(AGENT_ID, prod.deps);
    expect(prod.created[0]).toBe('CV Arena · Bob #a1b2c3d40000');
  });

  test('a create that already came back private and closed costs one listing read and no update', async () => {
    const h = harness(record());
    h.cps.set(CP_ID, { isPublic: false, acceptingBids: false, status: 'stopped', skills: [], walletAddress: WALLET });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.calls()).toEqual(['create', `listing ${CP_ID}`]);
  });

  test('only the field that is still on is updated (one field per body)', async () => {
    const h = harness(record());
    h.cps.set(CP_ID, { isPublic: false, acceptingBids: true, status: 'stopped', skills: [], walletAddress: WALLET });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log.filter((line) => line.startsWith('update'))).toEqual([`update ${CP_ID} {"accepting_bids":false}`]);
  });

  test('fails when ClawPump still reports public or accepting bids after the update; a missing field is never "off"', async () => {
    const pub = harness(record());
    pub.setUpdateHook(async (patch) => ('is_public' in patch ? { ignore: true } : undefined));
    expect(await provisionArenaAgent(AGENT_ID, pub.deps)).toBe('failed');
    expect(pub.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'failed', provisionError: 'agent_still_public', clawpumpAgentId: CP_ID });
    expect(pub.events.at(-1)!.data).toMatchObject({ error: 'agent_still_public', isPublic: true });

    const bids = harness(record());
    bids.setUpdateHook(async (patch) => ('accepting_bids' in patch ? { ignore: true } : undefined));
    expect(await provisionArenaAgent(AGENT_ID, bids.deps)).toBe('failed');
    expect(bids.rows.get(AGENT_ID)!.provisionError).toBe('agent_still_accepting_bids');

    const missing = harness(record());
    missing.cps.set(CP_ID, { isPublic: null, acceptingBids: null, status: 'stopped', skills: [], walletAddress: WALLET });
    missing.setUpdateHook(async () => ({ ignore: true }));
    expect(await provisionArenaAgent(AGENT_ID, missing.deps)).toBe('failed');
    expect(missing.rows.get(AGENT_ID)!.provisionError).toBe('agent_still_public');
    // Null was not read as private: both updates were sent.
    expect(missing.log.filter((line) => line.startsWith('update'))).toHaveLength(2);
  });

  test('the privacy update is sent at any ClawPump status (it only takes visibility away)', async () => {
    const h = harness(record());
    h.cpOf(CP_ID).status = 'running';
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.cpOf(CP_ID)).toMatchObject({ isPublic: false, acceptingBids: false });
  });

  test('every update names the owning arena row (writer ownership proof)', async () => {
    const h = harness(record());
    await provisionArenaAgent(AGENT_ID, h.deps);
    expect(h.seq).toEqual([`update for ${AGENT_ID}`, `update for ${AGENT_ID}`]);
  });

  test('no wallet in the create reply: the v1 GET fallback supplies it; none at all fails wallet_missing', async () => {
    const h = harness(record());
    h.setCreate(async () => ({ ...cpAgent(CP_ID, h.cpOf(CP_ID)), walletAddress: null }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log).toContain('getWallet');
    expect(h.rows.get(AGENT_ID)!.clawpumpWallet).toBe(WALLET);

    const none = harness(record());
    none.cpOf(CP_ID).walletAddress = null;
    expect(await provisionArenaAgent(AGENT_ID, none.deps)).toBe('failed');
    expect(none.rows.get(AGENT_ID)!.provisionError).toBe('wallet_missing');
  });

  test('Codex r18 #4: never adopts an existing ClawPump agent, even an exact-name look-alike', async () => {
    const h = harness(record());
    const HOUSE_LOOKALIKE = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
    let listed = 0;
    const writer = h.deps.writer as typeof h.deps.writer & { listAgentsByName?: (name: string) => Promise<ClawPumpCreatedAgent[]> };
    writer.listAgentsByName = async () => {
      listed += 1;
      return [cpAgent(HOUSE_LOOKALIKE, h.cpOf(HOUSE_LOOKALIKE))];
    };
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(listed).toBe(0);
    expect(h.created).toEqual([arenaClawPumpAgentName('Bob', AGENT_ID, PROD)]);
    expect(h.rows.get(AGENT_ID)!.clawpumpAgentId).toBe(CP_ID);
    expect(h.log.some((line) => line.includes(HOUSE_LOOKALIKE))).toBe(false);
  });

  test('Codex r18 #4: a create whose response was lost leaves the row empty; the retry creates a NEW agent', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new ClawPumpWriterError('timeout'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ clawpumpAgentId: null, provisionError: 'clawpump_timeout' });
    h.setCreate(async () => cpAgent(CP_ID, h.cpOf(CP_ID)));
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(h.created).toHaveLength(2);
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
    expect(h.events.at(-1)!.summary).toContain('attempt 1 of 5');
  });

  test('a failed privacy UPDATE keeps the saved id, so the retry updates the same agent and never re-creates', async () => {
    const h = harness(record());
    h.setUpdateHook(async () => { throw new ClawPumpWriterError('timeout'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)!.clawpumpAgentId).toBe(CP_ID);
    // The agent is still public on ClawPump until the retry.
    expect(h.cpOf(CP_ID).isPublic).toBe(true);
    h.setUpdateHook(async () => {});
    h.log.length = 0;
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('skipped');
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(h.log.some((line) => line === 'create')).toBe(false);
    expect(h.cpOf(CP_ID)).toMatchObject({ isPublic: false, acceptingBids: false });
  });

  test('stops after 5 attempts and says so', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: ARENA_PROVISION_MAX_ATTEMPTS - 1 }));
    h.setCreate(async () => { throw new ClawPumpWriterError('network_error'); });
    await provisionArenaAgent(AGENT_ID, h.deps);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 5, provisionNextAt: null });
    expect(h.events.at(-1)!.summary).toContain('after 5 attempts');
    h.log.length = 0;
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('exhausted');
    expect(h.log).toEqual([]);
  });

  test('never touches a row (house or user) that names a LIVE trader ClawPump id, and a ready agent is a no-op', async () => {
    for (const liveId of FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS) {
      for (const state of ['pending', 'failed', 'ready'] as const) {
        for (const base of [
          record({ id: 'house:genesis', kind: 'house', ownerUserId: null, avatarId: null, name: 'Genesis' }),
          record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }),
        ]) {
          const h = harness({ ...base, provisionState: state, clawpumpAgentId: liveId, clawpumpWallet: WALLET });
          expect(await provisionArenaAgent(base.id, h.deps)).toBe('skipped');
          expect(await readArenaX402Ready(base.id, h.deps)).toBe('skipped');
          await runArenaProvisioningTick(NOW, h.deps);
          await runArenaPrivacyRepair(h.deps);
          expect(h.log).toEqual([]);
          expect(h.events).toEqual([]);
        }
      }
    }
    const ready = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    expect(await provisionArenaAgent(AGENT_ID, ready.deps)).toBe('ready');
    expect(ready.log).toEqual([]);
  });

  test('losing a cross-process race continues with the winner id and wallet, never a mix', async () => {
    const h = harness(record());
    const WINNER = '77777777-6666-4555-8444-333333333333';
    h.setCreate(async () => {
      h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, clawpumpAgentId: WINNER, clawpumpWallet: 'WinnerWallet' });
      return cpAgent(CP_ID, h.cpOf(CP_ID));
    });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ clawpumpAgentId: WINNER, clawpumpWallet: 'WinnerWallet', provisionState: 'ready' });
    expect(h.log).toContain(`update ${WINNER} {"is_public":false}`);
    expect(h.log.some((line) => line.startsWith(`update ${CP_ID}`))).toBe(false);
  });

  test('Codex r2 #4: only the claimer creates; a second process inside the lease does nothing', async () => {
    const h = harness(record());
    h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, provisionState: 'creating', provisionNextAt: new Date(NOW.getTime() + 60_000) });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('skipped');
    expect(h.created).toHaveLength(0);
    expect(h.log).not.toContain('claim');
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 61_000) };
    expect(await h.deps.store.listDue(new Date(NOW.getTime() + 61_000), 5, 10)).toEqual([AGENT_ID]);
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(h.created).toHaveLength(1);
  });

  test('Codex r3 #11: a claimant whose lease was re-claimed cannot write ready OR failed', async () => {
    const readyCase = harness(record());
    readyCase.setUpdateHook(async () => {
      const row = readyCase.rows.get(AGENT_ID)!;
      readyCase.rows.set(AGENT_ID, { ...row, provisionNextAt: new Date(NOW.getTime() + 20 * 60_000) });
    });
    expect(await provisionArenaAgent(AGENT_ID, readyCase.deps)).toBe('skipped');
    expect(readyCase.log).toContain('ready fenced');
    expect(readyCase.rows.get(AGENT_ID)!.provisionState).toBe('creating');
    expect(readyCase.events).toEqual([]);

    const failCase = harness(record());
    failCase.setCreate(async () => {
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
      return cpAgent(CP_ID, h.cpOf(CP_ID));
    });
    await Promise.all([provisionArenaAgent(AGENT_ID, h.deps), provisionArenaAgent(AGENT_ID, h.deps)]);
    expect(creates).toBe(1);
  });

  test('the tick retries only due rows; each claim reads the real clock (money audit N3)', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: 1, provisionNextAt: new Date(NOW.getTime() + 60_000) }));
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.log).toEqual([]);
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 75_000) };
    let leaseSeen: Date | null = null;
    const claim = later.store.claim;
    later.store = { ...later.store, claim: async (...args) => { leaseSeen = args[1]; return claim(...args); } };
    await runArenaProvisioningTick(new Date(NOW.getTime() + 61_000), later);
    expect(leaseSeen!.getTime()).toBe(NOW.getTime() + 75_000);
    expect(h.rows.get(AGENT_ID)!.provisionState).toBe('ready');
  });

  test('money audit M2: the operator pause stops every create; resume provisions', async () => {
    const h = harness(record());
    let paused = true;
    const deps = { ...h.deps, paused: () => paused };
    expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('skipped');
    await runArenaProvisioningTick(NOW, deps);
    expect(h.log).toEqual([]);
    paused = false;
    expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('ready');
    expect(h.rows.get(AGENT_ID)!.provisionState).toBe('ready');
  });

  test('the persona and prompt forbid trading', () => {
    expect(ARENA_CLAWPUMP_PERSONA).toContain('does not trade');
    expect(ARENA_CLAWPUMP_SYSTEM_PROMPT).toContain('Do not trade');
  });
});

describe('ensureArenaAgentPrivate', () => {
  test('returns changed=false with one read for a private, closed agent; changed=true after a fix', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.cps.set(CP_ID, { isPublic: false, acceptingBids: false, status: 'stopped', skills: [], walletAddress: WALLET });
    expect((await ensureArenaAgentPrivate(h.deps, AGENT_ID, CP_ID)).changed).toBe(false);
    expect(h.calls()).toEqual([`listing ${CP_ID}`]);
    h.cpOf(CP_ID).isPublic = true;
    const fixed = await ensureArenaAgentPrivate(h.deps, AGENT_ID, CP_ID, 'removal');
    expect(fixed).toEqual({ changed: true, listing: { id: CP_ID, isPublic: false, acceptingBids: false } });
    expect(h.priorities.slice(1)).toEqual(['listing:removal', 'update:removal', 'listing:removal']);
  });
});

describe('privacy repair (agents created public before the fix)', () => {
  const READY_IDS = Array.from({ length: 6 }, (_, index) => `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

  function many() {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.clear();
    READY_IDS.forEach((id, index) => {
      h.rows.set(id, record({ id, provisionState: index === 5 ? 'failed' : 'ready', provisionAttempts: index === 5 ? 5 : 0, clawpumpAgentId: `cp-${index}` }));
      // Even indexes: public and accepting bids (the 11-11..11-16 agents); odd: already private.
      h.cps.set(`cp-${index}`, {
        isPublic: index % 2 === 0, acceptingBids: index % 2 === 0, status: 'stopped', skills: [...V1_DEFAULT_SKILLS], walletAddress: WALLET,
      });
    });
    return h;
  }

  test(`checks ${ARENA_PRIVACY_CHECKS_PER_TICK} agents a tick from a cursor, fixes the public ones (failed rows too), and wraps`, async () => {
    const h = many();
    await runArenaPrivacyRepair(h.deps);
    expect(h.log.filter((line) => line.startsWith('listing')).length).toBeGreaterThanOrEqual(ARENA_PRIVACY_CHECKS_PER_TICK);
    await runArenaPrivacyRepair(h.deps);
    for (let index = 0; index < READY_IDS.length; index += 1) {
      expect(h.cpOf(`cp-${index}`)).toMatchObject({ isPublic: false, acceptingBids: false });
      // Skills untouched.
      expect(h.cpOf(`cp-${index}`).skills).toEqual(V1_DEFAULT_SKILLS);
    }
    // Every write used removal priority and named its own arena row.
    expect(h.priorities.every((priority) => priority.endsWith(':removal'))).toBe(true);
    expect(new Set(h.seq)).toEqual(new Set(READY_IDS.filter((_, index) => index % 2 === 0).map((id) => `update for ${id}`)));
    // Idempotent: a third and fourth pass send no update.
    const updates = h.log.filter((line) => line.startsWith('update')).length;
    await runArenaPrivacyRepair(h.deps);
    await runArenaPrivacyRepair(h.deps);
    expect(h.log.filter((line) => line.startsWith('update')).length).toBe(updates);
  });

  test('skips pending and creating rows and rows without a ClawPump id', async () => {
    const h = harness(record({ provisionState: 'pending', clawpumpAgentId: CP_ID }));
    h.rows.set('b2', record({ id: 'b2', provisionState: 'ready', clawpumpAgentId: null }));
    await runArenaPrivacyRepair(h.deps);
    expect(h.log).toEqual([]);
  });

  test('a throttle ends the pass (retried next tick); any other error is logged and the next agent still runs', async () => {
    const h = many();
    h.setUpdateHook(async () => { throw new ClawPumpWriterError('budget_exhausted'); });
    await runArenaPrivacyRepair(h.deps);
    // Stopped at the first public agent's update.
    expect(h.log.filter((line) => line.startsWith('update'))).toHaveLength(1);

    _resetArenaProvisioningForTest();
    const failing = many();
    failing.setUpdateHook(async (_patch, id) => { if (id === 'cp-0') throw new ClawPumpWriterError('http_error', 500); });
    await runArenaPrivacyRepair(failing.deps);
    expect(failing.cpOf('cp-0').isPublic).toBe(true);
    expect(failing.cpOf('cp-2')).toMatchObject({ isPublic: false, acceptingBids: false });
  });

  test('Codex writer r1: a throttle on every first call still walks the cursor a, b, c, d, then wraps (never a, a, a)', async () => {
    const h = many();
    // Four agents, so a full page (4) is followed by an empty page that must wrap at once.
    for (const id of READY_IDS.slice(4)) h.rows.delete(id);
    const attempted: string[] = [];
    h.deps.writer.readListing = async (id) => {
      attempted.push(id);
      throw new ClawPumpWriterError('budget_exhausted');
    };
    for (let pass = 0; pass < 6; pass += 1) await runArenaPrivacyRepair(h.deps);
    expect(attempted).toEqual(['cp-0', 'cp-1', 'cp-2', 'cp-3', 'cp-0', 'cp-1']);
  });

  test('a store failure never throws out of the pass', async () => {
    const h = many();
    h.deps.store.listClawPumpSweepAgents = async () => { throw new Error('db down'); };
    await runArenaPrivacyRepair(h.deps);
    expect(h.log).toEqual([]);
  });
});

describe('readArenaX402Ready (read only: ClawVille never adds or removes x402)', () => {
  const addon = [{ id: 'feed', enabled: true, dailyCapUsd: 1 }];

  test('on: a ready row with an enabled add-on, x402 on the agent, not running; one GET and no write', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: addon }));
    expect(await readArenaX402Ready(AGENT_ID, h.deps)).toBe('on');
    expect(h.calls()).toEqual([`read ${CP_ID}`]);
  });

  test('off: no x402 on the agent (an older agent), a running agent, no enabled add-on, or a failed row; never a write', async () => {
    const noX402 = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: addon }));
    noX402.cpOf(CP_ID).skills = ['action-plans', 'web-browsing'];
    expect(await readArenaX402Ready(AGENT_ID, noX402.deps)).toBe('off');
    const running = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: addon }));
    running.cpOf(CP_ID).status = 'running';
    expect(await readArenaX402Ready(AGENT_ID, running.deps)).toBe('off');
    const noAddon = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    expect(await readArenaX402Ready(AGENT_ID, noAddon.deps)).toBe('off');
    expect(noAddon.log).toEqual([]);
    const failed = harness(record({ provisionState: 'failed', clawpumpAgentId: CP_ID, addons: addon }));
    expect(await readArenaX402Ready(AGENT_ID, failed.deps)).toBe('off');
    for (const h of [noX402, running, noAddon, failed]) expect(h.log.some((line) => line.startsWith('update'))).toBe(false);
  });

  test('skipped: a pending row, a row without a ClawPump id, an unknown row', async () => {
    const pending = harness(record({ provisionState: 'pending', addons: addon }));
    expect(await readArenaX402Ready(AGENT_ID, pending.deps)).toBe('skipped');
    expect(await readArenaX402Ready('nope', pending.deps)).toBe('skipped');
  });
});

/**
 * Mirrors the writer's shared token bucket (clawpump-writer takeWriterToken, no
 * refill): 'removal' calls may spend it down to 0, normal calls stop above the
 * removal reserve. Empty -> our own 'budget_exhausted' BEFORE the fake call runs.
 */
function budgeted(h: ReturnType<typeof harness>, start: number = CLAWPUMP_WRITER_BURST) {
  let tokens = start;
  const order: string[] = [];
  const take = (label: string, priority: ClawPumpCallPriority = 'normal') => {
    const floor = priority === 'removal' ? 0 : CLAWPUMP_WRITER_REMOVAL_RESERVE;
    if (tokens - 1 < floor) throw new ClawPumpWriterError('budget_exhausted');
    tokens -= 1;
    order.push(label);
  };
  const w = h.deps.writer;
  const writer: ArenaProvisionDeps['writer'] = {
    ...w,
    createAgent: async (input) => { take('create'); return w.createAgent(input); },
    updateAgent: async (id, patch, arenaAgentId, priority) => { take(`update ${id}`, priority); return w.updateAgent(id, patch, arenaAgentId, priority); },
    readListing: async (id, priority) => { take(`listing ${id}`, priority); return w.readListing(id, priority); },
    readAgent: async (id, priority) => { take(`read ${id}`, priority); return w.readAgent(id, priority); },
    getWallet: async (id) => { take('wallet'); return w.getWallet(id); },
  };
  return { deps: { ...h.deps, writer }, order, refill: (next: number) => { tokens = next; } };
}

describe('FX-PROV: provisioning and the shared ClawPump call budget', () => {
  test('(a) our own budget refusal is not an attempt: attempts unchanged, no "attempt N of 5" event, due on the next tick', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new ClawPumpWriterError('budget_exhausted'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('throttled');
    const row = h.rows.get(AGENT_ID)!;
    expect(row.provisionAttempts).toBe(0);
    expect(row.provisionError).toBe('clawpump_budget_exhausted');
    expect(row.provisionNextAt!.getTime()).toBeLessThanOrEqual(NOW.getTime() + 27_000);
    expect(await h.deps.store.listDue(new Date(NOW.getTime() + 27_000), ARENA_PROVISION_MAX_ATTEMPTS, 20)).toEqual([AGENT_ID]);
    expect(h.events).toEqual([]);

    // ClawPump's HTTP 429 mid-flow (after the create): same rule, and the saved id is reused on the retry.
    const mid = harness(record());
    mid.setUpdateHook(async () => { throw new ClawPumpWriterError('rate_limited', 429); });
    expect(await provisionArenaAgent(AGENT_ID, mid.deps)).toBe('throttled');
    expect(mid.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 1, clawpumpAgentId: CP_ID });
    expect(mid.events).toEqual([]);
    mid.setUpdateHook(async () => {});
    mid.log.length = 0;
    const later = { ...mid.deps, now: () => new Date(NOW.getTime() + 30_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(mid.log.some((line) => line === 'create')).toBe(false);
  });

  test('(b) six throttled ticks in a row never fail the agent; it is retried every tick, then provisions', async () => {
    const h = harness(record());
    let budget = false;
    h.setCreate(async () => {
      if (!budget) throw new ClawPumpWriterError('budget_exhausted');
      return cpAgent(CP_ID, h.cpOf(CP_ID));
    });
    let clock = NOW.getTime();
    const deps = { ...h.deps, now: () => new Date(clock) };
    for (let tick = 0; tick < 6; tick += 1) {
      clock = NOW.getTime() + tick * 30_000;
      await runArenaProvisioningTick(new Date(clock), deps);
    }
    expect(h.created.length).toBe(6);
    expect(h.rows.get(AGENT_ID)!.provisionAttempts).toBe(0);
    expect(h.events).toEqual([]);
    budget = true;
    clock = NOW.getTime() + 6 * 30_000;
    await runArenaProvisioningTick(new Date(clock), deps);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', provisionAttempts: 1, clawpumpAgentId: CP_ID });
  });

  test('(b2) a throttle ends the tick\'s provisioning pass: the next due agent is not claimed (it stays pending)', async () => {
    const h = harness(record());
    const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';
    h.rows.set(SECOND, record({ id: SECOND, name: 'Ann', createdAt: new Date(NOW.getTime() + 1) }));
    h.setCreate(async () => { throw new ClawPumpWriterError('budget_exhausted'); });
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.created.length).toBe(1);
    expect(h.rows.get(SECOND)).toMatchObject({ provisionState: 'pending', provisionAttempts: 0 });
  });

  test('(c) the tick provisions a due agent BEFORE the privacy repair spends the shared budget', async () => {
    const h = harness(record());
    for (let index = 0; index < 3; index += 1) {
      const agentId = `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      h.rows.set(agentId, record({ id: agentId, provisionState: 'ready', clawpumpAgentId: `cp-b${index}` }));
    }
    const b = budgeted(h);
    await runArenaProvisioningTick(NOW, b.deps);
    // Provisioning's calls come first (5 normal calls fit above the reserve), then the repair.
    expect(b.order.slice(0, 5)).toEqual([
      'create', `listing ${CP_ID}`, `update ${CP_ID}`, `update ${CP_ID}`, `listing ${CP_ID}`,
    ]);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', provisionAttempts: 1, clawpumpAgentId: CP_ID });
    // The repair still runs on the removal reserve this tick.
    expect(h.cpOf('cp-b0')).toMatchObject({ isPublic: false, acceptingBids: false });
  });

  test('(e) Codex r2 B2: ClawPump\'s 429 on the CREATE counts as an attempt (it may have created one); 5 -> exhausted, no 6th create', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new ClawPumpWriterError('rate_limited', 429); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('rate_limited');
    expect(h.rows.get(AGENT_ID)).toMatchObject({
      provisionState: 'failed',
      provisionError: 'clawpump_rate_limited_429',
      provisionAttempts: 1,
      provisionNextAt: new Date(NOW.getTime() + ARENA_PROVISION_RETRY_MS),
      clawpumpAgentId: null,
    });
    expect(h.events.at(-1)!.summary).toContain('attempt 1 of 5');
    expect(await provisionArenaAgent(AGENT_ID, { ...h.deps, now: () => new Date(NOW.getTime() + 30_000) })).toBe('skipped');
    for (let attempt = 2; attempt <= ARENA_PROVISION_MAX_ATTEMPTS; attempt += 1) {
      const later = { ...h.deps, now: () => new Date(NOW.getTime() + (attempt - 1) * 11 * 60_000) };
      expect(await provisionArenaAgent(AGENT_ID, later)).toBe('rate_limited');
    }
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 5, provisionNextAt: null });
    expect(h.events.at(-1)!.summary).toContain('after 5 attempts');
    expect(h.created).toHaveLength(ARENA_PROVISION_MAX_ATTEMPTS);
    const muchLater = { ...h.deps, now: () => new Date(NOW.getTime() + 24 * 60 * 60_000) };
    expect(await provisionArenaAgent(AGENT_ID, muchLater)).toBe('exhausted');
    await runArenaProvisioningTick(muchLater.now(), muchLater);
    expect(h.created).toHaveLength(ARENA_PROVISION_MAX_ATTEMPTS);
  });

  test('(e2) a 429 on the create ends the tick\'s provisioning pass: the next due agent is not claimed', async () => {
    const h = harness(record());
    const SECOND = 'a1b2c3d4-0000-4000-8000-000000000002';
    h.rows.set(SECOND, record({ id: SECOND, name: 'Ann', createdAt: new Date(NOW.getTime() + 1) }));
    h.setCreate(async () => { throw new ClawPumpWriterError('rate_limited', 429); });
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.created.length).toBe(1);
    expect(h.rows.get(SECOND)).toMatchObject({ provisionState: 'pending', provisionAttempts: 0 });
  });

  for (const call of ['update', 'listing', 'getWallet'] as const) {
    test(`(f) Codex r2 B2: a 429 AFTER the id is saved (${call}) adds no attempt; the retry reuses the saved agent`, async () => {
      const h = harness(record());
      // No wallet in the create answer, so provisioning needs the getWallet fallback.
      h.setCreate(async () => ({ ...cpAgent(CP_ID, h.cpOf(CP_ID)), walletAddress: null }));
      let fail = true;
      const once = () => {
        if (fail) { fail = false; throw new ClawPumpWriterError('rate_limited', 429); }
      };
      const w = h.deps.writer;
      const writer: ArenaProvisionDeps['writer'] = {
        ...w,
        updateAgent: async (id, patch, arenaAgentId, priority) => { if (call === 'update') once(); return w.updateAgent(id, patch, arenaAgentId, priority); },
        readListing: async (id, priority) => { if (call === 'listing') once(); return w.readListing(id, priority); },
        getWallet: async (id) => { if (call === 'getWallet') once(); return w.getWallet(id); },
      };
      const deps = { ...h.deps, writer };
      expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('throttled');
      expect(h.rows.get(AGENT_ID)).toMatchObject({
        provisionState: 'failed', provisionAttempts: 1, clawpumpAgentId: CP_ID, provisionError: 'clawpump_rate_limited_429',
      });
      expect(h.rows.get(AGENT_ID)!.provisionNextAt!.getTime()).toBe(NOW.getTime() + ARENA_PROVISION_THROTTLE_RETRY_MS);
      expect(h.events).toEqual([]);
      const later = { ...deps, now: () => new Date(NOW.getTime() + 30_000) };
      expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
      expect(h.created).toHaveLength(1);
      expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', provisionAttempts: 1, clawpumpAgentId: CP_ID });
    });
  }

  test('(g) Codex r2 B2 follow-up: the attempt is counted BEFORE the create, so a crash after the create still counts it; 5 -> no 6th create', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new Error('process died'); });
    const deps: ArenaProvisionDeps = {
      ...h.deps,
      store: { ...h.deps.store, markFailed: async () => { throw new Error('process died'); } },
    };
    const at = (run: number) => ({ ...deps, now: () => new Date(NOW.getTime() + run * (ARENA_PROVISION_LEASE_MS + 60_000)) });
    for (let run = 1; run <= ARENA_PROVISION_MAX_ATTEMPTS; run += 1) {
      await expect(provisionArenaAgent(AGENT_ID, at(run))).rejects.toThrow('process died');
      expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'creating', provisionAttempts: run, clawpumpAgentId: null });
    }
    expect(h.created).toHaveLength(ARENA_PROVISION_MAX_ATTEMPTS);
    expect(await provisionArenaAgent(AGENT_ID, at(6))).toBe('exhausted');
    await runArenaProvisioningTick(at(7).now(), at(7));
    expect(h.created).toHaveLength(ARENA_PROVISION_MAX_ATTEMPTS);
  });

  test('(g2) a 429 on the saved agent after the 5th create is a counted failure: exhausted WITH the owner event', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: ARENA_PROVISION_MAX_ATTEMPTS - 1 }));
    h.setUpdateHook(async () => { throw new ClawPumpWriterError('rate_limited', 429); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 5, provisionNextAt: null, clawpumpAgentId: CP_ID });
    expect(h.events.at(-1)!.summary).toContain('after 5 attempts');
  });

  test('(h) Codex r2 B2 follow-up: our own budget refusal of the create gives the pre-counted attempt back', async () => {
    const h = harness(record());
    h.setCreate(async () => { throw new ClawPumpWriterError('budget_exhausted'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('throttled');
    expect(h.log).toContain('count 1');
    expect(h.rows.get(AGENT_ID)).toMatchObject({
      provisionState: 'failed', provisionAttempts: 0, provisionError: 'clawpump_budget_exhausted',
      provisionNextAt: new Date(NOW.getTime() + ARENA_PROVISION_THROTTLE_RETRY_MS),
    });
    expect(h.events).toEqual([]);
  });

  test('(i) Codex r2 B2 follow-up: a pre-count the claim fence refuses sends NO create', async () => {
    const h = harness(record());
    const deps: ArenaProvisionDeps = { ...h.deps, store: { ...h.deps.store, countCreateAttempt: async () => null } };
    expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('skipped');
    expect(h.created).toEqual([]);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 0, clawpumpAgentId: null });
  });

  test('(d) a paused tick runs the privacy repair and no provisioning', async () => {
    const h = harness(record());
    const OFF = 'b0000000-0000-4000-8000-000000000000';
    h.rows.set(OFF, record({ id: OFF, provisionState: 'ready', clawpumpAgentId: 'cp-off' }));
    await runArenaProvisioningTick(NOW, { ...h.deps, paused: () => true });
    expect(h.cpOf('cp-off')).toMatchObject({ isPublic: false, acceptingBids: false });
    expect(h.created).toEqual([]);
    expect(h.log).not.toContain('claim');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'pending', provisionAttempts: 0 });
  });
});

describe('SPEC house-clawpump-x402 T3: house rows provision through the D8 path', () => {
  function houseRecord(houseId = 'house:genesis', name = 'Genesis', overrides: Partial<ArenaAgentRecord> = {}): ArenaAgentRecord {
    return record({
      id: houseId, kind: 'house', ownerUserId: null, avatarId: null, name, templateId: 'genesis',
      seated: true, contestId: null, ...overrides,
    });
  }

  test('the 5 house names: the spec pattern on production, the (staging) marker elsewhere, <= 48 chars', () => {
    const prodNames = FLOOR_ARENA_HOUSE_AGENTS.map((house) => arenaClawPumpAgentName(house.name, house.id, PROD));
    expect(prodNames).toEqual([
      'CV Arena · Genesis #housegenesis',
      'CV Arena · Runner #houserunner',
      'CV Arena · Dip Hunter #housediphunt',
      'CV Arena · Mid-Cap Climber #housemidcapc',
      'CV Arena · Late Bloomer #houselateblo',
    ]);
    for (const house of FLOOR_ARENA_HOUSE_AGENTS) {
      const staging = arenaClawPumpAgentName(house.name, house.id, STAGING);
      expect(staging.startsWith('CV Arena (staging) · ')).toBe(true);
      expect(staging.length).toBeLessThanOrEqual(48);
      expect(staging.endsWith(` #${house.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`)).toBe(true);
    }
    expect(FLOOR_ARENA_HOUSE_AGENTS.every((house) => house.clawpumpAgentId === null)).toBe(true);
  });

  test('a pending house row: create, save, privacy updates for the house row, ready; no event', async () => {
    const h = harness(houseRecord());
    expect(await provisionArenaAgent('house:genesis', h.deps)).toBe('ready');
    expect(h.created).toEqual(['CV Arena · Genesis #housegenesis']);
    expect(h.createInputs[0]).toEqual({
      name: 'CV Arena · Genesis #housegenesis', persona: ARENA_CLAWPUMP_PERSONA, system_prompt: ARENA_CLAWPUMP_SYSTEM_PROMPT,
    });
    expect(h.seq).toEqual(['update for house:genesis', 'update for house:genesis']);
    expect(h.rows.get('house:genesis')).toMatchObject({ provisionState: 'ready', clawpumpAgentId: CP_ID, clawpumpWallet: WALLET });
    expect(h.cpOf(CP_ID)).toMatchObject({ isPublic: false, acceptingBids: false });
    expect(h.events).toEqual([]);
  });

  test('a house row on staging gets the (staging) name; a privacy failure fails the attempt with no event', async () => {
    const staging = harness(houseRecord('house:runner', 'Runner'), STAGING);
    expect(await provisionArenaAgent('house:runner', staging.deps)).toBe('ready');
    expect(staging.created).toEqual(['CV Arena (staging) · Runner #houserunner']);

    const h = harness(houseRecord());
    h.setUpdateHook(async () => ({ ignore: true }));
    expect(await provisionArenaAgent('house:genesis', h.deps)).toBe('failed');
    expect(h.rows.get('house:genesis')).toMatchObject({ provisionState: 'failed', provisionError: 'agent_still_public', provisionAttempts: 1 });
    expect(h.events).toEqual([]);
  });

  test('the engine pause blocks house provisioning (direct call and tick); the row stays due', async () => {
    const h = harness(houseRecord());
    const paused = { ...h.deps, paused: () => true };
    expect(await provisionArenaAgent('house:genesis', paused)).toBe('skipped');
    await runArenaProvisioningTick(NOW, paused);
    expect(h.created).toEqual([]);
    expect(h.log).not.toContain('claim');
    expect(h.rows.get('house:genesis')).toMatchObject({ provisionState: 'pending', provisionAttempts: 0 });
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.rows.get('house:genesis')).toMatchObject({ provisionState: 'ready', clawpumpAgentId: CP_ID });
  });

  test('a ready house row is repaired like a user row, and readArenaX402Ready reports off (no add-on)', async () => {
    const h = harness(houseRecord('house:genesis', 'Genesis', { provisionState: 'ready', clawpumpAgentId: CP_ID, clawpumpWallet: WALLET }));
    await runArenaPrivacyRepair(h.deps);
    expect(h.cpOf(CP_ID)).toMatchObject({ isPublic: false, acceptingBids: false });
    expect(h.seq).toEqual(['update for house:genesis', 'update for house:genesis']);
    expect(await readArenaX402Ready('house:genesis', h.deps)).toBe('off');
    expect(h.cpOf(CP_ID).skills).toEqual(V1_DEFAULT_SKILLS);
  });
});
