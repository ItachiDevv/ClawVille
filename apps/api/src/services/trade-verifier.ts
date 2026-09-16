import bs58 from 'bs58';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import {
  TRADE_DEX_PROGRAMS,
  TRADE_DAILY_SCORED_CAP,
  resolveTradeMultiplierTier,
  type TradeDex,
  type TradeMultiplierTier,
  type TradeUnscoredReason,
} from '@clawville/shared';
import { decodeJupiterV6RouteInstruction } from './clv-swap-live';

export interface MintDelta { mint: string; delta: string; decimals: number }
export const TRADE_REJECT_REASONS = [
  'dex_not_recognized',
  'dex_discriminator_unknown',
  'wallet_not_signer',
  'token_account_not_owned',
  'vault_flow_mismatch',
  'no_net_movement',
  'single_sided',
  'multi_leg',
  'same_mint',
] as const;
export type TradeRejectReason = (typeof TRADE_REJECT_REASONS)[number];

export type DecodedSwap =
  | { kind: 'not_found'; signature: string }
  | { kind: 'tx_failed'; signature: string; blockTime: number | null }
  | { kind: 'rejected'; signature: string; blockTime: number | null; reason: TradeRejectReason; dex: TradeDex | null }
  | { kind: 'swap'; signature: string; blockTime: number | null; slot: number; dex: TradeDex; wallet: string;
      inputMint: string; inputAmount: string; inputDecimals: number;
      outputMint: string; outputAmount: string; outputDecimals: number; deltas: MintDelta[] };

export const SOL_DUST_LAMPORTS = 1_000_000n;
export const MAX_PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS = 2_500_000n;

const accountKeySchema = z.union([
  z.string(),
  z.object({ pubkey: z.string(), signer: z.boolean().optional(), writable: z.boolean().optional() }).passthrough(),
]);
const tokenBalanceSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().optional(),
  programId: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0).max(18) }).passthrough(),
}).passthrough();
const compiledInstructionSchema = z.object({
  programIdIndex: z.number().int().nonnegative().optional(),
  programId: z.union([z.string(), z.object({ toString: z.function().optional() }).passthrough()]).optional(),
  accounts: z.array(z.union([z.number().int().nonnegative(), z.string()])).optional(),
  data: z.string().optional(),
}).passthrough();
const parsedTransactionSchema = z.object({
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  meta: z.object({
    err: z.unknown().nullable(),
    fee: z.number().int().nonnegative(),
    preBalances: z.array(z.number().int().nonnegative()),
    postBalances: z.array(z.number().int().nonnegative()),
    preTokenBalances: z.array(tokenBalanceSchema).optional().default([]),
    postTokenBalances: z.array(tokenBalanceSchema).optional().default([]),
    innerInstructions: z.array(z.object({ index: z.number().int(), instructions: z.array(compiledInstructionSchema) }).passthrough()).optional().default([]),
    loadedAddresses: z.object({ writable: z.array(z.string()), readonly: z.array(z.string()) }).optional(),
    logMessages: z.array(z.string()).nullable().optional(),
  }).passthrough().nullable(),
  transaction: z.object({
    message: z.object({ accountKeys: z.array(accountKeySchema), instructions: z.array(compiledInstructionSchema) }).passthrough(),
  }).passthrough(),
}).passthrough();

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

// Official sources: pump-fun/pump-public-docs idl/pump_amm.json and idl/pump.json.
// Both IDLs publish the same Anchor buy and sell discriminators.
const PUMP_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const PUMP_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

function keyText(key: z.infer<typeof accountKeySchema>): string {
  return typeof key === 'string' ? key : key.pubkey;
}

function instructionProgram(ix: z.infer<typeof compiledInstructionSchema>, keys: string[]): string | null {
  if (typeof ix.programId === 'string') return ix.programId;
  if (ix.programId && typeof ix.programId.toString === 'function') return String(ix.programId.toString());
  return ix.programIdIndex === undefined ? null : keys[ix.programIdIndex] ?? null;
}

function instructionAccounts(ix: z.infer<typeof compiledInstructionSchema>, keys: string[]): string[] {
  return (ix.accounts ?? []).map((account) => typeof account === 'number' ? keys[account] : account).filter((v): v is string => !!v);
}

function discriminatorMatches(dex: TradeDex, data: Uint8Array): boolean {
  if (dex === 'jupiter') return decodeJupiterV6RouteInstruction(data) !== null;
  const head = Buffer.from(data).subarray(0, 8);
  return head.equals(PUMP_BUY) || head.equals(PUMP_SELL);
}

export function decodeSwapFromParsedTransaction(input: {
  signature: string;
  raw: unknown | null;
  expectedWallet?: string | null;
}): DecodedSwap {
  z.object({ signature: z.string().min(1), raw: z.unknown().nullable(), expectedWallet: z.string().nullable().optional() }).strict().parse(input);
  if (input.raw === null) return { kind: 'not_found', signature: input.signature };
  const parsed = parsedTransactionSchema.parse(input.raw);
  if (parsed.meta === null) throw new Error('parsed transaction meta is null');
  if (parsed.meta.err !== null) return { kind: 'tx_failed', signature: input.signature, blockTime: parsed.blockTime };

  const staticKeys = parsed.transaction.message.accountKeys.map(keyText);
  const keys = [...staticKeys, ...(parsed.meta.loadedAddresses?.writable ?? []), ...(parsed.meta.loadedAddresses?.readonly ?? [])];
  const wallet = input.expectedWallet ?? staticKeys[0];
  if (!wallet) throw new Error('parsed transaction has no account keys');
  const walletIndex = keys.indexOf(wallet);
  const staticWallet = parsed.transaction.message.accountKeys[walletIndex];
  const walletSigner = walletIndex >= 0 && walletIndex < staticKeys.length
    && (typeof staticWallet === 'string' ? walletIndex === 0 : staticWallet.signer === true);
  if (!walletSigner) return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'wallet_not_signer', dex: null };

  const instructions = [
    ...parsed.transaction.message.instructions,
    ...parsed.meta.innerInstructions.flatMap((group) => group.instructions),
  ];
  let dexSeen: TradeDex | null = null;
  let dex: TradeDex | null = null;
  let matchedIx: z.infer<typeof compiledInstructionSchema> | null = null;
  for (const candidate of ['jupiter', 'pumpswap', 'pumpfun'] as const) {
    const programInstructions = instructions.filter((ix) => instructionProgram(ix, keys) === TRADE_DEX_PROGRAMS[candidate]);
    if (programInstructions.length === 0) continue;
    dexSeen ??= candidate;
    for (const ix of programInstructions) {
      if (!ix.data) continue;
      let bytes: Uint8Array;
      try { bytes = bs58.decode(ix.data); } catch { continue; }
      if (discriminatorMatches(candidate, bytes)) {
        dex = candidate;
        matchedIx = ix;
        break;
      }
    }
    if (dex) break;
  }
  if (!dexSeen) return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'dex_not_recognized', dex: null };
  if (!dex || !matchedIx) return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'dex_discriminator_unknown', dex: dexSeen };
  const matchedAccounts = new Set(instructionAccounts(matchedIx, keys));

  const pre = new Map<number, z.infer<typeof tokenBalanceSchema>>();
  const post = new Map<number, z.infer<typeof tokenBalanceSchema>>();
  for (const balance of parsed.meta.preTokenBalances) pre.set(balance.accountIndex, balance);
  for (const balance of parsed.meta.postTokenBalances) post.set(balance.accountIndex, balance);
  const aggregate = new Map<string, { delta: bigint; decimals: number }>();
  const walletAccountDeltas: Array<{ account: string | null; mint: string; delta: bigint }> = [];
  const tokenAccountDeltas: Array<{
    account: string | null;
    owner: string | undefined;
    delta: bigint;
  }> = [];
  for (const accountIndex of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const sample = after ?? before;
    if (!sample) continue;
    const owner = after?.owner ?? before?.owner;
    const programId = after?.programId ?? before?.programId;
    if (programId && !TOKEN_PROGRAMS.has(programId)) continue;
    const beforeAmount = BigInt(before?.uiTokenAmount.amount ?? '0');
    const afterAmount = BigInt(after?.uiTokenAmount.amount ?? '0');
    const delta = afterAmount - beforeAmount;
    const account = keys[accountIndex] ?? null;
    tokenAccountDeltas.push({ account, owner, delta });
    if (owner !== wallet) continue;
    walletAccountDeltas.push({ account, mint: sample.mint, delta });
    const current = aggregate.get(sample.mint) ?? { delta: 0n, decimals: sample.uiTokenAmount.decimals };
    current.delta += delta;
    aggregate.set(sample.mint, current);
  }

  const nativeBefore = parsed.meta.preBalances[walletIndex];
  const nativeAfter = parsed.meta.postBalances[walletIndex];
  if (nativeBefore !== undefined && nativeAfter !== undefined) {
    let delta = BigInt(nativeAfter) - BigInt(nativeBefore);
    if (walletIndex === 0) delta += BigInt(parsed.meta.fee);
    if (dex === 'pumpswap') {
      try {
        const [accumulator] = PublicKey.findProgramAddressSync(
          [Buffer.from('user_volume_accumulator'), new PublicKey(wallet).toBuffer()],
          new PublicKey(TRADE_DEX_PROGRAMS.pumpswap),
        );
        const accumulatorIndex = keys.indexOf(accumulator.toBase58());
        if (accumulatorIndex >= 0) {
          const beforeRent = BigInt(parsed.meta.preBalances[accumulatorIndex] ?? 0);
          const afterRent = BigInt(parsed.meta.postBalances[accumulatorIndex] ?? 0);
          const createdRent = afterRent - beforeRent;
          if (beforeRent === 0n && createdRent > 0n && createdRent <= MAX_PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS) {
            delta += createdRent;
          }
        }
      } catch {
        // A malformed wallet was already rejected at the signer boundary.
      }
    }
    if (delta > SOL_DUST_LAMPORTS || delta < -SOL_DUST_LAMPORTS) {
      const wsol = 'So11111111111111111111111111111111111111112';
      const current = aggregate.get(wsol) ?? { delta: 0n, decimals: 9 };
      current.delta += delta;
      aggregate.set(wsol, current);
    }
  }

  const deltas: MintDelta[] = [...aggregate.entries()]
    .filter(([, value]) => value.delta !== 0n)
    .map(([mint, value]) => ({ mint, delta: value.delta.toString(), decimals: value.decimals }));
  const walletLegAccounts = walletAccountDeltas.filter((entry) => entry.delta !== 0n);
  if (walletLegAccounts.some((entry) => entry.account === null || !matchedAccounts.has(entry.account))) {
    return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'vault_flow_mismatch', dex };
  }
  if (deltas.length === 0) {
    const nonzeroAccounts = walletAccountDeltas.filter((entry) => entry.delta !== 0n);
    if (nonzeroAccounts.some((negative) => negative.delta < 0n
      && nonzeroAccounts.some((positive) => positive.delta > 0n && positive.mint === negative.mint))) {
      return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'same_mint', dex };
    }
    return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'no_net_movement', dex };
  }
  const negatives = deltas.filter((value) => BigInt(value.delta) < 0n);
  const positives = deltas.filter((value) => BigInt(value.delta) > 0n);
  if (negatives.length === 0 || positives.length === 0) {
    const foreignCounterpart = tokenAccountDeltas.some((entry) => entry.account !== null
      && matchedAccounts.has(entry.account)
      && entry.owner !== undefined
      && entry.owner !== wallet
      && ((negatives.length > 0 && positives.length === 0 && entry.delta > 0n)
        || (positives.length > 0 && negatives.length === 0 && entry.delta < 0n)));
    return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime,
      reason: foreignCounterpart ? 'token_account_not_owned' : 'single_sided', dex };
  }
  if (negatives.length !== 1 || positives.length !== 1) return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'multi_leg', dex };
  if (negatives[0].mint === positives[0].mint) return { kind: 'rejected', signature: input.signature, blockTime: parsed.blockTime, reason: 'same_mint', dex };
  return {
    kind: 'swap', signature: input.signature, blockTime: parsed.blockTime, slot: parsed.slot, dex, wallet,
    inputMint: negatives[0].mint, inputAmount: (-BigInt(negatives[0].delta)).toString(), inputDecimals: negatives[0].decimals,
    outputMint: positives[0].mint, outputAmount: positives[0].delta, outputDecimals: positives[0].decimals, deltas,
  };
}

export type TradeScoreVerdict =
  | { scored: true; tier: TradeMultiplierTier }
  | { scored: false; reason: TradeUnscoredReason };

export function scoreTrade(input: {
  notionalUsd: number | null; minNotionalUsd: number; slot: number; blockTime: number | null;
  boundSlot: number; scoredTodayForAvatar: number; dailyScoredCap: number;
  inputMint: string; outputMint: string; pairAlreadyScoredToday: boolean;
}): TradeScoreVerdict {
  z.object({
    notionalUsd: z.number().nonnegative().nullable(), minNotionalUsd: z.number().nonnegative(),
    slot: z.number().int().nonnegative(), blockTime: z.number().int().nullable(), boundSlot: z.number().int().nonnegative(),
    scoredTodayForAvatar: z.number().int().nonnegative(), dailyScoredCap: z.number().int().min(0).max(TRADE_DAILY_SCORED_CAP),
    inputMint: z.string().min(1), outputMint: z.string().min(1), pairAlreadyScoredToday: z.boolean(),
  }).strict().parse(input);
  if (input.slot <= input.boundSlot) return { scored: false, reason: 'pre_bind' };
  if (input.blockTime === null) return { scored: false, reason: 'chain_time_unavailable' };
  if (input.notionalUsd === null) return { scored: false, reason: 'price_unavailable' };
  if (input.notionalUsd < input.minNotionalUsd) return { scored: false, reason: 'below_min_notional' };
  if (input.pairAlreadyScoredToday) return { scored: false, reason: 'pair_repeat_today' };
  if (input.scoredTodayForAvatar >= input.dailyScoredCap) return { scored: false, reason: 'daily_cap' };
  return { scored: true, tier: resolveTradeMultiplierTier(input.inputMint, input.outputMint) };
}
