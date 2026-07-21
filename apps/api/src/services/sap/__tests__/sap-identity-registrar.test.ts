/**
 * SAP identity registrar durable-state tests.
 *
 * Every persistence and chain seam is an in-memory fake: these tests never
 * open DATABASE_URL, decrypt a custodial key, or contact Solana/Metaplex.
 * They pin the proof-bearing transitions that make the public EIP document
 * honest after retries and ambiguous broadcasts.
 */

import { describe, expect, it } from 'bun:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { SapAgentIdentity } from '@clawville/database';
import { findDregIdentityPda } from '../sap-dreg-identity';
import {
  SAP_IDENTITY_REGISTRATION_BASE_URL,
  SAP_REGISTER_BALANCE_FLOOR_LAMPORTS,
  buildSapIdentityMetadataUrl,
  buildSapIdentityRegistrationUrl,
  processSapIdentityRow,
  resolveSapIdentityRegistrationBaseUrl,
  type SapIdentityRegistrarDeps,
} from '../sap-identity-registrar';

const WALLET = Keypair.generate().publicKey.toBase58();
const AGENT_PDA = Keypair.generate().publicKey.toBase58();
const ASSET = Keypair.generate().publicKey.toBase58();
const IDENTITY_REGISTRATION = findDregIdentityPda(new PublicKey(ASSET)).toBase58();
const REGISTER_SIG = '1'.repeat(64);
const ATTACH_SIG = `${'1'.repeat(63)}2`;

function identityRow(
  overrides: Partial<SapAgentIdentity> = {},
): SapAgentIdentity {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    avatarId: '22222222-2222-4222-8222-222222222222',
    wallet: WALLET,
    agentPda: AGENT_PDA,
    cluster: 'devnet',
    status: 'pending_funding',
    registerTxSig: null,
    name: 'Test Agent',
    description: 'Test Agent - ClawVille agent (https://clawville.world)',
    capabilities: [],
    metaplexAsset: null,
    identityRegistration: null,
    metaplexTxSig: null,
    triggerSource: 'test',
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
    ...overrides,
  };
}

function harness(
  initial: SapAgentIdentity,
  overrides: Partial<SapIdentityRegistrarDeps> = {},
) {
  let current = initial;
  const patches: Array<Record<string, unknown>> = [];
  let registerCalls = 0;
  let mintCalls = 0;
  const alerts: unknown[] = [];

  const deps: SapIdentityRegistrarDeps = {
    getBalanceLamports: async () => SAP_REGISTER_BALANCE_FLOOR_LAMPORTS,
    fetchProfile: async () => ({ ok: true, data: null }),
    findRegistrationSignature: async () => ({ ok: true, data: REGISTER_SIG }),
    register: async () => {
      registerCalls += 1;
      return {
        ok: true,
        dryRun: false,
        signature: REGISTER_SIG,
        accounts: { agent: AGENT_PDA },
      };
    },
    persistPatch: async (_id, patch) => {
      patches.push({ ...patch });
      current = { ...current, ...patch, updatedAt: new Date() };
      return current;
    },
    mintAndAttach: async (_row, persistPreparedAsset) => {
      mintCalls += 1;
      await persistPreparedAsset(ASSET, IDENTITY_REGISTRATION);
      return {
        ok: true,
        dryRun: false,
        signature: ATTACH_SIG,
        asset: ASSET,
        identityRegistration: IDENTITY_REGISTRATION,
        registrationUrl: buildSapIdentityRegistrationUrl(AGENT_PDA),
      };
    },
    assetExists: async () => true,
    findMetaplexTxSignature: async () => ATTACH_SIG,
    verifyLink: async () => true,
    alert: async (params) => {
      alerts.push(params);
    },
    ...overrides,
  };

  return {
    deps,
    patches,
    alerts,
    current: () => current,
    registerCalls: () => registerCalls,
    mintCalls: () => mintCalls,
  };
}

describe('SAP identity registrar state machine', () => {
  it('parks insufficiently funded registration without consuming an attempt', async () => {
    const row = identityRow({ attempts: 3 });
    const h = harness(row, {
      getBalanceLamports: async () => SAP_REGISTER_BALANCE_FLOOR_LAMPORTS - 1,
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('pending_funding');
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain('Waiting for 60000000 lamports');
    expect(h.registerCalls()).toBe(0);
    expect(h.mintCalls()).toBe(0);
  });

  it('records a real register signature and does not claim a dry-run attach', async () => {
    const row = identityRow();
    const h = harness(row, {
      mintAndAttach: async (_identity, persistPreparedAsset) => {
        await persistPreparedAsset(ASSET, IDENTITY_REGISTRATION);
        return {
          ok: true,
          dryRun: true,
          asset: ASSET,
          identityRegistration: IDENTITY_REGISTRATION,
          registrationUrl: buildSapIdentityRegistrationUrl(AGENT_PDA),
        };
      },
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('registered');
    expect(result.registerTxSig).toBe(REGISTER_SIG);
    expect(result.metaplexAsset).toBeNull();
    expect(result.identityRegistration).toBeNull();
    expect(result.metaplexTxSig).toBeNull();
    expect(h.registerCalls()).toBe(1);
  });

  it('adopts a pre-existing on-chain profile only with its recovered real signature', async () => {
    const row = identityRow({ status: 'registering' });
    const h = harness(row, {
      fetchProfile: async () => ({
        ok: true,
        data: {
          agentPda: AGENT_PDA,
          wallet: WALLET,
          name: row.name,
          description: row.description,
          isActive: true,
          reputationScore: 0,
          totalFeedbacks: 0,
          agentUri: null,
          x402Endpoint: null,
        },
      }),
      findRegistrationSignature: async () => ({ ok: true, data: REGISTER_SIG }),
      mintAndAttach: async () => ({
        ok: true,
        dryRun: true,
        asset: ASSET,
        registrationUrl: buildSapIdentityRegistrationUrl(AGENT_PDA),
      }),
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('registered');
    expect(result.registerTxSig).toBe(REGISTER_SIG);
    expect(h.registerCalls()).toBe(0);
  });

  it('returns a transient register failure to pending_funding and increments attempts', async () => {
    const row = identityRow({ status: 'registering', attempts: 2 });
    const h = harness(row, {
      register: async () => ({
        ok: false,
        code: 'rpc_unreachable',
        message: 'RPC timed out before broadcast',
      }),
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('pending_funding');
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain('RPC timed out');
    expect(h.alerts).toHaveLength(0);
    // One failure transition owns the retry timestamp. A second empty UPDATE
    // would silently push backoff forward and make the durable row harder to resume.
    expect(h.patches).toHaveLength(1);
  });

  it('caps the tenth failed attempt and emits one critical alert', async () => {
    const row = identityRow({ status: 'registering', attempts: 9 });
    const h = harness(row, {
      register: async () => ({
        ok: false,
        code: 'rpc_unreachable',
        message: 'still unavailable',
      }),
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(10);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      severity: 'critical',
      source: 'sap-identity-registrar',
    });
  });

  it('pins the SDK registration base to the immutable public route shape', () => {
    expect(SAP_IDENTITY_REGISTRATION_BASE_URL).toBe('https://api.clawville.world');
    expect(buildSapIdentityRegistrationUrl(AGENT_PDA)).toBe(
      `https://api.clawville.world/agents/${AGENT_PDA}/eip-8004.json`,
    );
    expect(buildSapIdentityMetadataUrl(AGENT_PDA)).toBe(
      `https://api.clawville.world/agents/${AGENT_PDA}/metadata.json`,
    );
  });

  it('resolves and normalizes the environment-specific registration base URL', () => {
    const original = process.env.SAP_IDENTITY_REGISTRATION_BASE_URL;
    try {
      process.env.SAP_IDENTITY_REGISTRATION_BASE_URL =
        '  https://api-staging.clawville.world///  ';
      expect(resolveSapIdentityRegistrationBaseUrl()).toBe(
        'https://api-staging.clawville.world',
      );
      process.env.SAP_IDENTITY_REGISTRATION_BASE_URL = 'http://api-staging.clawville.world';
      expect(resolveSapIdentityRegistrationBaseUrl()).toBe('https://api.clawville.world');
    } finally {
      if (original === undefined) delete process.env.SAP_IDENTITY_REGISTRATION_BASE_URL;
      else process.env.SAP_IDENTITY_REGISTRATION_BASE_URL = original;
    }
  });

  it('applies the environment override to the module-load const and immutable URLs', () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--eval',
        `const registrar = await import('./src/services/sap/sap-identity-registrar.ts');
console.log('SAP_IDENTITY_ENV_TEST=' + JSON.stringify({
  base: registrar.SAP_IDENTITY_REGISTRATION_BASE_URL,
  registration: registrar.buildSapIdentityRegistrationUrl('${AGENT_PDA}'),
  metadata: registrar.buildSapIdentityMetadataUrl('${AGENT_PDA}'),
}));`,
      ],
      cwd: `${import.meta.dir}/../../../..`,
      env: {
        ...process.env,
        DATABASE_URL: '',
        SAP_IDENTITY_REGISTRATION_BASE_URL: '  https://api-staging.clawville.world///  ',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(child.exitCode).toBe(0);
    const output = new TextDecoder().decode(child.stdout);
    const payload = output
      .split(/\r?\n/)
      .find((line) => line.startsWith('SAP_IDENTITY_ENV_TEST='));
    if (!payload) throw new Error(`Child module probe returned no payload: ${output}`);
    expect(JSON.parse(payload.slice('SAP_IDENTITY_ENV_TEST='.length))).toEqual({
      base: 'https://api-staging.clawville.world',
      registration: `https://api-staging.clawville.world/agents/${AGENT_PDA}/eip-8004.json`,
      metadata: `https://api-staging.clawville.world/agents/${AGENT_PDA}/metadata.json`,
    });
  });

  it('retains the prepared asset and stays attaching when verifyLink is false', async () => {
    const row = identityRow({
      status: 'registered',
      registerTxSig: REGISTER_SIG,
    });
    const h = harness(row, { verifyLink: async () => false });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('attaching_identity');
    expect(result.attempts).toBe(1);
    expect(result.metaplexAsset).toBe(ASSET);
    expect(result.identityRegistration).toBe(IDENTITY_REGISTRATION);
    expect(result.metaplexTxSig).toBe(ATTACH_SIG);
    expect(result.lastError).toContain('not yet verifiable');
  });

  it('retains a prepared asset and signed tx proof when send outcome is unknown', async () => {
    const row = identityRow({ status: 'registered', registerTxSig: REGISTER_SIG });
    const h = harness(row, {
      mintAndAttach: async (_identity, persistPreparedAsset) => {
        await persistPreparedAsset(ASSET, IDENTITY_REGISTRATION);
        return {
          ok: false,
          code: 'rpc_unreachable',
          message: 'send timed out after bytes may have reached the RPC',
          broadcast: true,
          signature: ATTACH_SIG,
          asset: ASSET,
          identityRegistration: IDENTITY_REGISTRATION,
          registrationUrl: buildSapIdentityRegistrationUrl(AGENT_PDA),
        };
      },
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('attaching_identity');
    expect(result.metaplexAsset).toBe(ASSET);
    expect(result.identityRegistration).toBe(IDENTITY_REGISTRATION);
    expect(result.metaplexTxSig).toBe(ATTACH_SIG);
    expect(result.attempts).toBe(1);
    expect(h.mintCalls()).toBe(0);
  });

  it('marks identity_attached only after verifyLink succeeds', async () => {
    const row = identityRow({
      status: 'registered',
      registerTxSig: REGISTER_SIG,
    });
    const h = harness(row, { verifyLink: async () => true });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('identity_attached');
    expect(result.metaplexAsset).toBe(ASSET);
    expect(result.metaplexTxSig).toBe(ATTACH_SIG);
    expect(result.identityRegistration).toBe(IDENTITY_REGISTRATION);
    expect(h.patches[0]).toMatchObject({
      status: 'attaching_identity',
      metaplexAsset: ASSET,
      identityRegistration: IDENTITY_REGISTRATION,
    });
    expect(h.patches).toContainEqual(expect.objectContaining({
      status: 'attaching_identity',
      metaplexAsset: ASSET,
      identityRegistration: IDENTITY_REGISTRATION,
      metaplexTxSig: ATTACH_SIG,
    }));
  });

  it('reconciles a prepared/broadcast asset before ever minting another one', async () => {
    const row = identityRow({
      status: 'attaching_identity',
      registerTxSig: REGISTER_SIG,
      metaplexAsset: ASSET,
      metaplexTxSig: ATTACH_SIG,
    });
    const h = harness(row, { verifyLink: async () => true });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('identity_attached');
    expect(h.mintCalls()).toBe(0);
  });

  it('verifies a persisted asset even when the post-mint wallet balance is zero', async () => {
    const row = identityRow({
      status: 'attaching_identity',
      registerTxSig: REGISTER_SIG,
      metaplexAsset: ASSET,
      metaplexTxSig: ATTACH_SIG,
    });
    const h = harness(row, {
      getBalanceLamports: async () => 0,
      verifyLink: async () => true,
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('identity_attached');
    expect(h.mintCalls()).toBe(0);
  });

  it('safely resets a stale crash-before-send asset only after proving it absent', async () => {
    const row = identityRow({
      status: 'attaching_identity',
      registerTxSig: REGISTER_SIG,
      metaplexAsset: ASSET,
      identityRegistration: IDENTITY_REGISTRATION,
      metaplexTxSig: null,
      attempts: 4,
      updatedAt: new Date(Date.now() - 11 * 60_000),
    });
    const h = harness(row, { assetExists: async () => false });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('registered');
    expect(result.metaplexAsset).toBeNull();
    expect(result.identityRegistration).toBeNull();
    expect(result.metaplexTxSig).toBeNull();
    expect(result.attempts).toBe(4);
    expect(h.mintCalls()).toBe(0);
  });

  it('resets a stale signed-but-reverted asset only after proving it absent', async () => {
    let verifyCalls = 0;
    const row = identityRow({
      status: 'attaching_identity',
      registerTxSig: REGISTER_SIG,
      metaplexAsset: ASSET,
      identityRegistration: IDENTITY_REGISTRATION,
      metaplexTxSig: ATTACH_SIG,
      attempts: 1,
      updatedAt: new Date(Date.now() - 11 * 60_000),
    });
    const h = harness(row, {
      assetExists: async () => false,
      verifyLink: async () => {
        verifyCalls += 1;
        return false;
      },
    });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result.status).toBe('registered');
    expect(result.metaplexAsset).toBeNull();
    expect(result.identityRegistration).toBeNull();
    expect(result.metaplexTxSig).toBeNull();
    expect(result.attempts).toBe(1);
    expect(verifyCalls).toBe(0);
    expect(h.mintCalls()).toBe(0);
  });

  it('parks a recent prepared asset without an attempt or blind remint', async () => {
    const row = identityRow({
      status: 'attaching_identity',
      registerTxSig: REGISTER_SIG,
      metaplexAsset: ASSET,
      metaplexTxSig: null,
      attempts: 2,
      updatedAt: new Date(),
    });
    const h = harness(row, { assetExists: async () => false });

    const result = await processSapIdentityRow(row, h.deps);

    expect(result).toBe(row);
    expect(result.attempts).toBe(2);
    expect(h.patches).toHaveLength(0);
    expect(h.mintCalls()).toBe(0);
  });
});
