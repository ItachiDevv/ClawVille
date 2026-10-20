/**
 * Special-event SOL checks read the right Solana cluster (roundup 2026-10-20).
 *
 * Root cause: the entry / refund / hold checks read `SOLANA_RPC_URL`, which is
 * the DEVNET wager RPC on the prod box too, so a devnet transfer could buy a
 * real seat. Asserts:
 *   (1) `CLAWVILLE_ENV=production` (and UNSET) never builds the devnet RPC, even
 *       when `SOLANA_RPC_URL` points at devnet.
 *   (2) `CLAWVILLE_ENV=staging` keeps `SOLANA_RPC_URL` (the pre-fix staging path).
 *   (3) on mainnet, a non-mainnet genesis or an unreachable RPC fails closed
 *       (`sol_network_unverified`, no proof returned) and is retried next call.
 *   (4) the default seam checks the recipient and the amount from the parsed tx.
 *
 * No endpoint string is printed or compared in full (a keyed Helius URL may be
 * present in a local env); only the hostname is checked.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  createDefaultEventRpc,
  createEventConnection,
  resolveEventRpcCluster,
  SpecialEventError,
  type EventRpcCluster,
} from '../special-event-manager';
import { MAINNET_GENESIS_HASH } from '../solana-mainnet-rpc';
import { _resetClvSwapCustodyCachesForTest } from '../clv-swap-custody';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TREASURY = 'Treasury1111111111111111111111111111111111';
const PAYER = 'Payer111111111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';

const savedEnv = {
  CLAWVILLE_ENV: process.env.CLAWVILLE_ENV,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetClvSwapCustodyCachesForTest();
});

function host(endpoint: string): string {
  return new URL(endpoint).hostname.toLowerCase();
}

/** A parsed System transfer of `lamports` from PAYER to `dest`. */
function parsedTransfer(dest: string, lamports: number) {
  return {
    meta: {
      err: null,
      preBalances: [10_000_000, 0],
      postBalances: [10_000_000 - lamports - 5_000, lamports],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [PAYER, dest].map((pubkey) => ({ pubkey, signer: false, writable: true })),
        instructions: [
          {
            program: 'system',
            programId: SYSTEM,
            parsed: { type: 'transfer', info: { source: PAYER, destination: dest, lamports } },
          },
        ],
      },
    },
  };
}

function fakeConnection(o: { genesis?: string | Error; tx?: unknown }) {
  const calls = { genesis: 0, parsed: 0, clusters: [] as EventRpcCluster[] };
  const conn = {
    rpcEndpoint: 'https://fake.invalid',
    async getGenesisHash() {
      calls.genesis += 1;
      if (o.genesis instanceof Error) throw o.genesis;
      return o.genesis ?? MAINNET_GENESIS_HASH;
    },
    async getParsedTransaction() {
      calls.parsed += 1;
      return o.tx ?? null;
    },
    async getTokenSupply() {
      return { context: { slot: 1 }, value: { amount: '0', decimals: 0, uiAmount: 0 } };
    },
  };
  const connect = (cluster: EventRpcCluster) => {
    calls.clusters.push(cluster);
    return conn as never;
  };
  return { conn, connect, calls };
}

describe('special-event RPC cluster selection', () => {
  it('production and UNSET resolve to mainnet; only staging reads SOLANA_RPC_URL', () => {
    expect(resolveEventRpcCluster('production')).toBe('mainnet');
    expect(resolveEventRpcCluster(undefined)).toBe('mainnet');
    expect(resolveEventRpcCluster('development')).toBe('mainnet');
    expect(resolveEventRpcCluster('Staging')).toBe('mainnet');
    expect(resolveEventRpcCluster('staging')).toBe('cluster-env');
  });

  it('a prod-env config never builds the devnet RPC, even with SOLANA_RPC_URL on devnet', () => {
    process.env.CLAWVILLE_ENV = 'production';
    process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
    _resetClvSwapCustodyCachesForTest();
    const h = host(createEventConnection(resolveEventRpcCluster()).rpcEndpoint);
    expect(h).not.toContain('devnet');
    expect(h).not.toContain('testnet');
    expect(['mainnet.helius-rpc.com', 'api.mainnet-beta.solana.com']).toContain(h);
  });

  it('staging keeps SOLANA_RPC_URL (devnet default when unset)', () => {
    process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
    expect(host(createEventConnection(resolveEventRpcCluster('staging')).rpcEndpoint)).toBe('api.devnet.solana.com');
    delete process.env.SOLANA_RPC_URL;
    expect(host(createEventConnection('cluster-env').rpcEndpoint)).toBe('api.devnet.solana.com');
  });

  it('the default seam resolves the cluster on first use, from CLAWVILLE_ENV at that time', async () => {
    const f = fakeConnection({ tx: parsedTransfer(TREASURY, 1_000_000) });
    process.env.CLAWVILLE_ENV = 'staging';
    const rpc = createDefaultEventRpc({ connect: f.connect });
    process.env.CLAWVILLE_ENV = 'production';
    await rpc.getSolTransfer('sig', TREASURY);
    expect(f.calls.clusters).toEqual(['mainnet']);
    expect(f.calls.genesis).toBe(1);
  });
});

describe('special-event mainnet proof fails closed', () => {
  it('a devnet genesis on the mainnet cluster refuses (503) and never reads the tx', async () => {
    const f = fakeConnection({ genesis: DEVNET_GENESIS, tx: parsedTransfer(TREASURY, 1_000_000) });
    const rpc = createDefaultEventRpc({ env: 'production', connect: f.connect });
    const err = await rpc.getSolTransfer('sig', TREASURY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecialEventError);
    expect((err as SpecialEventError).message).toBe('sol_network_unverified');
    expect((err as SpecialEventError).httpStatus).toBe(503);
    expect(f.calls.parsed).toBe(0);
    await expect(rpc.getTokenSupply(TREASURY)).rejects.toThrow('sol_network_unverified');
  });

  it('an unreachable RPC refuses, and the proof is retried (not cached) on the next call', async () => {
    const f = fakeConnection({ genesis: new Error('fetch failed'), tx: parsedTransfer(TREASURY, 1_000_000) });
    const rpc = createDefaultEventRpc({ env: undefined, connect: f.connect });
    await expect(rpc.getSolTransfer('sig', TREASURY)).rejects.toThrow('sol_network_unverified');
    expect(f.calls.genesis).toBe(1);
    // The RPC recovers: the next call re-proves and then reads the tx.
    (f.conn as { getGenesisHash: () => Promise<string> }).getGenesisHash = async () => {
      f.calls.genesis += 1;
      return MAINNET_GENESIS_HASH;
    };
    const proof = await rpc.getSolTransfer('sig', TREASURY);
    expect(f.calls.genesis).toBe(2);
    expect(proof?.lamportsToDest).toBe(1_000_000n);
  });

  it('a verified mainnet proof is cached (one genesis call for many reads)', async () => {
    const f = fakeConnection({ tx: parsedTransfer(TREASURY, 1_000_000) });
    const rpc = createDefaultEventRpc({ env: 'production', connect: f.connect });
    await rpc.getSolTransfer('a', TREASURY);
    await rpc.getSolTransfer('b', TREASURY);
    expect(f.calls.genesis).toBe(1);
    expect(f.calls.parsed).toBe(2);
  });

  it('staging skips the mainnet genesis proof (devnet is expected there)', async () => {
    const f = fakeConnection({ genesis: DEVNET_GENESIS, tx: parsedTransfer(TREASURY, 1_000_000) });
    const rpc = createDefaultEventRpc({ env: 'staging', connect: f.connect });
    const proof = await rpc.getSolTransfer('sig', TREASURY);
    expect(f.calls.genesis).toBe(0);
    expect(f.calls.clusters).toEqual(['cluster-env']);
    expect(proof?.lamportsToDest).toBe(1_000_000n);
  });
});

describe('special-event default seam checks recipient + amount', () => {
  it('credits only the expected recipient: a payment to another wallet proves 0 lamports', async () => {
    const f = fakeConnection({ tx: parsedTransfer(OTHER, 1_000_000) });
    const rpc = createDefaultEventRpc({ env: 'production', connect: f.connect });
    const proof = await rpc.getSolTransfer('sig', TREASURY);
    expect(proof?.success).toBe(true);
    expect(proof?.lamportsToDest).toBe(0n);
    expect(proof?.transfersBySource?.size).toBe(0);
  });

  it('reports the exact lamports and the payer for a transfer to the recipient', async () => {
    const f = fakeConnection({ tx: parsedTransfer(TREASURY, 750_000) });
    const rpc = createDefaultEventRpc({ env: 'production', connect: f.connect });
    const proof = await rpc.getSolTransfer('sig', TREASURY);
    expect(proof?.lamportsToDest).toBe(750_000n);
    expect([...(proof?.transfersBySource ?? [])]).toEqual([[PAYER, 750_000n]]);
  });

  it('passes the tx block time through (null when the RPC has none)', async () => {
    const withTime = fakeConnection({ tx: { ...parsedTransfer(TREASURY, 1_000_000), blockTime: 1_900_000_000 } });
    const a = await createDefaultEventRpc({ env: 'production', connect: withTime.connect }).getSolTransfer('s', TREASURY);
    expect(a?.blockTime).toBe(1_900_000_000);
    const noTime = fakeConnection({ tx: parsedTransfer(TREASURY, 1_000_000) });
    const b = await createDefaultEventRpc({ env: 'production', connect: noTime.connect }).getSolTransfer('s', TREASURY);
    expect(b?.blockTime).toBeNull();
  });

  it('an unknown signature returns null (no proof)', async () => {
    const f = fakeConnection({ tx: null });
    const rpc = createDefaultEventRpc({ env: 'production', connect: f.connect });
    expect(await rpc.getSolTransfer('sig', TREASURY)).toBeNull();
  });
});
