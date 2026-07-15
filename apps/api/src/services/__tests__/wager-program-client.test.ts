import { afterEach, describe, expect, test } from 'bun:test';
import type { Connection } from '@solana/web3.js';
import {
  assertWagerBroadcastCluster,
  isDefinitelyUnsentWagerBroadcastError,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_TESTNET_GENESIS_HASH,
} from '../wager-program-client';

const originalCluster = process.env.WAGER_PROGRAM_CLUSTER;
const originalNodeEnv = process.env.NODE_ENV;
const originalClawvilleEnv = process.env.CLAWVILLE_ENV;

afterEach(() => {
  if (originalCluster === undefined) delete process.env.WAGER_PROGRAM_CLUSTER;
  else process.env.WAGER_PROGRAM_CLUSTER = originalCluster;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalClawvilleEnv === undefined) delete process.env.CLAWVILLE_ENV;
  else process.env.CLAWVILLE_ENV = originalClawvilleEnv;
});

function fakeConnection(genesis: string, rpcEndpoint: string) {
  return {
    rpcEndpoint,
    getGenesisHash: async () => genesis,
  } as Pick<Connection, 'getGenesisHash' | 'rpcEndpoint'>;
}

describe('assertWagerBroadcastCluster', () => {
  test('accepts the exact full devnet genesis hash', async () => {
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection(SOLANA_DEVNET_GENESIS_HASH, 'https://api.devnet.solana.com'),
        'test',
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects the truncated CAIP-2 devnet prefix', async () => {
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection('EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'https://api.devnet.solana.com'),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'network_refused' });
  });

  test('allows unknown local-validator genesis only behind non-prod loopback triple gate', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'test';
    delete process.env.CLAWVILLE_ENV;
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection('local-validator-genesis', 'http://127.0.0.1:8899'),
        'test',
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects mainnet even when proxied through localnet loopback', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'test';
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection(SOLANA_MAINNET_GENESIS_HASH, 'http://localhost:8899'),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'network_refused' });
  });

  test('rejects an unknown remote cluster despite localnet env', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'test';
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection('unknown-remote-genesis', 'https://rpc.example.com'),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'network_refused' });
  });

  test('rejects official testnet even through a local loopback proxy', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'test';
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection(SOLANA_TESTNET_GENESIS_HASH, 'http://127.0.0.1:8899'),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'network_refused' });
  });

  test('rejects localnet in production', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'production';
    await expect(
      assertWagerBroadcastCluster(
        fakeConnection('local-validator-genesis', 'http://127.0.0.1:8899'),
        'test',
      ),
    ).rejects.toMatchObject({ code: 'network_refused' });
  });

  test('fails closed when the genesis probe throws', async () => {
    const conn = {
      rpcEndpoint: 'https://api.devnet.solana.com',
      getGenesisHash: async () => {
        throw new Error('rpc unavailable');
      },
    } as Pick<Connection, 'getGenesisHash' | 'rpcEndpoint'>;
    await expect(assertWagerBroadcastCluster(conn, 'test')).rejects.toMatchObject({
      code: 'network_refused',
    });
  });
});

describe('isDefinitelyUnsentWagerBroadcastError', () => {
  test('classifies web3 preflight simulation rejection as definitely unsent', () => {
    expect(
      isDefinitelyUnsentWagerBroadcastError(
        Object.assign(new Error('Transaction simulation failed: custom program error'), {
          name: 'SendTransactionError',
        }),
      ),
    ).toBe(true);
  });

  test('keeps transport timeout ambiguous because the node may have accepted bytes', () => {
    expect(
      isDefinitelyUnsentWagerBroadcastError(new Error('fetch failed: request timed out')),
    ).toBe(false);
  });
});
