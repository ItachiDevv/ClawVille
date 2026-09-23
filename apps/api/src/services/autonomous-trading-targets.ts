import { and, or, clawpumpAgentLinks, db, desc, eq, gte, inArray, tradingDecisions, tradingHalts, isNull } from '@clawville/database';
import {
  readTradingLimits,
  TRADE_REFUSAL_CODES,
  TRADE_MINTS,
  TRADING_OBJECTIVE_ALLOWED_OUTPUTS,
  TRADING_OBJECTIVE_BRIEFS,
  type TradingObjective,
} from '@clawville/shared';
import { readTradingWalletEquity } from './trading-fleet-equity';

export interface AutonomousTradingDesk {
  linked: boolean;
  armed: boolean;
  killed: boolean;
  objective: TradingObjective | null;
  objectiveBrief: string | null;
  equityUsd: string | null;
  floatStartUsd: string | null;
  positions: { symbol: string; mint: string; amountUi: string; valueUsd: string }[];
  cooldownSecondsRemaining: number;
  dailyNotionalUsedUsd: string;
  dailyNotionalCapUsd: string;
  halted: boolean;
  haltReason: string | null;
  allowedMints: { symbol: string; mint: string }[];
  lastIntel: string | null;
  lastTrades: { at: string; verdict: string; reason: string }[];
}

export const EMPTY_TRADING_DESK: AutonomousTradingDesk = {
  linked: false, armed: false, killed: true, objective: null, objectiveBrief: null,
  equityUsd: null, floatStartUsd: null, positions: [], cooldownSecondsRemaining: 0,
  dailyNotionalUsedUsd: '0.00', dailyNotionalCapUsd: '0.00', halted: false,
  haltReason: null, allowedMints: [], lastIntel: null, lastTrades: [],
};

const SYMBOL = new Map<string, string>(Object.entries(TRADE_MINTS).map(([symbol, mint]) => [mint, symbol === 'WSOL' ? 'SOL' : symbol]));
const usd = (micros: bigint) => (Number(micros) / 1_000_000).toFixed(2);

export async function readAutonomousTradingTargets(input: { avatarId: string }): Promise<AutonomousTradingDesk> {
  const link = await db.query.clawpumpAgentLinks.findFirst({ where: eq(clawpumpAgentLinks.avatarId, input.avatarId) });
  if (!link) return EMPTY_TRADING_DESK;
  const limits = readTradingLimits();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const countedStatuses = ['admitted', 'submitted', 'executed', 'reconcile'];
  const [equity, recent, lastCounted, halts, daily] = await Promise.all([
    readTradingWalletEquity({ walletPubkey: link.walletPubkey }),
    db.select().from(tradingDecisions).where(eq(tradingDecisions.avatarId, input.avatarId)).orderBy(desc(tradingDecisions.createdAt)).limit(3),
    db.select({ createdAt: tradingDecisions.createdAt }).from(tradingDecisions).where(and(
      eq(tradingDecisions.avatarId, input.avatarId),
      inArray(tradingDecisions.status, countedStatuses),
    )).orderBy(desc(tradingDecisions.createdAt)).limit(1),
    // Bind the same fleet/avatar scope used below. A zero-parameter SELECT uses
    // postgres.js simple protocol and can stall adjacent extended queries on
    // the transaction pooler; keep this concurrent batch parameterized.
    db.select().from(tradingHalts).where(and(
      isNull(tradingHalts.clearedAt),
      or(eq(tradingHalts.scope, 'fleet'), eq(tradingHalts.scopeId, input.avatarId)),
    )),
    db.select({ amount: tradingDecisions.amountUsdMicros }).from(tradingDecisions).where(and(
      eq(tradingDecisions.avatarId, input.avatarId),
      gte(tradingDecisions.createdAt, start),
      inArray(tradingDecisions.status, countedStatuses),
    )),
  ]);
  const halt = halts.find((row) => row.scope === 'fleet' || row.scopeId === input.avatarId);
  const lastAt = lastCounted[0]?.createdAt?.getTime() ?? 0;
  const objective = link.objective as TradingObjective;
  return {
    linked: true,
    armed: link.armed,
    killed: link.killed,
    objective,
    objectiveBrief: TRADING_OBJECTIVE_BRIEFS[objective],
    equityUsd: equity ? usd(equity.equityUsdMicros) : null,
    floatStartUsd: usd(BigInt(link.floatStartUsdMicros)),
    positions: (equity?.positions ?? []).slice(0, 6).map((position) => ({
      symbol: position.symbol,
      mint: position.mint,
      amountUi: (Number(position.amountAtomic) / 10 ** position.decimals).toFixed(6),
      valueUsd: usd(position.valueUsdMicros),
    })),
    cooldownSecondsRemaining: Math.max(0, Math.ceil((lastAt + limits.cooldownSeconds * 1_000 - Date.now()) / 1_000)),
    dailyNotionalUsedUsd: usd(daily.reduce((sum, row) => sum + BigInt(row.amount), 0n)),
    dailyNotionalCapUsd: limits.dailyNotionalUsdPerAgent.toFixed(2),
    halted: Boolean(halt),
    haltReason: halt?.reason ?? null,
    allowedMints: halt ? [] : TRADING_OBJECTIVE_ALLOWED_OUTPUTS[objective].slice(0, 12).map((mint) => ({ symbol: SYMBOL.get(mint) ?? mint, mint })),
    lastIntel: null,
    lastTrades: recent.map((row) => ({ at: row.createdAt.toISOString(), verdict: row.status, reason: row.reason.slice(0, 120) })),
  };
}

export function formatAutonomousTradingDesk(desk: AutonomousTradingDesk): string {
  if (!desk.linked) return '';
  const lines = [
    'Trading desk:',
    `Status: armed=${desk.armed}; killed=${desk.killed}`,
    `Objective: ${desk.objective ?? 'none'} — ${desk.objectiveBrief ?? ''}`,
    `Equity: ${desk.equityUsd ?? 'unreadable'} USD; funded start: ${desk.floatStartUsd ?? 'unreadable'} USD`,
    `Cooldown: ${desk.cooldownSecondsRemaining}s; daily: ${desk.dailyNotionalUsedUsd}/${desk.dailyNotionalCapUsd} USD`,
    `Refusal codes: ${TRADE_REFUSAL_CODES.join(', ')}`,
  ];
  if (desk.halted) lines.push(`TRADING IS HALTED: ${desk.haltReason ?? 'operator halt'}`);
  else lines.push(`Allowed mints: ${desk.allowedMints.map((mint) => `${mint.symbol}=${mint.mint}`).join(', ')}`);
  if (desk.lastIntel) lines.push(`Intel: ${desk.lastIntel.slice(0, 240)}`);
  return lines.join('\n');
}
