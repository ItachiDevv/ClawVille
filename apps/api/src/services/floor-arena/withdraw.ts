import { FLOOR_ARENA_WITHDRAW_LIMITS, TRADE_MINTS, type FloorArenaWithdrawState } from '@clawville/shared';
import type { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { alertError, type AlertErrorParams } from '../alert-error';
import {
  clawPumpArenaWithdrawWriter,
  clawPumpWriterBudget,
  CLAWPUMP_WRITER_REMOVAL_RESERVE,
  formatAtomicAmount,
  type ArenaTransferInput,
  type ArenaTransferOutcome,
  type ClawPumpArenaWalletLive,
} from '../clawpump-writer';
import { readAssociatedTokenAccountExists } from '../solana-token-balance';
import { tradingConnection } from '../trading-rpc';
import { entriesPaused } from './engine';
import {
  admitArenaWithdrawal,
  arenaWithdrawSignatureUsed,
  ArenaWithdrawTxReusedError,
  attachArenaWithdrawalSignature,
  finalizeArenaWithdrawal,
  readArenaAddonSpentSince,
  readArenaWithdrawalsDue,
  readArenaWithdrawalsToReconcile,
  touchArenaWithdrawalCheck,
  tryWithArenaWithdrawLock,
  type ArenaWithdrawalRecord,
} from './queries';

/**
 * Trading Arena wallet WITHDRAW leader loop (P5, D34-g). REAL MONEY.
 * Contract: ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §0, §4.
 *
 * This loop is the ONLY caller of the ClawPump transfer POST (I4). The money
 * control is the admission compare-and-set `requested -> dispatching`
 * (admitArenaWithdrawal, I1): `transfer` runs only after it returned
 * 'dispatched', once, to the destination and amount of THAT admitted row (I3).
 * Nothing here loops or retries a transfer; a row in 'dispatching', 'sent' or
 * 'unknown' never reaches the writer again (I2). Reconcile reads the chain and
 * ClawPump history only: 'confirmed' needs a finalized transaction with exact
 * owner + mint + amount deltas (I7), and an amount-only match never confirms.
 * Each tick: reconcile first (also while paused), then stop if paused, then at
 * most 2 dispatches. Every DB write is its own short transaction (queries.ts);
 * the per-agent try-lock only keeps two leaders from repeating the same reads.
 * Alerts carry codes only (I9), once per cause per process.
 */

export const ARENA_WITHDRAW_TICK_MS = 30_000;
export const ARENA_WITHDRAW_DISPATCH_PER_TICK = 2;
export const ARENA_WITHDRAW_RECONCILE_PER_TICK = 10;
/** History GET, guard GET, transfer POST: all normal-priority ClawPump calls. */
export const ARENA_WITHDRAW_CALLS_PER_DISPATCH = 3;
/** Must equal the private stale constant of readArenaWithdrawalsToReconcile (queries.ts). */
export const ARENA_WITHDRAW_DISPATCH_STALE_MS = 120_000;
export const ARENA_WITHDRAW_UNKNOWN_GIVE_UP_MS = 15 * 60_000;
export const ARENA_WITHDRAW_SENT_GIVE_UP_MS = 30 * 60_000;
/** Equals the writer's default history limit (readWalletLive reads 50 rows). */
export const ARENA_WITHDRAW_HISTORY_LIMIT = 50;
/** An 'unknown' row whose history window stays uncovered goes to an operator after this. */
export const ARENA_WITHDRAW_REVIEW_AFTER_MS = 24 * 60 * 60_000;
/** History match window starts this long before dispatched_at (seconds). */
const WINDOW_SLACK_S = 60;
const ALERT_SOURCE = 'floor-arena-withdraw';
const TX_CACHE_MAX = 500;

/** A token balance row of a transaction (owner-keyed; `amount` = atomic integer text). */
export interface ArenaWithdrawTokenBalance {
  mint: string;
  owner: string | null;
  amount: string;
}

/** The parts of a finalized transaction the match reads. `accountKeys` = static keys, then loaded writable, then loaded readonly. */
export interface ArenaWithdrawChainTx {
  blockTime: number | null;
  accountKeys: string[];
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: ArenaWithdrawTokenBalance[];
    postTokenBalances: ArenaWithdrawTokenBalance[];
  } | null;
}

export interface ArenaWithdrawSignatureStatus {
  finalized: boolean;
  err: unknown;
}

export interface ArenaWithdrawDeps {
  /** The operator pause (entriesPaused): holds admission; reconcile keeps running. */
  paused: () => boolean;
  clock: () => Date;
  /** True when `calls` normal ClawPump calls in a row fit above the removal reserve. */
  budgetOk: (calls: number) => boolean;
  listDue: (limit: number) => Promise<ArenaWithdrawalRecord[]>;
  listReconcile: (now: Date, limit: number) => Promise<ArenaWithdrawalRecord[]>;
  tryLock<T>(agentId: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  readWalletLive: (clawpumpAgentId: string, arenaAgentId: string) => Promise<ClawPumpArenaWalletLive>;
  /** A throw = nothing sent (every writer throw is before the POST). */
  transfer: (clawpumpAgentId: string, input: ArenaTransferInput, arenaAgentId: string) => Promise<ArenaTransferOutcome>;
  /** Null = unknown (RPC failed): the row waits. */
  destinationHasUsdcAccount: (address: string) => Promise<boolean | null>;
  /** Null = the cluster does not know the signature (history searched). */
  getSignatureStatus: (signature: string) => Promise<ArenaWithdrawSignatureStatus | null>;
  /** Finalized commitment only; null = not available. */
  getTransaction: (signature: string) => Promise<ArenaWithdrawChainTx | null>;
  admit: typeof admitArenaWithdrawal;
  finalize: typeof finalizeArenaWithdrawal;
  attachSignature: typeof attachArenaWithdrawalSignature;
  touch: typeof touchArenaWithdrawalCheck;
  signatureUsed: typeof arenaWithdrawSignatureUsed;
  addonSpentSince: typeof readArenaAddonSpentSince;
  alert: (params: AlertErrorParams) => Promise<void>;
}

const txCache = new Map<string, ArenaWithdrawChainTx>();

function keyText(key: PublicKey | string): string {
  return typeof key === 'string' ? key : key.toBase58();
}

function toChainTx(response: VersionedTransactionResponse): ArenaWithdrawChainTx {
  const meta = response.meta;
  const balances = (list: NonNullable<typeof meta>['preTokenBalances']): ArenaWithdrawTokenBalance[] =>
    (list ?? []).map((entry) => ({ mint: entry.mint, owner: entry.owner ?? null, amount: entry.uiTokenAmount.amount }));
  return {
    blockTime: response.blockTime ?? null,
    accountKeys: [
      ...response.transaction.message.staticAccountKeys.map(keyText),
      ...(meta?.loadedAddresses?.writable ?? []).map(keyText),
      ...(meta?.loadedAddresses?.readonly ?? []).map(keyText),
    ],
    meta: meta
      ? {
        err: meta.err ?? null,
        fee: meta.fee,
        preBalances: meta.preBalances,
        postBalances: meta.postBalances,
        preTokenBalances: balances(meta.preTokenBalances),
        postTokenBalances: balances(meta.postTokenBalances),
      }
      : null,
  };
}

/** Finalized transactions never change, so a found one is cached (bounded) to spare the RPC on later ticks. */
async function readFinalizedTransaction(signature: string): Promise<ArenaWithdrawChainTx | null> {
  const cached = txCache.get(signature);
  if (cached) return cached;
  const response = await tradingConnection().getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!response) return null;
  const tx = toChainTx(response);
  if (txCache.size >= TX_CACHE_MAX) txCache.clear();
  txCache.set(signature, tx);
  return tx;
}

export const defaultArenaWithdrawDeps: ArenaWithdrawDeps = {
  paused: () => entriesPaused(),
  clock: () => new Date(),
  // Same formula as addons.ts: the writer refuses a normal call when tokens - 1 < reserve.
  budgetOk: (calls) => clawPumpWriterBudget().tokens - calls >= CLAWPUMP_WRITER_REMOVAL_RESERVE,
  listDue: readArenaWithdrawalsDue,
  listReconcile: readArenaWithdrawalsToReconcile,
  tryLock: tryWithArenaWithdrawLock,
  readWalletLive: (clawpumpAgentId, arenaAgentId) => clawPumpArenaWithdrawWriter.readWalletLive(clawpumpAgentId, arenaAgentId),
  transfer: (clawpumpAgentId, input, arenaAgentId) => clawPumpArenaWithdrawWriter.transfer(clawpumpAgentId, input, arenaAgentId),
  destinationHasUsdcAccount: async (address) => {
    let connection: ReturnType<typeof tradingConnection>;
    try {
      connection = tradingConnection();
    } catch {
      return null;
    }
    return readAssociatedTokenAccountExists(connection, TRADE_MINTS.USDC, address);
  },
  getSignatureStatus: async (signature) => {
    const { value } = await tradingConnection().getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value[0];
    if (!status) return null;
    // confirmations === null means rooted (finalized) when an old node omits confirmationStatus.
    const finalized = status.confirmationStatus === 'finalized'
      || (status.confirmationStatus === undefined && status.confirmations === null);
    return { finalized, err: status.err ?? null };
  },
  getTransaction: readFinalizedTransaction,
  admit: admitArenaWithdrawal,
  finalize: finalizeArenaWithdrawal,
  attachSignature: attachArenaWithdrawalSignature,
  touch: touchArenaWithdrawalCheck,
  signatureUsed: arenaWithdrawSignatureUsed,
  addonSpentSince: readArenaAddonSpentSince,
  alert: alertError,
};

let tickRunning = false;
/** Causes already alerted in this process (once per cause, contract §4). */
const alerted = new Set<string>();

/** Test seam. */
export function _resetArenaWithdrawForTest(): void {
  tickRunning = false;
  alerted.clear();
  txCache.clear();
}

/** A short code for an error: never its message (RPC errors can carry a keyed URL, I9). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9_]{1,50}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'error';
}

function alertOnce(
  deps: ArenaWithdrawDeps,
  cause: string,
  severity: AlertErrorParams['severity'],
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (alerted.has(cause)) return;
  alerted.add(cause);
  void Promise.resolve()
    .then(() => deps.alert({ severity, source: ALERT_SOURCE, message, context: { cause, ...context } }))
    .catch(() => undefined);
}

function decimalsOf(row: Pick<ArenaWithdrawalRecord, 'asset'>): number {
  return row.asset === 'USDC' ? FLOOR_ARENA_WITHDRAW_LIMITS.usdcDecimals : FLOOR_ARENA_WITHDRAW_LIMITS.solDecimals;
}

function amountText(row: ArenaWithdrawalRecord): string {
  const atomic = row.amountAtomic ?? row.requestedAtomic;
  return atomic === null ? `all free ${row.asset}` : `${formatAtomicAmount(atomic, decimalsOf(row))} ${row.asset}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/** The owner-feed event for a state change (codes and public chain data only). */
function eventFor(row: ArenaWithdrawalRecord, state: FloorArenaWithdrawState, code: string | null, txSignature: string | null) {
  const what = `Withdrawal of ${amountText(row)}`;
  let summary: string;
  switch (state) {
    case 'sent': summary = `${what} sent to ${shortAddress(row.destination)}. Waiting for the chain.`; break;
    case 'confirmed': summary = `${what} confirmed on chain.`; break;
    case 'unknown': summary = `${what}: no clear answer (${code}). ClawVille checks the chain and never sends it again.`; break;
    case 'failed':
      summary = code === 'chain_error' ? `${what} failed on chain; only the network fee moved.` : `${what} not sent (${code}).`;
      break;
    case 'failed_no_send': summary = `${what} not sent (${code}).`; break;
    case 'needs_review': summary = `${what}: an operator checks it (${code}).`; break;
    default: summary = `${what}: ${state}.`;
  }
  return { summary, data: { action: state, withdrawalId: row.id, code, txSignature } };
}

// ─── Chain match (I7) ──────────────────────────────────────────────────────

function atomicOrNull(text: string): bigint | null {
  return /^\d{1,30}$/.test(text) ? BigInt(text) : null;
}

/** Sum of an owner's USDC token balances in one list (no entry = 0, e.g. a new token account). Null = unreadable. */
function ownerUsdc(list: ArenaWithdrawTokenBalance[], owner: string): bigint | null {
  let sum = 0n;
  for (const entry of list) {
    if (entry.mint !== TRADE_MINTS.USDC || entry.owner !== owner) continue;
    const amount = atomicOrNull(entry.amount);
    if (amount === null) return null;
    sum += amount;
  }
  return sum;
}

function lamportsOrNull(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

type MatchRow = Pick<ArenaWithdrawalRecord, 'asset' | 'amountAtomic' | 'sourceWallet' | 'destination'>;

/**
 * 'match' only when the transaction moved EXACTLY `amountAtomic` from the
 * source owner to the destination owner. USDC: owner + mint deltas from the
 * pre/post token balances (a missing pre entry = 0). SOL: account-key lamport
 * deltas; the source also pays the fee. Amount alone never matches (I7).
 */
export function matchWithdrawTransfer(tx: ArenaWithdrawChainTx, row: MatchRow): 'match' | 'no_match' | 'chain_error' {
  const meta = tx.meta;
  if (!meta) return 'no_match';
  if (meta.err !== null && meta.err !== undefined) return 'chain_error';
  const amount = row.amountAtomic;
  if (amount === null || amount <= 0n || row.sourceWallet === row.destination) return 'no_match';
  if (row.asset === 'USDC') {
    const sourcePre = ownerUsdc(meta.preTokenBalances, row.sourceWallet);
    const sourcePost = ownerUsdc(meta.postTokenBalances, row.sourceWallet);
    const destPre = ownerUsdc(meta.preTokenBalances, row.destination);
    const destPost = ownerUsdc(meta.postTokenBalances, row.destination);
    if (sourcePre === null || sourcePost === null || destPre === null || destPost === null) return 'no_match';
    return destPost - destPre === amount && sourcePre - sourcePost === amount ? 'match' : 'no_match';
  }
  const source = tx.accountKeys.indexOf(row.sourceWallet);
  const dest = tx.accountKeys.indexOf(row.destination);
  if (source < 0 || dest < 0) return 'no_match';
  const sourcePre = lamportsOrNull(meta.preBalances[source]);
  const sourcePost = lamportsOrNull(meta.postBalances[source]);
  const destPre = lamportsOrNull(meta.preBalances[dest]);
  const destPost = lamportsOrNull(meta.postBalances[dest]);
  const fee = lamportsOrNull(meta.fee);
  if (sourcePre === null || sourcePost === null || destPre === null || destPost === null || fee === null) return 'no_match';
  return destPost - destPre === amount && sourcePre - sourcePost === amount + fee ? 'match' : 'no_match';
}

/** The source wallet's balance of the row asset after the transaction (stored on 'confirmed'). */
function sourcePostBalance(tx: ArenaWithdrawChainTx, row: MatchRow): bigint | null {
  if (!tx.meta) return null;
  if (row.asset === 'USDC') return ownerUsdc(tx.meta.postTokenBalances, row.sourceWallet);
  const index = tx.accountKeys.indexOf(row.sourceWallet);
  return index < 0 ? null : lamportsOrNull(tx.meta.postBalances[index]);
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

export type ArenaWithdrawDispatchResult =
  | 'skipped' | 'balance_unavailable' | 'rpc_unavailable' | 'wait' | 'gone' | 'refused'
  | 'sent' | 'unknown' | 'failed' | 'failed_no_send' | 'needs_review' | 'cas_lost' | 'record_failed';

/** Results that mean the transfer was called (counted against the per-tick limit). */
const TRANSFER_CALLED: ReadonlySet<ArenaWithdrawDispatchResult> = new Set<ArenaWithdrawDispatchResult>([
  'sent', 'unknown', 'failed', 'failed_no_send', 'needs_review', 'cas_lost', 'record_failed',
]);

/** `clawpump_<code>` of a writer throw (status suffix dropped). */
function writerThrowCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,50}$/.test(code) ? `clawpump_${code}` : 'clawpump_error';
}

/**
 * One withdrawal, inside the per-agent try-lock: live read -> (USDC) destination
 * token account -> admission CAS -> ONE transfer to the admitted row -> finalize
 * by CAS from 'dispatching'. Never throws after the transfer was called.
 */
export async function dispatchArenaWithdrawal(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord): Promise<ArenaWithdrawDispatchResult> {
  if (row.state !== 'requested') return 'skipped';
  let live: ClawPumpArenaWalletLive;
  try {
    live = await deps.readWalletLive(row.sourceClawpumpAgentId, row.agentId);
  } catch (error) {
    alertOnce(deps, 'withdraw:balance_unavailable', 'warning',
      'Arena withdraw: the live wallet read failed; requests wait.', { code: errorCode(error), withdrawalId: row.id });
    return 'balance_unavailable';
  }
  let destinationHasUsdcAccount = true;
  if (row.asset === 'USDC') {
    let exists: boolean | null;
    try {
      exists = await deps.destinationHasUsdcAccount(row.destination);
    } catch {
      exists = null;
    }
    if (exists === null) {
      alertOnce(deps, 'withdraw:rpc_unavailable', 'warning',
        'Arena withdraw: the destination token-account check failed; USDC requests wait.', { withdrawalId: row.id });
      return 'rpc_unavailable';
    }
    destinationHasUsdcAccount = exists;
  }
  const now = deps.clock();
  const admission = await deps.admit({
    withdrawalId: row.id, live, destinationHasUsdcAccount, paused: () => deps.paused(), now,
  });
  if (admission.kind === 'gone') return 'gone';
  if (admission.kind === 'wait') {
    if (admission.reason === 'account_cap') {
      const day = now.toISOString().slice(0, 10);
      alertOnce(deps, `withdraw:account_cap:${day}`, 'warning',
        'Arena withdraw: the all-agent daily USDC cap is reached; requests wait for the next UTC day.', { day });
    }
    return 'wait';
  }
  if (admission.kind === 'refused') {
    if (admission.code === 'source_mismatch') {
      alertOnce(deps, `withdraw:source_mismatch:${row.id}`, 'critical',
        'Arena withdraw refused: the live ClawPump wallet is not the wallet on the request.', { withdrawalId: row.id });
    }
    return 'refused';
  }
  // I3: from here on, only the ADMITTED row decides where the money goes and how much.
  const admitted = admission.withdrawal;
  const amount = admitted.amountAtomic;
  if (amount === null) {
    // The 0074 CHECK makes this impossible; without an amount there is nothing to send.
    const saved = await deps.finalize(admitted.id, ['dispatching'], { state: 'failed_no_send', errorCode: 'clawpump_invalid_input' },
      eventFor(admitted, 'failed_no_send', 'clawpump_invalid_input', null));
    return saved ? 'failed_no_send' : 'cas_lost';
  }
  let outcome: ArenaTransferOutcome | null = null;
  let thrown: { error: unknown } | null = null;
  try {
    outcome = await deps.transfer(admitted.sourceClawpumpAgentId, {
      to: admitted.destination, asset: admitted.asset, amountAtomic: amount, expectedSource: admitted.sourceWallet,
    }, admitted.agentId);
  } catch (error) {
    thrown = { error };
  }
  return recordTransferOutcome(deps, admitted, outcome, thrown);
}

/** Books the ONE transfer result. CAS from 'dispatching'; a lost CAS hands a signature to the 'unknown' row. */
async function recordTransferOutcome(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  outcome: ArenaTransferOutcome | null,
  thrown: { error: unknown } | null,
): Promise<ArenaWithdrawDispatchResult> {
  type Patch = Parameters<ArenaWithdrawDeps['finalize']>[2];
  let patch: Patch;
  let signature: string | null = null;
  if (thrown) {
    // Every writer throw happens before the POST: nothing was sent.
    patch = { state: 'failed_no_send', errorCode: writerThrowCode(thrown.error) };
    alertOnce(deps, `withdraw:transfer_refused:${patch.errorCode}`, 'warning',
      'Arena withdraw: the writer refused a transfer before sending.', { code: patch.errorCode, withdrawalId: row.id });
  } else if (outcome?.kind === 'sent') {
    signature = outcome.txSignature;
    patch = { state: 'sent', txSignature: signature, sentAt: deps.clock(), recipientAccountCreated: outcome.recipientAccountCreated };
  } else if (outcome?.kind === 'rejected') {
    patch = { state: 'failed', errorCode: outcome.code };
  } else if (outcome?.kind === 'mismatch') {
    signature = outcome.txSignature;
    patch = { state: 'needs_review', errorCode: 'reply_mismatch', ...(signature ? { txSignature: signature } : {}) };
    alertOnce(deps, `withdraw:reply_mismatch:${row.id}`, 'critical',
      'Arena withdraw: the ClawPump reply does not match the request (from, to, mint or amount). An operator must check it.',
      { withdrawalId: row.id, txSignature: signature });
  } else {
    // 'unknown', or a result this code does not know: the money may have moved, so never 'failed_no_send'.
    signature = outcome?.kind === 'unknown' ? outcome.txSignature : null;
    const code = outcome?.kind === 'unknown' ? outcome.code : 'reply_unparsed';
    patch = { state: 'unknown', errorCode: code, ...(signature ? { txSignature: signature } : {}) };
    alertOnce(deps, `withdraw:transfer_unknown:${code}`, 'warning',
      'Arena withdraw: a transfer reply did not prove the result; reconcile checks the chain (never re-sent).',
      { code, withdrawalId: row.id, txSignature: signature });
  }
  try {
    let saved: ArenaWithdrawalRecord | null;
    try {
      saved = await deps.finalize(row.id, ['dispatching'], patch,
        eventFor(row, patch.state, patch.errorCode ?? null, signature));
    } catch (error) {
      if (!(error instanceof ArenaWithdrawTxReusedError)) throw error;
      // The signature already belongs to another withdrawal: never store it on this row.
      return await bookTxReused(deps, row, ['dispatching', 'unknown'], signature);
    }
    if (saved) return saved.state as ArenaWithdrawDispatchResult;
    // CAS lost: a new leader moved this stale row to 'unknown'. Hand it the signature; reconcile confirms on chain.
    if (signature) {
      try {
        await deps.attachSignature(row.id, signature);
      } catch (error) {
        if (!(error instanceof ArenaWithdrawTxReusedError)) throw error;
        return await bookTxReused(deps, row, ['unknown'], signature);
      }
    }
    return 'cas_lost';
  } catch (error) {
    // The POST may have moved money and the row did not record it. The row stays 'dispatching';
    // reconcile moves it to 'unknown' after 2 min and decides from the chain. Never re-sent.
    alertOnce(deps, `withdraw:record_failed:${row.id}`, 'critical',
      'Arena withdraw: a transfer result could not be written. Reconcile checks the chain; check this withdrawal.',
      { withdrawalId: row.id, txSignature: signature, outcome: outcome?.kind ?? 'threw', code: errorCode(error) });
    return 'record_failed';
  }
}

async function bookTxReused(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  from: readonly FloorArenaWithdrawState[],
  signature: string | null,
): Promise<ArenaWithdrawDispatchResult> {
  alertOnce(deps, `withdraw:tx_reused:${row.id}`, 'critical',
    'Arena withdraw: the transfer signature already belongs to another withdrawal. An operator must check it.',
    { withdrawalId: row.id, txSignature: signature });
  const saved = await deps.finalize(row.id, from, { state: 'needs_review', errorCode: 'tx_reused' },
    eventFor(row, 'needs_review', 'tx_reused', null));
  return saved ? 'needs_review' : 'cas_lost';
}

// ─── Reconcile ─────────────────────────────────────────────────────────────

export type ArenaWithdrawReconcileResult =
  | 'skipped' | 'interrupted' | 'touched' | 'confirmed' | 'failed' | 'failed_no_send' | 'needs_review' | 'cas_lost';

function ageMs(row: ArenaWithdrawalRecord, now: Date): number {
  return row.dispatchedAt ? now.getTime() - row.dispatchedAt.getTime() : Number.POSITIVE_INFINITY;
}

async function finish(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  patch: Parameters<ArenaWithdrawDeps['finalize']>[2],
  txSignature: string | null = row.txSignature,
): Promise<ArenaWithdrawReconcileResult> {
  const saved = await deps.finalize(row.id, [row.state], patch, eventFor(row, patch.state, patch.errorCode ?? null, txSignature));
  return saved ? (saved.state as ArenaWithdrawReconcileResult) : 'cas_lost';
}

async function review(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord, code: string): Promise<ArenaWithdrawReconcileResult> {
  const result = await finish(deps, row, { state: 'needs_review', errorCode: code });
  if (result === 'needs_review') {
    alertOnce(deps, `withdraw:needs_review:${code}:${row.id}`, 'critical',
      `Arena withdraw needs an operator (${code}). Nothing is re-sent.`,
      { withdrawalId: row.id, code, txSignature: row.txSignature });
  }
  return result;
}

async function touch(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord, now: Date): Promise<ArenaWithdrawReconcileResult> {
  await deps.touch(row.id, now);
  return 'touched';
}

/** No decision is possible yet (uncovered history window, wrong wallet): wait, and give it to an operator after 24 h. */
async function undecided(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord, now: Date): Promise<ArenaWithdrawReconcileResult> {
  if (ageMs(row, now) > ARENA_WITHDRAW_REVIEW_AFTER_MS) return review(deps, row, 'not_found_balance_drop');
  return touch(deps, row, now);
}

/**
 * Balance rule (give-up time passed, no chain match): drop = pre balance - live
 * balance + (USDC) add-on spend since dispatched_at, as contract §4 step 4
 * writes it (the add-on term only makes the rule stricter). drop < amount ->
 * failed_no_send; else needs_review.
 */
async function applyBalanceRule(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  live: ClawPumpArenaWalletLive,
): Promise<ArenaWithdrawReconcileResult> {
  const amount = row.amountAtomic;
  const pre = row.preBalanceAtomic;
  if (amount === null || pre === null || row.dispatchedAt === null) return review(deps, row, 'not_found_balance_drop');
  let addonAtomic = 0n;
  if (row.asset === 'USDC') {
    const spentUsd = await deps.addonSpentSince(row.agentId, row.dispatchedAt);
    if (!Number.isFinite(spentUsd) || spentUsd < 0) return review(deps, row, 'not_found_balance_drop');
    addonAtomic = BigInt(Math.ceil(spentUsd * 1e6));
  }
  const liveBalance = row.asset === 'USDC' ? live.usdcAtomic : live.solLamports;
  const drop = pre - liveBalance + addonAtomic;
  if (drop < amount) return finish(deps, row, { state: 'failed_no_send', errorCode: 'not_found_no_drop' });
  return review(deps, row, 'not_found_balance_drop');
}

/** A live read for the balance rule or the history scan. Null = skip this row now (budget short). */
async function readLiveForReconcile(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord): Promise<ClawPumpArenaWalletLive | null> {
  if (!deps.budgetOk(1)) return null;
  return deps.readWalletLive(row.sourceClawpumpAgentId, row.agentId);
}

function liveIsSource(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord, live: ClawPumpArenaWalletLive): boolean {
  if (live.address === row.sourceWallet) return true;
  alertOnce(deps, `withdraw:reconcile_source_mismatch:${row.id}`, 'critical',
    'Arena withdraw reconcile: the live ClawPump wallet is not the wallet on the request; no decision is made.',
    { withdrawalId: row.id });
  return false;
}

async function reconcileBySignature(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  signature: string,
  now: Date,
): Promise<ArenaWithdrawReconcileResult> {
  const status = await deps.getSignatureStatus(signature);
  if (status === null) {
    if (ageMs(row, now) <= ARENA_WITHDRAW_SENT_GIVE_UP_MS) return touch(deps, row, now);
    const live = await readLiveForReconcile(deps, row);
    if (!live) return 'skipped';
    if (!liveIsSource(deps, row, live)) return undecided(deps, row, now);
    return applyBalanceRule(deps, row, live);
  }
  if (!status.finalized) return touch(deps, row, now);
  if (status.err !== null && status.err !== undefined) return finish(deps, row, { state: 'failed', errorCode: 'chain_error' });
  const tx = await deps.getTransaction(signature);
  if (!tx || !tx.meta) return touch(deps, row, now);
  const verdict = matchWithdrawTransfer(tx, row);
  if (verdict === 'chain_error') return finish(deps, row, { state: 'failed', errorCode: 'chain_error' });
  if (verdict === 'no_match') return review(deps, row, 'chain_mismatch');
  return finish(deps, row, { state: 'confirmed', postBalanceAtomic: sourcePostBalance(tx, row) });
}

function earliest(current: number | null, tx: ArenaWithdrawChainTx | null): number | null {
  const time = tx?.blockTime;
  if (time === null || time === undefined) return current;
  return current === null ? time : Math.min(current, time);
}

async function reconcileByHistory(deps: ArenaWithdrawDeps, row: ArenaWithdrawalRecord, now: Date): Promise<ArenaWithdrawReconcileResult> {
  const live = await readLiveForReconcile(deps, row);
  if (!live) return 'skipped';
  if (!liveIsSource(deps, row, live)) return undecided(deps, row, now);
  const windowStart = row.dispatchedAt ? Math.floor(row.dispatchedAt.getTime() / 1000) - WINDOW_SLACK_S : Number.NEGATIVE_INFINITY;
  const matches: Array<{ signature: string; tx: ArenaWithdrawChainTx }> = [];
  const fetched = new Set<string>();
  let oldest: number | null = null;
  for (const item of live.transactions) {
    if (fetched.has(item.signature) || item.status?.toLowerCase() !== 'success') continue;
    if (await deps.signatureUsed(item.signature)) continue;
    fetched.add(item.signature);
    const tx = await deps.getTransaction(item.signature);
    oldest = earliest(oldest, tx);
    if (!tx || tx.blockTime === null || tx.blockTime < windowStart) continue;
    if (matchWithdrawTransfer(tx, row) === 'match') matches.push({ signature: item.signature, tx });
  }
  if (matches.length > 1) return review(deps, row, 'ambiguous_match');
  if (matches.length === 1) {
    const match = matches[0]!;
    try {
      if (!(await deps.attachSignature(row.id, match.signature))) return 'cas_lost';
    } catch (error) {
      if (!(error instanceof ArenaWithdrawTxReusedError)) throw error;
      return review(deps, row, 'tx_reused');
    }
    const saved = await deps.finalize(row.id, ['unknown'], { state: 'confirmed', postBalanceAtomic: sourcePostBalance(match.tx, row) },
      eventFor(row, 'confirmed', null, match.signature));
    return saved ? 'confirmed' : 'cas_lost';
  }
  // No match. The oldest listed item (by block time) must reach back past the window start, or the list may miss the transfer.
  const last = live.transactions.at(-1);
  if (last && !fetched.has(last.signature)) oldest = earliest(oldest, await deps.getTransaction(last.signature));
  const covered = oldest !== null && oldest <= windowStart;
  if (!covered) return undecided(deps, row, now);
  if (ageMs(row, now) <= ARENA_WITHDRAW_UNKNOWN_GIVE_UP_MS) return touch(deps, row, now);
  return applyBalanceRule(deps, row, live);
}

/**
 * Reconciles one row (inside the per-agent try-lock). It NEVER calls transfer:
 * stale 'dispatching' -> 'unknown'; a known signature -> chain status and exact
 * deltas; 'unknown' without one -> ClawPump history + exact match + balance rule.
 */
export async function reconcileArenaWithdrawal(
  deps: ArenaWithdrawDeps,
  row: ArenaWithdrawalRecord,
  now: Date,
): Promise<ArenaWithdrawReconcileResult> {
  if (row.state === 'dispatching') {
    if (ageMs(row, now) <= ARENA_WITHDRAW_DISPATCH_STALE_MS) return 'skipped';
    const moved = await deps.finalize(row.id, ['dispatching'], { state: 'unknown', errorCode: 'dispatch_interrupted' },
      eventFor(row, 'unknown', 'dispatch_interrupted', null));
    if (!moved) return 'cas_lost';
    alertOnce(deps, `withdraw:dispatch_interrupted:${row.id}`, 'warning',
      'Arena withdraw: a send was interrupted (leader change or crash). Reconcile checks the chain; it is never re-sent.',
      { withdrawalId: row.id });
    return 'interrupted';
  }
  if (row.state !== 'sent' && row.state !== 'unknown') return 'skipped';
  if (row.txSignature) return reconcileBySignature(deps, row, row.txSignature, now);
  return reconcileByHistory(deps, row, now);
}

// ─── Tick ──────────────────────────────────────────────────────────────────

/** The leader's 30 s tick. Never throws; a tick still running blocks the next one. */
export async function runArenaWithdrawTick(
  now: Date = new Date(),
  deps: ArenaWithdrawDeps = defaultArenaWithdrawDeps,
): Promise<{ dispatched: number; reconciled: number }> {
  const result = { dispatched: 0, reconciled: 0 };
  if (tickRunning) return result;
  tickRunning = true;
  try {
    // 1. Reconcile first, also while paused: it never sends.
    let toReconcile: ArenaWithdrawalRecord[] = [];
    try {
      toReconcile = await deps.listReconcile(now, ARENA_WITHDRAW_RECONCILE_PER_TICK);
    } catch (error) {
      alertOnce(deps, `withdraw:list_reconcile:${errorCode(error)}`, 'warning', 'Arena withdraw: the reconcile list failed.', { code: errorCode(error) });
    }
    for (const row of toReconcile) {
      try {
        const locked = await deps.tryLock(row.agentId, () => reconcileArenaWithdrawal(deps, row, now));
        if (locked.acquired) result.reconciled += 1;
      } catch (error) {
        alertOnce(deps, `withdraw:reconcile_error:${errorCode(error)}`, 'warning',
          'Arena withdraw: a reconcile step failed; it runs again next tick.', { code: errorCode(error), withdrawalId: row.id });
        try {
          await deps.touch(row.id, now);
        } catch {
          // The row keeps its place in the list.
        }
      }
    }
    // 2. The operator pause holds every new send.
    if (deps.paused()) return result;
    // 3. At most DISPATCH_PER_TICK transfers, each only with budget for its 3 ClawPump calls.
    let due: ArenaWithdrawalRecord[];
    try {
      due = await deps.listDue(ARENA_WITHDRAW_DISPATCH_PER_TICK * 3);
    } catch (error) {
      alertOnce(deps, `withdraw:list_due:${errorCode(error)}`, 'warning', 'Arena withdraw: the dispatch list failed.', { code: errorCode(error) });
      return result;
    }
    for (const row of due) {
      if (result.dispatched >= ARENA_WITHDRAW_DISPATCH_PER_TICK) break;
      if (deps.paused()) break;
      if (!deps.budgetOk(ARENA_WITHDRAW_CALLS_PER_DISPATCH)) {
        console.warn('[floor-arena] withdrawals: ClawPump call budget is short; dispatch waits for the next tick');
        break;
      }
      try {
        const locked = await deps.tryLock(row.agentId, () => dispatchArenaWithdrawal(deps, row));
        if (locked.acquired && TRANSFER_CALLED.has(locked.value)) result.dispatched += 1;
      } catch (error) {
        alertOnce(deps, `withdraw:dispatch_error:${errorCode(error)}`, 'warning',
          'Arena withdraw: a dispatch step failed. A request not admitted yet waits; an admitted one is never re-sent.',
          { code: errorCode(error), withdrawalId: row.id });
      }
    }
  } catch (error) {
    alertOnce(deps, `withdraw:tick_error:${errorCode(error)}`, 'warning', 'Arena withdraw: the tick failed.', { code: errorCode(error) });
  } finally {
    tickRunning = false;
  }
  return result;
}
