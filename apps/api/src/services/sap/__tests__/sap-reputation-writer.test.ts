import { describe, expect, it } from 'bun:test';
import bs58 from 'bs58';
import type { SapAgentIdentity, SapReputationJob } from '@clawville/database';
import type { SapWriteResult } from '../sap-client';
import {
  bountyReputationScore,
  processSapReputationJob,
  type FeedbackProbe,
  type SapReputationWriterDeps,
} from '../sap-reputation-writer';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const REAL_SIG = bs58.encode(Buffer.alloc(64, 7));
const HUNTER = '11111111-1111-4111-8111-111111111111';
const HOUSE = '22222222-2222-4222-8222-222222222222';
const BOUNTY = '33333333-3333-4333-8333-333333333333';

function job(overrides: Partial<SapReputationJob> = {}): SapReputationJob {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    bountyId: BOUNTY,
    hunterAvatarId: HUNTER,
    status: 'writing',
    attestationTxSig: null,
    feedbackTxSig: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

function identity(avatarId = HUNTER): SapAgentIdentity {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    avatarId,
    wallet: avatarId === HOUSE ? 'house-wallet' : 'hunter-wallet',
    agentPda: avatarId === HOUSE ? 'house-agent-pda' : 'hunter-agent-pda',
    cluster: 'devnet',
    status: 'identity_attached',
    registerTxSig: REAL_SIG,
    name: 'Agent',
    description: 'Registered test agent',
    capabilities: [],
    metaplexAsset: null,
    identityRegistration: null,
    metaplexTxSig: null,
    triggerSource: 'test',
    attempts: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function live(signature = REAL_SIG): SapWriteResult {
  return { ok: true, dryRun: false, signature, accounts: {} };
}

function makeDeps(opts: {
  attestationProbes?: boolean[];
  feedback?: FeedbackProbe;
  createResult?: SapWriteResult;
  giveResult?: SapWriteResult;
  updateResult?: SapWriteResult;
  completed?: number;
  houseAvatarId?: string | null;
} = {}) {
  let current = job();
  const calls = { create: 0, give: 0, update: 0 };
  const probes = [...(opts.attestationProbes ?? [false])];
  const deps: SapReputationWriterDeps = {
    config: { enabled: true, reputationWritesEnabled: true, cluster: 'devnet' },
    now: () => NOW,
    loadHunterIdentity: async () => identity(),
    resolveHouseAvatarId: async () => opts.houseAvatarId === undefined ? HOUSE : opts.houseAvatarId,
    loadHouseIdentity: async () => ({ wallet: 'house-wallet', agentPda: 'house-agent-pda', cluster: 'devnet' }),
    countPaidComposedBounties: async () => opts.completed ?? 1,
    probeAttestation: async () => probes.shift() ?? false,
    probeFeedback: async () => opts.feedback ?? { exists: false },
    createAttestation: async () => { calls.create++; return opts.createResult ?? live(); },
    giveFeedback: async () => { calls.give++; return opts.giveResult ?? live(); },
    updateFeedback: async () => { calls.update++; return opts.updateResult ?? live(); },
    persistPatch: async (_id, patch) => {
      current = { ...current, ...patch };
      return current;
    },
    alert: async () => {},
  };
  return { deps, calls, get current() { return current; } };
}

describe('SAP bounty reputation score', () => {
  it('ramps from 625 on the first completion and caps at 1000', () => {
    expect(bountyReputationScore(1)).toBe(625);
    expect(bountyReputationScore(15)).toBe(975);
    expect(bountyReputationScore(16)).toBe(1000);
    expect(bountyReputationScore(999)).toBe(1000);
  });
});

describe('SAP reputation writer state machine', () => {
  it('creates the standing attestation then gives first feedback', async () => {
    const ctx = makeDeps({ completed: 1 });
    const result = await processSapReputationJob(job(), ctx.deps);
    expect(result.status).toBe('written');
    expect(ctx.calls).toEqual({ create: 1, give: 1, update: 0 });
    expect(result.attestationTxSig).toBe(REAL_SIG);
    expect(result.feedbackTxSig).toBe(REAL_SIG);
  });

  it('updates an existing valid pair instead of colliding with give_feedback', async () => {
    const ctx = makeDeps({
      completed: 2,
      attestationProbes: [true],
      feedback: {
        exists: true,
        agent: 'hunter-agent-pda',
        reviewer: 'house-wallet',
        score: 625,
        tag: 'bounty',
        commentHashHex: '00'.repeat(32),
        isRevoked: false,
      },
    });
    const result = await processSapReputationJob(job(), ctx.deps);
    expect(result.status).toBe('written');
    expect(ctx.calls).toEqual({ create: 0, give: 0, update: 1 });
  });

  it('adopts an already-created attestation pair after a collision', async () => {
    const ctx = makeDeps({
      attestationProbes: [false, true],
      createResult: {
        ok: false,
        code: 'on_chain_error',
        message: 'account already in use',
      },
    });
    const result = await processSapReputationJob(job(), ctx.deps);
    expect(result.status).toBe('written');
    expect(ctx.calls.create).toBe(1);
    expect(ctx.calls.give).toBe(1);
  });

  it('adopts exact decoded feedback before any resend after an unknown broadcast', async () => {
    const expectedHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOUNTY));
    const ctx = makeDeps({
      completed: 1,
      attestationProbes: [true],
      feedback: {
        exists: true,
        agent: 'hunter-agent-pda',
        reviewer: 'house-wallet',
        score: 625,
        tag: 'bounty',
        commentHashHex: Buffer.from(expectedHash).toString('hex'),
        isRevoked: false,
      },
    });
    const result = await processSapReputationJob(job(), ctx.deps);
    expect(result.status).toBe('written');
    expect(ctx.calls).toEqual({ create: 0, give: 0, update: 0 });
  });

  it('refuses house self-attestation', async () => {
    const ctx = makeDeps({ houseAvatarId: HUNTER });
    const result = await processSapReputationJob(job(), ctx.deps);
    expect(result.status).toBe('skipped');
    expect(result.lastError).toContain('self-attestation');
    expect(ctx.calls).toEqual({ create: 0, give: 0, update: 0 });
  });

  it('waits for identity, then skips after fourteen days', async () => {
    const ctx = makeDeps();
    ctx.deps.loadHunterIdentity = async () => null;
    const waiting = await processSapReputationJob(job(), ctx.deps);
    expect(waiting.status).toBe('waiting_identity');

    const old = job({ createdAt: new Date(NOW.getTime() - 14 * 24 * 60 * 60_000) });
    const skipped = await processSapReputationJob(old, ctx.deps);
    expect(skipped.status).toBe('skipped');
  });
});
