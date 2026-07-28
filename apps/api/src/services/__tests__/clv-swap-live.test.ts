/**
 * CLV SWAP LIVE PATH — unit tests (Tokenomics GoLive executors, 2026-07-07).
 *
 * The live path is default-OFF; these tests prove its money discipline
 * WITHOUT chain or Postgres (all I/O through the injectable ClvSwapLiveDeps):
 *
 *   1. GATES: every live entrypoint refuses when CLV_SWAP_EXECUTE != 'true';
 *      the network guard refuses devnet USDC and the mock facilitator.
 *   2. FUNDING SWEEP: exactly-once (double-sweep replays, in-flight refuses,
 *      terminal never retries); amounts tied to SETTLED MAINNET checkouts
 *      only; ATOMIC CLAIM before custody; CAPTURE-BEFORE-SEND ordering;
 *      insufficient merchant USDC releases the claim pre-send; an ambiguous
 *      send goes to 'reconcile' with the signature durable and is NEVER
 *      retried; a definitive on-chain failure goes to 'failed'.
 *   3. EXECUTION: funding-swept precondition; ATOMIC CLAIM before decrypt
 *      (double-claim + restart-mid-tick refuse without touching custody);
 *      PER-CLIP oracle re-fetch (a depth change resizes the NEXT clip);
 *      oracle-unavailable HARD-STOP (zero Jupiter calls); quoted output must
 *      clear the independent ORACLE-tolerance floor while Jupiter slippage
 *      remains the on-chain threshold; zero-clip pre-sign stops release the
 *      claim, but post-sign/partial states stay executing; the swap tx payer
 *      must be OUR wallet; capture-before-send per clip; conservation
 *      (Σ clips == queued amount, BigInt-exact).
 *
 * Env preamble mirrors x402-checkout.test.ts (the module pulls
 * routes/ct-topup for resolveTopupNetwork). No @clawville/database mock is
 * needed — every DB touch goes through the injected fake db api.
 */

// Crash-loud module-load env BEFORE imports (the ct-topup import graph).
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
delete process.env.X402_ENABLED;
delete process.env.X402_MOCK_FACILITATOR;
delete process.env.X402_FACILITATOR_PRESET;
delete process.env.X402_TOPUP_NETWORK;
delete process.env.CLV_SWAP_EXECUTE; // the module-load gate on the import graph

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { USDC_MINT_MAINNET, SOLANA_MAINNET_CAIP2 } from '../x402-payai';
import { CLV_MINT, type ClvPriceQuote } from '../clv-price-oracle';
// Type-only (erased at runtime — the runtime import below controls load order).
import type { ClvSwapLiveDb, ClvSwapLiveDeps } from '../clv-swap-live';

const {
  claimAndSweepFundingForQueueRow,
  executeQueuedClvBuy,
  runLiveClvSwapTick,
  startClvSwapLiveWorker,
  stopClvSwapLiveWorker,
  requireLiveClvSwapExecution,
  assertMainnetRealMoneyContext,
  sizeClipMicro,
  parseJupiterPriceImpactPct,
  jupiterImpactWithinBps,
  shrinkClipMicroForImpact,
  resolveClvSwapImpactProbeMicro,
  oracleMinOutClvAtomic,
  resolveClvSwapOracleToleranceBps,
  resolveJupiterBaseUrl,
  resolveClvSwapExecutingStaleMs,
  findUsdcAta,
  findClvAta,
  jupiterExactInMinimumOut,
} = await import('../clv-swap-live');

if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const swapKp = Keypair.generate();
const merchantKp = Keypair.generate();
const strangerKp = Keypair.generate();
const SRC = '11111111-1111-4111-8111-111111111111'; // the settled checkout id
const PRICE = 0.00007;

function quoteOf(
  depth: number | null,
  opts: { available?: boolean; quoteUsd?: number | null } = {},
): ClvPriceQuote {
  const available = opts.available ?? true;
  const quoteUsd = opts.quoteUsd === undefined ? (available ? PRICE : null) : opts.quoteUsd;
  return {
    spotUsd: quoteUsd,
    twap30mUsd: quoteUsd,
    quoteUsd,
    asOf: new Date().toISOString(),
    source: 'dexscreener',
    stale: false,
    available,
    poolLiquidityUsd: depth,
    liquidityAsOf: depth === null ? null : new Date().toISOString(),
  };
}

function buildSwapTxB64(
  payer: PublicKey,
  amount = '1000000',
  outAmount = '1000000',
  slippageBps = 100,
  opts: {
    arbitraryProgram?: boolean;
    extraSigner?: boolean;
    includeAtaSetup?: boolean;
    duplicateAtaSetup?: boolean;
    realisticRoute?: boolean;
    maliciousWalletTokenAccount?: PublicKey;
  } = {},
): { transaction: string; lookupTables: AddressLookupTableAccount[] } {
  const jupiter = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const eventAuthority = new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');
  const [programAuthority] = PublicKey.findProgramAddressSync([Buffer.from('authority')], jupiter);
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(1);
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(BigInt(amount), 0);
  tail.writeBigUInt64LE(BigInt(outAmount), 8);
  tail.writeUInt16LE(slippageBps, 16);
  const data = Buffer.concat([
    Buffer.from(opts.realisticRoute
      ? [229, 23, 203, 151, 122, 227, 173, 42]
      : [193, 32, 155, 51, 65, 214, 156, 129]),
    ...(opts.realisticRoute ? [] : [Buffer.from([0])]),
    u32,
    Buffer.from([7, 100, 0, 1]), // Raydium route step
    tail,
  ]);
  const realisticRouteAccount = Keypair.generate().publicKey;
  const ix = new TransactionInstruction({
    programId: jupiter,
    keys: opts.realisticRoute ? [
      { pubkey: token2022, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: findUsdcAta(payer), isSigner: false, isWritable: true },
      { pubkey: findClvAta(payer), isSigner: false, isWritable: true },
      { pubkey: findClvAta(payer), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(CLV_MINT), isSigner: false, isWritable: false },
      { pubkey: jupiter, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: jupiter, isSigner: false, isWritable: false },
      // Current Jupiter V1 routes legitimately repeat these in remaining metas.
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: findClvAta(payer), isSigner: false, isWritable: true },
      { pubkey: realisticRouteAccount, isSigner: false, isWritable: true },
      ...(opts.maliciousWalletTokenAccount
        ? [{ pubkey: opts.maliciousWalletTokenAccount, isSigner: false, isWritable: true }]
        : []),
    ] : [
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: findUsdcAta(payer), isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: findClvAta(payer), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(USDC_MINT_MAINNET), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CLV_MINT), isSigner: false, isWritable: false },
      { pubkey: jupiter, isSigner: false, isWritable: false },
      { pubkey: token2022, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: jupiter, isSigner: false, isWritable: false },
      ...(opts.extraSigner
        ? [{ pubkey: strangerKp.publicKey, isSigner: true, isWritable: false }]
        : []),
    ],
    data,
  });
  const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ataSetup = new TransactionInstruction({
    programId: ataProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: findClvAta(payer), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CLV_MINT), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: token2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const instructions = [
    ...(opts.realisticRoute
      ? [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ]
      : []),
    ...(opts.includeAtaSetup ? [ataSetup] : []),
    ...(opts.duplicateAtaSetup ? [ataSetup, ataSetup] : []),
    ...(opts.arbitraryProgram
      ? [SystemProgram.transfer({ fromPubkey: payer, toPubkey: strangerKp.publicKey, lamports: 1 })]
      : []),
    ix,
  ];
  const lookupTables = opts.realisticRoute
    ? [new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: 0xffff_ffff_ffff_ffffn,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: [realisticRouteAccount, ...(opts.maliciousWalletTokenAccount
            ? [opts.maliciousWalletTokenAccount]
            : [])],
        },
      })]
    : [];
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)),
    instructions,
  }).compileToV0Message(lookupTables);
  return {
    transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'),
    lookupTables,
  };
}

// ── the injectable harness ───────────────────────────────────────────────────
interface Harness {
  deps: ClvSwapLiveDeps;
  log: string[];
  queue: Map<string, Record<string, unknown>>;
  funding: Map<string, Record<string, unknown>>; // keyed by sourceRef
  quoteRequests: Array<{ amount: string; slippageBps: string }>;
  swapRequests: Array<Record<string, unknown>>;
  sentRaw: Uint8Array[];
  lookupRequests: PublicKey[];
  sleeps: number[];
  alerts: Array<Record<string, unknown>>;
}

function makeHarness(opts: {
  queueRows?: Array<Record<string, unknown>>;
  fundingRows?: Array<Record<string, unknown>>;
  checkouts?: Array<Record<string, unknown>>;
  prices?: ClvPriceQuote[];
  quoteAmounts?: { outAmountAtomic: string; otherAmountThresholdAtomic: string };
  quotePriceImpacts?: string[];
  quoteRouteFee?: 'absent' | 'valid' | 'amount_only' | 'mint_only' | 'excessive' | 'wrong_mint';
  swapTxPayer?: PublicKey;
  swapTxMode?:
    | 'valid'
    | 'arbitrary_program'
    | 'extra_signer'
    | 'wrong_amount'
    | 'duplicate_ata'
    | 'realistic_route'
    | 'malicious_wallet_token'
    | 'malicious_wallet_delegate'
    | 'malicious_wallet_close';
  clvAtaExists?: boolean;
  clvAtaState?: number;
  merchantUsdcAtomic?: string;
  merchantTokenState?: number;
  sendThrows?: boolean;
  signFundingThrows?: boolean;
  captureSweepThrows?: boolean;
  loadSwapThrows?: boolean;
  confirmOutcome?: 'confirmed' | 'failed';
  markFundingSweptLost?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const queue = new Map<string, Record<string, unknown>>();
  for (const r of opts.queueRows ?? []) queue.set(r.id as string, { fills: [], ...r });
  const funding = new Map<string, Record<string, unknown>>();
  for (const f of opts.fundingRows ?? []) funding.set(f.sourceRef as string, { ...f });
  const checkouts = new Map<string, Record<string, unknown>>();
  for (const c of opts.checkouts ?? []) checkouts.set(c.id as string, { ...c });

  const prices = [...(opts.prices ?? [quoteOf(22_000)])];
  let priceIdx = 0;

  const quoteRequests: Harness['quoteRequests'] = [];
  const swapRequests: Harness['swapRequests'] = [];
  const sentRaw: Uint8Array[] = [];
  const sleeps: number[] = [];
  const alerts: Array<Record<string, unknown>> = [];
  const maliciousWalletTokenAccount = Keypair.generate().publicKey;
  let activeLookupTables: AddressLookupTableAccount[] = [];
  const lookupRequests: PublicKey[] = [];

  const findFunding = (fid: string) =>
    [...funding.values()].find((f) => f.id === fid) as Record<string, unknown> | undefined;

  const dbApi = {
    async getQueueRow(id: string) {
      log.push('getQueueRow');
      const r = queue.get(id);
      return r ? { ...r } : null;
    },
    async listPlannedQueueRows(limit: number) {
      return [...queue.values()]
        .filter((r) => r.status === 'planned')
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async listStaleExecutingQueueRows(cutoff: Date, limit: number) {
      return [...queue.values()]
        .filter(
          (r) =>
            r.status === 'executing' && r.claimedAt instanceof Date && r.claimedAt < cutoff,
        )
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async claimQueueRow(id: string, claimId: string) {
      log.push('claimQueueRow');
      const r = queue.get(id);
      if (!r || r.status !== 'planned') return null;
      r.status = 'executing';
      r.claimId = claimId;
      r.claimedAt = new Date();
      return { ...r };
    },
    async releaseQueueClaim(id: string, claimId: string) {
      log.push('releaseQueueClaim');
      const r = queue.get(id);
      if (
        !r ||
        r.claimId !== claimId ||
        r.status !== 'executing' ||
        (r.fills as unknown[]).length !== 0
      ) {
        return false;
      }
      r.status = 'planned';
      r.claimId = null;
      r.claimedAt = null;
      return true;
    },
    async appendClipFill(id: string, claimId: string, entry: Record<string, unknown>) {
      log.push('appendClipFill');
      const r = queue.get(id);
      if (!r || r.claimId !== claimId || r.status !== 'executing') return false;
      (r.fills as unknown[]).push(entry);
      return true;
    },
    async markQueueExecuted(id: string, claimId: string, executedPrice: string) {
      log.push('markQueueExecuted');
      const r = queue.get(id);
      if (!r || r.claimId !== claimId || r.status !== 'executing') return false;
      r.status = 'executed';
      r.executedPrice = executedPrice;
      return true;
    },
    async getSettledCheckout(checkoutId: string) {
      log.push('getSettledCheckout');
      const c = checkouts.get(checkoutId);
      return c ? { ...c } : null;
    },
    async ensureFundingRow(input: Record<string, unknown>) {
      log.push('ensureFundingRow');
      let f = funding.get(input.sourceRef as string);
      if (!f) {
        f = {
          id: `fund-${input.sourceRef}`,
          sourceRef: input.sourceRef,
          checkoutId: input.checkoutId,
          amountUsdc: input.amountUsdc,
          status: 'pending',
          sweepTxSignature: null,
          claimId: null,
          claimedAt: null,
          sweptAt: null,
          failureReason: null,
          metadata: input.metadata,
          createdAt: new Date(),
        };
        funding.set(input.sourceRef as string, f);
      }
      return { ...f };
    },
    async claimFundingRow(fid: string, claimId: string) {
      log.push('claimFundingRow');
      const f = findFunding(fid);
      if (!f || f.status !== 'pending') return null;
      f.status = 'sweeping';
      f.claimId = claimId;
      f.claimedAt = new Date();
      return { ...f };
    },
    async releaseFundingClaim(fid: string, claimId: string) {
      log.push('releaseFundingClaim');
      const f = findFunding(fid);
      if (f && f.claimId === claimId && f.status === 'sweeping' && !f.sweepTxSignature) {
        f.status = 'pending';
        f.claimId = null;
      }
    },
    async captureSweepSignature(fid: string, claimId: string, signature: string) {
      log.push('captureSweepSignature');
      if (opts.captureSweepThrows) throw new Error('capture store unavailable');
      const f = findFunding(fid);
      if (!f || f.claimId !== claimId || f.status !== 'sweeping' || f.sweepTxSignature) {
        return false;
      }
      f.sweepTxSignature = signature;
      return true;
    },
    async markFundingSwept(fid: string, claimId: string) {
      log.push('markFundingSwept');
      if (opts.markFundingSweptLost) return false;
      const f = findFunding(fid);
      if (!f || f.claimId !== claimId || f.status !== 'sweeping') return false;
      f.status = 'swept';
      f.sweptAt = new Date();
      return true;
    },
    async markFundingFailed(fid: string, _claimId: string, reason: string) {
      log.push('markFundingFailed');
      const f = findFunding(fid);
      if (f) {
        f.status = 'failed';
        f.failureReason = reason;
      }
    },
    async markFundingReconcile(fid: string, _claimId: string, reason: string) {
      log.push('markFundingReconcile');
      const f = findFunding(fid);
      if (f) {
        f.status = 'reconcile';
        f.failureReason = reason;
      }
    },
    async getFundingBySourceRef(sourceRef: string) {
      log.push('getFundingBySourceRef');
      const f = funding.get(sourceRef);
      return f ? { ...f } : null;
    },
  } as unknown as ClvSwapLiveDb;

  const swapTxPayer = opts.swapTxPayer ?? swapKp.publicKey;

  const fakeFetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('/swap/v1/quote')) {
      const u = new URL(url);
      const amount = u.searchParams.get('amount')!;
      quoteRequests.push({ amount, slippageBps: u.searchParams.get('slippageBps')! });
      const priceImpactPct = opts.quotePriceImpacts?.[quoteRequests.length - 1] ?? '0.001';
      const expected = Number(amount) / PRICE; // atomic CLV
      const out = Math.floor(expected * 1.01);
      const body = {
        inputMint: USDC_MINT_MAINNET,
        outputMint: CLV_MINT,
        inAmount: amount,
        outAmount: opts.quoteAmounts?.outAmountAtomic ?? String(out),
        otherAmountThreshold:
          opts.quoteAmounts?.otherAmountThresholdAtomic ?? String(Math.floor(out * 0.99)),
        swapMode: 'ExactIn',
        slippageBps: Number(u.searchParams.get('slippageBps')),
        instructionVersion: 'V1',
        priceImpactPct,
        routePlan: [{
          swapInfo: {
            ammKey: Keypair.generate().publicKey.toBase58(),
            label: 'Raydium',
            inputMint: USDC_MINT_MAINNET,
            outputMint: CLV_MINT,
            inAmount: amount,
            outAmount: opts.quoteAmounts?.outAmountAtomic ?? String(out),
            ...(opts.quoteRouteFee === 'valid'
              ? { feeAmount: '1', feeMint: USDC_MINT_MAINNET }
              : opts.quoteRouteFee === 'amount_only'
                ? { feeAmount: '1' }
                : opts.quoteRouteFee === 'mint_only'
                  ? { feeMint: USDC_MINT_MAINNET }
                  : opts.quoteRouteFee === 'excessive'
                    ? { feeAmount: (BigInt(amount) + 1n).toString(), feeMint: USDC_MINT_MAINNET }
                    : opts.quoteRouteFee === 'wrong_mint'
                      ? { feeAmount: '1', feeMint: Keypair.generate().publicKey.toBase58() }
                      : {}),
          },
          percent: 100,
        }],
      };
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.endsWith('/swap/v1/swap')) {
      const request = JSON.parse(init?.body ?? '{}');
      swapRequests.push(request);
      const quoteResponse = request.quoteResponse as { inAmount: string; outAmount: string; slippageBps: number };
      const built = buildSwapTxB64(
          swapTxPayer,
          opts.swapTxMode === 'wrong_amount'
            ? (BigInt(quoteResponse.inAmount) + 1n).toString()
            : quoteResponse.inAmount,
          quoteResponse.outAmount,
          quoteResponse.slippageBps,
          {
            arbitraryProgram: opts.swapTxMode === 'arbitrary_program',
            extraSigner: opts.swapTxMode === 'extra_signer',
            includeAtaSetup: request.destinationTokenAccount === undefined,
            duplicateAtaSetup: opts.swapTxMode === 'duplicate_ata',
            realisticRoute:
              opts.swapTxMode === 'realistic_route' ||
              opts.swapTxMode === 'malicious_wallet_token' ||
              opts.swapTxMode === 'malicious_wallet_delegate' ||
              opts.swapTxMode === 'malicious_wallet_close',
            maliciousWalletTokenAccount:
              opts.swapTxMode === 'malicious_wallet_token' ||
              opts.swapTxMode === 'malicious_wallet_delegate' ||
              opts.swapTxMode === 'malicious_wallet_close'
                ? maliciousWalletTokenAccount
                : undefined,
          },
        );
      activeLookupTables = built.lookupTables;
      const body = {
        swapTransaction: built.transaction,
        lastValidBlockHeight: 999,
      };
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const token2022Program = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const tokenAccountInfo = (
    mint: PublicKey,
    authority: PublicKey,
    program: PublicKey,
    extra: { delegate?: PublicKey; closeAuthority?: PublicKey } = {},
  ) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    authority.toBuffer().copy(data, 32);
    data[108] = 1; // AccountState::Initialized
    if (extra.delegate) {
      data.writeUInt32LE(1, 72);
      extra.delegate.toBuffer().copy(data, 76);
    }
    if (extra.closeAuthority) {
      data.writeUInt32LE(1, 129);
      extra.closeAuthority.toBuffer().copy(data, 133);
    }
    return {
      data,
      executable: false,
      lamports: 2_039_280,
      owner: program,
      rentEpoch: 0,
    };
  };
  const fakeConn = {
    getAccountInfo: async () => {
      if (opts.clvAtaExists === false) return null;
      const data = Buffer.alloc(165);
      new PublicKey(CLV_MINT).toBuffer().copy(data, 0);
      swapKp.publicKey.toBuffer().copy(data, 32);
      data[108] = opts.clvAtaState ?? 1;
      return {
        data,
        executable: false,
        lamports: 2_039_280,
        owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
        rentEpoch: 0,
      };
    },
    getLatestBlockhash: async () => ({
      blockhash: bs58.encode(new Uint8Array(32).fill(3)),
      lastValidBlockHeight: 500,
    }),
    getAddressLookupTable: async (key: PublicKey) => {
      lookupRequests.push(key);
      return {
        context: { slot: 1 },
        value: activeLookupTables.find((table) => table.key.equals(key)) ?? null,
      };
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => {
      if (key.equals(findUsdcAta(swapKp.publicKey))) {
        return tokenAccountInfo(new PublicKey(USDC_MINT_MAINNET), swapKp.publicKey, tokenProgram);
      }
      if (key.equals(findClvAta(swapKp.publicKey))) {
        return opts.clvAtaExists === false
          ? null
          : tokenAccountInfo(new PublicKey(CLV_MINT), swapKp.publicKey, token2022Program);
      }
      if (key.equals(maliciousWalletTokenAccount)) {
        const authority = opts.swapTxMode === 'malicious_wallet_token'
          ? swapKp.publicKey
          : strangerKp.publicKey;
        return tokenAccountInfo(Keypair.generate().publicKey, authority, tokenProgram, {
          delegate: opts.swapTxMode === 'malicious_wallet_delegate' ? swapKp.publicKey : undefined,
          closeAuthority: opts.swapTxMode === 'malicious_wallet_close' ? swapKp.publicKey : undefined,
        });
      }
      return null;
    }),
    getTokenAccountsByOwner: async () => {
      const data = Buffer.alloc(165);
      new PublicKey(USDC_MINT_MAINNET).toBuffer().copy(data, 0);
      merchantKp.publicKey.toBuffer().copy(data, 32);
      data.writeBigUInt64LE(BigInt(opts.merchantUsdcAtomic ?? '999999999999'), 64);
      data[108] = opts.merchantTokenState ?? 1;
      return {
        context: { slot: 123_456 },
        value: [{
          pubkey: findUsdcAta(merchantKp.publicKey),
          account: {
            data,
            executable: false,
            lamports: 2_039_280,
            owner: tokenProgram,
            rentEpoch: 0,
          },
        }],
      };
    },
    getAccountInfoAndContext: async () => {
      const data = Buffer.alloc(82);
      data[44] = 6;
      data[45] = 1;
      return {
        context: { slot: 123_456 },
        value: {
          data,
          executable: false,
          lamports: 1_461_600,
          owner: tokenProgram,
          rentEpoch: 0,
        },
      };
    },
    getParsedTokenAccountsByOwner: async () => ({
      context: { slot: 123_456 },
      value: [
        {
          account: {
            data: {
              parsed: {
                info: {
                  tokenAmount: {
                    amount: opts.merchantUsdcAtomic ?? '999999999999',
                    decimals: 6,
                  },
                },
              },
            },
          },
        },
      ],
    }),
  } as unknown as Connection;

  const deps: ClvSwapLiveDeps = {
    db: dbApi,
    getPrice: () => {
      const q = prices[Math.min(priceIdx, prices.length - 1)];
      priceIdx += 1;
      return q;
    },
    loadSwapKeypair: async () => {
      log.push('loadSwapKeypair');
      if (opts.loadSwapThrows) throw new Error('custody unavailable before signing');
      return swapKp;
    },
    loadMerchantKeypair: async () => {
      log.push('loadMerchantKeypair');
      return merchantKp;
    },
    getSwapWalletPubkey: async () => swapKp.publicKey.toBase58(),
    connection: () => fakeConn,
    fetchImpl: fakeFetch,
    signFundingTransaction: (transaction, signer) => {
      log.push('signFundingTransaction');
      transaction.sign(signer);
      if (opts.signFundingThrows) throw new Error('signer threw after mutation');
    },
    sendRawTransaction: async (_conn, raw) => {
      log.push('sendRaw');
      if (opts.sendThrows) throw new Error('boom: transport died mid-send');
      sentRaw.push(raw);
      return 'rpc-echo-sig';
    },
    confirmTransaction: async () => {
      log.push('confirm');
      return opts.confirmOutcome ?? 'confirmed';
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    alert: async (params) => {
      log.push('alert');
      alerts.push(params as unknown as Record<string, unknown>);
    },
  };

  return {
    deps,
    log,
    queue,
    funding,
    quoteRequests,
    swapRequests,
    sentRaw,
    lookupRequests,
    sleeps,
    alerts,
  };
}

const settledCheckout = (over: Record<string, unknown> = {}) => ({
  id: SRC,
  status: 'settled',
  txSignature: 'settled-sig-1',
  usdCents: 500, // $5.00
  metadata: { settleNetwork: SOLANA_MAINNET_CAIP2 },
  ...over,
});

const plannedQueueRow = (over: Record<string, unknown> = {}) => ({
  id: 'q-1',
  status: 'planned',
  amountUsdc: '5.000000',
  reason: 'checkout_clv_leg',
  sourceRef: SRC,
  ...over,
});

const sweptFundingRow = (over: Record<string, unknown> = {}) => ({
  id: `fund-${SRC}`,
  sourceRef: SRC,
  checkoutId: SRC,
  amountUsdc: '5.000000',
  status: 'swept',
  sweepTxSignature: 'prior-sweep-sig',
  claimId: null,
  claimedAt: null,
  sweptAt: new Date(),
  failureReason: null,
  metadata: {},
  createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  // Live-context env: literal opt-in, mainnet, real facilitator. Individual
  // tests override; the dry-run-only assertion is no longer module-scoped.
  process.env.CLV_SWAP_EXECUTE = 'true';
  process.env.X402_TOPUP_NETWORK = 'mainnet';
  process.env.X402_FACILITATOR_PRESET = 'payai';
  delete process.env.X402_MOCK_FACILITATOR;
  delete process.env.CLV_SWAP_SLIPPAGE_BPS;
  delete process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS;
  delete process.env.CLV_SWAP_MAX_IMPACT_BPS;
  delete process.env.CLV_SWAP_CLIP_SPACING_MS;
  delete process.env.CLV_SWAP_JUPITER_BASE_URL;
  delete process.env.CLV_SWAP_JUPITER_PROBE_USDC;
  delete process.env.CLV_SWAP_EXECUTING_STALE_MS;
});

afterAll(() => {
  stopClvSwapLiveWorker();
  delete process.env.CLV_SWAP_EXECUTE;
  delete process.env.X402_TOPUP_NETWORK;
  delete process.env.X402_FACILITATOR_PRESET;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GATES — the live path is default-off', () => {
  it('every live entrypoint refuses when CLV_SWAP_EXECUTE is not "true"', async () => {
    delete process.env.CLV_SWAP_EXECUTE;
    const h = makeHarness();
    expect(() => requireLiveClvSwapExecution()).toThrow(/disabled/);
    await expect(claimAndSweepFundingForQueueRow('q-1', h.deps)).rejects.toThrow(/disabled/);
    await expect(executeQueuedClvBuy('q-1', h.deps)).rejects.toThrow(/disabled/);
    await expect(runLiveClvSwapTick(h.deps)).rejects.toThrow(/disabled/);
    expect(() => startClvSwapLiveWorker()).toThrow(/disabled/);
    expect(h.log.length).toBe(0); // nothing touched anything
  });

  it('NETWORK GUARD: devnet USDC refuses (CLV is mainnet-only)', async () => {
    process.env.X402_TOPUP_NETWORK = 'devnet';
    const h = makeHarness();
    expect(() => assertMainnetRealMoneyContext()).toThrow(/devnet USDC/);
    await expect(claimAndSweepFundingForQueueRow('q-1', h.deps)).rejects.toThrow(/mainnet-only/);
    await expect(executeQueuedClvBuy('q-1', h.deps)).rejects.toThrow(/mainnet-only/);
    expect(h.log.length).toBe(0);
  });

  it('NETWORK GUARD: unset network (devnet-first default) also refuses', () => {
    delete process.env.X402_TOPUP_NETWORK;
    expect(() => assertMainnetRealMoneyContext()).toThrow(/'devnet'/);
  });

  it('NETWORK GUARD: the mock facilitator refuses (fake money can never fund a swap)', () => {
    process.env.X402_FACILITATOR_PRESET = 'mock';
    expect(() => assertMainnetRealMoneyContext()).toThrow(/MOCK x402 facilitator/);
    process.env.X402_FACILITATOR_PRESET = 'payai';
    process.env.X402_MOCK_FACILITATOR = 'true';
    expect(() => assertMainnetRealMoneyContext()).toThrow(/MOCK x402 facilitator/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FUNDING SWEEP — exactly-once merchant→swap-wallet USDC', () => {
  it('happy path: claim → custody → capture BEFORE send → confirm → swept', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.replay).toBe(false);
    const f = h.funding.get(SRC)!;
    expect(f.status).toBe('swept');
    expect(f.sweepTxSignature).toBe(res.sweepTxSignature);
    expect(res.sweepTxSignature.length).toBeGreaterThan(30); // real base58 sig

    // ORDERING: atomic claim precedes custody; capture precedes the send.
    const idx = (name: string) => h.log.indexOf(name);
    expect(idx('claimFundingRow')).toBeGreaterThan(-1);
    expect(idx('claimFundingRow')).toBeLessThan(idx('loadMerchantKeypair'));
    expect(idx('captureSweepSignature')).toBeLessThan(idx('sendRaw'));
    expect(idx('sendRaw')).toBeLessThan(idx('markFundingSwept'));
  });

  it('DOUBLE-SWEEP: a second call replays the swept row — no claim, no custody, no send', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.replay).toBe(true);
    expect(res.sweepTxSignature).toBe('prior-sweep-sig');
    expect(h.log).not.toContain('claimFundingRow');
    expect(h.log).not.toContain('loadMerchantKeypair');
    expect(h.log).not.toContain('sendRaw');
  });

  it('in-flight sweep refuses; terminal (reconcile/failed) is NEVER retried', async () => {
    const inflight = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow({ status: 'sweeping', sweepTxSignature: null })],
    });
    const r1 = await claimAndSweepFundingForQueueRow('q-1', inflight.deps);
    expect(r1).toMatchObject({ ok: false, code: 'funding_in_flight' });

    for (const status of ['reconcile', 'failed']) {
      const h = makeHarness({
        queueRows: [plannedQueueRow()],
        checkouts: [settledCheckout()],
        fundingRows: [sweptFundingRow({ status })],
      });
      const r = await claimAndSweepFundingForQueueRow('q-1', h.deps);
      expect(r).toMatchObject({ ok: false, code: 'funding_terminal' });
      expect(h.log).not.toContain('sendRaw');
    }
  });

  it('amounts tied to SETTLED MAINNET checkouts ONLY', async () => {
    // Not settled.
    const pending = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout({ status: 'pending', txSignature: null })],
    });
    expect(await claimAndSweepFundingForQueueRow('q-1', pending.deps)).toMatchObject({
      ok: false,
      code: 'checkout_not_settled',
    });

    // Settled on DEVNET — its USDC is not mainnet money.
    const devnet = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout({ metadata: { network: 'devnet' } })],
    });
    expect(await claimAndSweepFundingForQueueRow('q-1', devnet.deps)).toMatchObject({
      ok: false,
      code: 'checkout_not_mainnet',
    });

    // Queue amount EXCEEDS the settled checkout — never sweep more than settled.
    const oversize = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '5.000001' })],
      checkouts: [settledCheckout()], // $5.00
    });
    expect(await claimAndSweepFundingForQueueRow('q-1', oversize.deps)).toMatchObject({
      ok: false,
      code: 'amount_exceeds_checkout',
    });

    // Non-checkout source refs are refused (v1 funds settled checkouts only).
    const nonUuid = makeHarness({
      queueRows: [plannedQueueRow({ sourceRef: 'order-42' })],
    });
    expect(await claimAndSweepFundingForQueueRow('q-1', nonUuid.deps)).toMatchObject({
      ok: false,
      code: 'source_not_checkout_uuid',
    });

    // A SKIPPED row never funds — its USDC must not be parked in the swap wallet.
    const skipped = makeHarness({
      queueRows: [plannedQueueRow({ status: 'skipped' })],
      checkouts: [settledCheckout()],
    });
    expect(await claimAndSweepFundingForQueueRow('q-1', skipped.deps)).toMatchObject({
      ok: false,
      code: 'queue_row_skipped',
    });
    expect(skipped.log).not.toContain('ensureFundingRow');
  });

  it('insufficient merchant USDC: releases the claim PRE-send (retryable once funded)', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      merchantUsdcAtomic: '10', // 0.00001 USDC — nowhere near $5
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'insufficient_merchant_usdc' });
    expect(h.log).toContain('releaseFundingClaim');
    expect(h.log).not.toContain('captureSweepSignature');
    expect(h.log).not.toContain('sendRaw');
    expect(h.funding.get(SRC)!.status).toBe('pending'); // clean retry later
  });

  it('frozen merchant USDC is not spendable availability and releases before signing', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      merchantTokenState: 2,
    });
    await expect(claimAndSweepFundingForQueueRow('q-1', h.deps)).rejects.toThrow(
      /rpc_token_account_invalid/,
    );
    expect(h.funding.get(SRC)!.status).toBe('pending');
    expect(h.log).toContain('releaseFundingClaim');
    expect(h.log).not.toContain('signFundingTransaction');
    expect(h.log).not.toContain('sendRaw');
  });

  for (const failure of ['sign', 'capture'] as const) {
    it(`${failure} failure after signing starts strands in reconcile and never releases`, async () => {
      const h = makeHarness({
        queueRows: [plannedQueueRow()],
        checkouts: [settledCheckout()],
        signFundingThrows: failure === 'sign',
        captureSweepThrows: failure === 'capture',
      });
      const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
      expect(res).toMatchObject({
        ok: false,
        code: 'capture_lost',
        detail: 'unexpected_post_signing_pre_capture',
      });
      expect(h.funding.get(SRC)!.status).toBe('reconcile');
      expect(h.log).not.toContain('releaseFundingClaim');
      expect(h.log).not.toContain('sendRaw');
    });
  }

  it('AMBIGUOUS send: signature captured, row → reconcile, NEVER retried', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      sendThrows: true,
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'send_ambiguous' });
    const f = h.funding.get(SRC)!;
    expect(f.status).toBe('reconcile');
    expect(typeof f.sweepTxSignature).toBe('string'); // durable BEFORE the send
    expect((f.sweepTxSignature as string).length).toBeGreaterThan(30);

    // A retry finds the terminal row and refuses — no second send attempt.
    const res2 = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res2).toMatchObject({ ok: false, code: 'funding_terminal' });
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
  });

  it('definitive on-chain failure: row → failed (no money moved), loud terminal', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      confirmOutcome: 'failed',
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'sweep_tx_failed' });
    expect(h.funding.get(SRC)!.status).toBe('failed');
  });

  it('confirmed sweep with a lost terminal CAS goes to reconcile, never reports success', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      markFundingSweptLost: true,
    });
    const res = await claimAndSweepFundingForQueueRow('q-1', h.deps);
    expect(res).toMatchObject({
      ok: false,
      code: 'send_ambiguous',
      detail: 'confirmed_mark_missed',
    });
    expect(h.funding.get(SRC)!.status).toBe('reconcile');
    expect(h.log.filter((entry) => entry === 'sendRaw')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Jupiter exact-impact gate — fixed point + conservative shrink', () => {
  it('uses decimal-fraction units, accepts zero/exact boundary, and CEILs long tails', () => {
    expect(parseJupiterPriceImpactPct('0')).toBe(0n);
    expect(jupiterImpactWithinBps(parseJupiterPriceImpactPct('0')!, 100)).toBe(true);
    expect(jupiterImpactWithinBps(parseJupiterPriceImpactPct('0.01')!, 100)).toBe(true);
    expect(parseJupiterPriceImpactPct('0.0014436537437998371390113307'))
      .toBe(1_443_653_743_799_838n);
    const overBoundary = parseJupiterPriceImpactPct('0.0100000000000000001');
    expect(overBoundary).toBe(10_000_000_000_000_001n);
    expect(jupiterImpactWithinBps(overBoundary!, 100)).toBe(false);
  });

  it('rejects malformed impact and halves every rejected candidate', () => {
    for (const value of ['-0.01', '1', '0.1e-2', 'NaN', '', ' 0.01']) {
      expect(parseJupiterPriceImpactPct(value)).toBeNull();
    }
    expect(shrinkClipMicroForImpact(25_000_001n, parseJupiterPriceImpactPct('0.02')!, 100))
      .toBe(12_500_000n);
    expect(shrinkClipMicroForImpact(1n, parseJupiterPriceImpactPct('0.02')!, 100)).toBeNull();
  });

  it('defaults/caps the first candidate at $25 and permits tuning down only', () => {
    expect(resolveClvSwapImpactProbeMicro()).toBe(25_000_000n);
    process.env.CLV_SWAP_JUPITER_PROBE_USDC = '10.123456';
    expect(resolveClvSwapImpactProbeMicro()).toBe(10_123_456n);
    process.env.CLV_SWAP_JUPITER_PROBE_USDC = '100';
    expect(resolveClvSwapImpactProbeMicro()).toBe(25_000_000n);
  });
});

describe('LIVE EXECUTION — atomic claim + per-clip oracle-checked Jupiter swaps', () => {
  it('refuses when the funding is not swept — the claim is never taken', async () => {
    const h = makeHarness({ queueRows: [plannedQueueRow()] }); // no funding row
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'funding_not_swept' });
    expect(h.log).not.toContain('claimQueueRow');
    expect(h.log).not.toContain('loadSwapKeypair');
  });

  it('HAPPY PATH: null/tiny Dex depth cannot stall or under-size; $25 cap conserves', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '150.000000' })],
      checkouts: [settledCheckout({ usdCents: 15_000 })],
      fundingRows: [sweptFundingRow({ amountUsdc: '150.000000' })],
      // First clip reproduces the live null-depth defect; later clips prove a
      // tiny positive reading cannot under-size (old cap: 5 µUSDC → >10k clips).
      prices: [quoteOf(null), quoteOf(0.001)],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.clipCount).toBe(6);

    expect(h.quoteRequests.map((q) => q.amount)).toEqual(Array(6).fill('25000000'));
    // CONSERVATION: Σ clip µUSD === queued amount exactly.
    const sum = h.quoteRequests.reduce((a, q) => a + BigInt(q.amount), 0n);
    expect(sum).toBe(150_000_000n);

    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('executed');
    expect(Number(row.executedPrice)).toBeGreaterThan(0);
    expect(Number(row.executedPrice)).toBeLessThan(0.001);
    expect((row.fills as unknown[]).length).toBe(6);

    // Capture-before-send holds for EVERY clip.
    const captures = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'appendClipFill')
      .map(([, i]) => i);
    const sends = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'sendRaw')
      .map(([, i]) => i);
    expect(captures.length).toBe(6);
    expect(sends.length).toBe(6);
    for (let i = 0; i < 6; i += 1) expect(captures[i]).toBeLessThan(sends[i]);

    // Spacing sleeps between clips (not after the last).
    expect(h.sleeps.length).toBe(5);

    // The atomic claim preceded custody.
    expect(h.log.indexOf('claimQueueRow')).toBeLessThan(h.log.indexOf('loadSwapKeypair'));
  });

  it('shrinks over-cap quotes and forwards only accepted quote objects to /swap', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      quotePriceImpacts: ['0.02', '0.005', '0.005'],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: true, clipCount: 2 });
    expect(h.quoteRequests.map((q) => q.amount)).toEqual(['5000000', '2500000', '2500000']);
    expect(h.swapRequests).toHaveLength(2);
    expect((h.swapRequests[0].quoteResponse as { inAmount: string }).inAmount).toBe('2500000');
    expect(h.log.filter((entry) => entry === 'sendRaw')).toHaveLength(2);
  });

  it('refuses at 1 µUSDC when exact impact remains over cap; nothing signs/sends', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '0.000002' })],
      fundingRows: [sweptFundingRow({ amountUsdc: '0.000002' })],
      quotePriceImpacts: ['0.02', '0.02'],
    });
    expect(await executeQueuedClvBuy('q-1', h.deps)).toMatchObject({
      ok: false,
      code: 'no_liquidity',
      detail: 'price_impact_exceeds_cap_at_dust',
    });
    expect(h.quoteRequests.map((q) => q.amount)).toEqual(['2', '1']);
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
  });

  it('fails closed on malformed priceImpactPct before /swap/sign/send', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      quotePriceImpacts: ['NaN'],
    });
    expect(await executeQueuedClvBuy('q-1', h.deps)).toMatchObject({
      ok: false,
      code: 'jupiter_quote_failed',
      detail: 'price_impact_invalid',
    });
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
  });

  it('accounts from ExactIn threshold, never optimistic Jupiter outAmount', async () => {
    const optimisticOutAtomic = '80000000000';
    const guaranteedOutAtomic = jupiterExactInMinimumOut(
      BigInt(optimisticOutAtomic),
      100,
    ).toString();
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      quoteAmounts: {
        outAmountAtomic: optimisticOutAtomic,
        otherAmountThresholdAtomic: guaranteedOutAtomic,
      },
    });

    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');

    const row = h.queue.get('q-1')!;
    const fills = row.fills as Array<{ outAmountAtomic: string }>;
    const expectedPrice = (
      5 / (Number(guaranteedOutAtomic) / 10 ** 6)
    ).toFixed(12);

    // The capture-before-send record, aggregate, and persisted rate all use
    // Jupiter's on-chain-enforced floor. Optimistic outAmount is never stored
    // or allowed to increase downstream payout capacity.
    expect(fills).toHaveLength(1);
    expect(fills[0]?.outAmountAtomic).toBe(guaranteedOutAtomic);
    expect(fills[0]?.outAmountAtomic).not.toBe(optimisticOutAtomic);
    expect(res.totalClvOutAtomic).toBe(guaranteedOutAtomic);
    expect(res.executedPrice).toBe(expectedPrice);
    expect(row.executedPrice).toBe(expectedPrice);
    expect(h.log.indexOf('appendClipFill')).toBeLessThan(h.log.indexOf('sendRaw'));
  });

  it('DOUBLE-CLAIM: the second executor loses the claim and never touches custody', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
    });
    const first = await executeQueuedClvBuy('q-1', h.deps);
    expect(first.ok).toBe(true);
    const loadsAfterFirst = h.log.filter((l) => l === 'loadSwapKeypair').length;
    expect(loadsAfterFirst).toBe(1);

    const second = await executeQueuedClvBuy('q-1', h.deps);
    expect(second).toMatchObject({ ok: false, code: 'claim_lost' });
    expect(h.log.filter((l) => l === 'loadSwapKeypair').length).toBe(loadsAfterFirst);
  });

  it('RESTART-MID-TICK: a row left "executing" by a crash is NEVER re-claimed', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ status: 'executing', claimId: 'dead-claim' })],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'claim_lost' });
    expect(h.log).not.toContain('loadSwapKeypair');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.claimId).toBe('dead-claim'); // untouched
  });

  it('ORACLE UNAVAILABLE hard-stops sizing and releases a zero-clip pre-sign claim', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
      // available:false even though numbers are still present in the struct —
      // availability is THE gate for BOTH quoteUsd and poolLiquidityUsd.
      prices: [quoteOf(22_000, { available: false, quoteUsd: PRICE })],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'oracle_unavailable', executedClips: 0 });
    expect(h.quoteRequests.length).toBe(0);
    expect(h.log).not.toContain('sendRaw');
    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('planned');
    expect(row.claimId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(h.log).toContain('releaseQueueClaim');
  });

  it('a thrown pre-sign dependency error releases the empty claim to planned', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      loadSwapThrows: true,
    });
    await expect(executeQueuedClvBuy('q-1', h.deps)).rejects.toThrow(/custody unavailable/);
    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('planned');
    expect(row.claimId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(h.log).toContain('releaseQueueClaim');
    expect(h.log).not.toContain('sendRaw');
  });

  it('ORACLE UNAVAILABLE mid-row: confirmed fills stay durable, then hard-stop', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '150.000000' })],
      checkouts: [settledCheckout({ usdCents: 15_000 })],
      fundingRows: [sweptFundingRow({ amountUsdc: '150.000000' })],
      prices: [quoteOf(22_000), quoteOf(null, { available: false, quoteUsd: null })],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'oracle_unavailable', executedClips: 1 });
    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('executing');
    expect((row.fills as unknown[]).length).toBe(1); // clip 1 durable
  });

  it('passes below oracle mid when quoted out is within tolerance and threshold clears its composite floor', async () => {
    const oracleMid = Math.floor((5 / PRICE) * 1e6);
    const outWithinTolerance = Math.floor(oracleMid * 0.98);
    const jupiterThreshold = Math.floor(outWithinTolerance * 0.95);
    const oracleFloor = oracleMinOutClvAtomic(5_000_000n, PRICE, 300);
    expect(BigInt(outWithinTolerance)).toBeGreaterThanOrEqual(oracleFloor);
    expect(BigInt(jupiterThreshold)).toBeLessThan(oracleFloor);

    const h = makeHarness({
      queueRows: [plannedQueueRow({ maxSlippage: '0.0500' })],
      fundingRows: [sweptFundingRow()],
      quoteAmounts: {
        outAmountAtomic: String(outWithinTolerance),
        otherAmountThresholdAtomic: String(jupiterThreshold),
      },
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.quoteRequests[0]?.slippageBps).toBe('500');
    expect(h.queue.get('q-1')!.status).toBe('executed');
    expect(h.sentRaw).toHaveLength(1);
  });

  it('refuses quoted out below the independent ORACLE tolerance — no swap, capture, or send', async () => {
    const oracleMid = Math.floor((5 / PRICE) * 1e6);
    const outBelowTolerance = Math.floor(oracleMid * 0.96);
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      quoteAmounts: {
        outAmountAtomic: String(outBelowTolerance),
        otherAmountThresholdAtomic: String(Math.floor(outBelowTolerance * 0.99)),
      },
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'quote_below_oracle_min_out', executedClips: 0 });
    expect(h.swapRequests.length).toBe(0);
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('ignores the informational wire threshold and accounts from the decoded instruction floor', async () => {
    const oracleMid = Math.floor((5 / PRICE) * 1e6);
    const h = makeHarness({
      queueRows: [plannedQueueRow({ maxSlippage: '0.0500' })],
      fundingRows: [sweptFundingRow()],
      quoteAmounts: {
        outAmountAtomic: String(Math.floor(oracleMid * 0.98)),
        otherAmountThresholdAtomic: String(Math.floor(oracleMid * 0.5)),
      },
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    const fill = (h.queue.get('q-1')!.fills as Array<{ outAmountAtomic: string }>)[0];
    expect(fill?.outAmountAtomic).toBe(
      jupiterExactInMinimumOut(BigInt(Math.floor(oracleMid * 0.98)), 500).toString(),
    );
    expect(fill?.outAmountAtomic).not.toBe(String(Math.floor(oracleMid * 0.5)));
    const forwarded = h.swapRequests[0]?.quoteResponse as {
      routePlan?: Array<{ swapInfo?: Record<string, unknown> }>;
    };
    expect(forwarded.routePlan?.[0]?.swapInfo).not.toHaveProperty('feeAmount');
    expect(forwarded.routePlan?.[0]?.swapInfo).not.toHaveProperty('feeMint');
  });

  it('accepts optional route fee metadata when the complete pair is bounded', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      quoteRouteFee: 'valid',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    const forwarded = h.swapRequests[0]?.quoteResponse as {
      routePlan?: Array<{ swapInfo?: Record<string, unknown> }>;
    };
    expect(forwarded.routePlan?.[0]?.swapInfo).toMatchObject({
      feeAmount: '1',
      feeMint: USDC_MINT_MAINNET,
    });
  });

  for (const quoteRouteFee of [
    'amount_only',
    'mint_only',
    'excessive',
    'wrong_mint',
  ] as const) {
    it(`rejects malformed or unbounded optional route fee metadata: ${quoteRouteFee}`, async () => {
      const h = makeHarness({
        queueRows: [plannedQueueRow()],
        fundingRows: [sweptFundingRow()],
        quoteRouteFee,
      });
      const res = await executeQueuedClvBuy('q-1', h.deps);
      expect(res).toMatchObject({
        ok: false,
        code: 'jupiter_quote_failed',
        detail: 'quote_route_mismatch',
      });
      expect(h.swapRequests).toHaveLength(0);
      expect(h.log).not.toContain('appendClipFill');
      expect(h.log).not.toContain('sendRaw');
      expect(h.queue.get('q-1')!.status).toBe('planned');
    });
  }

  it('fresh wallet omits destinationTokenAccount so Jupiter can create the canonical CLV ATA', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      clvAtaExists: false,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.swapRequests[0]).not.toHaveProperty('destinationTokenAccount');
  });

  it('existing initialized CLV ATA is pinned as destinationTokenAccount', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.swapRequests[0]?.destinationTokenAccount).toBe(findClvAta(swapKp.publicKey).toBase58());
  });

  it('refuses an existing uninitialized CLV ATA before requesting or signing a swap', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      clvAtaState: 0,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({
      ok: false,
      code: 'jupiter_swap_failed',
      detail: 'existing_clv_ata_invalid',
    });
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('accepts a current Jupiter V1 route with compute budget, Token-2022 role, repeated wallet/CLV metas, and ALT keys', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'realistic_route',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.lookupRequests).toHaveLength(1);
    expect(h.sentRaw).toHaveLength(1);
    expect(h.log.indexOf('appendClipFill')).toBeLessThan(h.log.indexOf('sendRaw'));
  });

  for (const mode of [
    'malicious_wallet_token',
    'malicious_wallet_delegate',
    'malicious_wallet_close',
  ] as const) {
    it(`rejects an ALT-loaded writable token account controlled through ${mode} before signing`, async () => {
      const h = makeHarness({
        queueRows: [plannedQueueRow()],
        fundingRows: [sweptFundingRow()],
        swapTxMode: mode,
      });
      const res = await executeQueuedClvBuy('q-1', h.deps);
      expect(res).toMatchObject({
        ok: false,
        code: 'swap_tx_binding_failed',
        executedClips: 0,
      });
      expect(h.lookupRequests).toHaveLength(1);
      expect(h.log).not.toContain('appendClipFill');
      expect(h.log).not.toContain('sendRaw');
      expect(h.log).toContain('releaseQueueClaim');
      expect(h.queue.get('q-1')!.status).toBe('planned');
    });
  }

  it('rejects a correct-payer transaction containing an arbitrary outer program before sign/capture/send', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'arbitrary_program',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed', executedClips: 0 });
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('rejects a transaction requiring any signer besides the exact payer', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'extra_signer',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed', executedClips: 0 });
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
  });

  it('rejects more than one canonical ATA setup instruction', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'duplicate_ata',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed', executedClips: 0 });
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
  });

  it('rejects a Jupiter route whose encoded input is not the accepted exact clip', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'wrong_amount',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed', executedClips: 0 });
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
  });

  it('refuses a projected 10,001-clip row after exact quote but before /swap/signature', async () => {
    process.env.CLV_SWAP_JUPITER_PROBE_USDC = '0.000001';
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '0.010001' })],
      fundingRows: [sweptFundingRow({ amountUsdc: '0.010001' })],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'clip_count_excessive', executedClips: 0 });
    expect(h.quoteRequests).toHaveLength(1); // exact 1µ candidate accepted, then projected
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('post-impact shrink beyond the clip-count cap keeps the prior fill durable', async () => {
    process.env.CLV_SWAP_JUPITER_PROBE_USDC = '0.000002';
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '0.010002' })],
      fundingRows: [sweptFundingRow({ amountUsdc: '0.010002' })],
      quotePriceImpacts: ['0.001', '0.02', '0.001'],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'clip_count_excessive', executedClips: 1 });
    expect(h.quoteRequests).toHaveLength(3); // 2µ accepted; then 2µ rejected → 1µ accepted
    expect(h.sentRaw).toHaveLength(1);
    expect(h.queue.get('q-1')!.status).toBe('executing');
    expect(h.queue.get('q-1')!.fills as unknown[]).toHaveLength(1);
    expect(h.log).not.toContain('releaseQueueClaim');
  });

  it('NEVER signs a swap tx whose fee payer is not our wallet', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
      swapTxPayer: strangerKp.publicKey,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_payer_mismatch' });
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
  });

  it('per-row max_slippage (fraction) overrides the env bps, clamped to the ceiling', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ maxSlippage: '0.0500' })], // 5% row override
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.quoteRequests[0].slippageBps).toBe('500');

    // Ceiling clamp: 50% asks for 5000 bps → clamped to 1000.
    const clamped = makeHarness({
      queueRows: [plannedQueueRow({ maxSlippage: '0.5000' })],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
    });
    const res2 = await executeQueuedClvBuy('q-1', clamped.deps);
    expect(res2.ok).toBe(true);
    expect(clamped.quoteRequests[0].slippageBps).toBe('1000');
  });

  it('AMBIGUOUS clip send: fill already captured, row stays executing, never auto-retried', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
      fundingRows: [sweptFundingRow()],
      sendThrows: true,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'send_ambiguous', executedClips: 0 });
    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('executing');
    expect(row.claimId).not.toBeNull();
    expect((row.fills as unknown[]).length).toBe(1); // captured BEFORE the send
    expect(h.log.filter((l) => l === 'sendRaw').length).toBe(1);
    expect(h.log).not.toContain('releaseQueueClaim');
  });

  it('definitive post-signature clip failure keeps the captured claim executing', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      confirmOutcome: 'failed',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'clip_tx_failed', executedClips: 0 });
    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('executing');
    expect(row.claimId).not.toBeNull();
    expect(row.fills as unknown[]).toHaveLength(1);
    expect(h.log).not.toContain('releaseQueueClaim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('runLiveClvSwapTick — sweep-then-execute per planned row', () => {
  it('one planned row: sweeps its funding then executes the buy', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      checkouts: [settledCheckout()],
    });
    const out = await runLiveClvSwapTick(h.deps);
    expect(out.length).toBe(1);
    expect(out[0].sweep.ok).toBe(true);
    expect(out[0].execute?.ok).toBe(true);
    expect(h.queue.get('q-1')!.status).toBe('executed');
    expect(h.funding.get(SRC)!.status).toBe('swept');
    expect(h.alerts.length).toBe(0); // nothing stale — nothing paged
  });

  it("STALE-CLAIM ALERTING: a row stuck 'executing' past the floor pages ops — no retry, no mutation", async () => {
    const h = makeHarness({
      queueRows: [
        plannedQueueRow({
          id: 'q-stale',
          status: 'executing',
          claimId: 'dead-claim',
          claimedAt: new Date(Date.now() - 10 * 60_000), // well past the 5-min default
        }),
      ],
    });
    const out = await runLiveClvSwapTick(h.deps);
    expect(out).toEqual([]); // not planned — never swept/executed by the tick
    expect(h.alerts.length).toBe(1);
    expect(h.alerts[0]).toMatchObject({ severity: 'warning', source: 'clv-swap-live' });
    expect(String(h.alerts[0].message)).toContain('q-stale');
    // ALERT-ONLY discipline: the row is untouched (manual reconcile), custody
    // was never loaded, no claim/send ever ran.
    const row = h.queue.get('q-stale')!;
    expect(row.status).toBe('executing');
    expect(row.claimId).toBe('dead-claim');
    expect(h.log).not.toContain('claimQueueRow');
    expect(h.log).not.toContain('loadSwapKeypair');
    expect(h.log).not.toContain('sendRaw');
  });

  it('a FRESH executing claim (younger than the stale floor) is NOT paged', async () => {
    const h = makeHarness({
      queueRows: [
        plannedQueueRow({
          id: 'q-live',
          status: 'executing',
          claimId: 'live-claim',
          claimedAt: new Date(), // in-flight right now
        }),
      ],
    });
    await runLiveClvSwapTick(h.deps);
    expect(h.alerts.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard)', () => {
  it('unset → the keyless lite-api default', () => {
    delete process.env.CLV_SWAP_JUPITER_BASE_URL;
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
  });

  it('api.jup.ag (the paid base) is accepted; trailing slashes trimmed', () => {
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'https://api.jup.ag/';
    expect(resolveJupiterBaseUrl()).toBe('https://api.jup.ag');
  });

  it('an OFF-ALLOWLIST https host falls back to the default (never a silent redirect of the money wire)', () => {
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'https://evil.example.com';
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'https://jup.ag.evil.example';
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
  });

  it('non-https / embedded credentials / garbage all fall back to the default', () => {
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'http://lite-api.jup.ag';
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'https://user:pass@api.jup.ag';
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
    process.env.CLV_SWAP_JUPITER_BASE_URL = 'not a url';
    expect(resolveJupiterBaseUrl()).toBe('https://lite-api.jup.ag');
  });
});

describe('resolveClvSwapExecutingStaleMs — default + hard floor', () => {
  it('default 300s; below-floor values refuse to the default; valid override honored', () => {
    delete process.env.CLV_SWAP_EXECUTING_STALE_MS;
    expect(resolveClvSwapExecutingStaleMs()).toBe(300_000);
    process.env.CLV_SWAP_EXECUTING_STALE_MS = '1000'; // below the 180s floor
    expect(resolveClvSwapExecutingStaleMs()).toBe(300_000);
    process.env.CLV_SWAP_EXECUTING_STALE_MS = 'garbage';
    expect(resolveClvSwapExecutingStaleMs()).toBe(300_000);
    process.env.CLV_SWAP_EXECUTING_STALE_MS = '240000';
    expect(resolveClvSwapExecutingStaleMs()).toBe(240_000);
    delete process.env.CLV_SWAP_EXECUTING_STALE_MS;
  });
});

describe('resolveClvSwapOracleToleranceBps — independent default + bounds', () => {
  it('defaults to 300; invalid falls back; floor/cap and valid overrides are honored', () => {
    delete process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS;
    expect(resolveClvSwapOracleToleranceBps()).toBe(300);
    process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS = 'garbage';
    expect(resolveClvSwapOracleToleranceBps()).toBe(300);
    process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS = '0';
    expect(resolveClvSwapOracleToleranceBps()).toBe(1);
    process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS = '5000';
    expect(resolveClvSwapOracleToleranceBps()).toBe(1_000);
    process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS = '250';
    expect(resolveClvSwapOracleToleranceBps()).toBe(250);
    delete process.env.CLV_SWAP_ORACLE_TOLERANCE_BPS;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pure sizing helpers', () => {
  it('sizeClipMicro mirrors planClips: cap = depth/2 × bps/10k, µUSD-floored', () => {
    expect(sizeClipMicro(1_000_000_000n, 22_000, 100)).toBe(110_000_000n); // $110 cap
    expect(sizeClipMicro(50_000_000n, 22_000, 100)).toBe(50_000_000n); // remainder clip
    expect(sizeClipMicro(1_000_000n, null, 100)).toBeNull();
    expect(sizeClipMicro(1_000_000n, 0, 100)).toBeNull();
    expect(sizeClipMicro(1_000_000n, 0.0000019, 100)).toBeNull(); // dust pool
  });

  it('oracleMinOutClvAtomic: house quote less oracle tolerance, atomic-floored', () => {
    // $110 at $0.00007/CLV = 1,571,428.571 CLV → atomic 1.571428571e12; −1%.
    const minOut = oracleMinOutClvAtomic(110_000_000n, PRICE, 100);
    const expected = Math.floor((110 / PRICE) * 0.99 * 1e6);
    expect(minOut).toBe(BigInt(expected));
  });
});
