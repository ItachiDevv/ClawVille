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
 *      fixed <=$100 clips; Jupiter price-impact refusal; Jupiter's decoded
 *      slippage threshold remains the on-chain minimum; route-agnostic
 *      pre-sign simulation proves wallet token deltas; zero-clip pre-sign stops release the
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
import { CLV_MINT } from '../clv-price-oracle';
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
  resolveClvSwapSlippageBps,
  resolveJupiterBaseUrl,
  resolveClvSwapExecutingStaleMs,
  findUsdcAta,
  findClvAta,
  decodeJupiterV6RouteInstruction,
  jupiterExactInMinimumOut,
  validateJupiterSwapSimulation,
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
const JUPITER_ROUTE_DISCRIMINATOR = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);

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
    multiAtaSetup?: boolean;
    token2022Close?: boolean;
    foreignAtaOwner?: PublicKey;
    computeUnitLimit?: number;
    computeUnitPrice?: number;
    maliciousWalletTokenAccount?: PublicKey;
  } = {},
): {
  transaction: string;
  lookupTables: AddressLookupTableAccount[];
  walletAtas: Array<{ address: PublicKey; mint: PublicKey; tokenProgram: PublicKey }>;
} {
  const jupiter = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const eventAuthority = new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');
  const [programAuthority] = PublicKey.findProgramAddressSync([Buffer.from('authority')], jupiter);
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(opts.realisticRoute ? 2 : 1);
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(BigInt(amount), 0);
  tail.writeBigUInt64LE(BigInt(outAmount), 8);
  tail.writeUInt16LE(slippageBps, 16);
  const data = Buffer.concat([
    Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]),
    Buffer.from([0]),
    u32,
    Buffer.from([7, 100, 0, 1]), // Raydium route step
    ...(opts.realisticRoute ? [Buffer.from([7, 100, 1, 2])] : []),
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
  const nativeMint = new PublicKey('So11111111111111111111111111111111111111112');
  const intermediateMint = Keypair.generate().publicKey;
  const ataOwner = opts.foreignAtaOwner ?? payer;
  const makeAtaSetup = (mint: PublicKey, program: PublicKey, owner = ataOwner) => {
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
      ataProgram,
    );
    return {
      spec: { address, mint, tokenProgram: program },
      ix: new TransactionInstruction({
        programId: ataProgram,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: address, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: program, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    };
  };
  const clvSetup = makeAtaSetup(new PublicKey(CLV_MINT), token2022);
  const intermediateSetup = makeAtaSetup(intermediateMint, tokenProgram);
  const nativeSetup = makeAtaSetup(nativeMint, tokenProgram);
  const token2022TempSetup = makeAtaSetup(Keypair.generate().publicKey, token2022);
  const walletAtas = opts.multiAtaSetup
    ? [
        clvSetup.spec, intermediateSetup.spec, nativeSetup.spec,
        ...(opts.token2022Close ? [token2022TempSetup.spec] : []),
      ]
    : opts.includeAtaSetup || opts.duplicateAtaSetup
      ? [clvSetup.spec]
      : [];
  const closeNative = new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: nativeSetup.spec.address, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
  const wrapNative = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: nativeSetup.spec.address,
    lamports: 1_000_000,
  });
  const closeToken2022Temp = new TransactionInstruction({
    programId: token2022,
    keys: [
      { pubkey: token2022TempSetup.spec.address, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
  const instructions = [
    ...(opts.realisticRoute
      ? [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ]
      : []),
    ...(opts.computeUnitLimit !== undefined
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit })]
      : []),
    ...(opts.computeUnitPrice !== undefined
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPrice })]
      : []),
    ...(opts.includeAtaSetup ? [clvSetup.ix] : []),
    ...(opts.duplicateAtaSetup ? [clvSetup.ix, clvSetup.ix] : []),
    ...(opts.multiAtaSetup
      ? [
          clvSetup.ix, intermediateSetup.ix, nativeSetup.ix,
          ...(opts.token2022Close ? [token2022TempSetup.ix] : []),
        ]
      : []),
    ...(opts.multiAtaSetup ? [wrapNative] : []),
    ...(opts.arbitraryProgram
      ? [SystemProgram.transfer({ fromPubkey: payer, toPubkey: strangerKp.publicKey, lamports: 1 })]
      : []),
    ix,
    ...(opts.token2022Close ? [closeToken2022Temp] : []),
    ...(opts.multiAtaSetup ? [closeNative] : []),
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
    walletAtas,
  };
}

// ── the injectable harness ───────────────────────────────────────────────────
async function simulateClosedPostAccount(
  scenario: 'transient_fresh' | 'canonical_clv' | 'transient_with_balance',
) {
  const wallet = Keypair.generate().publicKey;
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const token2022Program = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const transientMint = new PublicKey('So11111111111111111111111111111111111111112');
  const [transientAta] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), tokenProgram.toBuffer(), transientMint.toBuffer()],
    ataProgram,
  );
  const usdcAta = findUsdcAta(wallet);
  const clvAta = findClvAta(wallet);
  const tokenInfo = (mint: PublicKey, program: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    wallet.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return {
      data,
      executable: false,
      lamports: 2_039_280,
      owner: program,
      rentEpoch: 0,
    };
  };
  const postTokenInfo = (mint: PublicKey, program: PublicKey, amount: bigint) => {
    const info = tokenInfo(mint, program, amount);
    return {
      ...info,
      data: [info.data.toString('base64'), 'base64'],
      owner: program.toBase58(),
    };
  };
  const closedPostInfo = {
    data: ['', 'base64'],
    executable: false,
    lamports: 0,
    owner: SystemProgram.programId.toBase58(),
    rentEpoch: 0,
  };
  const connection = {
    getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => {
      if (address.equals(transientAta)) {
        return scenario === 'transient_with_balance'
          ? tokenInfo(transientMint, tokenProgram, 10n)
          : null;
      }
      if (address.equals(usdcAta)) {
        return tokenInfo(new PublicKey(USDC_MINT_MAINNET), tokenProgram, 100_000n);
      }
      if (address.equals(clvAta)) {
        return tokenInfo(new PublicKey(CLV_MINT), token2022Program, 0n);
      }
      if (address.equals(wallet)) {
        return {
          data: Buffer.alloc(0), executable: false, lamports: 50_000_000,
          owner: SystemProgram.programId, rentEpoch: 0,
        };
      }
      return null;
    }),
    simulateTransaction: async (_transaction: VersionedTransaction, config: {
      accounts: { addresses: string[] };
    }) => ({
      context: { slot: 1 },
      value: {
        err: null,
        accounts: config.accounts.addresses.map((address) => {
          if (address === transientAta.toBase58()) return closedPostInfo;
          if (address === usdcAta.toBase58()) {
            return postTokenInfo(new PublicKey(USDC_MINT_MAINNET), tokenProgram, 61_776n);
          }
          if (address === clvAta.toBase58()) {
            return scenario === 'canonical_clv'
              ? closedPostInfo
              : postTokenInfo(new PublicKey(CLV_MINT), token2022Program, 1_000n);
          }
          if (address === wallet.toBase58()) {
            return {
              data: ['', 'base64'], executable: false, lamports: 49_995_000,
              owner: SystemProgram.programId.toBase58(), rentEpoch: 0,
            };
          }
          return null;
        }),
      },
    }),
  } as unknown as Connection;
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(buildSwapTxB64(wallet).transaction, 'base64'),
  );
  const result = await validateJupiterSwapSimulation({
    transaction,
    wallet,
    connection,
    inputAmount: 38_224n,
    minimumOutAmount: 1_000n,
    priorityFeeLamports: 0n,
    walletAtas: [{ address: transientAta, mint: transientMint, tokenProgram }],
  });
  return { result, transientAta };
}

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
  quoteAmounts?: { outAmountAtomic: string; otherAmountThresholdAtomic: string };
  priceImpactPct?: string;
  quoteRouteFee?: 'absent' | 'valid' | 'amount_only' | 'mint_only' | 'excessive' | 'wrong_mint';
  swapTxPayer?: PublicKey;
  swapTxMode?:
    | 'valid'
    | 'arbitrary_program'
    | 'extra_signer'
    | 'wrong_amount'
    | 'duplicate_ata'
    | 'realistic_route'
    | 'multi_ata'
    | 'token2022_close'
    | 'foreign_ata'
    | 'priority_within_budget'
    | 'priority_over_budget'
    | 'priority_without_limit'
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
  simulateClvShortfall?: boolean;
  simulateOtherTokenDecrease?: boolean;
  simulateErr?: boolean;
  simulateWalletLamportDecrease?: number;
  simulateMalformedLamports?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const queue = new Map<string, Record<string, unknown>>();
  for (const r of opts.queueRows ?? []) queue.set(r.id as string, { fills: [], ...r });
  const funding = new Map<string, Record<string, unknown>>();
  for (const f of opts.fundingRows ?? []) funding.set(f.sourceRef as string, { ...f });
  const checkouts = new Map<string, Record<string, unknown>>();
  for (const c of opts.checkouts ?? []) checkouts.set(c.id as string, { ...c });

  const quoteRequests: Harness['quoteRequests'] = [];
  const swapRequests: Harness['swapRequests'] = [];
  const sentRaw: Uint8Array[] = [];
  const sleeps: number[] = [];
  const alerts: Array<Record<string, unknown>> = [];
  const maliciousWalletTokenAccount = Keypair.generate().publicKey;
  let activeLookupTables: AddressLookupTableAccount[] = [];
  let activeWalletAtas: Array<{ address: PublicKey; mint: PublicKey; tokenProgram: PublicKey }> = [];
  let activeInputAmount = 0n;
  let activeMinimumOut = 0n;
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
        priceImpactPct: opts.priceImpactPct ?? '0.001',
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
            includeAtaSetup:
              request.destinationTokenAccount === undefined &&
              opts.swapTxMode !== 'multi_ata' && opts.swapTxMode !== 'foreign_ata' &&
              opts.swapTxMode !== 'token2022_close',
            duplicateAtaSetup: opts.swapTxMode === 'duplicate_ata',
            multiAtaSetup:
              opts.swapTxMode === 'multi_ata' || opts.swapTxMode === 'foreign_ata' ||
              opts.swapTxMode === 'token2022_close',
            token2022Close: opts.swapTxMode === 'token2022_close',
            foreignAtaOwner:
              opts.swapTxMode === 'foreign_ata' ? strangerKp.publicKey : undefined,
            computeUnitLimit:
              opts.swapTxMode === 'priority_within_budget' ? 1_000_000
                : opts.swapTxMode === 'priority_over_budget' ? 1_400_000
                  : undefined,
            computeUnitPrice:
              opts.swapTxMode === 'priority_within_budget' ? 900_000
                : opts.swapTxMode === 'priority_over_budget' ? 800_000
                  : opts.swapTxMode === 'priority_without_limit' ? 1
                    : undefined,
            realisticRoute:
              opts.swapTxMode === 'realistic_route' ||
              opts.swapTxMode === 'multi_ata' ||
              opts.swapTxMode === 'token2022_close' ||
              opts.swapTxMode === 'foreign_ata' ||
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
      activeWalletAtas = built.walletAtas;
      activeInputAmount = BigInt(quoteResponse.inAmount);
      activeMinimumOut = jupiterExactInMinimumOut(
        BigInt(quoteResponse.outAmount),
        quoteResponse.slippageBps,
      );
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
    extra: { delegate?: PublicKey; closeAuthority?: PublicKey; amount?: bigint } = {},
  ) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    authority.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(extra.amount ?? 0n, 64);
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
        return tokenAccountInfo(new PublicKey(USDC_MINT_MAINNET), swapKp.publicKey, tokenProgram, {
          amount: 999_999_999_999n,
        });
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
      const activeAta = activeWalletAtas.find((spec) => spec.address.equals(key));
      if (activeAta) {
        const isNative = activeAta.mint.toBase58() === 'So11111111111111111111111111111111111111112';
        if (
          (opts.swapTxMode === 'multi_ata' || opts.swapTxMode === 'foreign_ata' ||
            opts.swapTxMode === 'token2022_close') &&
          (!opts.simulateOtherTokenDecrease || isNative)
        ) return null;
        return tokenAccountInfo(activeAta.mint, swapKp.publicKey, activeAta.tokenProgram, {
          amount: opts.simulateOtherTokenDecrease ? 10n : 0n,
        });
      }
      if (key.equals(swapKp.publicKey)) {
        return {
          data: Buffer.alloc(0), executable: false, lamports: 50_000_000,
          owner: SystemProgram.programId, rentEpoch: 0,
        };
      }
      return null;
    }),
    simulateTransaction: async (_tx: VersionedTransaction, config: {
      accounts: { addresses: string[] };
    }) => {
      log.push('simulate');
      const usdcAta = findUsdcAta(swapKp.publicKey).toBase58();
      const clvAta = findClvAta(swapKp.publicKey).toBase58();
      const account = (
        mint: PublicKey,
        program: PublicKey,
        amount: bigint,
        lamports = 2_039_280,
      ) => {
        const info = tokenAccountInfo(mint, swapKp.publicKey, program, { amount });
        return {
          data: [info.data.toString('base64'), 'base64'], executable: false,
          lamports, owner: program.toBase58(), rentEpoch: 0,
        };
      };
      const accounts = config.accounts.addresses.map((address) => {
        if (address === usdcAta) {
          return account(
            new PublicKey(USDC_MINT_MAINNET), tokenProgram,
            999_999_999_999n - activeInputAmount,
          );
        }
        if (address === clvAta) {
          return account(
            new PublicKey(CLV_MINT), token2022Program,
            opts.simulateClvShortfall ? activeMinimumOut - 1n : activeMinimumOut,
          );
        }
        const spec = activeWalletAtas.find((candidate) => candidate.address.toBase58() === address);
        if (spec) {
          const isNative = spec.mint.toBase58() === 'So11111111111111111111111111111111111111112';
          if (isNative) return null; // Jupiter closes the transient wrapped-SOL ATA.
          return account(
            spec.mint, spec.tokenProgram,
            opts.simulateOtherTokenDecrease ? 9n : 0n,
          );
        }
        if (address === swapKp.publicKey.toBase58()) {
          return {
            data: ['', 'base64'], executable: false,
            lamports: 50_000_000 - (opts.simulateWalletLamportDecrease ?? 5_000),
            owner: SystemProgram.programId.toBase58(), rentEpoch: 0,
          };
        }
        return null;
      });
      return {
        context: { slot: 1 },
        value: {
          err: opts.simulateErr ? { InstructionError: [5, 'Custom'] } : null,
          accounts: opts.simulateMalformedLamports
            ? accounts.map((value, index) => index === 0 && value ? { ...value, lamports: Number.NaN } : value)
            : accounts,
        },
      };
    },
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
describe('validateJupiterSwapSimulation — closed transient ATA handling', () => {
  it('treats an invalid post snapshot for a fresh transient wallet ATA as closed', async () => {
    const { result } = await simulateClosedPostAccount('transient_fresh');
    expect(result).toEqual({ ok: true });
  });

  it('still rejects a closed canonical CLV ATA post snapshot', async () => {
    const { result } = await simulateClosedPostAccount('canonical_clv');
    expect(result).toEqual({ ok: false, detail: 'simulation_canonical_balance_missing' });
  });

  it('still rejects a closed transient ATA that held a pre-simulation balance', async () => {
    const { result, transientAta } = await simulateClosedPostAccount('transient_with_balance');
    expect(result).toEqual({
      ok: false,
      detail: `simulation_other_token_decrease:${transientAta.toBase58()}`,
    });
  });
});

describe('decodeJupiterV6RouteInstruction — route-agnostic trailing args', () => {
  it('decodes a route whose final hop is Pump.fun Amm variant 99 without an AMM allowlist', () => {
    const stepCount = Buffer.alloc(4);
    stepCount.writeUInt32LE(2);
    const args = Buffer.alloc(19);
    args.writeBigUInt64LE(100_000_000n, 0);
    args.writeBigUInt64LE(1_234_567_890n, 8);
    args.writeUInt16LE(200, 16);
    args[18] = 0;
    const data = Buffer.concat([
      JUPITER_ROUTE_DISCRIMINATOR,
      stepCount,
      Buffer.from([120, 50, 0, 1]), // unknown/new AMM variant, no payload
      Buffer.from([99, 50, 1, 2]), // Pump.fun Amm final hop, no payload
      args,
    ]);

    expect(decodeJupiterV6RouteInstruction(data)).toEqual({
      kind: 'route',
      inAmount: 100_000_000n,
      quotedOutAmount: 1_234_567_890n,
      slippageBps: 200,
      platformFeeBps: 0,
    });
  });

  it('rejects a truncated route and an unknown discriminator', () => {
    const tooShort = Buffer.alloc(8 + 4 + 19 - 1);
    JUPITER_ROUTE_DISCRIMINATOR.copy(tooShort);
    tooShort.writeUInt32LE(1, 8);

    const unknown = Buffer.alloc(8 + 4 + 19);
    unknown.fill(0xff, 0, 8);
    unknown.writeUInt32LE(1, 8);

    expect(decodeJupiterV6RouteInstruction(tooShort)).toBeNull();
    expect(decodeJupiterV6RouteInstruction(unknown)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps', () => {
  it('refuses when the funding is not swept — the claim is never taken', async () => {
    const h = makeHarness({ queueRows: [plannedQueueRow()] }); // no funding row
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'funding_not_swept' });
    expect(h.log).not.toContain('claimQueueRow');
    expect(h.log).not.toContain('loadSwapKeypair');
  });

  it('HAPPY PATH: $100 clip cap splits the row; conservation exact; executed', async () => {
    // $250 queued becomes two $100 clips and the exact $50 remainder.
    const h = makeHarness({
      queueRows: [plannedQueueRow({ amountUsdc: '250.000000' })],
      checkouts: [settledCheckout({ usdCents: 25_000 })],
      fundingRows: [sweptFundingRow({ amountUsdc: '250.000000' })],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.clipCount).toBe(3);

    expect(h.quoteRequests.map((q) => q.amount)).toEqual([
      '100000000',
      '100000000',
      '50000000',
    ]);
    // CONSERVATION: Σ clip µUSD === queued amount exactly.
    const sum = h.quoteRequests.reduce((a, q) => a + BigInt(q.amount), 0n);
    expect(sum).toBe(250_000_000n);
    expect(h.swapRequests.every((request) => request.wrapAndUnwrapSol === true)).toBe(true);

    const row = h.queue.get('q-1')!;
    expect(row.status).toBe('executed');
    expect(Number(row.executedPrice)).toBeGreaterThan(0);
    expect(Number(row.executedPrice)).toBeLessThan(0.001);
    expect((row.fills as unknown[]).length).toBe(3);

    // Capture-before-send holds for EVERY clip.
    const captures = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'appendClipFill')
      .map(([, i]) => i);
    const sends = h.log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l === 'sendRaw')
      .map(([, i]) => i);
    expect(captures.length).toBe(3);
    expect(sends.length).toBe(3);
    for (let i = 0; i < 3; i += 1) expect(captures[i]).toBeLessThan(sends[i]);

    // Spacing sleeps between clips (not after the last).
    expect(h.sleeps.length).toBe(2);

    // The atomic claim preceded custody.
    expect(h.log.indexOf('claimQueueRow')).toBeLessThan(h.log.indexOf('loadSwapKeypair'));
  });

  it('accounts from ExactIn threshold, never optimistic Jupiter outAmount', async () => {
    const optimisticOutAtomic = '80000000000';
    const guaranteedOutAtomic = jupiterExactInMinimumOut(
      BigInt(optimisticOutAtomic),
      200,
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

  it('does not call DexScreener on the money path', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.log).not.toContain('getPrice');
    expect(h.quoteRequests).toHaveLength(1);
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

  it('refuses Jupiter price impact above maxImpactBps before requesting a swap', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow({ maxPriceImpact: '0.0100' })],
      fundingRows: [sweptFundingRow()],
      priceImpactPct: '0.0101',
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'price_impact_exceeded', executedClips: 0 });
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  for (const priceImpactPct of ['', '   '] as const) {
    it(`rejects malformed priceImpactPct ${JSON.stringify(priceImpactPct)}`, async () => {
      const h = makeHarness({
        queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()], priceImpactPct,
      });
      const res = await executeQueuedClvBuy('q-1', h.deps);
      expect(res).toMatchObject({ ok: false, code: 'jupiter_quote_failed' });
      expect(h.swapRequests).toHaveLength(0);
      expect(h.queue.get('q-1')!.status).toBe('planned');
    });
  }

  it('rejects a zero-output Jupiter quote before requesting or signing a swap', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      quoteAmounts: { outAmountAtomic: '0', otherAmountThresholdAtomic: '0' },
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({
      ok: false, code: 'jupiter_quote_failed', detail: 'quote_zero_output',
    });
    expect(h.swapRequests).toHaveLength(0);
    expect(h.log).not.toContain('sendRaw');
  });

  it('ignores the informational wire threshold and accounts from the decoded instruction floor', async () => {
    const quotedOut = Math.floor((5 / PRICE) * 0.98 * 1e6);
    const h = makeHarness({
      queueRows: [plannedQueueRow({ maxSlippage: '0.0500' })],
      fundingRows: [sweptFundingRow()],
      quoteAmounts: {
        outAmountAtomic: String(quotedOut),
        otherAmountThresholdAtomic: String(Math.floor(quotedOut * 0.5)),
      },
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    const fill = (h.queue.get('q-1')!.fills as Array<{ outAmountAtomic: string }>)[0];
    expect(fill?.outAmountAtomic).toBe(
      jupiterExactInMinimumOut(BigInt(quotedOut), 500).toString(),
    );
    expect(fill?.outAmountAtomic).not.toBe(String(Math.floor(quotedOut * 0.5)));
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

  it('accepts a real multi-hop route with three wallet-owned idempotent ATA setups', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()],
      fundingRows: [sweptFundingRow()],
      swapTxMode: 'multi_ata',
      clvAtaExists: false,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res.ok).toBe(true);
    expect(h.lookupRequests).toHaveLength(1);
    expect(h.log).toContain('simulate');
    expect(h.sentRaw).toHaveLength(1);
  });

  it('rejects an idempotent ATA setup whose owner is not the swap wallet', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      swapTxMode: 'foreign_ata', clvAtaExists: false,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed', executedClips: 0 });
    expect(h.log).not.toContain('sendRaw');
    expect(h.log).toContain('releaseQueueClaim');
  });

  it('accepts a high CU price when the decoded total priority fee stays within budget', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      swapTxMode: 'priority_within_budget',
    });
    expect(await executeQueuedClvBuy('q-1', h.deps)).toMatchObject({ ok: true });
  });

  for (const mode of ['priority_over_budget', 'priority_without_limit'] as const) {
    it(`rejects invalid total-priority-fee shape: ${mode}`, async () => {
      const h = makeHarness({
        queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()], swapTxMode: mode,
      });
      const res = await executeQueuedClvBuy('q-1', h.deps);
      expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed' });
      expect(h.log).not.toContain('sendRaw');
    });
  }

  it('rejects simulation when CLV output is below the decoded on-chain minimum', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      simulateClvShortfall: true,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed' });
    expect(h.log).toContain('simulate');
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('rejects simulation when another wallet-owned token account decreases', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      swapTxMode: 'multi_ata', clvAtaExists: false, simulateOtherTokenDecrease: true,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed' });
    expect(h.log).toContain('simulate');
    expect(h.log).not.toContain('sendRaw');
    expect(h.queue.get('q-1')!.status).toBe('planned');
  });

  it('bounds native lamport loss by the transaction actual priority fee, not the global maximum', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      // This transaction carries no priority fee, so a 20k lamport decrease
      // exceeds the 5k signature fee plus the deliberately small headroom.
      simulateWalletLamportDecrease: 20_000,
    });
    const res = await executeQueuedClvBuy('q-1', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'swap_tx_binding_failed' });
    expect(h.log).not.toContain('sendRaw');
  });

  it('releases an empty unsigned claim if malformed simulation data throws during parsing', async () => {
    const h = makeHarness({
      queueRows: [plannedQueueRow()], fundingRows: [sweptFundingRow()],
      simulateMalformedLamports: true,
    });
    await expect(executeQueuedClvBuy('q-1', h.deps)).rejects.toThrow();
    expect(h.queue.get('q-1')!.status).toBe('planned');
    expect(h.log).toContain('releaseQueueClaim');
    expect(h.log).not.toContain('appendClipFill');
    expect(h.log).not.toContain('sendRaw');
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

describe('resolveClvSwapSlippageBps — executable default + bounds', () => {
  it('defaults to 200 bps while remaining environment-overridable', () => {
    delete process.env.CLV_SWAP_SLIPPAGE_BPS;
    expect(resolveClvSwapSlippageBps()).toBe(200);
    process.env.CLV_SWAP_SLIPPAGE_BPS = '350';
    expect(resolveClvSwapSlippageBps()).toBe(350);
    delete process.env.CLV_SWAP_SLIPPAGE_BPS;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pure sizing helpers', () => {
  it('sizeClipMicro caps every clip at exactly $100 USDC and preserves the remainder', () => {
    expect(sizeClipMicro(1_000_000_000n)).toBe(100_000_000n);
    expect(sizeClipMicro(50_000_000n)).toBe(50_000_000n);
    expect(sizeClipMicro(1n)).toBe(1n);
  });
});
