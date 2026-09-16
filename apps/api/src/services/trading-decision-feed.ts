import type { TradingDecisionRow } from '@clawville/database';
import { isTradeRefusalCode, type TradeRefusalCode } from '@clawville/shared';
import { broadcastTradeDecisionEvent } from '../routes/world';

export interface TradeDecisionFrame {
  type: 'trade.decision';
  decisionId: string;
  subject: { type: 'agent'; id: string; avatarName: string | null };
  verdict: 'submitted' | 'refused' | 'executed';
  reason: TradeRefusalCode | null;
  inputMint: string;
  outputMint: string;
  requestedUsd: number | null;
  operatedByClawville: boolean;
  at: string;
}

export function buildTradeDecisionFrame(input: {
  row: TradingDecisionRow;
  agentId: string | null;
  avatarName: string | null;
  operatedByClawville: boolean;
}): TradeDecisionFrame {
  const status = input.row.status;
  const verdict: TradeDecisionFrame['verdict'] = status === 'executed'
    ? 'executed'
    : status === 'submitted' ? 'submitted' : 'refused';
  return {
    type: 'trade.decision',
    decisionId: input.row.id,
    subject: { type: 'agent', id: input.agentId ?? input.row.avatarId, avatarName: input.avatarName },
    verdict,
    reason: verdict === 'refused' && isTradeRefusalCode(input.row.verdict) ? input.row.verdict : null,
    inputMint: input.row.inputMint,
    outputMint: input.row.outputMint,
    requestedUsd: Number.isFinite(Number(input.row.amountUsdMicros)) ? Number(input.row.amountUsdMicros) / 1_000_000 : null,
    operatedByClawville: input.operatedByClawville,
    at: (input.row.settledAt ?? input.row.createdAt).toISOString(),
  };
}

export function publishTradeDecision(frame: TradeDecisionFrame): void {
  try { broadcastTradeDecisionEvent(frame); } catch { /* notification only */ }
}
