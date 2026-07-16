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
  resolveVerifiedWagerBroadcastCluster,
  WagerClientError,
  deriveCreateSolLobbyIntentPda,
} from '../wager-program-client';
import {
  canRemintWagerCreateDraft,
  handleWagerClientError,
  prepareCreateDraft,
} from '../../routes/wager';

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

  test('returns devnet proof despite a localnet config label and enforces namespace', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    const verified = await resolveVerifiedWagerBroadcastCluster('test', {
      connection: fakeConnection(
        SOLANA_DEVNET_GENESIS_HASH,
        'https://api.devnet.solana.com',
      ),
    });
    expect(verified.kind).toBe('devnet');
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(5n, {
        env: 'staging',
        verifiedCluster: verified,
      }),
    ).toThrow(/outside the 'staging' namespace/);
  });

  test('returns a true-local proof only after the loopback triple gate', async () => {
    process.env.WAGER_PROGRAM_CLUSTER = 'localnet';
    process.env.NODE_ENV = 'test';
    delete process.env.CLAWVILLE_ENV;
    const verified = await resolveVerifiedWagerBroadcastCluster('test', {
      connection: fakeConnection('local-validator-genesis', 'http://127.0.0.1:8899'),
    });
    expect(verified.kind).toBe('localnet');
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(5n, {
        env: 'development',
        verifiedCluster: verified,
      }),
    ).not.toThrow();
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

  test('dev/unset env gets the third range hermetically', () => {
    const saved = process.env.CLAWVILLE_ENV;
    delete process.env.CLAWVILLE_ENV;
    try {
      expect(() => assertWagerLobbyIdInEnvNamespace(2n * SPAN)).not.toThrow();
      expect(() => assertWagerLobbyIdInEnvNamespace(3n * SPAN - 1n)).not.toThrow();
      expect(() => assertWagerLobbyIdInEnvNamespace(170n))
        .toThrow(/outside the 'development' namespace/);
      expect(() => assertWagerLobbyIdInEnvNamespace(3n * SPAN)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.CLAWVILLE_ENV;
      else process.env.CLAWVILLE_ENV = saved;
    }
  });

  test('only verified unknown/local genesis is exempt', () => {
    const local = { genesisHash: 'local-validator-genesis', kind: 'localnet' as const };
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(5n, { env: 'production', verifiedCluster: local }),
    ).not.toThrow();
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(999n * SPAN, { env: 'staging', verifiedCluster: local }),
    ).not.toThrow();
    expect(() =>
      assertWagerLobbyIdInEnvNamespace(5n, {
        env: 'staging',
        verifiedCluster: {
          genesisHash: SOLANA_DEVNET_GENESIS_HASH,
          kind: 'localnet',
        },
      }),
    ).toThrow(/outside the 'staging' namespace/);
  });

  test('rejection carries namespace_violation code and the setval repair command', () => {
    try {
      assertWagerLobbyIdInEnvNamespace(5n, { env: 'staging' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'namespace_violation' });
      expect((err as Error).message).toContain(
        "SELECT setval('wager_lobby_id_seq', 4294967296, false);",
      );
    }
  });

  test.each(['Production', 'prod', 'STAGING'])('%s fails closed without a setval hint', (env) => {
    try {
      assertWagerLobbyIdInEnvNamespace(2n * SPAN, { env });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({
        code: 'namespace_violation',
        namespaceReason: 'invalid_env',
      });
      expect((err as Error).message).toContain(env);
      expect((err as Error).message).toContain(
        "'production', 'staging', 'development'",
      );
      expect((err as Error).message).not.toContain('setval');
    }
  });

  test('falls back to process.env when no overrides are injected', () => {
    process.env.CLAWVILLE_ENV = 'staging';
    delete process.env.WAGER_PROGRAM_CLUSTER;
    expect(() => assertWagerLobbyIdInEnvNamespace(SPAN)).not.toThrow();
    expect(() => assertWagerLobbyIdInEnvNamespace(5n)).toThrow();
  });
});

describe('namespace violation route contract and draft repair', () => {
  const SPAN = 1n << 32n;
  const devnet = { genesisHash: SOLANA_DEVNET_GENESIS_HASH, kind: 'devnet' as const };
  const baseDraft = {
    id: '00000000-0000-4000-8000-000000000001',
    lobbyId: 5n,
    activityId: 'reef-race',
    roomId: 'room-1',
    creatorUserId: '00000000-0000-4000-8000-000000000002',
    creatorAvatarId: '00000000-0000-4000-8000-000000000003',
    wagerAmountLamports: 10n,
    wagerMint: null,
    maxPlayers: 4,
    joinedCount: 1,
    state: 'open',
    visibility: 'public',
    inviteCode: null,
    mode: 'multiplayer',
    settledWinnerUserId: null,
    settledWinnerAvatarId: null,
    createdAt: new Date(0),
    lockedAt: null,
    settledAt: null,
    cancelledAt: null,
    onChainCreateStatus: 'prepared',
    onChainCreateSig: null,
    onChainLockSig: null,
    onChainSettleSig: null,
    onChainCancelSig: null,
  } as const;
  const operationKey = 'create:test';
  const prepareInput = {
    operationKey,
    activityId: baseDraft.activityId,
    roomId: baseDraft.roomId,
    userId: baseDraft.creatorUserId,
    avatarId: baseDraft.creatorAvatarId,
    wagerAmountLamports: baseDraft.wagerAmountLamports,
    maxPlayers: baseDraft.maxPlayers,
    visibility: baseDraft.visibility,
    inviteCode: null,
    resolveVerifiedCluster: async () => devnet,
  };

  function directMutex<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  test('maps namespace_violation to a terminal server-configuration 500', () => {
    try {
      handleWagerClientError(
        new WagerClientError(
          'bad namespace',
          'namespace_violation',
          undefined,
          'id_out_of_range',
        ),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ status: 500 });
      expect((err as { message: string }).message).toContain(
        'wager_namespace_configuration_fault: bad namespace',
      );
    }
  });

  test('allocation refuses an out-of-range sequence value before insert', async () => {
    process.env.CLAWVILLE_ENV = 'production';
    const order: string[] = [];
    let executeCount = 0;
    let insertCount = 0;
    const tx = {
      execute: async () => {
        executeCount++;
        return executeCount === 2 ? [{ lobby_id: SPAN.toString() }] : [];
      },
      query: { lobbies: { findFirst: async () => undefined } },
      insert: () => {
        insertCount++;
        throw new Error('insert must not run');
      },
    };
    await expect(
      prepareCreateDraft({
        ...prepareInput,
        resolveVerifiedCluster: async () => {
          order.push('genesis');
          return devnet;
        },
      }, {
        withMutex: directMutex as any,
        findDraft: async () => {
          order.push('preliminary-read');
          return undefined;
        },
        transaction: (async (fn: any) => {
          order.push('transaction');
          return fn(tx);
        }) as any,
      }),
    ).rejects.toMatchObject({
      code: 'namespace_violation',
      namespaceReason: 'id_out_of_range',
    });
    expect(insertCount).toBe(0);
    expect(order).toEqual(['preliminary-read', 'genesis', 'transaction']);
  });

  test.each([
    ['owner mismatch', { creatorAvatarId: '00000000-0000-4000-8000-000000000099' }],
    ['confirmed replay', { onChainCreateStatus: 'confirmed' }],
    ['terminal replay', { state: 'cancelled' }],
  ])('%s stays DB-only and skips genesis/transaction', async (_label, changes) => {
    let genesisCalls = 0;
    let transactionCalls = 0;
    const draft = { ...baseDraft, ...changes } as any;
    const result = await prepareCreateDraft({
      ...prepareInput,
      resolveVerifiedCluster: async () => {
        genesisCalls++;
        return devnet;
      },
    }, {
      withMutex: directMutex as any,
      findDraft: async () => draft,
      transaction: (async () => {
        transactionCalls++;
        throw new Error('transaction must not run');
      }) as any,
    });
    expect(result.draft).toBe(draft);
    expect(genesisCalls).toBe(0);
    expect(transactionCalls).toBe(0);
  });

  test('self-heals an unsigned stranded draft and updates its intent target', async () => {
    process.env.CLAWVILLE_ENV = 'staging';
    const intent = {
      id: '00000000-0000-4000-8000-000000000004',
      operationKey,
      operation: 'create',
      lobbyId: baseDraft.id,
      actorAvatarId: baseDraft.creatorAvatarId,
      status: 'prepared',
      targetPda: deriveCreateSolLobbyIntentPda(baseDraft.lobbyId).toBase58(),
      txSignature: null,
    };
    let executeCount = 0;
    let lobbyReads = 0;
    const updates: Record<string, unknown>[] = [];
    const tx = {
      execute: async () => {
        executeCount++;
        return executeCount === 3 ? [{ lobby_id: SPAN.toString() }] : [];
      },
      query: {
        lobbies: { findFirst: async () => (++lobbyReads <= 2 ? baseDraft : undefined) },
        wagerChainIntents: { findFirst: async () => intent },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updates.push(values);
              return values.targetPda
                ? [{ ...intent, ...values }]
                : [{ ...baseDraft, ...values }];
            },
          }),
        }),
      }),
    };
    const result = await prepareCreateDraft(prepareInput, {
      withMutex: directMutex as any,
      findDraft: async () => baseDraft as any,
      transaction: (async (fn: any) => fn(tx)) as any,
    });
    expect(executeCount).toBe(3);
    expect(result.draft.lobbyId).toBe(SPAN);
    expect(updates[0]).toMatchObject({ status: 'failed', lastError: 'namespace_reminted' });
    expect(updates[0]?.targetPda).not.toBe(intent.targetPda);
    expect(updates[1]).toMatchObject({ lobbyId: SPAN, onChainCreateStatus: 'failed' });
  });

  test('refuses to remint when the intent has broadcast evidence', async () => {
    process.env.CLAWVILLE_ENV = 'staging';
    const signedIntent = {
      id: '00000000-0000-4000-8000-000000000004',
      operationKey,
      operation: 'create',
      lobbyId: baseDraft.id,
      actorAvatarId: baseDraft.creatorAvatarId,
      status: 'sending',
      targetPda: deriveCreateSolLobbyIntentPda(baseDraft.lobbyId).toBase58(),
      txSignature: 'chain-signature',
    };
    let executeCount = 0;
    let updateCount = 0;
    const tx = {
      execute: async () => {
        executeCount++;
        return [];
      },
      query: {
        lobbies: { findFirst: async () => baseDraft },
        wagerChainIntents: { findFirst: async () => signedIntent },
      },
      update: () => {
        updateCount++;
        throw new Error('update must not run');
      },
    };
    await expect(
      prepareCreateDraft(prepareInput, {
        withMutex: directMutex as any,
        findDraft: async () => baseDraft as any,
        transaction: (async (fn: any) => fn(tx)) as any,
      }),
    ).rejects.toMatchObject({ code: 'namespace_violation' });
    expect(executeCount).toBe(2);
    expect(updateCount).toBe(0);
  });
});
