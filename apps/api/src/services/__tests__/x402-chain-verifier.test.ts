import { describe, expect, it } from 'bun:test';
import { Keypair } from '@solana/web3.js';

const {
  deriveUsdcAta,
  probeUsdcTransfers,
  resolveReconcileNetwork,
  verifyUsdcTransfer,
} = await import('../x402-chain-verifier');
import type { ReconcileChainDeps } from '../x402-chain-verifier';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OTHER_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 1)).publicKey.toBase58();
const OTHER_OWNER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 2)).publicKey.toBase58();
const PAYER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 3)).publicKey.toBase58();
const OTHER_PAYER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 4)).publicKey.toBase58();
const SOURCE_ATA = deriveUsdcAta(PAYER, MINT);
const DEST_ATA = deriveUsdcAta(OWNER, MINT);
const SINCE_ISO = '2026-07-13T00:00:00.000Z';
const BLOCK_TIME = Math.floor(new Date('2026-07-13T01:00:00.000Z').getTime() / 1_000);

function transferChecked(overrides: {
  amount?: string;
  mint?: string;
  destination?: string;
  payer?: string;
} = {}) {
  return {
    program: 'spl-token',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    parsed: {
      type: 'transferChecked',
      info: {
        source: SOURCE_ATA,
        destination: overrides.destination ?? DEST_ATA,
        authority: overrides.payer ?? PAYER,
        mint: overrides.mint ?? MINT,
        tokenAmount: {
          amount: overrides.amount ?? '1000000',
          decimals: 6,
          uiAmount: 1,
          uiAmountString: '1',
        },
      },
    },
  };
}

function transaction(options: {
  instructions?: unknown[];
  innerInstructions?: unknown[];
  err?: unknown;
  blockTime?: number | null;
} = {}) {
  return {
    blockTime: options.blockTime === undefined ? BLOCK_TIME : options.blockTime,
    meta: {
      err: options.err ?? null,
      innerInstructions: options.innerInstructions
        ? [{ index: 0, instructions: options.innerInstructions }]
        : [],
      fee: 5_000,
    },
    transaction: {
      message: {
        instructions: options.instructions ?? [],
        accountKeys: [],
      },
      signatures: ['ignored'],
    },
  };
}

function verifierDeps(rows: Record<string, unknown | null>) {
  return {
    async getParsedTransaction(_network: 'devnet' | 'mainnet', signature: string) {
      return rows[signature] ?? null;
    },
  };
}

const verifyInput = (signature: string, overrides: Record<string, unknown> = {}) => ({
  network: 'devnet' as const,
  signature,
  expectedAtomic: '1000000',
  expectedMint: MINT,
  destinationOwner: OWNER,
  expectedPayer: PAYER,
  ...overrides,
});

describe('x402 Solana chain verifier', () => {
  it('resolves friendly and CAIP-2 network ids and refuses unknown networks', () => {
    expect(resolveReconcileNetwork('devnet')).toBe('devnet');
    expect(resolveReconcileNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe('devnet');
    expect(resolveReconcileNetwork('mainnet')).toBe('mainnet');
    expect(resolveReconcileNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('mainnet');
    expect(resolveReconcileNetwork('solana:unknown')).toBeNull();
    expect(resolveReconcileNetwork(undefined)).toBeNull();
  });

  it('confirms one exact transferChecked and reports its payer + block time', async () => {
    const verdict = await verifyUsdcTransfer(
      verifyInput('match'),
      verifierDeps({ match: transaction({ instructions: [transferChecked()] }) }),
    );
    expect(verdict).toEqual({
      kind: 'confirmed_match',
      transfer: {
        signature: 'match',
        atomicAmount: '1000000',
        mint: MINT,
        destinationAta: DEST_ATA,
        sourceAta: SOURCE_ATA,
        payer: PAYER,
        blockTime: BLOCK_TIME,
      },
    });
  });

  it('finds a transferChecked in inner instructions', async () => {
    const verdict = await verifyUsdcTransfer(
      verifyInput('inner'),
      verifierDeps({ inner: transaction({ innerInstructions: [transferChecked()] }) }),
    );
    expect(verdict.kind).toBe('confirmed_match');
  });

  for (const [label, instruction, reason] of [
    ['amount', transferChecked({ amount: '999999' }), 'wrong_amount'],
    ['mint', transferChecked({ mint: OTHER_MINT }), 'wrong_mint'],
    ['destination', transferChecked({ destination: deriveUsdcAta(OTHER_OWNER, MINT) }), 'wrong_destination'],
    ['payer', transferChecked({ payer: OTHER_PAYER }), 'wrong_payer'],
  ] as const) {
    it(`rejects a confirmed transfer with the wrong ${label}`, async () => {
      const verdict = await verifyUsdcTransfer(
        verifyInput(`wrong-${label}`),
        verifierDeps({ [`wrong-${label}`]: transaction({ instructions: [instruction] }) }),
      );
      expect(verdict).toMatchObject({ kind: 'confirmed_mismatch', reason });
    });
  }

  it('rejects N plus an extra inbound amount from the same payer', async () => {
    const verdict = await verifyUsdcTransfer(
      verifyInput('overpaid'),
      verifierDeps({
        overpaid: transaction({
          instructions: [transferChecked(), transferChecked({ amount: '1' })],
        }),
      }),
    );
    expect(verdict).toMatchObject({ kind: 'confirmed_mismatch', reason: 'wrong_amount' });
  });

  it('allows unrelated destination/payer transfers while binding the expected payer total', async () => {
    const verdict = await verifyUsdcTransfer(
      verifyInput('unrelated'),
      verifierDeps({
        unrelated: transaction({ instructions: [
          transferChecked(),
          transferChecked({ payer: OTHER_PAYER, amount: '50' }),
          transferChecked({ destination: deriveUsdcAta(OTHER_OWNER, MINT), amount: '75' }),
        ] }),
      }),
    );
    expect(verdict.kind).toBe('confirmed_match');
  });

  it('refuses two payer groups that each exactly match when no payer was expected', async () => {
    const verdict = await verifyUsdcTransfer(
      verifyInput('two-payers', { expectedPayer: null }),
      verifierDeps({
        'two-payers': transaction({
          instructions: [transferChecked(), transferChecked({ payer: OTHER_PAYER })],
        }),
      }),
    );
    expect(verdict).toMatchObject({ kind: 'confirmed_mismatch', reason: 'multiple_exact_matches' });
  });

  it('distinguishes a failed transaction from a missing transaction', async () => {
    const deps = verifierDeps({ failed: transaction({ err: { InstructionError: [0, 'Custom'] } }) });
    expect(await verifyUsdcTransfer(verifyInput('failed'), deps)).toEqual({
      kind: 'tx_failed', signature: 'failed', blockTime: BLOCK_TIME,
    });
    expect(await verifyUsdcTransfer(verifyInput('missing'), deps)).toEqual({
      kind: 'not_found', signature: 'missing',
    });
  });

  it('throws on malformed successful RPC data instead of calling it no-money', async () => {
    await expect(verifyUsdcTransfer(
      verifyInput('malformed'),
      verifierDeps({ malformed: { blockTime: BLOCK_TIME, meta: { err: null } } }),
    )).rejects.toThrow();
  });
});

function probeDeps(options: {
  pages: Array<Array<{ signature: string; blockTime: number | null; err: unknown }>>;
  transactions: Record<string, unknown | null>;
  bound?: Set<string>;
}) {
  let page = 0;
  const parsedCalls: string[] = [];
  const signatureCalls: Array<{ address: string; before?: string; limit: number }> = [];
  const deps: ReconcileChainDeps = {
    async getParsedTransaction(_network, signature) {
      parsedCalls.push(signature);
      return options.transactions[signature] ?? null;
    },
    async getSignaturesForAddress(_network, address, request) {
      signatureCalls.push({ address, ...request });
      return options.pages[page++] ?? [];
    },
    async isSignatureBound(signature) {
      return options.bound?.has(signature) ?? false;
    },
  };
  return { deps, parsedCalls, signatureCalls };
}

const sig = (signature: string, blockTime = BLOCK_TIME, err: unknown = null) => ({
  signature,
  blockTime,
  err,
});

const probeInput = (overrides: Partial<Parameters<typeof probeUsdcTransfers>[0]> = {}) => ({
  network: 'devnet' as const,
  expectedAtomic: '1000000',
  expectedMint: MINT,
  destinationOwner: OWNER,
  expectedPayer: PAYER,
  sinceIso: SINCE_ISO,
  maxSignatures: 100,
  ...overrides,
});

describe('x402 merchant/recipient ATA probe', () => {
  it('returns one exact unbound match and scans the derived destination ATA', async () => {
    const h = probeDeps({
      pages: [[sig('match')]],
      transactions: { match: transaction({ instructions: [transferChecked()] }) },
    });
    const result = await probeUsdcTransfers(probeInput(), h.deps);
    expect(result).toMatchObject({ kind: 'match', match: { signature: 'match', payer: PAYER } });
    expect(h.signatureCalls).toEqual([{ address: DEST_ATA, limit: 100 }]);
  });

  it('returns ambiguous when two eligible inbound payments match', async () => {
    const h = probeDeps({
      pages: [[sig('one'), sig('two')]],
      transactions: {
        one: transaction({ instructions: [transferChecked()] }),
        two: transaction({ instructions: [transferChecked()] }),
      },
    });
    const result = await probeUsdcTransfers(probeInput(), h.deps);
    expect(result).toMatchObject({ kind: 'ambiguous', examined: 2 });
    if (result.kind === 'ambiguous') {
      expect(result.matches.map((m) => m.signature)).toEqual(['one', 'two']);
    }
  });

  it('excludes signatures already bound across all three payment tables', async () => {
    const bound = new Set(['checkout-bound', 'topup-bound', 'agent-bound']);
    const h = probeDeps({
      pages: [[
        sig('checkout-bound'), sig('topup-bound'), sig('agent-bound'), sig('available'),
      ]],
      transactions: { available: transaction({ instructions: [transferChecked()] }) },
      bound,
    });
    const result = await probeUsdcTransfers(probeInput(), h.deps);
    expect(result).toMatchObject({ kind: 'match', excludedBound: 3, examined: 4 });
    expect(h.parsedCalls).toEqual(['available']);
  });

  it('returns indeterminate when the hard cap is exhausted before the since boundary', async () => {
    const h = probeDeps({
      pages: [[sig('wrong-1'), sig('wrong-2'), sig('would-match')]],
      transactions: {
        'wrong-1': transaction({ instructions: [transferChecked({ amount: '1' })] }),
        'wrong-2': transaction({ instructions: [transferChecked({ amount: '2' })] }),
        'would-match': transaction({ instructions: [transferChecked()] }),
      },
    });
    const result = await probeUsdcTransfers(probeInput({ maxSignatures: 2 }), h.deps);
    expect(result).toMatchObject({
      kind: 'indeterminate', reason: 'lookback_cap_exhausted', examined: 2,
    });
    expect(h.parsedCalls).toEqual(['wrong-1', 'wrong-2']);
    expect(h.signatureCalls[0]?.limit).toBe(2);
  });

  it('stops at the since boundary and ignores older signatures', async () => {
    const old = Math.floor(new Date('2026-07-12T23:59:00.000Z').getTime() / 1_000);
    const h = probeDeps({
      pages: [[sig('new-wrong'), sig('old-match', old)]],
      transactions: {
        'new-wrong': transaction({ instructions: [transferChecked({ amount: '1' })] }),
        'old-match': transaction({ instructions: [transferChecked()], blockTime: old }),
      },
    });
    const result = await probeUsdcTransfers(probeInput(), h.deps);
    expect(result).toMatchObject({ kind: 'none', examined: 2 });
    expect(h.parsedCalls).toEqual(['new-wrong']);
  });

  it('returns indeterminate when an ATA candidate cannot be fetched', async () => {
    const h = probeDeps({ pages: [[sig('rpc-missing')]], transactions: {} });
    const result = await probeUsdcTransfers(probeInput(), h.deps);
    expect(result).toMatchObject({
      kind: 'indeterminate',
      reason: 'candidate_transaction_not_found',
    });
  });
});
