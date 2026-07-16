import { afterEach, describe, expect, test } from 'bun:test';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import {
  assertWagerBroadcastCluster,
  assertWagerLobbyIdInEnvNamespace,
  isDefinitelyUnsentWagerBroadcastError,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_TESTNET_GENESIS_HASH,
  decodeWagerLobbyAccount,
  decodeWagerPlayerAccount,
  wagerLobbyAccountMatches,
  wagerPlayerAccountMatches,
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

const LOBBY_DISCRIMINATOR = Buffer.from([167, 194, 217, 163, 92, 92, 103, 49]);
const PLAYER_DISCRIMINATOR = Buffer.from([205, 222, 112, 7, 165, 155, 206, 218]);

function lobbyAccountData(input: {
  lobbyId: bigint;
  creator: PublicKey;
  wager: bigint;
  maxPlayers: number;
  state: number;
}) {
  const data = Buffer.alloc(183);
  LOBBY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(input.lobbyId, 8);
  input.creator.toBuffer().copy(data, 16);
  data.writeBigUInt64LE(input.wager, 48);
  PublicKey.default.toBuffer().copy(data, 56);
  data[88] = input.maxPlayers;
  data[89] = 1;
  data[90] = input.state;
  return data;
}

function playerAccountData(input: {
  lobbyId: bigint;
  player: PublicKey;
  deposit: bigint;
  refunded?: boolean;
}) {
  const data = Buffer.alloc(58);
  PLAYER_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(input.lobbyId, 8);
  input.player.toBuffer().copy(data, 16);
  data.writeBigUInt64LE(input.deposit, 48);
  data[56] = input.refunded ? 1 : 0;
  return data;
}

describe('strict wager PDA reconciliation decoding', () => {
  const creator = Keypair.generate().publicKey;
  const player = Keypair.generate().publicKey;

  test('accepts a lobby account only when every committed field matches', () => {
    const account = decodeWagerLobbyAccount(lobbyAccountData({
      lobbyId: 42n,
      creator,
      wager: 50_000n,
      maxPlayers: 4,
      state: 0,
    }));
    expect(account).not.toBeNull();
    expect(wagerLobbyAccountMatches({
      account: account!,
      lobbyId: 42n,
      creator: creator.toBase58(),
      wagerAmountLamports: 50_000n,
      maxPlayers: 4,
      state: 0,
    })).toBe(true);
  });

  test.each([
    ['wrong lobby id', { lobbyId: 43n }],
    ['wrong creator', { creator: Keypair.generate().publicKey.toBase58() }],
    ['wrong wager', { wagerAmountLamports: 50_001n }],
    ['wrong max players', { maxPlayers: 5 }],
    ['wrong state', { state: 3 }],
  ])('rejects %s on a predictable lobby PDA', (_label, override) => {
    const account = decodeWagerLobbyAccount(lobbyAccountData({
      lobbyId: 42n,
      creator,
      wager: 50_000n,
      maxPlayers: 4,
      state: 0,
    }))!;
    expect(wagerLobbyAccountMatches({
      account,
      lobbyId: 42n,
      creator: creator.toBase58(),
      wagerAmountLamports: 50_000n,
      maxPlayers: 4,
      state: 0,
      ...override,
    })).toBe(false);
  });

  test('rejects a player PDA owned by the wrong avatar wallet', () => {
    const account = decodeWagerPlayerAccount(playerAccountData({
      lobbyId: 42n,
      player,
      deposit: 50_000n,
    }))!;
    expect(wagerPlayerAccountMatches({
      account,
      lobbyId: 42n,
      player: Keypair.generate().publicKey.toBase58(),
      depositAmountLamports: 50_000n,
    })).toBe(false);
  });

  test('rejects an already-refunded player account as a fresh join witness', () => {
    const account = decodeWagerPlayerAccount(playerAccountData({
      lobbyId: 42n,
      player,
      deposit: 50_000n,
      refunded: true,
    }))!;
    expect(wagerPlayerAccountMatches({
      account,
      lobbyId: 42n,
      player: player.toBase58(),
      depositAmountLamports: 50_000n,
    })).toBe(false);
  });
});


describe('assertWagerLobbyIdInEnvNamespace', () => {
  const SPAN = 1n << 32n;

  test('production accepts ids in [1, 2^32)', () => {
    expect(() => assertWagerLobbyIdInEnvNamespace(1n, { env: 'production' })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(170n, { env: 'production' })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(SPAN - 1n, { env: 'production' })).not.toThrow();
  });

  test('production rejects 0 and ids at/above 2^32', () => {
    expect(() => assertWagerLobbyIdInEnvNamespace(0n, { env: 'production' })).toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(SPAN, { env: 'production' }))
      .toThrow(/outside the 'production' namespace/);
  });

  test('staging accepts [2^32, 2*2^32) and rejects prod-range ids', () => {
    expect(() => assertWagerLobbyIdInEnvNamespace(SPAN, { env: 'staging' })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(2n * SPAN - 1n, { env: 'staging' })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(5n, { env: 'staging' }))
      .toThrow(/outside the 'staging' namespace/);
    expect(() => assertWagerLobbyIdInEnvNamespace(2n * SPAN, { env: 'staging' })).toThrow();
  });

  test('dev/unset env gets the third range', () => {
    expect(() => assertWagerLobbyIdInEnvNamespace(2n * SPAN, { env: undefined })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(3n * SPAN - 1n, { env: undefined })).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(170n, { env: undefined }))
      .toThrow(/outside the 'development' namespace/);
    expect(() => assertWagerLobbyIdInEnvNamespace(3n * SPAN, { env: undefined })).toThrow();
  });

  test('localnet is exempt regardless of env or id', () => {
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(5n, { env: 'production', cluster: 'localnet' }),
    ).not.toThrow();
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(999n * SPAN, { env: 'staging', cluster: 'localnet' }),
    ).not.toThrow();
  });

  test('rejection carries network_refused code and the setval repair command', () => {
    try {
      assertWagerLobbyIdInEnvNamespace(5n, { env: 'staging' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'network_refused' });
      expect((err as Error).message).toContain(
        "SELECT setval('wager_lobby_id_seq', 4294967296, false);",
      );
    }
  });

  test('falls back to process.env when no overrides are injected', () => {
    process.env.CLAWVILLE_ENV = 'staging';
    delete process.env.WAGER_PROGRAM_CLUSTER;
    expect(() => assertWagerLobbyIdInEnvNamespace(SPAN)).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(5n)).toThrow();
  });
});
