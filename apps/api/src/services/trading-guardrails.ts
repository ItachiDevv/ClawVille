import { randomUUID } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  and,
  clawpumpAgentLinks,
  db,
  eq,
  gte,
  inArray,
  isNull,
  sql,
  tradingDecisions,
  tradingHalts,
  tradingUsdcReservations,
} from '@clawville/database';
import type { TradingLink } from '@clawville/database';
import {
  readTradingLimits,
  TRADE_MINTS,
  TRADING_OBJECTIVE_ALLOWED_OUTPUTS,
  TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
  type TradeRefusalCode,
} from '@clawville/shared';
import { withKeyedMutex } from './keyed-mutex';
import { admitPosterUsdcSpend, lockPosterUsdcSpend, PosterUsdcSpendAdmissionError } from './usdc-spend-admission';
import { deriveTradingAta, loadTradingMintWhitelist, type MintInfo } from './trading-mint-info';
import { readTradingWalletEquity } from './trading-fleet-equity';
import { fetchJupiterPrices, type JupiterPriceRow } from './trade-price';
import { alertError, type AlertErrorParams } from './alert-error';
import { shouldAlertTradingLoop, tradingConnection } from './trading-rpc';

export interface TradeIntent {
  avatarId: string;
  inputMint: string;
  outputMint: string;
  amountUsdMicros: bigint;
  reason: string;
  origin: 'autonomous' | 'agent-tool' | 'human-rest' | 'admin-test';
  sessionId: string | null;
  agentId: string | null;
  directiveId: string | null;
  directiveOrdinal: number | null;
  operatorId?: string | null;
}

export interface TradeAdmission {
  decisionId: string;
  link: TradingLink;
  amountAtomic: bigint;
  notionalUsdMicros: bigint;
  slippageBps: number;
  inputInfo: MintInfo;
  outputInfo: MintInfo;
  equityUsdMicros: bigint;
}
export interface PreparedTrade {
  link: TradingLink;
  connection: Connection;
  amountAtomic: bigint;
  slippageBps: number;
  inputInfo: MintInfo;
  outputInfo: MintInfo;
  usdcInfo: MintInfo;
  equityUsdMicros: bigint;
  usdcValueUsdMicros: bigint;
}
export type TradeVerdict = { kind: 'allow'; admission: TradeAdmission } | { kind: 'refuse'; code: TradeRefusalCode; detail: string; decisionId: string };

export interface TradingGuardrailDeps {
  connection?: Connection;
  now?: Date;
  readUsdcBalance?: (pubkey: string, signal: AbortSignal) => Promise<bigint>;
  readEquity?: typeof readTradingWalletEquity;
  alert?: (input: AlertErrorParams) => Promise<void>;
  findLink?: (avatarId: string) => Promise<TradingLink | null | undefined>;
  recordRefusal?: (
    intent: TradeIntent,
    code: TradeRefusalCode,
    detail: string,
  ) => Promise<Extract<TradeVerdict, { kind: 'refuse' }>>;
  readHalts?: () => Promise<HaltState[]>;
}

export const TRADING_BASE_FEE_LAMPORTS = 5_000n;
export const TRADING_WORST_CASE_OUTPUT_ATA_RENT_LAMPORTS = 2_039_280n;

type TradingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AdmissionCaptureOutcome =
  | { kind: 'submitted'; signature: string }
  | { kind: 'refused_presign'; code: TradeRefusalCode; detail: string }
  | { kind: 'reconcile'; signature: string | null; detail: string };

export function findPriceDecimalsMismatch(
  prices: ReadonlyMap<string, JupiterPriceRow>,
  mintInfo: readonly MintInfo[],
): { mint: string; onChain: number; jupiter: number } | null {
  for (const info of mintInfo) {
    const price = prices.get(info.mint);
    if (price && price.decimals !== info.decimals) {
      return { mint: info.mint, onChain: info.decimals, jupiter: price.decimals };
    }
  }
  return null;
}

export async function alertPriceDecimalsMismatch(
  prices: ReadonlyMap<string, JupiterPriceRow>,
  mintInfo: readonly MintInfo[],
  alert: (input: AlertErrorParams) => Promise<void>,
): Promise<{ mint: string; onChain: number; jupiter: number } | null> {
  const mismatch = findPriceDecimalsMismatch(prices, mintInfo);
  if (!mismatch) return null;
  await alert({
    severity: 'critical',
    source: 'trading-guardrails',
    message: 'Jupiter price decimals differ from on-chain mint decimals.',
    context: {
      mint: mismatch.mint,
      onChainDecimals: String(mismatch.onChain),
      jupiterDecimals: String(mismatch.jupiter),
    },
  });
  return mismatch;
}

export async function readTradingUsdcBalanceRpc(input: {
  rpcEndpoint: string;
  ata: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<bigint> {
  const response = await (input.fetchImpl ?? fetch)(input.rpcEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'trading-usdc-balance', method: 'getTokenAccountBalance', params: [input.ata, { commitment: 'confirmed' }] }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`balance_http_${response.status}`);
  const body = await response.json() as { result?: { value?: { amount?: unknown } }; error?: unknown };
  const amount = body.result?.value?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || body.error) throw new Error('balance_schema_invalid');
  return BigInt(amount);
}

let fleetEquityUnreadableSinceMs: number | null = null;
let drawdownPoller: ReturnType<typeof setInterval> | null = null;
export const TRADING_BALANCE_RPC_TIMEOUT_MS = 4_000;

function connection(): Connection {
  return tradingConnection();
}

async function recordRefusal(
  intent: TradeIntent,
  code: TradeRefusalCode,
  detail: string,
): Promise<Extract<TradeVerdict, { kind: 'refuse' }>> {
  const rows = await db.insert(tradingDecisions).values({
    avatarId: intent.avatarId,
    origin: intent.origin,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amountUsdMicros: intent.amountUsdMicros.toString(),
    verdict: code,
    status: 'refused',
    reason: intent.reason,
    detail: detail.slice(0, 400),
    directiveId: intent.directiveId,
    directiveOrdinal: intent.directiveOrdinal,
    operatorId: intent.operatorId ?? null,
    settledAt: new Date(),
  }).returning({ id: tradingDecisions.id });
  return { kind: 'refuse', code, detail, decisionId: rows[0]!.id };
}

export function recordTradeRefusal(
  intent: TradeIntent,
  code: TradeRefusalCode,
  detail: string,
): Promise<Extract<TradeVerdict, { kind: 'refuse' }>> {
  return recordRefusal(intent, code, detail);
}

export async function inspectTradePreconditions(
  intent: TradeIntent,
  deps: Pick<TradingGuardrailDeps, 'connection' | 'findLink' | 'recordRefusal' | 'readHalts'> = {},
): Promise<
  { kind: 'continue'; link: TradingLink } | Extract<TradeVerdict, { kind: 'refuse' }>
> {
  const findLink = deps.findLink ?? ((avatarId: string) => db.query.clawpumpAgentLinks.findFirst({
    where: eq(clawpumpAgentLinks.avatarId, avatarId),
  }));
  const refuse = deps.recordRefusal ?? recordRefusal;
  const link = await findLink(intent.avatarId);
  if (!link) return refuse(intent, 'no_link', 'No fleet trading link exists.');
  if (!link.armed) return refuse(intent, 'armed_false', 'The fleet link is unarmed.');
  if (link.killed) return refuse(intent, 'agent_killed', 'The fleet link is killed.');
  const halts = await (deps.readHalts ?? readActiveHalts)();
  if (halts.some((halt) => halt.scope === 'fleet')) return refuse(intent, 'fleet_halted', 'The fleet halt is active.');
  if (halts.some((halt) => halt.scope === 'agent' && halt.scopeId === intent.avatarId)) {
    return refuse(intent, 'agent_halted', 'The agent halt is active.');
  }
  if (!process.env.JUPITER_API_KEY) return refuse(intent, 'not_configured', 'Jupiter execution credentials are absent.');
  if (!deps.connection) {
    try { connection(); }
    catch { return refuse(intent, 'not_configured', 'Helius mainnet execution is not configured.'); }
  }
  return { kind: 'continue', link };
}

export async function prepareTrade(intent: TradeIntent, deps: TradingGuardrailDeps = {}): Promise<PreparedTrade | Extract<TradeVerdict, { kind: 'refuse' }>> {
  const pre = await inspectTradePreconditions(intent, deps);
  if (pre.kind !== 'continue') return pre;
  const limits = readTradingLimits();
  if (intent.inputMint === intent.outputMint) return recordRefusal(intent, 'same_mint', 'Input and output mints match.');
  const allowed = new Set(Object.values(TRADE_MINTS));
  if (!allowed.has(intent.inputMint as never) || !allowed.has(intent.outputMint as never)) return recordRefusal(intent, 'mint_not_whitelisted', 'A mint is outside the static execution list.');
  if (!TRADING_OBJECTIVE_ALLOWED_OUTPUTS[pre.link.objective as keyof typeof TRADING_OBJECTIVE_ALLOWED_OUTPUTS]?.includes(intent.outputMint)) {
    return recordRefusal(intent, 'objective_forbids_mint', 'The objective excludes the output mint.');
  }

  const conn = deps.connection ?? connection();
  const [whitelist, equity, prices] = await Promise.all([
    loadTradingMintWhitelist({ connection: conn }),
    (deps.readEquity ?? readTradingWalletEquity)({ walletPubkey: pre.link.walletPubkey, connection: conn }),
    fetchJupiterPrices([intent.inputMint, intent.outputMint], { maxAgeMs: Number(process.env.TRADING_PRICE_MAX_AGE_MS ?? 2_000) }),
  ]);
  const inputInfo = whitelist.get(intent.inputMint) ?? null;
  const outputInfo = whitelist.get(intent.outputMint) ?? null;
  const usdcInfo = whitelist.get(TRADE_MINTS.USDC) ?? null;
  if (!inputInfo || !outputInfo || !usdcInfo) return recordRefusal(intent, 'decimals_unresolved', 'Mint metadata could not be read.');
  if (!equity) return recordRefusal(intent, 'equity_unreadable', 'Wallet equity could not be read.');
  const decimalsMismatch = await alertPriceDecimalsMismatch(prices, [inputInfo, outputInfo], deps.alert ?? alertError);
  if (decimalsMismatch) {
    return recordRefusal(intent, 'decimals_mismatch', 'Jupiter price decimals differ from on-chain mint decimals.');
  }
  const inputPrice = intent.inputMint === TRADE_MINTS.USDC ? 1 : prices.get(intent.inputMint)?.usdPrice;
  if (!inputPrice) return recordRefusal(intent, 'price_unavailable', 'Input price is unavailable.');
  const amountAtomic = BigInt(Math.floor(Number(intent.amountUsdMicros) / 1_000_000 / inputPrice * 10 ** inputInfo.decimals));
  if (amountAtomic <= 0n) return recordRefusal(intent, 'amount_below_min', 'The atomic amount is zero.');
  const minMicros = BigInt(Math.floor(limits.minTradeUsd * 1_000_000));
  const maxMicros = BigInt(Math.floor(limits.maxTradeUsd * 1_000_000));
  if (intent.amountUsdMicros < minMicros) return recordRefusal(intent, 'amount_below_min', 'The requested amount is below the minimum.');
  if (intent.amountUsdMicros > maxMicros) return recordRefusal(intent, 'amount_above_max', 'The requested amount exceeds the maximum.');
  if (intent.amountUsdMicros * 100n > equity.equityUsdMicros * BigInt(Math.floor(limits.maxTradePctOfFloat))) {
    return recordRefusal(intent, 'exceeds_float_pct', 'The requested amount exceeds the live float percentage.');
  }
  const nativeDebit = intent.inputMint === TRADE_MINTS.WSOL ? amountAtomic : 0n;
  const outputAtaRent = intent.outputMint === TRADE_MINTS.WSOL ? 0n : TRADING_WORST_CASE_OUTPUT_ATA_RENT_LAMPORTS;
  if (equity.nativeLamports < limits.minSolReserveLamports + limits.maxPriorityFeeLamports
    + TRADING_BASE_FEE_LAMPORTS + outputAtaRent + nativeDebit) {
    return recordRefusal(intent, 'sol_reserve_breached', 'The trade would cross the SOL reserve floor.');
  }
  const usdcValueUsdMicros = equity.positions.find((position) => position.mint === TRADE_MINTS.USDC)?.valueUsdMicros ?? 0n;

  return {
    link: pre.link,
    connection: conn,
    amountAtomic,
    slippageBps: Math.floor(limits.maxSlippageBps),
    inputInfo,
    outputInfo,
    usdcInfo,
    equityUsdMicros: equity.equityUsdMicros,
    usdcValueUsdMicros,
  };
}

export function objectiveUsdcShareBreached(input: {
  objective: keyof typeof TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT;
  inputMint: string;
  currentUsdcUsdMicros: bigint;
  equityUsdMicros: bigint;
  tradeUsdMicros: bigint;
}): boolean {
  const floorPct = BigInt(TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT[input.objective]);
  if (floorPct === 0n || input.inputMint !== TRADE_MINTS.USDC) return false;
  const projectedUsdc = input.currentUsdcUsdMicros > input.tradeUsdMicros
    ? input.currentUsdcUsdMicros - input.tradeUsdMicros
    : 0n;
  return projectedUsdc * 100n < input.equityUsdMicros * floorPct;
}

export async function admitTrade(
  intent: TradeIntent,
  deps: TradingGuardrailDeps,
  prepared: PreparedTrade,
  captureSignature: (input: { tx: TradingTx; decisionId: string; link: TradingLink }) => Promise<AdmissionCaptureOutcome>,
): Promise<TradeVerdict> {
  const limits = readTradingLimits();
  const {
    connection: conn,
    amountAtomic,
    inputInfo,
    outputInfo,
    usdcInfo,
    equityUsdMicros,
    usdcValueUsdMicros,
    slippageBps,
  } = prepared;

  return withKeyedMutex('trading:fleet', () => withKeyedMutex(`trading:${intent.avatarId}`, () => db.transaction(async (tx) => {
    const refuseLocked = async (code: TradeRefusalCode, detail: string): Promise<Extract<TradeVerdict, { kind: 'refuse' }>> => {
      const decisionId = randomUUID();
      await tx.insert(tradingDecisions).values({
        id: decisionId,
        avatarId: intent.avatarId,
        origin: intent.origin,
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amountUsdMicros: intent.amountUsdMicros.toString(),
        verdict: code,
        status: 'refused',
        reason: intent.reason,
        detail: detail.slice(0, 400),
        directiveId: intent.directiveId,
        directiveOrdinal: intent.directiveOrdinal,
        operatorId: intent.operatorId ?? null,
        settledAt: new Date(),
      });
      return { kind: 'refuse', code, detail, decisionId };
    };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${intent.avatarId}`}, 0))`);
    const links = await tx.select().from(clawpumpAgentLinks).where(eq(clawpumpAgentLinks.avatarId, intent.avatarId)).for('update').limit(1);
    const link = links[0];
    if (!link) return refuseLocked('no_link', 'The link disappeared before admission.');
    if (!link.armed) return refuseLocked('armed_false', 'The fleet link is unarmed.');
    if (link.killed) return refuseLocked('agent_killed', 'The fleet link is killed.');
    if (link.walletPubkey !== prepared.link.walletPubkey || link.objective !== prepared.link.objective) {
      return refuseLocked('tx_binding_failed', 'The link changed after transaction validation.');
    }
    const halts = await tx.select().from(tradingHalts).where(isNull(tradingHalts.clearedAt));
    if (halts.some((halt) => halt.scope === 'fleet')) return refuseLocked('fleet_halted', 'The fleet halt is active.');
    if (halts.some((halt) => halt.scope === 'agent' && halt.scopeId === intent.avatarId)) return refuseLocked('agent_halted', 'The agent halt is active.');
    const now = deps.now ?? new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = await tx.select({
      total: sql<string>`COALESCE(SUM(${tradingDecisions.amountUsdMicros}), 0)::text`,
      last: sql<Date | null>`MAX(${tradingDecisions.createdAt})`,
      inFlight: sql<number>`COUNT(*) FILTER (WHERE ${tradingDecisions.status} IN ('admitted','submitted'))::int`,
    }).from(tradingDecisions).where(and(
      eq(tradingDecisions.avatarId, intent.avatarId),
      gte(tradingDecisions.createdAt, dayStart),
      inArray(tradingDecisions.status, ['admitted', 'submitted', 'executed', 'reconcile']),
    ));
    const state = rows[0]!;
    if (BigInt(state.total) + intent.amountUsdMicros > BigInt(Math.floor(limits.dailyNotionalUsdPerAgent * 1_000_000))) return refuseLocked('daily_notional_cap', 'The daily notional cap is reached.');
    if (state.last && now.getTime() - new Date(state.last).getTime() < limits.cooldownSeconds * 1_000) return refuseLocked('cooldown_active', 'The cooldown is active.');
    if (state.inFlight > 0) return refuseLocked('in_flight', 'Another decision is in flight.');
    if (objectiveUsdcShareBreached({
      objective: link.objective as keyof typeof TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
      inputMint: intent.inputMint,
      currentUsdcUsdMicros: usdcValueUsdMicros,
      equityUsdMicros,
      tradeUsdMicros: intent.amountUsdMicros,
    })) return refuseLocked('usdc_reserve_breached', 'The objective USDC allocation floor would be crossed.');
    if (intent.directiveId) {
      const prior = await tx.select({ id: tradingDecisions.id }).from(tradingDecisions).where(and(eq(tradingDecisions.directiveId, intent.directiveId), eq(tradingDecisions.directiveOrdinal, intent.directiveOrdinal!))).limit(1);
      if (prior.length) return refuseLocked('directive_replayed', 'The directive was already claimed.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRADING_BALANCE_RPC_TIMEOUT_MS);
    const readUsdcBalance = deps.readUsdcBalance ?? (async (pubkey: string, signal: AbortSignal) => {
      const ata = deriveTradingAta(new PublicKey(pubkey), usdcInfo).toBase58();
      return readTradingUsdcBalanceRpc({ rpcEndpoint: conn.rpcEndpoint, ata, signal });
    });
    try {
      await admitPosterUsdcSpend(tx, {
        posterAvatarId: intent.avatarId,
        // Admission must leave the compiled USDC reserve free after every
        // existing liability and this new notional reservation.
        amountAtomic: intent.amountUsdMicros + limits.minUsdcReserveMicros,
        readBalance: (pubkey) => readUsdcBalance(pubkey, controller.signal),
      });
    } catch (error) {
      clearTimeout(timer);
      const code: TradeRefusalCode = error instanceof PosterUsdcSpendAdmissionError && error.code === 'balance_unavailable'
        ? 'balance_unavailable' : 'wallet_obligated';
      return refuseLocked(code, error instanceof Error ? error.message : 'USDC admission failed.');
    }
    clearTimeout(timer);
    const decisionId = randomUUID();
    await tx.insert(tradingDecisions).values({
      id: decisionId, avatarId: intent.avatarId, origin: intent.origin,
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountUsdMicros: intent.amountUsdMicros.toString(), amountAtomic: amountAtomic.toString(),
      slippageBps, verdict: 'admitted', status: 'admitted',
      reason: intent.reason, detail: '', directiveId: intent.directiveId, directiveOrdinal: intent.directiveOrdinal,
      operatorId: intent.operatorId ?? null,
    });
    await tx.insert(tradingUsdcReservations).values({ decisionId, avatarId: intent.avatarId, amountBaseUnits: intent.amountUsdMicros.toString(), status: 'open' });
    const captured = await captureSignature({ tx, decisionId, link });
    if (captured.kind === 'refused_presign') {
      await tx.update(tradingDecisions).set({
        status: 'refused', verdict: captured.code, detail: captured.detail.slice(0, 400), settledAt: new Date(),
      }).where(and(eq(tradingDecisions.id, decisionId), eq(tradingDecisions.status, 'admitted')));
      await tx.update(tradingUsdcReservations).set({ status: 'failed', releaseReason: captured.code, releasedAt: new Date() })
        .where(eq(tradingUsdcReservations.decisionId, decisionId));
      return { kind: 'refuse', code: captured.code, detail: captured.detail, decisionId };
    }
    if (captured.kind === 'reconcile') {
      await tx.update(tradingDecisions).set({
        status: 'reconcile', verdict: 'chain_error', signature: captured.signature,
        detail: captured.detail.slice(0, 400),
      }).where(and(eq(tradingDecisions.id, decisionId), eq(tradingDecisions.status, 'admitted')));
      await tx.update(tradingUsdcReservations).set({
        status: 'reconcile', releaseReason: 'capture_failed', lastWedgeAlertAt: new Date(),
      })
        .where(eq(tradingUsdcReservations.decisionId, decisionId));
    } else {
      const submitted = await tx.select({
        status: tradingDecisions.status,
        signature: tradingDecisions.signature,
        signedTxBytes: tradingDecisions.signedTxBytes,
      }).from(tradingDecisions).where(eq(tradingDecisions.id, decisionId)).limit(1);
      if (submitted[0]?.status !== 'submitted' || !submitted[0].signature || !submitted[0].signedTxBytes) {
        throw new Error('signature_capture_not_persisted');
      }
    }
    return { kind: 'allow', admission: { decisionId, link, amountAtomic, notionalUsdMicros: intent.amountUsdMicros, slippageBps, inputInfo, outputInfo, equityUsdMicros } } as TradeVerdict;
  })));
}

export async function withTradingReservationMutation<T>(
  avatarId: string,
  mutate: (tx: TradingTx) => Promise<T>,
): Promise<T> {
  return withKeyedMutex('trading:fleet', () => withKeyedMutex(`trading:${avatarId}`, () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${avatarId}`}, 0))`);
    await lockPosterUsdcSpend(tx, avatarId);
    return mutate(tx);
  })));
}

export async function recordTradeOutcome(input: {
  decisionId: string;
  status: 'refused' | 'failed' | 'reconcile' | 'expired';
  signature?: string | null;
  errorCode?: TradeRefusalCode | null;
  errorDetail?: string | null;
  expectedStatus: 'admitted' | 'submitted';
}): Promise<boolean> {
  const decision = await db.select({ avatarId: tradingDecisions.avatarId })
    .from(tradingDecisions).where(eq(tradingDecisions.id, input.decisionId)).limit(1);
  if (!decision[0]) return false;
  return withTradingReservationMutation(decision[0].avatarId, async (tx) => {
    const settled = ['refused', 'failed', 'expired'].includes(input.status);
    const updated = await tx.update(tradingDecisions).set({
      status: input.status,
      verdict: input.errorCode ?? input.status,
      signature: input.signature,
      detail: input.errorDetail?.slice(0, 400),
      settledAt: settled ? new Date() : null,
    }).where(and(
      eq(tradingDecisions.id, input.decisionId),
      eq(tradingDecisions.status, input.expectedStatus),
    )).returning({ id: tradingDecisions.id });
    if (!updated[0]) return false;
    if (input.status === 'reconcile') {
      await tx.update(tradingUsdcReservations).set({
        status: 'reconcile', releaseReason: 'ambiguous_send', lastWedgeAlertAt: new Date(),
      }).where(eq(tradingUsdcReservations.decisionId, input.decisionId));
    } else if (settled) {
      const reservationStatus = input.status === 'expired' ? 'expired' : 'failed';
      await tx.update(tradingUsdcReservations).set({
        status: reservationStatus,
        releaseReason: input.status,
        releasedAt: new Date(),
      }).where(eq(tradingUsdcReservations.decisionId, input.decisionId));
    }
    return true;
  });
}

export async function releaseLegacyAdmittedDecision(decisionId: string): Promise<'released' | 'not_found' | 'not_releasable'> {
  const row = await db.select({ avatarId: tradingDecisions.avatarId }).from(tradingDecisions)
    .where(eq(tradingDecisions.id, decisionId)).limit(1);
  if (!row[0]) return 'not_found';
  return withTradingReservationMutation(row[0].avatarId, async (tx) => {
    const released = await tx.update(tradingDecisions).set({
      status: 'failed', verdict: 'chain_error', detail: 'Operator released a legacy decision with no captured signature.', settledAt: new Date(),
    }).where(and(
      eq(tradingDecisions.id, decisionId),
      eq(tradingDecisions.status, 'admitted'),
      isNull(tradingDecisions.signature),
    )).returning({ id: tradingDecisions.id });
    if (!released[0]) return 'not_releasable';
    await tx.update(tradingUsdcReservations).set({
      status: 'failed', releaseReason: 'operator_never_signed', releasedAt: new Date(),
    }).where(eq(tradingUsdcReservations.decisionId, decisionId));
    return 'released';
  });
}

export interface HaltState { scope: 'fleet' | 'agent'; scopeId: string | null; reason: string; haltedAt: Date }
export async function readActiveHalts(): Promise<HaltState[]> {
  return (await db.select().from(tradingHalts).where(isNull(tradingHalts.clearedAt))).map((row) => ({ scope: row.scope as 'fleet' | 'agent', scopeId: row.scopeId, reason: row.reason, haltedAt: row.haltedAt }));
}
export async function engageHalt(i: { scope: 'fleet' | 'agent'; scopeId: string | null; reason: string; by: string }): Promise<void> {
  const scopeId = i.scopeId;
  await withKeyedMutex('trading:fleet', () => (scopeId ? withKeyedMutex(`trading:${scopeId}`, async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${scopeId}`}, 0))`);
      await tx.insert(tradingHalts).values({ scope: i.scope, scopeId, reason: i.reason, engagedBy: i.by }).onConflictDoNothing();
    });
  }) : db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.insert(tradingHalts).values({ scope: i.scope, scopeId: i.scopeId, reason: i.reason, engagedBy: i.by }).onConflictDoNothing();
  })));
}
export async function clearHalt(i: { scope: 'fleet' | 'agent'; scopeId: string | null; by: string }): Promise<void> {
  const scopeId = i.scopeId;
  await withKeyedMutex('trading:fleet', () => (scopeId ? withKeyedMutex(`trading:${scopeId}`, async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading:${scopeId}`}, 0))`);
      await tx.update(tradingHalts).set({ clearedAt: new Date(), clearedBy: i.by }).where(and(eq(tradingHalts.scope, i.scope), eq(tradingHalts.scopeId, scopeId), isNull(tradingHalts.clearedAt)));
    });
  }) : db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('trading:fleet', 0))`);
    await tx.update(tradingHalts).set({ clearedAt: new Date(), clearedBy: i.by }).where(and(eq(tradingHalts.scope, i.scope), isNull(tradingHalts.scopeId), isNull(tradingHalts.clearedAt)));
  })));
}
export async function evaluateFleetDrawdown(deps: TradingGuardrailDeps = {}): Promise<{ equityUsdMicros: bigint | null; startUsdMicros: bigint; halted: boolean }> {
  const links = await db.select().from(clawpumpAgentLinks).where(and(
    eq(clawpumpAgentLinks.operatedByClawville, true),
    eq(clawpumpAgentLinks.armed, true),
  ));
  let startUsdMicros = 0n;
  let equityUsdMicros = 0n;
  const nowMs = (deps.now ?? new Date()).getTime();
  const alert = deps.alert ?? alertError;
  for (const link of links) {
    const baseline = (link as typeof link & { baselineEvidence?: { equityUsdMicros?: unknown } | null }).baselineEvidence;
    let baselineEquity: bigint;
    try {
      if (!baseline || typeof baseline.equityUsdMicros !== 'string' || !/^\d+$/.test(baseline.equityUsdMicros)) throw new Error('baseline evidence missing');
      baselineEquity = BigInt(baseline.equityUsdMicros);
      if (baselineEquity <= 0n) throw new Error('baseline equity is not positive');
    } catch (error) {
      await engageHalt({ scope: 'fleet', scopeId: null, reason: 'Fleet baseline evidence is invalid.', by: 'system:baseline-evidence' });
      void alert({
        severity: 'critical',
        source: 'trading-drawdown',
        message: 'An armed fleet link has invalid baseline evidence.',
        context: { avatarId: link.avatarId, error: error instanceof Error ? error.message : 'unknown' },
      });
      return { equityUsdMicros: null, startUsdMicros, halted: true };
    }
    startUsdMicros += baselineEquity;
    const equity = await (deps.readEquity ?? readTradingWalletEquity)({ walletPubkey: link.walletPubkey, connection: deps.connection });
    if (!equity) {
      if (fleetEquityUnreadableSinceMs === null) {
        fleetEquityUnreadableSinceMs = nowMs;
        void alert({ severity: 'warning', source: 'trading-drawdown', message: 'Fleet equity is unreadable.' });
      }
      const graceMs = Number(process.env.TRADING_EQUITY_UNREADABLE_GRACE_S ?? 300) * 1_000;
      if (Number.isFinite(graceMs) && graceMs >= 0 && nowMs - fleetEquityUnreadableSinceMs >= graceMs) {
        await engageHalt({ scope: 'fleet', scopeId: null, reason: 'Fleet equity remained unreadable.', by: 'system:equity-unreadable' });
        void alert({ severity: 'critical', source: 'trading-drawdown', message: 'Fleet equity remained unreadable past its grace period.' });
      }
      return { equityUsdMicros: null, startUsdMicros, halted: (await readActiveHalts()).some((halt) => halt.scope === 'fleet') };
    }
    equityUsdMicros += equity.equityUsdMicros;
  }
  fleetEquityUnreadableSinceMs = null;
  const pct = BigInt(Math.floor(readTradingLimits().fleetDrawdownHaltPct));
  const breached = startUsdMicros > 0n && equityUsdMicros * 100n < startUsdMicros * (100n - pct);
  if (breached) {
    await engageHalt({ scope: 'fleet', scopeId: null, reason: 'Fleet drawdown limit reached.', by: 'system:drawdown' });
    void alert({ severity: 'critical', source: 'trading-drawdown', message: 'Fleet drawdown limit reached.' });
  }
  return { equityUsdMicros, startUsdMicros, halted: breached || (await readActiveHalts()).some((halt) => halt.scope === 'fleet') };
}

export function startTradingDrawdownPoller(
  pollMs = Number(process.env.TRADING_DRAWDOWN_POLL_MS ?? 300_000),
): void {
  if (drawdownPoller) return;
  const run = () => {
    void evaluateFleetDrawdown().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown';
      if (!shouldAlertTradingLoop(`drawdown:${message}`)) return;
      return alertError({
        severity: 'warning',
        source: 'trading-drawdown',
        message: 'The fleet drawdown check failed.',
        context: { error: message },
      });
    });
  };
  run();
  drawdownPoller = setInterval(run, Math.max(5_000, pollMs));
  drawdownPoller.unref?.();
}

export function stopTradingDrawdownPoller(): void {
  if (drawdownPoller) clearInterval(drawdownPoller);
  drawdownPoller = null;
}
