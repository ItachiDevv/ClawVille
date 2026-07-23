/**
 * Public EIP-8004 registry route tests.
 *
 * The database is an in-memory query seam. No DATABASE_URL is read and no RPC
 * or custodial signer is touched. These tests lock the proof-before-publication
 * contract for both immutable URL shapes and the verbatim genesis fallback.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { SapAgentIdentity } from '@clawville/database';

const GENESIS_PDA = 'Ep7dD7biX7rZ6NSVzy8uEpgEEYipVfQ8ofwHzZmRM8dF';
const DB_PDA = '8pv2wEMMzhxN51JSsjB4jJM1bjgm8kxZpnA9c2qX3fNX';
const WALLET = '24i43XkDyJAJJBi7X3ARRCt3WBh16uJuSfVRLKXVEYBQ';
const REGISTER_TX_SIG =
  '3Az7DTyNQyEHKoMQQjGsxFRBsnLdovNP2cG2V5aJNAvthDuouiBFPMc9NoCHErHNjiecBi9DYxTEoREQ9HMmxP5p';

let row: SapAgentIdentity | undefined;
let lookupCalls = 0;
let interceptDatabase = true;

const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;
const queryProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'sapAgentIdentities' && interceptDatabase) {
      return {
        findFirst: async () => {
          lookupCalls += 1;
          return row;
        },
      };
    }
    const query = Reflect.get(delegateDb, 'query', delegateDb) as Record<PropertyKey, unknown>;
    return Reflect.get(query, property, query);
  },
});
const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') return queryProxy;
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { agentEip8004Routes } = await import('../../../routes/agent-eip8004');

function buildApp(): Hono {
  return new Hono().route('/agents', agentEip8004Routes);
}

function identityRow(
  overrides: Partial<SapAgentIdentity> = {},
): SapAgentIdentity {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    avatarId: '22222222-2222-4222-8222-222222222222',
    wallet: WALLET,
    agentPda: DB_PDA,
    cluster: 'devnet',
    status: 'registered',
    registerTxSig: REGISTER_TX_SIG,
    name: 'DB Agent',
    description: 'DB Agent — ClawVille agent (https://clawville.world)',
    capabilities: [
      { id: 'bounty-execution', description: 'Completes bounties' },
      { id: 'x402-payments' },
    ],
    metaplexAsset: null,
    identityRegistration: null,
    metaplexTxSig: null,
    triggerSource: 'bounty.create',
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
    updatedAt: new Date('2026-07-21T12:05:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  row = undefined;
  lookupCalls = 0;
});

afterAll(() => {
  interceptDatabase = false;
});

describe.serial('GET /agents/:sapAgentPda EIP-8004 documents', () => {
  it('serves the verbatim in-code genesis entry before consulting the database', async () => {
    row = identityRow({ agentPda: GENESIS_PDA, name: 'must-not-win' });

    const response = await buildApp().request(`/agents/${GENESIS_PDA}/eip-8004.json`);
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(lookupCalls).toBe(0);
    expect(body.name).toBe('clawville_genesis');
    expect(body.synapseAgent).toBe(GENESIS_PDA);
    expect(body.authority).toBe(WALLET);
    expect(body.updatedAt).toBe('2026-07-02T02:00:00Z');
    expect(body.extra.metaplexIdentityAsset.mainnet).toBe(
      'ALcUH8xDxRbqZ7rLMQdXRuvx6TmdSfF7UxQFFe9Ad3om',
    );
  });

  it('serves a proven DB registration with cluster-correct wallet service and real proofs', async () => {
    row = identityRow({
      status: 'identity_attached',
      metaplexAsset: 'MetaplexAsset111111111111111111111111111111',
      identityRegistration: 'IdentityRegistration1111111111111111111111111',
      metaplexTxSig: 'METAPLEX_TX_SIG',
    });

    const response = await buildApp().request(`/agents/${DB_PDA}/eip-8004.json`);
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(lookupCalls).toBe(1);
    expect(body).toMatchObject({
      version: '0.1',
      name: 'DB Agent',
      synapseAgent: DB_PDA,
      authority: WALLET,
      capabilities: ['bounty-execution', 'x402-payments'],
      services: [
        { name: 'web', endpoint: 'https://clawville.world' },
        {
          name: 'wallet',
          endpoint: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${WALLET}`,
        },
      ],
      extra: {
        cluster: 'devnet',
        registerTxSig: REGISTER_TX_SIG,
        metaplexAsset: 'MetaplexAsset111111111111111111111111111111',
        identityRegistration: 'IdentityRegistration1111111111111111111111111',
        metaplexTxSig: 'METAPLEX_TX_SIG',
      },
    });
  });

  it('derives metadata.json from the same proven DB row and pins the immutable EIP URL', async () => {
    row = identityRow();

    const response = await buildApp().request(`/agents/${DB_PDA}/metadata.json`);
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.name).toBe('DB Agent');
    expect(body.attributes).toContainEqual({ trait_type: 'synapse_agent', value: DB_PDA });
    expect(body.attributes).toContainEqual({
      trait_type: 'eip_8004',
      value: `https://api.clawville.world/agents/${DB_PDA}/eip-8004.json`,
    });
  });

  it('refuses non-success, missing-signature, and non-Solana-signature rows on both URL shapes', async () => {
    for (const candidate of [
      identityRow({ status: 'pending_funding' }),
      identityRow({ status: 'registering' }),
      identityRow({ status: 'failed' }),
      identityRow({ status: 'registered', registerTxSig: null }),
      identityRow({ status: 'registered', registerTxSig: 'adopted_existing' }),
    ]) {
      row = candidate;
      for (const suffix of ['eip-8004.json', 'metadata.json']) {
        const response = await buildApp().request(`/agents/${DB_PDA}/${suffix}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
    }
  });

  it('returns opaque 404 for unknown and malformed PDAs', async () => {
    const unknown = await buildApp().request(`/agents/${DB_PDA}/eip-8004.json`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    expect(lookupCalls).toBe(1);

    const malformed = await buildApp().request('/agents/not-a-pubkey/metadata.json');
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'not_found' });
    expect(lookupCalls).toBe(1);
  });
});
