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
  type TradeRefusalCode,
} from '@clawville/shared';
import { withKeyedMutex } from './keyed-mutex';
import { admitPosterUsdcSpend, PosterUsdcSpendAdmissionError } from './usdc-spend-admission';
import { deriveTradingAta, getMintInfo, loadTradingMintWhitelist, type MintInfo } from './trading-mint-info';
import { readTradingWalletEquity } from './trading-fleet-equity';
import { fetchJupiterPrices } from './trade-price';
import { alertError, type AlertErrorParams } from './alert-error';

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
export type TradeVerdict = { kind: 'allow'; admission: TradeAdmission } | { kind: 'refuse'; code: TradeRefusalCode; detail: string; decisionId: string };

export interface TradingGuardrailDeps {
  connection?: Connection;
  now?: Date;
  readUsdcBalance?: (pubkey: string, signal: AbortSignal) => Promise<bigint>;
  readEquity?: typeof readTradingWalletEquity;
  alert?: (input: AlertErrorParams) => Promise<void>;
}

let fleetEquityUnreadableSinceMs: number | null = null;
let drawdownPoller: ReturnType<typeof setInterval> | null = null;

function connection(): Connection {
  const endpoint = process.env.HELIUS_RPC_URL;
  if (!endpoint) throw new Error('Helius mainnet RPC not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().includes('mainnet')) throw new Error('Helius RPC is not a mainnet endpoint');
  return new Connection(endpoint, 'confirmed');
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

export async function inspectTradePreconditions(intent: TradeIntent, deps: Pick<TradingGuardrailDeps, 'connection'> = {}): Promise<
  { kind: 'continue'; link: TradingLink } | Extract<TradeVerdict, { kind: 'refuse' }>
> {
  const link = await db.query.clawpumpAgentLinks.findFirst({ where: eq(clawpumpAgentLinks.avatarId, intent.avatarId) });
  if (!link) return recordRefusal(intent, 'no_link', 'No fleet trading link exists.');
  if (!link.armed) return recordRefusal(intent, 'armed_false', 'The fleet link is unarmed.');
  if (link.killed) return recordRefusal(intent, 'agent_killed', 'The fleet link is killed.');
  if (!process.env.JUPITER_API_KEY) return recordRefusal(intent, 'not_configured', 'Jupiter execution credentials are absent.');
  if (!deps.connection) {
    try { connection(); }
    catch { return recordRefusal(intent, 'not_configured', 'Helius mainnet execution is not configured.'); }
  }
  return { kind: 'continue', link };
}

export async function admitTrade(intent: TradeIntent, deps: TradingGuardrailDeps = {}): Promise<TradeVerdict> {
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
  if (!inputInfo || !outputInfo) return recordRefusal(intent, 'decimals_unresolved', 'Mint metadata could not be read.');
  if (!equity) return recordRefusal(intent, 'equity_unreadable', 'Wallet equity could not be read.');
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
  if (equity.nativeLamports < limits.minSolReserveLamports + limits.maxPriorityFeeLamports + nativeDebit) {
    return recordRefusal(intent, 'sol_reserve_breached', 'The trade would cross the SOL reserve floor.');
  }

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
    if (intent.directiveId) {
      const prior = await tx.select({ id: tradingDecisions.id }).from(tradingDecisions).where(and(eq(tradingDecisions.directiveId, intent.directiveId), eq(tradingDecisions.directiveOrdinal, intent.directiveOrdinal!))).limit(1);
      if (prior.length) return refuseLocked('directive_replayed', 'The directive was already claimed.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const readUsdcBalance = deps.readUsdcBalance ?? (async (pubkey: string, signal: AbortSignal) => {
      if (signal.aborted) throw new Error('aborted');
      const usdc = await getMintInfo(TRADE_MINTS.USDC, { connection: conn });
      if (!usdc) throw new Error('usdc metadata unavailable');
      const balance = await conn.getTokenAccountBalance(deriveTradingAta(new PublicKey(pubkey), usdc), 'confirmed');
      if (signal.aborted) throw new Error('aborted');
      return BigInt(balance.value.amount);
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
      slippageBps: Math.floor(limits.maxSlippageBps), verdict: 'admitted', status: 'admitted',
      reason: intent.reason, detail: '', directiveId: intent.directiveId, directiveOrdinal: intent.directiveOrdinal,
      operatorId: intent.operatorId ?? null,
    });
    await tx.insert(tradingUsdcReservations).values({ decisionId, avatarId: intent.avatarId, amountBaseUnits: intent.amountUsdMicros.toString(), status: 'open' });
    return { kind: 'allow', admission: { decisionId, link, amountAtomic, notionalUsdMicros: intent.amountUsdMicros, slippageBps: Math.floor(limits.maxSlippageBps), inputInfo, outputInfo, equityUsdMicros: equity.equityUsdMicros } } as TradeVerdict;
  })));
}

export async function recordTradeOutcome(input: {
  decisionId: string;
  status: 'executed' | 'refused' | 'failed' | 'reconcile' | 'expired';
  signature?: string | null;
  errorCode?: TradeRefusalCode | null;
  errorDetail?: string | null;
  expectedStatus: 'admitted' | 'submitted';
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const settled = ['executed', 'refused', 'failed', 'expired'].includes(input.status);
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
      await tx.update(tradingUsdcReservations).set({ status: 'reconcile', releaseReason: 'ambiguous_send' }).where(eq(tradingUsdcReservations.decisionId, input.decisionId));
    } else if (settled) {
      const reservationStatus = input.status === 'executed'
        ? 'settled'
        : input.status === 'expired' ? 'expired' : 'failed';
      await tx.update(tradingUsdcReservations).set({
        status: reservationStatus,
        releaseReason: input.status,
        releasedAt: new Date(),
      }).where(eq(tradingUsdcReservations.decisionId, input.decisionId));
    }
    return true;
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
  const links = await db.select().from(clawpumpAgentLinks).where(eq(clawpumpAgentLinks.operatedByClawville, true));
  const startUsdMicros = links.reduce((sum, link) => sum + BigInt(link.floatStartUsdMicros), 0n);
  let equityUsdMicros = 0n;
  const nowMs = (deps.now ?? new Date()).getTime();
  const alert = deps.alert ?? alertError;
  for (const link of links) {
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
    void evaluateFleetDrawdown().catch((error: unknown) => alertError({
      severity: 'warning',
      source: 'trading-drawdown',
      message: 'The fleet drawdown check failed.',
      context: { error: error instanceof Error ? error.message : 'unknown' },
    }));
  };
  run();
  drawdownPoller = setInterval(run, Math.max(5_000, pollMs));
  drawdownPoller.unref?.();
}

export function stopTradingDrawdownPoller(): void {
  if (drawdownPoller) clearInterval(drawdownPoller);
  drawdownPoller = null;
}
