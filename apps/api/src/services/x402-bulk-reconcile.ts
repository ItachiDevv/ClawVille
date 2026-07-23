/**
 * Bulk x402 outage reconciliation.
 *
 * A target account is paged once for the selected row window, transactions are
 * parsed in bounded parallel batches, and rows are paired to unbound transfers
 * in memory. Mutations remain owned by x402-reconcile's existing capture and
 * no-money primitives.
 */

import type { X402Network } from './x402-payai';
import { loadX402Config } from './x402-config';
import {
  aggregatePayerTransfers,
  deriveUsdcAta,
  parseReconcileSignaturePage,
  parseUsdcTransaction,
  type ReconcileChainDeps,
  type VerifiedUsdcTransfer,
} from './x402-chain-verifier';
import {
  applyReconcileNoMoney,
  applyVerifiedReconcileCapture,
  assertReconcileApplyConsent,
  classifyReconcile,
  createDefaultReconcileChainDeps,
  defaultReconcileApplyStore,
  readReconcileRows,
  resolveReconcileNoMoneyGraceMs,
  resolveReconcileTarget,
  type ReconcileApplyStore,
  type ReconcileRow,
  type ReconcileRowVerdict,
  type VerifiedCaptureApplyDeps,
} from './x402-reconcile';

const DEFAULT_LIMIT = 10_000;
const DEFAULT_SAFETY_MARGIN_MS = 10 * 60_000;
const DEFAULT_MATCH_TOLERANCE_MS = 10 * 60_000;
const DEFAULT_TX_CONCURRENCY = 8;
const DEFAULT_MAX_SIGNATURES = 100_000;
const DEFAULT_RPC_RETRIES = 5;
const DEFAULT_RPC_BACKOFF_MS = 500;

export type BulkReconcileBucket =
  | 'matched'
  | 'no_money'
  | 'waiting'
  | 'manual'
  | 'indeterminate';

export interface BulkReconcileWindow {
  startMs: number;
  endMs: number;
}

export interface BulkReconcileTarget {
  network: X402Network;
  mint: string;
  destinationOwner: string;
  destinationAta: string;
}

export interface IndexedReconcileTransfer extends VerifiedUsdcTransfer {
  targetKey: string;
}

export interface BulkReconcileVerdict {
  row: ReconcileRow;
  bucket: BulkReconcileBucket;
  detail: string;
  transfer?: IndexedReconcileTransfer;
  action?: ReconcileRowVerdict['action'];
}

export interface BulkReconcileSummary {
  selected: number;
  matched: number;
  noMoney: number;
  waiting: number;
  manual: number;
  indeterminate: number;
  captured: number;
  closedNoMoney: number;
  capturedUsdCents: number;
  manualRowIds: string[];
}

export interface BulkReconcileResult {
  apply: boolean;
  window: BulkReconcileWindow | null;
  verdicts: BulkReconcileVerdict[];
  summary: BulkReconcileSummary;
}

export interface BulkReconcileDeps extends VerifiedCaptureApplyDeps {
  readRows?: () => Promise<ReconcileRow[]>;
  store?: ReconcileApplyStore;
  chain?: ReconcileChainDeps;
  loadConfig?: typeof loadX402Config;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

export interface BulkReconcileOptions {
  apply?: boolean;
  /** Operator mode requires RECONCILE_APPLY; auto mode requires its own gate. */
  consent?: 'operator' | 'auto';
  limit?: number;
  safetyMarginMs?: number;
  matchToleranceMs?: number;
  txConcurrency?: number;
  maxSignatures?: number;
  rpcRetries?: number;
  rpcBackoffMs?: number;
  before?: string;
  until?: string;
  deps?: BulkReconcileDeps;
}

export interface BulkReconcileCliOptions extends BulkReconcileOptions {
  consent: 'operator';
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value) && value! >= min
    ? Math.min(value!, max)
    : fallback;
}

function envInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return boundedInteger(parsed, fallback, min, max);
}

export function resolveBulkReconcileDefaults(): Required<Pick<
  BulkReconcileOptions,
  | 'limit'
  | 'safetyMarginMs'
  | 'matchToleranceMs'
  | 'txConcurrency'
  | 'maxSignatures'
  | 'rpcRetries'
  | 'rpcBackoffMs'
>> {
  return {
    limit: envInteger('RECONCILE_BULK_LIMIT', DEFAULT_LIMIT, 1, 100_000),
    safetyMarginMs: envInteger(
      'RECONCILE_BULK_SAFETY_MARGIN_MS',
      DEFAULT_SAFETY_MARGIN_MS,
      0,
      24 * 60 * 60_000,
    ),
    matchToleranceMs: envInteger(
      'RECONCILE_BULK_MATCH_TOLERANCE_MS',
      DEFAULT_MATCH_TOLERANCE_MS,
      0,
      24 * 60 * 60_000,
    ),
    txConcurrency: envInteger(
      'RECONCILE_BULK_TX_CONCURRENCY',
      DEFAULT_TX_CONCURRENCY,
      1,
      32,
    ),
    maxSignatures: envInteger(
      'RECONCILE_BULK_MAX_SIGNATURES',
      DEFAULT_MAX_SIGNATURES,
      1,
      1_000_000,
    ),
    rpcRetries: envInteger(
      'RECONCILE_BULK_RPC_RETRIES',
      DEFAULT_RPC_RETRIES,
      0,
      10,
    ),
    rpcBackoffMs: envInteger(
      'RECONCILE_BULK_RPC_BACKOFF_MS',
      DEFAULT_RPC_BACKOFF_MS,
      10,
      60_000,
    ),
  };
}

function rowAnchorMs(row: ReconcileRow): number {
  const value = new Date(
    row.settlingStartedAt ?? row.reconcileAnchorAt ?? row.createdAt,
  ).getTime();
  if (!Number.isFinite(value)) {
    throw new Error(`invalid reconcile timestamp for ${row.table}:${row.id}`);
  }
  return value;
}

export function deriveRowSettlingWindow(
  row: ReconcileRow,
  toleranceMs: number,
): BulkReconcileWindow {
  const createdMs = new Date(row.createdAt).getTime();
  const settlingMs = new Date(
    row.settlingStartedAt ?? row.reconcileAnchorAt ?? row.createdAt,
  ).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(settlingMs)) {
    throw new Error(`invalid reconcile timestamp for ${row.table}:${row.id}`);
  }
  return {
    startMs: Math.min(createdMs, settlingMs) - toleranceMs,
    endMs: Math.max(createdMs, settlingMs) + toleranceMs,
  };
}

export function deriveBulkReconcileWindow(
  rows: ReconcileRow[],
  safetyMarginMs: number,
  matchToleranceMs: number,
): BulkReconcileWindow | null {
  if (rows.length === 0) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const window = deriveRowSettlingWindow(row, matchToleranceMs);
    startMs = Math.min(startMs, window.startMs);
    endMs = Math.max(endMs, window.endMs);
  }
  return {
    startMs: startMs - safetyMarginMs,
    endMs: endMs + safetyMarginMs,
  };
}

export function selectOldestReconcileRows(
  rows: ReconcileRow[],
  limit: number,
): ReconcileRow[] {
  return [...rows]
    .sort((left, right) => {
      const byTime = rowAnchorMs(left) - rowAnchorMs(right);
      return byTime || `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`);
    })
    .slice(0, limit);
}

function targetKey(target: Omit<BulkReconcileTarget, 'destinationAta'>): string {
  return `${target.network}:${target.mint}:${target.destinationOwner}`;
}

function isRpc429(error: unknown): boolean {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: { status?: unknown; code?: unknown; message?: unknown };
  } | null;
  const fields = [
    candidate?.status,
    candidate?.code,
    candidate?.message,
    candidate?.cause?.status,
    candidate?.cause?.code,
    candidate?.cause?.message,
  ];
  return fields.some((value) => value === 429 || String(value ?? '').includes('429'));
}

async function with429Backoff<T>(
  operation: () => Promise<T>,
  retries: number,
  baseMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRpc429(error) || attempt >= retries) throw error;
      await sleep(baseMs * (2 ** attempt));
    }
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}

interface TargetScanResult {
  complete: boolean;
  transfers: IndexedReconcileTransfer[];
}

async function scanTargetWindow(
  target: BulkReconcileTarget,
  key: string,
  window: BulkReconcileWindow,
  options: Required<Pick<
    BulkReconcileOptions,
    'txConcurrency' | 'maxSignatures' | 'rpcRetries' | 'rpcBackoffMs'
  >> & Pick<BulkReconcileOptions, 'before' | 'until'>,
  chain: ReconcileChainDeps,
  sleep: (ms: number) => Promise<void>,
  log: (message: string, error?: unknown) => void,
  boundCache: Map<string, boolean>,
  transactionCache: Map<string, unknown | null>,
): Promise<TargetScanResult> {
  const signatures: string[] = [];
  let before = options.before;
  let examined = 0;
  let complete = false;
  let reachedOldest = false;

  while (examined < options.maxSignatures && !reachedOldest) {
    const limit = Math.min(1_000, options.maxSignatures - examined);
    const rawPage = await with429Backoff(
      () => chain.getSignaturesForAddress(
        target.network,
        target.destinationAta,
        {
          ...(before ? { before } : {}),
          ...(options.until ? { until: options.until } : {}),
          limit,
        },
      ),
      options.rpcRetries,
      options.rpcBackoffMs,
      sleep,
    );
    const page = parseReconcileSignaturePage(rawPage);
    if (page.length === 0) {
      complete = true;
      break;
    }
    for (const candidate of page) {
      examined += 1;
      if (candidate.blockTime !== null && candidate.blockTime * 1_000 < window.startMs) {
        reachedOldest = true;
        complete = true;
        break;
      }
      if (
        candidate.err === null
        && (candidate.blockTime === null || candidate.blockTime * 1_000 <= window.endMs)
      ) {
        signatures.push(candidate.signature);
      }
      if (examined >= options.maxSignatures) break;
    }
    const last = page.at(-1)?.signature;
    if (reachedOldest || page.length < limit) {
      complete = true;
      break;
    }
    if (!last || last === before) {
      throw new Error('bulk reconcile signature pagination did not advance');
    }
    before = last;
  }

  const parsed = await mapConcurrent(
    [...new Set(signatures)],
    options.txConcurrency,
    async (signature): Promise<IndexedReconcileTransfer[]> => {
      try {
        const transactionKey = `${target.network}:${signature}`;
        let raw = transactionCache.get(transactionKey);
        if (!transactionCache.has(transactionKey)) {
          raw = await with429Backoff(
            () => chain.getParsedTransaction(target.network, signature),
            options.rpcRetries,
            options.rpcBackoffMs,
            sleep,
          );
          transactionCache.set(transactionKey, raw ?? null);
        }
        const tx = parseUsdcTransaction(signature, raw ?? null);
        if (tx.kind === 'not_found') {
          complete = false;
          return [];
        }
        if (tx.kind === 'tx_failed') return [];
        if (
          tx.blockTime !== null
          && (tx.blockTime * 1_000 < window.startMs || tx.blockTime * 1_000 > window.endMs)
        ) {
          return [];
        }
        const applicable = tx.transfers.filter(
          (transfer) =>
            transfer.destinationAta === target.destinationAta
            && transfer.mint === target.mint,
        );
        if (applicable.length === 0) return [];
        let bound = boundCache.get(signature);
        if (bound === undefined) {
          bound = await chain.isSignatureBound(signature);
          boundCache.set(signature, bound);
        }
        if (bound) return [];
        return aggregatePayerTransfers(applicable).map((group) => ({
          ...group.transfers[0],
          atomicAmount: group.total.toString(),
          payer: group.payer,
          blockTime: tx.blockTime,
          targetKey: key,
        }));
      } catch (error) {
        complete = false;
        log(`[x402-bulk-reconcile] transaction ${signature} was indeterminate`, error);
        return [];
      }
    },
  );

  return { complete, transfers: parsed.flat() };
}

interface EligibleRow {
  row: ReconcileRow;
  target: BulkReconcileTarget;
  targetKey: string;
  expectedPayer: string;
  expectedAtomic: string;
  window: BulkReconcileWindow;
}

function pairRowsOneToOne(
  rows: EligibleRow[],
  transfers: IndexedReconcileTransfer[],
  completeTargets: Map<string, boolean>,
  nowMs: number,
  noMoneyGraceMs: number,
): BulkReconcileVerdict[] {
  const verdicts = new Map<string, BulkReconcileVerdict>();
  const rowKey = (row: ReconcileRow) => `${row.table}:${row.id}`;
  const transferBySignature = new Map<string, IndexedReconcileTransfer>();
  const multiEntrySignatures = new Set<string>();
  const rowEdges = new Map<string, Map<string, IndexedReconcileTransfer>>();
  const transferRows = new Map<string, Set<string>>();
  const eligibleByKey = new Map(rows.map((candidate) => [rowKey(candidate.row), candidate]));

  for (const candidate of rows) {
    const key = rowKey(candidate.row);
    const edges = new Map<string, IndexedReconcileTransfer>();
    for (const transfer of transfers) {
      if (
        transfer.targetKey !== candidate.targetKey
        || transfer.payer !== candidate.expectedPayer
        || transfer.atomicAmount !== candidate.expectedAtomic
      ) {
        continue;
      }
      const transferMs = transfer.blockTime === null ? null : transfer.blockTime * 1_000;
      if (
        transferMs !== null
        && (transferMs < candidate.window.startMs || transferMs > candidate.window.endMs)
      ) {
        continue;
      }
      edges.set(transfer.signature, transfer);
      const prior = transferBySignature.get(transfer.signature);
      if (
        prior
        && (
          prior.targetKey !== transfer.targetKey
          || prior.payer !== transfer.payer
          || prior.atomicAmount !== transfer.atomicAmount
        )
      ) {
        multiEntrySignatures.add(transfer.signature);
      } else {
        transferBySignature.set(transfer.signature, transfer);
      }
      const owners = transferRows.get(transfer.signature) ?? new Set<string>();
      owners.add(key);
      transferRows.set(transfer.signature, owners);
    }
    rowEdges.set(key, edges);
  }

  const visitedRows = new Set<string>();
  for (const candidate of rows) {
    const startKey = rowKey(candidate.row);
    if (visitedRows.has(startKey) || (rowEdges.get(startKey)?.size ?? 0) === 0) continue;
    const componentRows = new Set<string>();
    const componentTransfers = new Set<string>();
    const queue = [startKey];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (componentRows.has(current)) continue;
      componentRows.add(current);
      visitedRows.add(current);
      for (const signature of rowEdges.get(current)?.keys() ?? []) {
        if (!componentTransfers.has(signature)) {
          componentTransfers.add(signature);
          for (const owner of transferRows.get(signature) ?? []) {
            if (!componentRows.has(owner)) queue.push(owner);
          }
        }
      }
    }

    const orderedRows = [...componentRows]
      .map((key) => eligibleByKey.get(key)!)
      .sort((left, right) => rowAnchorMs(left.row) - rowAnchorMs(right.row)
        || rowKey(left.row).localeCompare(rowKey(right.row)));
    const orderedTransfers = [...componentTransfers]
      .map((signature) => transferBySignature.get(signature)!)
      .sort((left, right) =>
        (left.blockTime ?? Number.NEGATIVE_INFINITY)
        - (right.blockTime ?? Number.NEGATIVE_INFINITY)
        || left.signature.localeCompare(right.signature));
    const hasUnknownTime = orderedTransfers.some((transfer) => transfer.blockTime === null);
    const hasMultiEntrySignature = orderedTransfers.some((transfer) =>
      multiEntrySignatures.has(transfer.signature));
    const orderedPairingValid = !hasUnknownTime
      && !hasMultiEntrySignature
      && orderedRows.length === orderedTransfers.length
      && orderedRows.every((entry, index) =>
        rowEdges.get(rowKey(entry.row))?.has(orderedTransfers[index].signature));

    if (!orderedPairingValid) {
      for (const entry of orderedRows) {
        verdicts.set(rowKey(entry.row), {
          row: entry.row,
          bucket: 'manual',
          detail: 'candidate component is not a unique time-ordered 1:1 pairing',
        });
      }
      continue;
    }
    orderedRows.forEach((entry, index) => {
      verdicts.set(rowKey(entry.row), {
        row: entry.row,
        bucket: 'matched',
        detail: 'exact payer/amount/time match with unique time-ordered pairing',
        transfer: orderedTransfers[index],
      });
    });
  }

  for (const candidate of rows) {
    const key = rowKey(candidate.row);
    if (verdicts.has(key)) continue;
    if (!completeTargets.get(candidate.targetKey)) {
      verdicts.set(key, {
        row: candidate.row,
        bucket: 'indeterminate',
        detail: 'target signature window was incomplete; no-money transition refused',
      });
      continue;
    }
    const createdMs = new Date(candidate.row.createdAt).getTime();
    if (!Number.isFinite(createdMs) || nowMs - createdMs < noMoneyGraceMs) {
      verdicts.set(key, {
        row: candidate.row,
        bucket: 'waiting',
        detail: 'no exact transfer and row remains inside no-money grace',
      });
      continue;
    }
    verdicts.set(key, {
      row: candidate.row,
      bucket: 'no_money',
      detail: 'complete target window contains no eligible transfer after grace',
    });
  }
  return [...verdicts.values()];
}

function summaryFor(verdicts: BulkReconcileVerdict[]): BulkReconcileSummary {
  const captured = verdicts.filter((verdict) =>
    verdict.action === 'applied_capture_fulfill'
    || verdict.action === 'applied_capture_pending');
  return {
    selected: verdicts.length,
    matched: verdicts.filter((verdict) => verdict.bucket === 'matched').length,
    noMoney: verdicts.filter((verdict) => verdict.bucket === 'no_money').length,
    waiting: verdicts.filter((verdict) => verdict.bucket === 'waiting').length,
    manual: verdicts.filter((verdict) => verdict.bucket === 'manual').length,
    indeterminate: verdicts.filter((verdict) => verdict.bucket === 'indeterminate').length,
    captured: captured.length,
    closedNoMoney: verdicts.filter((verdict) =>
      verdict.action === 'applied_no_money').length,
    capturedUsdCents: captured.reduce((sum, verdict) => sum + verdict.row.usdCents, 0),
    manualRowIds: verdicts
      .filter((verdict) => verdict.bucket === 'manual')
      .map((verdict) => `${verdict.row.table}:${verdict.row.id}`),
  };
}

function assertBulkApplyConsent(apply: boolean, consent: 'operator' | 'auto'): void {
  if (!apply) return;
  if (consent === 'operator') {
    assertReconcileApplyConsent(true);
    return;
  }
  if (process.env.X402_AUTO_RECONCILE !== 'true') {
    throw new Error('Auto apply requested without X402_AUTO_RECONCILE=true');
  }
}

export async function runBulkReconcileSweep(
  options: BulkReconcileOptions = {},
): Promise<BulkReconcileResult> {
  const defaults = resolveBulkReconcileDefaults();
  const apply = options.apply === true;
  const consent = options.consent ?? 'operator';
  assertBulkApplyConsent(apply, consent);
  const limit = boundedInteger(options.limit, defaults.limit, 1, 100_000);
  const safetyMarginMs = boundedInteger(
    options.safetyMarginMs,
    defaults.safetyMarginMs,
    0,
    24 * 60 * 60_000,
  );
  const matchToleranceMs = boundedInteger(
    options.matchToleranceMs,
    defaults.matchToleranceMs,
    0,
    24 * 60 * 60_000,
  );
  const txConcurrency = boundedInteger(options.txConcurrency, defaults.txConcurrency, 1, 32);
  const maxSignatures = boundedInteger(
    options.maxSignatures,
    defaults.maxSignatures,
    1,
    1_000_000,
  );
  const rpcRetries = boundedInteger(options.rpcRetries, defaults.rpcRetries, 0, 10);
  const rpcBackoffMs = boundedInteger(
    options.rpcBackoffMs,
    defaults.rpcBackoffMs,
    10,
    60_000,
  );
  const deps = options.deps ?? {};
  const store = deps.store ?? defaultReconcileApplyStore;
  const chain = deps.chain ?? createDefaultReconcileChainDeps(store);
  const loadConfig = deps.loadConfig ?? loadX402Config;
  const sleep = deps.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((message: string, error?: unknown) =>
    error === undefined ? console.warn(message) : console.warn(message, error));
  const now = deps.now ?? (() => new Date());
  const selected = selectOldestReconcileRows(
    await (deps.readRows ?? readReconcileRows)(),
    limit,
  );
  if (selected.length === 0) {
    return {
      apply,
      window: null,
      verdicts: [],
      summary: summaryFor([]),
    };
  }

  const manual: BulkReconcileVerdict[] = [];
  const eligible: EligibleRow[] = [];
  for (const row of selected) {
    const resolution = classifyReconcile(row);
    if (resolution.kind !== 'probe_merchant' || !resolution.expectedPayer) {
      manual.push({
        row,
        bucket: 'manual',
        detail: resolution.kind === 'probe_merchant'
          ? 'bulk matching requires an exact expected payer'
          : `bulk sweep leaves ${resolution.kind} to the existing per-row operator tool`,
      });
      continue;
    }
    const target = resolveReconcileTarget(row, loadConfig);
    if (!target) {
      manual.push({
        row,
        bucket: 'manual',
        detail: 'unresolvable settle network or destination',
      });
      continue;
    }
    const bulkTarget: BulkReconcileTarget = {
      ...target,
      destinationAta: deriveUsdcAta(target.destinationOwner, target.mint),
    };
    eligible.push({
      row,
      target: bulkTarget,
      targetKey: targetKey(target),
      expectedPayer: resolution.expectedPayer,
      expectedAtomic: resolution.expectedUsdcAtomic,
      window: deriveRowSettlingWindow(row, matchToleranceMs),
    });
  }

  const allWindow = deriveBulkReconcileWindow(
    eligible.map((entry) => entry.row),
    safetyMarginMs,
    matchToleranceMs,
  );
  const targets = new Map<string, { target: BulkReconcileTarget; rows: EligibleRow[] }>();
  for (const candidate of eligible) {
    const group = targets.get(candidate.targetKey) ?? {
      target: candidate.target,
      rows: [],
    };
    group.rows.push(candidate);
    targets.set(candidate.targetKey, group);
  }

  const completeTargets = new Map<string, boolean>();
  const transfers: IndexedReconcileTransfer[] = [];
  const boundCache = new Map<string, boolean>();
  const transactionCache = new Map<string, unknown | null>();
  for (const [key, group] of targets) {
    const window = deriveBulkReconcileWindow(
      group.rows.map((entry) => entry.row),
      safetyMarginMs,
      matchToleranceMs,
    );
    if (!window) continue;
    const scan = await scanTargetWindow(
      group.target,
      key,
      window,
      {
        txConcurrency,
        maxSignatures,
        rpcRetries,
        rpcBackoffMs,
        ...(options.before ? { before: options.before } : {}),
        ...(options.until ? { until: options.until } : {}),
      },
      chain,
      sleep,
      log,
      boundCache,
      transactionCache,
    );
    completeTargets.set(key, scan.complete);
    transfers.push(...scan.transfers);
  }

  let verdicts = [
    ...manual,
    ...pairRowsOneToOne(
      eligible,
      transfers,
      completeTargets,
      now().getTime(),
      resolveReconcileNoMoneyGraceMs(),
    ),
  ].sort((left, right) => rowAnchorMs(left.row) - rowAnchorMs(right.row)
    || `${left.row.table}:${left.row.id}`.localeCompare(
      `${right.row.table}:${right.row.id}`,
    ));

  if (apply) {
    verdicts = await mapConcurrent(verdicts, Math.min(txConcurrency, 8), async (verdict) => {
      if (verdict.bucket === 'matched' && verdict.transfer) {
        const applied = await applyVerifiedReconcileCapture(verdict.row, verdict.transfer, {
          store,
          fulfillCheckout: deps.fulfillCheckout,
          fulfillTopup: deps.fulfillTopup,
          fulfillAgentPayment: deps.fulfillAgentPayment,
          alert: deps.alert,
          now,
          randomId: deps.randomId,
        });
        if (
          applied.action === 'applied_capture_fulfill'
          || applied.action === 'applied_capture_pending'
        ) {
          return { ...verdict, action: applied.action, detail: applied.detail };
        }
        return {
          ...verdict,
          bucket: applied.action === 'manual_review' ? 'manual' : 'indeterminate',
          action: applied.action,
          detail: applied.detail,
        };
      }
      if (verdict.bucket === 'no_money') {
        const changed = await applyReconcileNoMoney(verdict.row, { store, now });
        return changed
          ? { ...verdict, action: 'applied_no_money' as const }
          : {
              ...verdict,
              bucket: 'indeterminate' as const,
              action: 'skipped' as const,
              detail: 'no-money CAS lost',
            };
      }
      return verdict;
    });
  }

  return {
    apply,
    window: allWindow,
    verdicts,
    summary: summaryFor(verdicts),
  };
}

function requireCliValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCliInteger(value: string, flag: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${flag} requires an integer >= ${min}`);
  }
  return parsed;
}

export function parseBulkReconcileCliArgs(argv: string[]): BulkReconcileCliOptions {
  const result: BulkReconcileCliOptions = { consent: 'operator', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    const value = requireCliValue(argv, index, arg);
    index += 1;
    switch (arg) {
      case '--limit':
        result.limit = parseCliInteger(value, arg, 1);
        break;
      case '--safety-margin-ms':
        result.safetyMarginMs = parseCliInteger(value, arg, 0);
        break;
      case '--match-tolerance-ms':
        result.matchToleranceMs = parseCliInteger(value, arg, 0);
        break;
      case '--tx-concurrency':
        result.txConcurrency = parseCliInteger(value, arg, 1);
        break;
      case '--max-signatures':
        result.maxSignatures = parseCliInteger(value, arg, 1);
        break;
      case '--before':
        result.before = value;
        break;
      case '--until':
        result.until = value;
        break;
      default:
        throw new Error(`Unknown argument '${arg}'`);
    }
  }
  if (result.apply) assertReconcileApplyConsent(true);
  return result;
}
