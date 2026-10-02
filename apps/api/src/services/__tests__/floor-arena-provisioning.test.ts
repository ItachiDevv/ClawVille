import { beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
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
  ARENA_PROVISION_MAX_ATTEMPTS,
  ARENA_PROVISION_RETRY_MS,
  ARENA_X402_REMOVAL_SLOTS,
  _resetArenaProvisioningForTest,
  arenaClawPumpAgentName,
  deniedSkillsPresent,
  desiredArenaSkills,
  ensureArenaX402ForPay,
  provisionArenaAgent,
  removeUnwantedArenaX402,
  startArenaX402LeaderTerm,
  runArenaProvisioningTick,
  type ArenaProvisionDeps,
} from '../floor-arena/provisioning';
import { ArenaClawPumpOwnedError, type ArenaAgentRecord } from '../floor-arena/queries';

const NOW = new Date('2026-09-30T20:00:00Z');
const AGENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CP_ID = '99999999-8888-4777-8666-555555555555';
const WALLET = 'Wa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PROD = { CLAWVILLE_ENV: 'production' };
const STICKY = ['action-plans', 'web-browsing', 'private-transfers', 'bitget-intel', 'self-learning', 'skill-management'];
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
    id: CP_ID, name: arenaClawPumpAgentName('Bob', AGENT_ID, PROD), status: 'stopped', walletAddress: WALLET,
    enabledSkills: [], isPublic: false, acceptingBids: true, ...overrides,
  };
}

function harness(initial: ArenaAgentRecord, env: Record<string, string | undefined> = PROD) {
  const rows = new Map<string, ArenaAgentRecord>([[initial.id, initial]]);
  const log: string[] = [];
  /** Order of ClawPump reads and PATCHes (Codex r17 #3: a read must come first). */
  const seq: string[] = [];
  /** x402 advisory lock take/release, in order. */
  const locks: string[] = [];
  /** ClawPump's reported run status for this agent. */
  let cpStatus = 'stopped';
  /** Agents with their OWN ClawPump state (multi-agent tests); others share `skills` / `cpStatus`. */
  const perCp = new Map<string, { skills: string[]; status: string; failPatch?: boolean }>();
  /** x402 locks held right now (one holder per agent, like pg_try_advisory_xact_lock). */
  const held = new Set<string>();
  /** Budget priority of each ClawPump call, in order. */
  const priorities: string[] = [];
  /** The database clock (dbNow). */
  let dbClock = NOW;
  /** Open fake transactions: the long x402 one and the short row reads; peak = the most at once. */
  const conns = { long: 0, short: 0, peakLong: 0, peakTotal: 0 };
  const peak = () => {
    conns.peakLong = Math.max(conns.peakLong, conns.long);
    conns.peakTotal = Math.max(conns.peakTotal, conns.long + conns.short);
  };
  const created: string[] = [];
  const events: string[] = [];
  const ownedElsewhere = new Set<string>();
  /** The agent's skills on ClawPump: the 6 sticky platform defaults unless a test says otherwise. */
  let skills: string[] | null = [...STICKY];
  /** Extra skills ClawPump keeps whatever we PATCH (the "denied skill persists" case). */
  let sticky: string[] = [];
  let createImpl: () => Promise<ClawPumpCreatedAgent> = async () => cpAgent();
  let updateImpl: (patch: Record<string, unknown>) => Promise<ClawPumpCreatedAgent> =
    async (patch) => cpAgent({ acceptingBids: patch.accepting_bids as boolean, isPublic: patch.is_public as boolean });
  const deps: ArenaProvisionDeps = {
    now: () => NOW,
    env,
    paused: () => false,
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
      // Mirrors readArenaAgentLocked (the advisory lock is a no-op in one JS thread).
      readLocked: async (id) => {
        conns.short += 1;
        peak();
        await Promise.resolve();
        conns.short -= 1;
        return rows.get(id) ?? null;
      },
      dbNow: async () => dbClock,
      // Mirrors tryWithArenaX402Lock: a busy agent returns { acquired: false } at once.
      tryX402Lock: async (id, fn) => {
        if (held.has(id)) return { acquired: false };
        held.add(id);
        locks.push(`lock ${id}`);
        conns.long += 1;
        peak();
        try {
          return { acquired: true, value: await fn() };
        } finally {
          conns.long -= 1;
          held.delete(id);
          locks.push(`unlock ${id}`);
        }
      },
      // Mirrors readArenaX402RecentOff.
      listX402RecentOff: async (since, afterId, limit) => [...rows.values()]
        .filter((row) => row.kind === 'user' && ['ready', 'failed'].includes(row.provisionState) && row.clawpumpAgentId !== null
          && !row.addons.some((addon) => addon.enabled) && (since === null || row.updatedAt.getTime() >= since.getTime())
          && row.id > afterId)
        .map((row) => row.id)
        .sort()
        .slice(0, limit),
      // Mirrors readArenaX402OffAgents.
      listX402OffAgents: async (afterId, limit) => [...rows.values()]
        .filter((row) => row.kind === 'user' && ['ready', 'failed'].includes(row.provisionState) && row.clawpumpAgentId !== null
          && !row.addons.some((addon) => addon.enabled) && row.id > afterId)
        .map((row) => row.id)
        .sort()
        .slice(0, limit),
      // Mirrors readArenaX402SweepAgents.
      listX402SweepAgents: async (afterId, limit) => [...rows.values()]
        .filter((row) => row.kind === 'user' && ['ready', 'failed'].includes(row.provisionState) && row.clawpumpAgentId !== null
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
      createAgent: async (input) => {
        created.push(input.name);
        log.push(`create ${JSON.stringify(input.enabled_skills)} public=${input.is_public}`);
        return createImpl();
      },
      updateAgent: async (id, patch, arenaAgentId, priority?: ClawPumpCallPriority) => {
        log.push(`update ${id} ${JSON.stringify(patch)}`);
        seq.push(`update for ${arenaAgentId}`);
        priorities.push(`patch:${priority ?? 'normal'}`);
        const own = perCp.get(id);
        if (own) {
          if (own.failPatch) throw new ClawPumpWriterError('http_error', 500);
          if (patch.enabled_skills) own.skills = [...new Set([...STICKY, ...patch.enabled_skills])];
          return cpAgent({ id, acceptingBids: false, isPublic: false });
        }
        const result = await updateImpl(patch as Record<string, unknown>);
        // Live staging: the 6 platform defaults are sticky; the PATCH list sets only the NON-default skills.
        // (skills === null simulates a ClawPump answer without the list: it stays unreadable.)
        if (patch.enabled_skills && skills !== null) skills = [...new Set([...STICKY, ...patch.enabled_skills, ...sticky])];
        return result;
      },
      readAgent: async (id, priority?: ClawPumpCallPriority) => {
        seq.push('read');
        priorities.push(`read:${priority ?? 'normal'}`);
        const own = perCp.get(id);
        if (own) return cpAgent({ id, status: own.status, acceptingBids: false, enabledSkills: [...own.skills] });
        return cpAgent({ id, status: cpStatus, acceptingBids: false, enabledSkills: skills === null ? null : [...skills] });
      },
      getWalletBalances: async () => [],
      x402Pay: async () => { throw new Error('not used'); },
      getWallet: async () => { log.push('getWallet'); return WALLET; },
    },
  };
  return {
    deps, rows, log, seq, locks, held, priorities, perCp, conns, created, events, ownedElsewhere,
    setDbNow: (next: Date) => { dbClock = next; },
    setStatus: (next: string) => { cpStatus = next; },
    setCreate: (impl: typeof createImpl) => { createImpl = impl; },
    setUpdate: (impl: typeof updateImpl) => { updateImpl = impl; },
    setSkills: (next: string[] | null, stickyNext: string[] = []) => { skills = next; sticky = stickyNext; },
    skillsNow: () => skills,
  };
}

beforeEach(() => _resetArenaProvisioningForTest());

/** One pass with no agent to fix, so the next passes are "steady state" (the term's full pass is done). */
async function warmUp(h: { rows: Map<string, ArenaAgentRecord>; deps: ArenaProvisionDeps }): Promise<void> {
  const saved = new Map(h.rows);
  h.rows.clear();
  await runArenaProvisioningTick(NOW, h.deps);
  for (const [id, row] of saved) h.rows.set(id, row);
}

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
  test('pending -> create (private, no skills) -> save id -> update (no bids) -> ready', async () => {
    const h = harness(record());
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.log).toEqual([
      'claim',
      'create [] public=false',
      `save ${CP_ID}`,
      `update ${CP_ID} {"accepting_bids":false,"is_public":false,"enabled_skills":[]}`,
      'ready',
    ]);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', clawpumpAgentId: CP_ID, clawpumpWallet: WALLET });
    expect(h.events.at(-1)).toContain('Execution wallet ready');
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('D16: provisioning on staging creates the (staging) name', async () => {
    const h = harness(record(), STAGING);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.created[0]).toBe('CV Arena (staging) · Bob #a1b2c3d40000');
    const prod = harness(record(), PROD);
    await provisionArenaAgent(AGENT_ID, prod.deps);
    expect(prod.created[0]).toBe('CV Arena · Bob #a1b2c3d40000');
  });

  test('live staging: the 6 sticky defaults (private-transfers included) end READY, the list recorded', async () => {
    const h = harness(record());
    h.setSkills([...STICKY, 'defi-trading', 'x402']);
    const logged: unknown[] = [];
    const insertEvent = h.deps.store.insertEvent;
    h.deps.store.insertEvent = async (agentId, event) => { logged.push(event.data); return insertEvent(agentId, event); };
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    // The first PATCH ([]) removed every non-default (defi-trading, x402); the defaults stay.
    expect(h.skillsNow()).toEqual(STICKY);
    expect(logged.at(-1)).toMatchObject({ provisionState: 'ready', skills: STICKY });
    expect(deniedSkillsPresent(STICKY, false)).toEqual([]);
  });

  test('desiredArenaSkills sends only the non-default skills to keep (+ x402 with an add-on)', () => {
    const current = [...STICKY, 'defi-trading', 'twitter', 'X402', 'wallet-ops'];
    expect(desiredArenaSkills(current, false)).toEqual(['twitter']);
    expect(desiredArenaSkills(current, true)).toEqual(['twitter', 'x402']);
    expect(desiredArenaSkills(STICKY, false)).toEqual([]);
  });

  test('a denied skill that survives the PATCH fails the attempt (owner event lists it)', async () => {
    const h = harness(record());
    h.setSkills(['web-browsing', 'token-sniper'], ['token-sniper']);
    const logged: Array<Record<string, unknown>> = [];
    const insertEvent = h.deps.store.insertEvent;
    h.deps.store.insertEvent = async (agentId, event) => {
      logged.push({ type: event.type, ...(event.data as object) });
      return insertEvent(agentId, event);
    };
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'failed', provisionError: 'clawpump_denied_skill_present' });
    expect(logged.at(-1)).toMatchObject({ type: 'addon', error: 'clawpump_denied_skill_present', deniedSkills: ['token-sniper'] });
  });

  test('fails closed when ClawPump does not return the skill list', async () => {
    const h = harness(record());
    h.setSkills(null);
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)!.provisionError).toBe('clawpump_skills_unreadable');
  });

  test('x402 counts as denied without an add-on; provisioning removes it (and denied skills) even with an add-on on', async () => {
    expect(deniedSkillsPresent(['X402', 'web-browsing', 'perps-trading', 'laso-finance', 'agenc-worker', 'wallet-ops', 'private-transfers'], false))
      .toEqual(['x402', 'perps-trading', 'laso-finance', 'agenc-worker', 'wallet-ops']);
    expect(deniedSkillsPresent(['x402', 'web-browsing'], true)).toEqual([]);
    const withAddon = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    withAddon.setSkills(['web-browsing', 'marketplace', 'x402'], ['web-browsing']);
    expect(await provisionArenaAgent(AGENT_ID, withAddon.deps)).toBe('ready');
    expect(withAddon.skillsNow()).toContain('web-browsing');
    expect(withAddon.skillsNow()).not.toContain('marketplace');
    expect(withAddon.skillsNow()).not.toContain('x402');
  });

  test('the add path reports skipped and backs off when ClawPump will not enable x402 for an add-on', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    // ClawPump drops x402 whatever we send.
    const readAgent = h.deps.writer.readAgent;
    h.deps.writer.readAgent = async (id) => ({ ...(await readAgent(id)), enabledSkills: ['web-browsing'] });
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('skipped');
    const patches = h.log.length;
    // Backing off: the next try in the same minute sends no PATCH (one GET only).
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('skipped');
    expect(h.log.length).toBe(patches);
  });

  test('provisioning never adds x402, even with an add-on on (the add-on tick adds it right before paying)', async () => {
    const h = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    // Codex r17 #3: created with NO skill.
    expect(h.log[1]).toBe('create [] public=false');
    expect(h.log.filter((line) => line.includes('x402'))).toEqual([]);
    expect(h.seq[0]).toBe('read');
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('Codex r18 #4: never adopts an existing ClawPump agent, even an exact-name look-alike', async () => {
    const h = harness(record());
    // An older house agent renamed to this row's exact arena name. Even a writer
    // that could list it is never asked: provisioning always creates.
    const HOUSE_LOOKALIKE = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
    let listed = 0;
    const writer = h.deps.writer as typeof h.deps.writer & { listAgentsByName?: (name: string) => Promise<ClawPumpCreatedAgent[]> };
    writer.listAgentsByName = async (name) => {
      listed += 1;
      return [cpAgent({ id: HOUSE_LOOKALIKE, name })];
    };
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(listed).toBe(0);
    expect(h.created).toEqual([arenaClawPumpAgentName('Bob', AGENT_ID, PROD)]);
    expect(h.rows.get(AGENT_ID)!.clawpumpAgentId).toBe(CP_ID);
    expect(h.log.some((line) => line.includes(HOUSE_LOOKALIKE))).toBe(false);
  });

  test('Codex r18 #4: a create whose response was lost leaves the row empty; the retry creates a NEW agent', async () => {
    const h = harness(record());
    // ClawPump made the agent, but the response never arrived.
    h.setCreate(async () => { throw new ClawPumpWriterError('timeout'); });
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ clawpumpAgentId: null, provisionError: 'clawpump_timeout' });
    h.setCreate(async () => cpAgent());
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 11 * 60_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(h.created).toHaveLength(2);
    expect(h.rows.get(AGENT_ID)!.clawpumpAgentId).toBe(CP_ID);
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
    expect(h.log.some((line) => line.startsWith('create'))).toBe(false);
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
    expect(await removeUnwantedArenaX402('house:genesis', house.deps)).toBe('skipped');
    expect(await ensureArenaX402ForPay('house:genesis', house.deps)).toBe('skipped');
    expect(house.log).toEqual([]);
    const ready = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    expect(await provisionArenaAgent(AGENT_ID, ready.deps)).toBe('ready');
    expect(ready.log).toEqual([]);
  });

  test('losing a cross-process race continues with the winner id and wallet, never a mix', async () => {
    const h = harness(record());
    const WINNER = '77777777-6666-4555-8444-333333333333';
    // Another container saved its agent between our create and our save.
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

  test('the tick retries only due rows; each claim reads the real clock (money audit N3)', async () => {
    const h = harness(record({ provisionState: 'failed', provisionAttempts: 1, provisionNextAt: new Date(NOW.getTime() + 60_000) }));
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.log).toEqual([]);
    // The tick starts at +61 s, but the claim happens at +75 s: the lease runs from +75 s.
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 75_000) };
    let leaseSeen: Date | null = null;
    const claim = later.store.claim;
    later.store = { ...later.store, claim: async (...args) => { leaseSeen = args[1]; return claim(...args); } };
    await runArenaProvisioningTick(new Date(NOW.getTime() + 61_000), later);
    expect(leaseSeen!.getTime()).toBe(NOW.getTime() + 75_000);
    expect(h.rows.get(AGENT_ID)!.provisionState).toBe('ready');
  });

  test('money audit M2: the operator pause stops every ClawPump write; resume provisions', async () => {
    const h = harness(record());
    let paused = true;
    const deps = { ...h.deps, paused: () => paused };
    expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('skipped');
    await runArenaProvisioningTick(NOW, deps);
    expect(h.log).toEqual([]);
    // Paused: the add path never ADDS x402 (one GET, no PATCH).
    const ready = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    expect(await ensureArenaX402ForPay(AGENT_ID, { ...ready.deps, paused: () => true })).toBe('skipped');
    expect(ready.log).toEqual([]);
    expect(ready.skillsNow()).not.toContain('x402');
    paused = false;
    expect(await provisionArenaAgent(AGENT_ID, deps)).toBe('ready');
    expect(h.rows.get(AGENT_ID)!.provisionState).toBe('ready');
  });

  test("money audit N5 / Codex r17 #3: a 'running' ClawPump agent fails closed with ZERO PATCH calls", async () => {
    const h = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setStatus('running');
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('failed');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'failed', provisionError: 'clawpump_agent_running' });
    expect(h.log.filter((line) => line.startsWith('update'))).toEqual([]);
    expect(h.seq).toEqual(['read']);
    // Created with no skill at all, so nothing (x402 included) was ever enabled.
    expect(h.log).toContain('create [] public=false');
  });

  test("Codex r17 #3: the add path never adds x402 to a 'running' agent (no PATCH)", async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setStatus('Running ');
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('skipped');
    expect(h.log).toEqual([]);
    expect(h.seq).toEqual(['read']);
  });

  test('audit-money v3 (a): an agent that starts DURING the add gets x402 taken back off, then the add fails', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    // Stopped on the add path's first two reads; running from the read after the add PATCH.
    const readAgent = h.deps.writer.readAgent;
    let reads = 0;
    h.deps.writer.readAgent = async (id, priority) => {
      reads += 1;
      return { ...(await readAgent(id, priority)), status: reads <= 2 ? 'stopped' : 'running' };
    };
    await expect(ensureArenaX402ForPay(AGENT_ID, h.deps)).rejects.toMatchObject({ code: 'clawpump_agent_running' });
    const updates = h.log.filter((line) => line.startsWith('update'));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('"enabled_skills":["x402"]');
    expect(updates[1]).toBe(`update ${CP_ID} {"enabled_skills":[]}`);
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('a running agent that holds x402 loses it (removal priority), even with an add-on on', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setSkills([...STICKY, 'x402']);
    h.setStatus('running');
    expect(await removeUnwantedArenaX402(AGENT_ID, h.deps)).toBe('removed');
    expect(h.log).toEqual([`update ${CP_ID} {"enabled_skills":[]}`]);
    expect(h.priorities).toEqual(['read:removal', 'patch:removal', 'read:removal']);
    expect(h.skillsNow()).not.toContain('x402');
    // The add-on tick's check does the same for a running agent.
    h.setSkills([...STICKY, 'x402']);
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('removed');
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('Codex r17 #3/#4: every sync reads first, and every PATCH names the owning arena row', async () => {
    const h = harness(record({ addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    expect(await provisionArenaAgent(AGENT_ID, h.deps)).toBe('ready');
    expect(h.seq[0]).toBe('read');
    expect(h.seq.filter((step) => step.startsWith('update'))).toEqual([`update for ${AGENT_ID}`]);
  });

  test('the add-on tick adds x402 for a ready agent with an enabled add-on, then it is "on" (one GET)', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('added');
    expect(h.log).toEqual([`update ${CP_ID} {"accepting_bids":false,"is_public":false,"enabled_skills":["x402"]}`]);
    const before = h.seq.length;
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('on');
    expect(h.seq.slice(before)).toEqual(['read']);
    // allowAdd false (adds used up, or a removal deferred): no add.
    const capped = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    expect(await ensureArenaX402ForPay(AGENT_ID, capped.deps, false)).toBe('skipped');
    expect(capped.log).toEqual([]);
  });

  test('Codex r18 #3: whenever a read reports running, no later PATCH can add a skill (add path, running from read 1-5)', async () => {
    for (const runningFrom of [1, 2, 3, 4, 5]) {
      _resetArenaProvisioningForTest();
      const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
      // A denied skill that ClawPump keeps forces the second (denied-skill) PATCH path.
      h.setSkills([...STICKY, 'defi-trading'], ['defi-trading']);
      const trace: Array<{ kind: 'read'; running: boolean; skills: string[] } | { kind: 'patch'; patch: Record<string, unknown> }> = [];
      const readAgent = h.deps.writer.readAgent;
      const updateAgent = h.deps.writer.updateAgent;
      let reads = 0;
      h.deps.writer.readAgent = async (id, priority) => {
        reads += 1;
        const agent = { ...(await readAgent(id, priority)), status: reads >= runningFrom ? 'running' : 'stopped' };
        trace.push({ kind: 'read', running: agent.status === 'running', skills: [...(agent.enabledSkills ?? [])] });
        return agent;
      };
      h.deps.writer.updateAgent = async (id, patch, arenaAgentId, priority) => {
        trace.push({ kind: 'patch', patch: patch as Record<string, unknown> });
        return updateAgent(id, patch, arenaAgentId, priority);
      };
      await ensureArenaX402ForPay(AGENT_ID, h.deps).catch(() => 'threw');
      const firstRunning = trace.findIndex((step) => step.kind === 'read' && step.running);
      expect(firstRunning).toBeGreaterThanOrEqual(0);
      const seenRunning = trace[firstRunning] as { skills: string[] };
      for (const step of trace.slice(firstRunning + 1)) {
        if (step.kind !== 'patch') continue;
        // Removal only: just enabled_skills, no x402, nothing the running read did not list.
        expect(Object.keys(step.patch)).toEqual(['enabled_skills']);
        const next = step.patch.enabled_skills as string[];
        expect(next).not.toContain('x402');
        for (const skill of next) expect(seenRunning.skills).toContain(skill);
      }
      expect(h.skillsNow()).not.toContain('x402');
    }
  });

  test('Codex r19: the removal takes x402 off an add-on-free agent (also paused and running); in sync costs one GET', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.setSkills([...STICKY, 'x402']);
    h.setStatus('running');
    expect(await removeUnwantedArenaX402(AGENT_ID, { ...h.deps, paused: () => true })).toBe('removed');
    expect(h.log).toEqual([`update ${CP_ID} {"enabled_skills":[]}`]);
    expect(h.skillsNow()).not.toContain('x402');
    const before = h.seq.length;
    expect(await removeUnwantedArenaX402(AGENT_ID, h.deps)).toBe('off');
    expect(h.seq.slice(before)).toEqual(['read']);
    // A failed row never keeps x402 either; a creating row is not the reconcile's.
    const failed = harness(record({ provisionState: 'failed', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    failed.setSkills([...STICKY, 'x402']);
    expect(await removeUnwantedArenaX402(AGENT_ID, failed.deps)).toBe('removed');
    const creating = harness(record({ provisionState: 'creating', clawpumpAgentId: CP_ID }));
    creating.setSkills([...STICKY, 'x402']);
    expect(await removeUnwantedArenaX402(AGENT_ID, creating.deps)).toBe('skipped');
    expect(creating.seq).toEqual([]);
  });

  test('Codex r19: no local "absent" is proof: x402 added by another writer is removed by the fair cursor', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
    expect(await removeUnwantedArenaX402(AGENT_ID, h.deps)).toBe('off');
    // Something outside this leader turns x402 on (an old leader's last PATCH, a dashboard edit).
    h.setSkills([...STICKY, 'x402']);
    await runArenaProvisioningTick(NOW, h.deps);
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('V6-3: the player turns add-ons OFF during the add -> x402 comes off again in the SAME call', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    // The route commits OFF right after the add PATCH (the leader's row reads before it saw ON).
    const updateAgent = h.deps.writer.updateAgent;
    h.deps.writer.updateAgent = async (id, patch, arenaAgentId, priority) => {
      const result = await updateAgent(id, patch, arenaAgentId, priority);
      if (patch.enabled_skills?.includes('x402')) h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, addons: [] });
      return result;
    };
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('removed');
    expect(h.skillsNow()).not.toContain('x402');
    expect(h.log.at(-1)).toBe(`update ${CP_ID} {"enabled_skills":[]}`);
  });

  test('Codex r19: an OFF that commits BEFORE the config PATCH is honoured: x402 is never added', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    // The add path's first read saw ON; the player turns OFF before the PATCH's own row read.
    const readAgent = h.deps.writer.readAgent;
    let reads = 0;
    h.deps.writer.readAgent = async (id, priority) => {
      reads += 1;
      if (reads === 1) h.rows.set(AGENT_ID, { ...h.rows.get(AGENT_ID)!, addons: [] });
      return readAgent(id, priority);
    };
    await ensureArenaX402ForPay(AGENT_ID, h.deps);
    expect(h.log.filter((line) => line.includes('x402'))).toEqual([]);
    expect(h.skillsNow()).not.toContain('x402');
  });

  test('Lead v8b: two callers in one process run strictly one after the other; at most 2 connections (1 long)', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.setSkills([...STICKY, 'x402']);
    h.rows.set('b0000000-0000-4000-8000-000000000000', record({
      id: 'b0000000-0000-4000-8000-000000000000', provisionState: 'ready', clawpumpAgentId: 'cp-b', addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }],
    }));
    h.perCp.set('cp-b', { skills: [...STICKY], status: 'stopped' });
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    const trace: string[] = [];
    const tryX402Lock = h.deps.store.tryX402Lock;
    h.deps.store.tryX402Lock = async (id, fn) => {
      trace.push(`begin ${id.slice(0, 1)}`);
      try {
        return await tryX402Lock(id, fn);
      } finally {
        trace.push(`end ${id.slice(0, 1)}`);
      }
    };
    const readAgent = h.deps.writer.readAgent;
    h.deps.writer.readAgent = async (id, priority) => {
      // Slow ClawPump: a second caller has every chance to start meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 3));
      return readAgent(id, priority);
    };
    // The provisioning tick's removal and the add-on tick's add, at the same time.
    const [removal, add, again] = await Promise.all([
      removeUnwantedArenaX402(AGENT_ID, h.deps),
      ensureArenaX402ForPay('b0000000-0000-4000-8000-000000000000', h.deps),
      removeUnwantedArenaX402(AGENT_ID, h.deps),
    ]);
    expect([removal, add, again]).toEqual(['removed', 'added', 'off']);
    expect(trace).toEqual(['begin a', 'end a', 'begin b', 'end b', 'begin a', 'end a']);
    expect(h.conns.peakLong).toBe(1);
    expect(h.conns.peakTotal).toBeLessThanOrEqual(2);
  });

  test('audit-money P2: a lock held by ANOTHER process -> busy at once, never ready to pay; provisioning fails visibly', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setSkills([...STICKY, 'x402']);
    h.held.add(AGENT_ID);
    expect(await removeUnwantedArenaX402(AGENT_ID, h.deps)).toBe('busy');
    expect(await ensureArenaX402ForPay(AGENT_ID, h.deps)).toBe('busy');
    expect(h.seq).toEqual([]);
    _resetArenaProvisioningForTest();
    const p = harness(record());
    p.held.add(AGENT_ID);
    expect(await provisionArenaAgent(AGENT_ID, p.deps)).toBe('failed');
    expect(p.rows.get(AGENT_ID)!.provisionError).toBe('x402_lock_busy');
  });

  test('Codex r20 (1): 8 stuck agents never starve removals: 30 OFF agents all get an attempt within ceil(30 / slots) ticks', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.delete(AGENT_ID);
    const id = (prefix: string, index: number) => `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    // 8 permanently stuck ADD mismatches: add-on ON, x402 missing, agent running (never addable).
    for (let index = 0; index < 8; index += 1) {
      h.rows.set(id('a', index), record({ id: id('a', index), provisionState: 'ready', clawpumpAgentId: `cp-a${index}`, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }], updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-a${index}`, { skills: [...STICKY], status: 'running' });
    }
    // 30 add-on-free agents that still hold x402 (rows unchanged for an hour: not in R1).
    for (let index = 0; index < 30; index += 1) {
      h.rows.set(id('b', index), record({ id: id('b', index), provisionState: 'ready', clawpumpAgentId: `cp-b${index}`, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-b${index}`, { skills: [...STICKY, 'x402'], status: 'stopped' });
    }
    // Steady state: the term's first (full) pass already ran, before these rows changed.
    await warmUp(h);
    const bound = Math.ceil(30 / ARENA_X402_REMOVAL_SLOTS);
    for (let tick = 0; tick < bound; tick += 1) await runArenaProvisioningTick(NOW, h.deps);
    for (let index = 0; index < 30; index += 1) expect(h.perCp.get(`cp-b${index}`)!.skills).not.toContain('x402');
  });

  test('Codex r20/r21 (1): a removal that keeps failing backs off and never blocks the others', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.delete(AGENT_ID);
    const id = (prefix: string, index: number) => `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    // 8 OFF agents whose removal PATCH always fails, and 30 OFF agents that can be fixed.
    for (let index = 0; index < 8; index += 1) {
      h.rows.set(id('a', index), record({ id: id('a', index), provisionState: 'ready', clawpumpAgentId: `cp-a${index}`, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-a${index}`, { skills: [...STICKY, 'x402'], status: 'stopped', failPatch: true });
    }
    for (let index = 0; index < 30; index += 1) {
      h.rows.set(id('b', index), record({ id: id('b', index), provisionState: 'ready', clawpumpAgentId: `cp-b${index}`, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-b${index}`, { skills: [...STICKY, 'x402'], status: 'stopped' });
    }
    await warmUp(h);
    const failingPatches = () => h.log.filter((line) => line.startsWith('update cp-a')).length;
    const bound = Math.ceil(38 / ARENA_X402_REMOVAL_SLOTS);
    for (let tick = 0; tick < bound; tick += 1) await runArenaProvisioningTick(NOW, h.deps);
    // The clock does not move here: each failing agent was tried ONCE, then waits out its backoff.
    expect(failingPatches()).toBe(8);
    for (let index = 0; index < 30; index += 1) expect(h.perCp.get(`cp-b${index}`)!.skills).not.toContain('x402');
  });

  test('audit-money F: every fresh OFF is removed in ONE tick (no cap); re-checks wait while a removal is deferred', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.delete(AGENT_ID);
    const ids = Array.from({ length: 20 }, (_, index) => `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    for (const [index, agentId] of ids.entries()) {
      // Turned off just now (updated_at = now).
      h.rows.set(agentId, record({ id: agentId, provisionState: 'ready', clawpumpAgentId: `cp-${index}`, updatedAt: NOW }));
      h.perCp.set(`cp-${index}`, { skills: [...STICKY, 'x402'], status: 'stopped' });
    }
    await runArenaProvisioningTick(NOW, { ...h.deps, paused: () => true });
    for (let index = 0; index < 20; index += 1) expect(h.perCp.get(`cp-${index}`)!.skills).not.toContain('x402');
    // A busy lock defers a removal: re-checks are skipped that tick, and adds wait.
    _resetArenaProvisioningForTest();
    const busy = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, updatedAt: NOW }));
    busy.setSkills([...STICKY, 'x402']);
    busy.held.add(AGENT_ID);
    const sweep = busy.deps.store.listX402SweepAgents;
    let rechecks = 0;
    busy.deps.store.listX402SweepAgents = async (afterId, limit) => { rechecks += 1; return sweep(afterId, limit); };
    await runArenaProvisioningTick(NOW, busy.deps);
    expect(rechecks).toBe(0);
    const { arenaX402RemovalsDeferred } = await import('../floor-arena/provisioning');
    expect(arenaX402RemovalsDeferred()).toBe(true);
    // Lock free again: the next tick removes it (R3 retry) and clears the flag.
    busy.held.delete(AGENT_ID);
    await runArenaProvisioningTick(NOW, busy.deps);
    expect(busy.skillsNow()).not.toContain('x402');
    expect(arenaX402RemovalsDeferred()).toBe(false);
  });

  test('Codex r20 (3): a low call budget skips re-checks (removals still run first)', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, updatedAt: NOW }));
    h.setSkills([...STICKY, 'x402']);
    const sweep = h.deps.store.listX402SweepAgents;
    let rechecks = 0;
    h.deps.store.listX402SweepAgents = async (afterId, limit) => { rechecks += 1; return sweep(afterId, limit); };
    await runArenaProvisioningTick(NOW, { ...h.deps, budgetOk: () => false });
    expect(h.skillsNow()).not.toContain('x402');
    expect(rechecks).toBe(0);
  });

  test('audit-money F: a failed or impossible add backs off 1, 2, 4 ... minutes (max 30) for that agent', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID, addons: [{ id: 'feed', enabled: true, dailyCapUsd: 1 }] }));
    h.setStatus('running');
    let clock = NOW.getTime();
    const deps = { ...h.deps, now: () => new Date(clock) };
    expect(await ensureArenaX402ForPay(AGENT_ID, deps)).toBe('skipped');
    h.setStatus('stopped');
    h.setUpdate(async () => cpAgent({ acceptingBids: false }));
    // Within the first minute: still backing off, no PATCH.
    clock += 30_000;
    expect(await ensureArenaX402ForPay(AGENT_ID, deps)).toBe('skipped');
    expect(h.log).toEqual([]);
    clock += 31_000;
    expect(await ensureArenaX402ForPay(AGENT_ID, deps)).toBe('added');
  });

  test('Codex r21 (2): a failing removal backs off 30 s, 1 min, 2 min ... (max 30 min)', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: 'cp-a', updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
    h.perCp.set('cp-a', { skills: [...STICKY, 'x402'], status: 'stopped', failPatch: true });
    let clock = NOW.getTime();
    const deps = { ...h.deps, now: () => new Date(clock) };
    const attempts = () => h.log.filter((line) => line.startsWith('update cp-a')).length;
    const tickAt = async (offsetMs: number) => { clock = NOW.getTime() + offsetMs; await runArenaProvisioningTick(new Date(clock), deps); };
    await tickAt(0);
    expect(attempts()).toBe(1);
    await tickAt(29_000);
    expect(attempts()).toBe(1);
    await tickAt(30_000);
    expect(attempts()).toBe(2);
    await tickAt(89_000);
    expect(attempts()).toBe(2);
    await tickAt(90_000);
    expect(attempts()).toBe(3);
    // Fixed on ClawPump's side: the next allowed try removes it and clears the backoff.
    h.perCp.get('cp-a')!.failPatch = false;
    await tickAt(90_000 + 2 * 60_000);
    expect(h.perCp.get('cp-a')!.skills).not.toContain('x402');
  });

  test('Codex r21 (2): the first pass of a leader term covers EVERY add-on-free agent; later passes only recent changes + the cursor', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.delete(AGENT_ID);
    await warmUp(h);
    const ids = Array.from({ length: 20 }, (_, index) => `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    for (const [index, agentId] of ids.entries()) {
      h.rows.set(agentId, record({ id: agentId, provisionState: 'ready', clawpumpAgentId: `cp-${index}`, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-${index}`, { skills: [...STICKY, 'x402'], status: 'stopped' });
    }
    const fixed = () => ids.filter((_, index) => !h.perCp.get(`cp-${index}`)!.skills.includes('x402')).length;
    // Same term: old rows are only reached by the fair cursor (6 a tick).
    await runArenaProvisioningTick(NOW, h.deps);
    expect(fixed()).toBe(ARENA_X402_REMOVAL_SLOTS);
    // A new term (this process was just elected): one full pass fixes the rest.
    startArenaX402LeaderTerm();
    await runArenaProvisioningTick(NOW, h.deps);
    expect(fixed()).toBe(20);
  });

  test('Codex r21 (2): the "changed since" watermark is DATABASE time, not the API host clock', async () => {
    const h = harness(record({ provisionState: 'ready', clawpumpAgentId: CP_ID }));
    h.rows.delete(AGENT_ID);
    await warmUp(h);
    // The player turns add-ons off 10 s after the previous pass (DB clock).
    h.rows.set('b0000000-0000-4000-8000-000000000000', record({
      id: 'b0000000-0000-4000-8000-000000000000', provisionState: 'ready', clawpumpAgentId: 'cp-b', updatedAt: new Date(NOW.getTime() + 10_000),
    }));
    h.perCp.set('cp-b', { skills: [...STICKY, 'x402'], status: 'stopped' });
    // Push it past the fair cursor so only R1 can find it this tick.
    for (let index = 0; index < 6; index += 1) {
      const agentId = `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      h.rows.set(agentId, record({ id: agentId, provisionState: 'ready', clawpumpAgentId: `cp-a${index}`, updatedAt: new Date(NOW.getTime() - 60 * 60_000) }));
      h.perCp.set(`cp-a${index}`, { skills: [...STICKY], status: 'stopped' });
    }
    // The API host clock runs 2 hours ahead; the DB clock says 30 s later.
    h.setDbNow(new Date(NOW.getTime() + 30_000));
    const skewed = { ...h.deps, now: () => new Date(NOW.getTime() + 2 * 60 * 60_000) };
    await runArenaProvisioningTick(NOW, skewed);
    expect(h.perCp.get('cp-b')!.skills).not.toContain('x402');
  });

  test('the persona and prompt forbid trading', () => {
    expect(ARENA_CLAWPUMP_PERSONA).toContain('does not trade');
    expect(ARENA_CLAWPUMP_SYSTEM_PROMPT).toContain('Do not trade');
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
    updateAgent: async (id, patch, arenaAgentId, priority) => { take(`patch ${id}`, priority); return w.updateAgent(id, patch, arenaAgentId, priority); },
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
    // Due again before the next 30 s tick (the loop's shortest spacing is 27 s after a tick ends).
    expect(row.provisionNextAt!.getTime()).toBeLessThanOrEqual(NOW.getTime() + 27_000);
    expect(await h.deps.store.listDue(new Date(NOW.getTime() + 27_000), ARENA_PROVISION_MAX_ATTEMPTS, 20)).toEqual([AGENT_ID]);
    expect(h.events).toEqual([]);

    // ClawPump's HTTP 429 mid-flow (after the create): same rule, and the saved id is reused on the retry.
    const mid = harness(record());
    mid.setUpdate(async () => { throw new ClawPumpWriterError('rate_limited', 429); });
    expect(await provisionArenaAgent(AGENT_ID, mid.deps)).toBe('throttled');
    expect(mid.rows.get(AGENT_ID)).toMatchObject({ provisionAttempts: 0, clawpumpAgentId: CP_ID });
    expect(mid.events).toEqual([]);
    mid.setUpdate(async () => cpAgent({ acceptingBids: false }));
    mid.log.length = 0;
    const later = { ...mid.deps, now: () => new Date(NOW.getTime() + 30_000) };
    expect(await provisionArenaAgent(AGENT_ID, later)).toBe('ready');
    expect(mid.log.some((line) => line.startsWith('create'))).toBe(false);
  });

  test('(b) six throttled ticks in a row never fail the agent; it is retried every tick, then provisions', async () => {
    const h = harness(record());
    let budget = false;
    h.setCreate(async () => {
      if (!budget) throw new ClawPumpWriterError('budget_exhausted');
      return cpAgent();
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
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', provisionAttempts: 0, clawpumpAgentId: CP_ID });
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

  test('(c) the tick provisions a due agent BEFORE the x402 reconcile spends the shared budget', async () => {
    const h = harness(record());
    // Three add-on-free agents that still hold x402: their removals alone can drain the bucket.
    for (let index = 0; index < 3; index += 1) {
      const agentId = `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      h.rows.set(agentId, record({ id: agentId, provisionState: 'ready', clawpumpAgentId: `cp-b${index}`, updatedAt: NOW }));
      h.perCp.set(`cp-b${index}`, { skills: [...STICKY, 'x402'], status: 'stopped' });
    }
    const b = budgeted(h);
    await runArenaProvisioningTick(NOW, b.deps);
    // Provisioning's calls (create, then the config sync) come first; the x402 pass follows.
    expect(b.order.slice(0, 4)).toEqual(['create', `read ${CP_ID}`, `patch ${CP_ID}`, `read ${CP_ID}`]);
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'ready', provisionAttempts: 0, clawpumpAgentId: CP_ID });
    // Normal calls stop above the removal reserve, so the reconcile still removes x402 this tick.
    expect(h.perCp.get('cp-b0')!.skills).not.toContain('x402');
  });

  test('(d) a paused tick runs the x402 reconcile and no provisioning', async () => {
    const h = harness(record());
    const OFF = 'b0000000-0000-4000-8000-000000000000';
    h.rows.set(OFF, record({ id: OFF, provisionState: 'ready', clawpumpAgentId: 'cp-off', updatedAt: NOW }));
    h.perCp.set('cp-off', { skills: [...STICKY, 'x402'], status: 'stopped' });
    await runArenaProvisioningTick(NOW, { ...h.deps, paused: () => true });
    expect(h.perCp.get('cp-off')!.skills).not.toContain('x402');
    expect(h.created).toEqual([]);
    expect(h.log).not.toContain('claim');
    expect(h.rows.get(AGENT_ID)).toMatchObject({ provisionState: 'pending', provisionAttempts: 0 });
  });
});
