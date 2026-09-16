import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import {
  and, avatars, db, desc, eq, inArray, isNull, sql, tradingWallets, verifiedTrades,
  type VerifiedTrade,
} from '@clawville/database';
import {
  TRADE_DAILY_SCORED_CAP, TRADE_MIN_NOTIONAL_USD_DEFAULT, TRADE_MIN_NOTIONAL_USD_FLOOR,
  TRADE_TIER_MULTIPLIER, resolveTradeMultiplierTier,
  type TradeDex, type TradeMultiplierTier, type TradeUnscoredReason,
} from '@clawville/shared';
import type { TradingSubject } from './trading-wallet-challenge';
import {
  advanceTradingWalletCursor, resolveBoundTradingWallets, withTradingWalletLease,
  type BoundTradingWallet,
} from './trading-wallets';
import { decodeSwapFromParsedTransaction, scoreTrade, type TradeRejectReason } from './trade-verifier';
import { resolveTradeNotionalUsd, type NotionalSource } from './trade-price';
import { logVerifiedTradeEventTx, recordVerifiedTradeEventFailure } from './event-logger';
import { alertError } from './alert-error';
import { broadcastTradeEvent } from '../routes/world';

/** Identifiers a verified trade can offer WITHOUT floor-core knowing anything
 *  about fleet tables. `decisionId` is non-null only when a prime supplied it
 *  (frozen spec §5.15); `signature` is always present and is the fleet's own
 *  fallback key, since they persist it on their decision row under a unique
 *  partial index. */
export interface TradeVerifiedNotice {
  signature: string;
  decisionId: string | null;
  avatarId: string;
  tradingWalletId: string;
}

/** Fire-and-forget, invoked AFTER COMMIT. MUST be idempotent: floor-core does
 *  not guarantee once-only delivery and a reconciler may re-invoke it. */
export type TradeVerifiedCallback = (notice: TradeVerifiedNotice) => Promise<void>;

export interface TradeObserverDeps {
  getSignaturesForAddress(address: string, options: { before?: string; until?: string; limit: number }): Promise<unknown>;
  getParsedTransaction(signature: string): Promise<unknown | null>;
  now(): number;
}

interface TradeObserverTickRuntime {
  resolveWallets(): Promise<BoundTradingWallet[]>;
  withLease: typeof withTradingWalletLease;
  ingest: typeof ingestTradeSignature;
  advanceCursor: typeof advanceTradingWalletCursor;
  alert: typeof alertError;
}

export interface VerifiedTradeDTO {
  signature: string; dex: TradeDex; inputMint: string; outputMint: string;
  inputAmount: string; outputAmount: string; inputDecimals: number; outputDecimals: number;
  notionalUsd: number | null; notionalSource: NotionalSource | null;
  multiplierTier: TradeMultiplierTier; multiplier: 1 | 1.5 | 2;
  scored: boolean; unscoredReason: TradeUnscoredReason | null;
  blockTime: number | null; verifiedAt: string; wallet: string;
  operatedByClawville: boolean; decisionId: string | null;
}

export type PublicTradeDTO = Omit<VerifiedTradeDTO, 'wallet'> & {
  subject: { type: 'avatar' | 'agent'; id: string; avatarName: string | null };
};

export interface TradeIngestOutcome {
  signature: string; inserted: boolean; scored: boolean;
  reason: TradeUnscoredReason | null; trade: VerifiedTradeDTO | null;
}

export class TradeReportError extends Error {
  constructor(readonly code: 'signature_not_found' | 'tx_failed' | 'not_a_swap' | 'signature_already_claimed' | 'wallet_not_bound' | 'upstream_unavailable' | 'settlement_write_failed',
    readonly status: 404 | 409 | 422 | 503, readonly detail?: TradeRejectReason) { super(code); }
}

const signatureRowsSchema = z.array(z.object({ signature: z.string(), slot: z.number().int(), blockTime: z.number().int().nullable() }).passthrough());
const TRADE_VERIFIED_CALLBACK_TIMEOUT_MS = 5_000;
let observerTimer: ReturnType<typeof setInterval> | null = null;
let observerRunning = false;
let lastTickAt: string | null = null;
let tradeVerifiedCallback: TradeVerifiedCallback | null = null;

/** Register the fleet-owned promotion callback. A second registration replaces
 *  the first callback and warns because it indicates a boot wiring defect. */
export function registerTradeVerifiedCallback(cb: TradeVerifiedCallback): () => void {
  if (tradeVerifiedCallback !== null) {
    console.warn('[trade-observer] replacing an already registered trade-verified callback');
  }
  tradeVerifiedCallback = cb;
  return () => {
    if (tradeVerifiedCallback === cb) tradeVerifiedCallback = null;
  };
}

/** Test-only. */
export function _clearTradeVerifiedCallbackForTest(): void {
  tradeVerifiedCallback = null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`trade-verified callback timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function onTradeVerified(notice: TradeVerifiedNotice): Promise<void> {
  const cb = tradeVerifiedCallback;
  if (cb === null) return;
  try {
    await withTimeout(cb(notice), TRADE_VERIFIED_CALLBACK_TIMEOUT_MS);
  } catch {
    try {
      await alertError({
        severity: 'warning',
        source: 'trade-observer',
        message: 'trade-verified callback failed; decision promotion may be pending',
        context: { signature: notice.signature, decisionId: notice.decisionId },
      });
    } catch (alertFailure) {
      console.warn('[trade-observer] callback failure alert failed', alertFailure);
    }
  }
}

function safeObserverError(error: unknown): string {
  const key = process.env.HELIUS_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return key ? message.replaceAll(key, '[REDACTED]') : message;
}

function observerEnabled(): boolean {
  const value = process.env.TRADE_OBSERVER_ENABLED?.trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function tradeObserverRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : 'https://api.mainnet-beta.solana.com';
}

export function createDefaultTradeObserverDeps(): TradeObserverDeps {
  const connection = new Connection(tradeObserverRpcUrl(), 'confirmed');
  return {
    getSignaturesForAddress: (address, options) => connection.getSignaturesForAddress(new PublicKey(address), options, 'confirmed'),
    getParsedTransaction: (signature) => connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
    now: () => Date.now(),
  };
}

function toDto(row: VerifiedTrade, operatedByClawville: boolean): VerifiedTradeDTO {
  const tier = row.multiplierTier as TradeMultiplierTier;
  return {
    signature: row.signature, dex: row.dex as TradeDex, inputMint: row.inputMint, outputMint: row.outputMint,
    inputAmount: row.inputAmount, outputAmount: row.outputAmount, inputDecimals: row.inputDecimals,
    outputDecimals: row.outputDecimals, notionalUsd: row.notionalUsd === null ? null : Number(row.notionalUsd),
    notionalSource: row.notionalSource as NotionalSource | null, multiplierTier: tier,
    multiplier: TRADE_TIER_MULTIPLIER[tier] as 1 | 1.5 | 2, scored: row.scored,
    unscoredReason: row.unscoredReason as TradeUnscoredReason | null, blockTime: row.blockTime,
    verifiedAt: row.verifiedAt.toISOString(), wallet: row.wallet, operatedByClawville, decisionId: row.decisionId,
  };
}

async function dtoForRow(row: VerifiedTrade): Promise<VerifiedTradeDTO> {
  const wallet = row.tradingWalletId
    ? await db.select({ operated: tradingWallets.operatedByClawville }).from(tradingWallets).where(eq(tradingWallets.id, row.tradingWalletId)).limit(1)
    : [];
  return toDto(row, wallet[0]?.operated ?? false);
}

function minNotionalUsd(): number {
  const configured = Number(process.env.TRADE_MIN_NOTIONAL_USD ?? TRADE_MIN_NOTIONAL_USD_DEFAULT);
  return Number.isFinite(configured) ? Math.max(TRADE_MIN_NOTIONAL_USD_FLOOR, configured) : TRADE_MIN_NOTIONAL_USD_DEFAULT;
}

function dailyCap(): number {
  const configured = Number(process.env.TRADE_DAILY_SCORED_CAP ?? TRADE_DAILY_SCORED_CAP);
  return Number.isFinite(configured) ? Math.max(0, Math.min(TRADE_DAILY_SCORED_CAP, Math.floor(configured))) : TRADE_DAILY_SCORED_CAP;
}

function utcScoreDay(blockTime: number): string {
  const instant = new Date(blockTime * 1_000);
  return instant.toISOString().slice(0, 10);
}

export async function ingestTradeSignature(input: {
  wallet: BoundTradingWallet; signature: string; source: 'observer' | 'report' | 'prime';
  decisionId?: string; parsedTransaction?: unknown; deps?: TradeObserverDeps;
}): Promise<TradeIngestOutcome> {
  const deps = input.deps ?? createDefaultTradeObserverDeps();
  const raw = input.parsedTransaction ?? await deps.getParsedTransaction(input.signature);
  const decoded = decodeSwapFromParsedTransaction({ signature: input.signature, raw, expectedWallet: input.wallet.pubkey });
  if (decoded.kind === 'not_found') throw new TradeReportError('signature_not_found', 404);
  if (decoded.kind === 'tx_failed') throw new TradeReportError('tx_failed', 409);
  if (decoded.kind === 'rejected') throw new TradeReportError('not_a_swap', 422, decoded.reason);
  const notional = await resolveTradeNotionalUsd({
    inputMint: decoded.inputMint, inputAmount: decoded.inputAmount, inputDecimals: decoded.inputDecimals,
    outputMint: decoded.outputMint, outputAmount: decoded.outputAmount, outputDecimals: decoded.outputDecimals,
    blockTime: decoded.blockTime, nowMs: deps.now(),
  });
  const tier = resolveTradeMultiplierTier(decoded.inputMint, decoded.outputMint);
  const scoreDay = decoded.blockTime === null ? null : utcScoreDay(decoded.blockTime);
  let attempted: VerifiedTrade | null = null;
  let committed: VerifiedTrade | null = null;
  let inserted = false;
  let enriched = false;
  try {
    committed = await db.transaction(async (tx) => {
      if (scoreDay) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trade-day:${input.wallet.avatarId}:${scoreDay}`}, 0))`);
      const provisional = await tx.insert(verifiedTrades).values({
        signature: input.signature, tradingWalletId: input.wallet.id, subjectKind: input.wallet.subjectKind,
        userId: input.wallet.userId, avatarId: input.wallet.avatarId, agentId: input.wallet.agentId,
        wallet: input.wallet.pubkey, dex: decoded.dex, inputMint: decoded.inputMint, outputMint: decoded.outputMint,
        inputAmount: decoded.inputAmount, outputAmount: decoded.outputAmount, inputDecimals: decoded.inputDecimals,
        outputDecimals: decoded.outputDecimals, notionalUsd: notional.notionalUsd?.toFixed(6) ?? null,
        notionalSource: notional.source, multiplierTier: tier, scored: false, unscoredReason: 'daily_cap',
        blockTime: decoded.blockTime, slot: decoded.slot, scoreDay,
        decisionId: input.decisionId ?? null, source: input.source,
      }).onConflictDoNothing({ target: verifiedTrades.signature }).returning();
      if (!provisional[0]) {
        const existing = await tx.select().from(verifiedTrades).where(eq(verifiedTrades.signature, input.signature)).limit(1);
        if (!existing[0]) throw new Error('conflicted trade row is unavailable');
        if (input.source === 'prime' && input.decisionId
          && existing[0].tradingWalletId === input.wallet.id
          && existing[0].avatarId === input.wallet.avatarId
          && existing[0].decisionId === null) {
          const enrichedRows = await tx.update(verifiedTrades).set({ decisionId: input.decisionId }).where(and(
            eq(verifiedTrades.signature, input.signature),
            eq(verifiedTrades.tradingWalletId, input.wallet.id),
            eq(verifiedTrades.avatarId, input.wallet.avatarId),
            isNull(verifiedTrades.decisionId),
          )).returning();
          enriched = enrichedRows.length === 1;
          return enrichedRows[0] ?? existing[0];
        }
        return existing[0];
      }
      inserted = true;
      let scoredToday = 0;
      let pairAlready = false;
      if (scoreDay) {
        const today = await tx.select({ signature: verifiedTrades.signature, inputMint: verifiedTrades.inputMint, outputMint: verifiedTrades.outputMint, scored: verifiedTrades.scored })
          .from(verifiedTrades).where(and(
            eq(verifiedTrades.avatarId, input.wallet.avatarId),
            eq(verifiedTrades.scoreDay, scoreDay),
          ));
        const pair = [decoded.inputMint, decoded.outputMint].sort().join(':');
        scoredToday = today.filter((row) => row.signature !== input.signature && row.scored).length;
        pairAlready = today.some((row) => row.signature !== input.signature && row.scored && [row.inputMint, row.outputMint].sort().join(':') === pair);
      }
      const verdict = notional.reason
        ? { scored: false as const, reason: notional.reason }
        : scoreTrade({ notionalUsd: notional.notionalUsd, minNotionalUsd: minNotionalUsd(), slot: decoded.slot,
            blockTime: decoded.blockTime, boundSlot: input.wallet.boundSlot, scoredTodayForAvatar: scoredToday,
            dailyScoredCap: dailyCap(), inputMint: decoded.inputMint, outputMint: decoded.outputMint,
            pairAlreadyScoredToday: pairAlready });
      const finalRows = await tx.update(verifiedTrades).set({
        scored: verdict.scored,
        unscoredReason: verdict.scored ? null : verdict.reason,
        multiplierTier: verdict.scored ? verdict.tier : tier,
      }).where(eq(verifiedTrades.signature, input.signature)).returning();
      const finalRow = finalRows[0];
      if (!finalRow) throw new Error('trade final update returned no row');
      attempted = finalRow;
      if (finalRow.scored) {
        const eventId = await logVerifiedTradeEventTx(tx, finalRow);
        const stamped = await tx.update(verifiedTrades).set({ eventId }).where(eq(verifiedTrades.signature, input.signature)).returning();
        return stamped[0] ?? finalRow;
      }
      return finalRow;
    });
  } catch (error) {
    const failedAttempt = attempted as VerifiedTrade | null;
    if (failedAttempt?.scored) {
      await recordVerifiedTradeEventFailure(failedAttempt, error);
      // The observer keeps the primary error so its per-wallet loop records the
      // fault and continues. The report surface converts the same rollback into
      // its stable retryable wire code.
      if (input.source === 'report') throw new TradeReportError('settlement_write_failed', 503);
    }
    throw error;
  }
  if (!committed) throw new Error('trade transaction returned no row');
  if (inserted || enriched) {
    await onTradeVerified({
      signature: committed.signature,
      decisionId: committed.decisionId,
      avatarId: committed.avatarId ?? input.wallet.avatarId,
      tradingWalletId: committed.tradingWalletId ?? input.wallet.id,
    });
  }
  const dto = await dtoForRow(committed);
  if (inserted || enriched) {
    const name = committed.avatarId ? await db.select({ name: avatars.name }).from(avatars).where(eq(avatars.id, committed.avatarId)).limit(1) : [];
    broadcastTradeEvent({
      type: 'trade.verified', signature: committed.signature,
      subject: { type: committed.subjectKind as 'avatar' | 'agent', id: committed.agentId ?? committed.avatarId ?? '', avatarName: name[0]?.name ?? null },
      inputMint: committed.inputMint, outputMint: committed.outputMint,
      notionalUsd: committed.notionalUsd === null ? null : Number(committed.notionalUsd), dex: committed.dex as TradeDex,
      blockTime: committed.blockTime, multiplier: dto.multiplier, scored: committed.scored,
      operatedByClawville: dto.operatedByClawville, decisionId: committed.decisionId,
      unscoredReason: committed.unscoredReason as TradeUnscoredReason | null,
    });
  }
  return { signature: input.signature, inserted, scored: committed.scored,
    reason: committed.unscoredReason as TradeUnscoredReason | null, trade: dto };
}

function rawSignerKeys(raw: unknown): string[] {
  const shape = z.object({ transaction: z.object({ message: z.object({ accountKeys: z.array(z.union([
    z.string(), z.object({ pubkey: z.string(), signer: z.boolean().optional() }).passthrough(),
  ])) }).passthrough() }).passthrough() }).passthrough().parse(raw);
  return shape.transaction.message.accountKeys.flatMap((key, index) => {
    if (typeof key === 'string') return index === 0 ? [key] : [];
    return key.signer === true || index === 0 ? [key.pubkey] : [];
  });
}

export async function reportTradeSignature(input: {
  subject: TradingSubject; signature: string; deps?: TradeObserverDeps;
}): Promise<TradeIngestOutcome> {
  const existing = await db.select().from(verifiedTrades).where(eq(verifiedTrades.signature, input.signature)).limit(1);
  if (existing[0]) {
    if (existing[0].avatarId !== input.subject.avatarId) throw new TradeReportError('signature_already_claimed', 409);
    const dto = await dtoForRow(existing[0]);
    return { signature: input.signature, inserted: false, scored: existing[0].scored,
      reason: existing[0].unscoredReason as TradeUnscoredReason | null, trade: dto };
  }
  const deps = input.deps ?? createDefaultTradeObserverDeps();
  let raw: unknown | null;
  try {
    raw = await deps.getParsedTransaction(input.signature);
  } catch {
    throw new TradeReportError('upstream_unavailable', 503);
  }
  if (raw === null) throw new TradeReportError('signature_not_found', 404);
  const signers = new Set(rawSignerKeys(raw));
  const bindings = await resolveBoundTradingWallets({ scope: 'subject', subject: input.subject });
  const wallet = bindings.find((candidate) => signers.has(candidate.pubkey));
  if (!wallet) throw new TradeReportError('wallet_not_bound', 409);
  return ingestTradeSignature({ wallet, signature: input.signature, source: 'report', parsedTransaction: raw, deps });
}

export async function runTradeObserverTick(
  deps = createDefaultTradeObserverDeps(),
  runtimeOverrides: Partial<TradeObserverTickRuntime> = {},
): Promise<{
  walletsPolled: number; signaturesExamined: number; inserted: number; scored: number; errors: number;
}> {
  if (observerRunning) return { walletsPolled: 0, signaturesExamined: 0, inserted: 0, scored: 0, errors: 0 };
  observerRunning = true;
  const result = { walletsPolled: 0, signaturesExamined: 0, inserted: 0, scored: 0, errors: 0 };
  const runtime: TradeObserverTickRuntime = {
    resolveWallets: () => resolveBoundTradingWallets({ scope: 'all' }),
    withLease: withTradingWalletLease,
    ingest: ingestTradeSignature,
    advanceCursor: advanceTradingWalletCursor,
    alert: alertError,
    ...runtimeOverrides,
  };
  try {
    const limit = boundedInteger(process.env.TRADE_OBSERVER_WALLETS_PER_TICK, 25, 1, 200);
    const walletsToPoll = (await runtime.resolveWallets())
      .sort((a, b) => (a.lastPolledAt?.getTime() ?? 0) - (b.lastPolledAt?.getTime() ?? 0)).slice(0, limit);
    for (const wallet of walletsToPoll) {
      try {
        const leased = await runtime.withLease(wallet.id, async () => {
        result.walletsPolled++;
        let before: string | undefined;
        const newest: Array<{ signature: string; slot: number; blockTime: number | null }> = [];
        for (;;) {
          const rows = signatureRowsSchema.parse(await deps.getSignaturesForAddress(wallet.pubkey, { before, until: wallet.cursorSignature ?? undefined, limit: 100 }));
          newest.push(...rows);
          if (rows.length < 100 || rows.some((row) => row.signature === wallet.cursorSignature)) break;
          before = rows.at(-1)?.signature;
          if (!before) break;
        }
        let terminal = true;
        for (const signature of newest.reverse()) {
          result.signaturesExamined++;
          try {
            const outcome = await runtime.ingest({ wallet, signature: signature.signature, source: 'observer', deps });
            if (outcome.inserted) result.inserted++;
            if (outcome.scored && outcome.inserted) result.scored++;
          } catch (error) {
            if (error instanceof TradeReportError) continue;
            result.errors++;
            try {
              await runtime.alert({
                severity: 'warning',
                source: 'trade-observer',
                message: 'Trade ingestion failed for a bound wallet; continuing with the next wallet.',
                context: { walletId: wallet.id, signature: signature.signature, error: safeObserverError(error) },
              });
            } catch (alertFailure) {
              console.warn('[trade-observer] wallet failure alert failed', safeObserverError(alertFailure));
            }
            terminal = false;
            break;
          }
        }
        const newestTerminal = newest.at(-1);
        if (terminal && newestTerminal) await runtime.advanceCursor({ walletId: wallet.id, expectedCursorSignature: wallet.cursorSignature,
          signature: newestTerminal.signature, slot: newestTerminal.slot, blockTime: newestTerminal.blockTime });
        });
        if (leased === 'lease_unavailable') continue;
      } catch {
        result.errors++;
      }
    }
    return result;
  } finally {
    observerRunning = false;
    lastTickAt = new Date(deps.now()).toISOString();
  }
}

export function observerHealth(): { enabled: boolean; lastTickAt: string | null; stale: boolean } {
  const enabled = observerEnabled();
  const pollMs = boundedInteger(process.env.TRADE_OBSERVER_POLL_MS, 45_000, 15_000);
  return { enabled, lastTickAt, stale: !enabled || !lastTickAt || Date.now() - Date.parse(lastTickAt) > pollMs * 3 };
}

export function startTradeObserver(): void {
  if (observerTimer || !observerEnabled()) return;
  const pollMs = boundedInteger(process.env.TRADE_OBSERVER_POLL_MS, 45_000, 15_000);
  observerTimer = setInterval(() => { void runTradeObserverTick().catch((error) => console.warn('[trade-observer] tick failed', safeObserverError(error))); }, pollMs);
  observerTimer.unref?.();
  void runTradeObserverTick().catch((error) => console.warn('[trade-observer] initial tick failed', safeObserverError(error)));
}

export function stopTradeObserver(): void {
  if (observerTimer) clearInterval(observerTimer);
  observerTimer = null;
}

/** Read-only. One lookup on the `verified_trades` primary key. This server-only
 *  seam performs no fleet join, side effect, write, broadcast, or event. The
 *  caller must compare `avatarId` before it promotes any fleet decision. */
export async function lookupVerifiedTrade(signature: string): Promise<
  | { verified: true; avatarId: string; tradingWalletId: string; decisionId: string | null; slot: number }
  | { verified: false }
> {
  const rows = await db.select({
    avatarId: verifiedTrades.avatarId,
    tradingWalletId: verifiedTrades.tradingWalletId,
    decisionId: verifiedTrades.decisionId,
    slot: verifiedTrades.slot,
  }).from(verifiedTrades).where(eq(verifiedTrades.signature, signature)).limit(1);
  const row = rows[0];
  if (!row || row.avatarId === null || row.tradingWalletId === null) return { verified: false };
  return {
    verified: true,
    avatarId: row.avatarId,
    tradingWalletId: row.tradingWalletId,
    decisionId: row.decisionId,
    slot: row.slot,
  };
}

export async function listMyVerifiedTrades(avatarId: string, limit: number): Promise<VerifiedTradeDTO[]> {
  const rows = await db.select().from(verifiedTrades).where(eq(verifiedTrades.avatarId, avatarId)).orderBy(desc(verifiedTrades.verifiedAt)).limit(limit);
  return Promise.all(rows.map(dtoForRow));
}

export async function listPublicVerifiedTrades(limit: number): Promise<PublicTradeDTO[]> {
  const rows = await db.select().from(verifiedTrades).orderBy(desc(verifiedTrades.verifiedAt)).limit(limit);
  const avatarIds = rows.flatMap((row) => row.avatarId ? [row.avatarId] : []);
  const names = avatarIds.length ? await db.select({ id: avatars.id, name: avatars.name }).from(avatars).where(inArray(avatars.id, avatarIds)) : [];
  const nameMap = new Map(names.map((row) => [row.id, row.name]));
  return Promise.all(rows.map(async (row) => {
    const { wallet: _wallet, ...dto } = await dtoForRow(row);
    return { ...dto, subject: { type: row.subjectKind as 'avatar' | 'agent', id: row.agentId ?? row.avatarId ?? '', avatarName: row.avatarId ? nameMap.get(row.avatarId) ?? null : null } };
  }));
}
