import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { issueMoneyOperatorNonce, moneyOperatorOnly, type MoneyOperatorContext } from '../middleware/money-operator-only';
import { armTradingLink, killTradingLink, readTradingLink } from '../services/trading-links';
import { clearHalt, engageHalt, readActiveHalts, releaseLegacyAdmittedDecision } from '../services/trading-guardrails';
import { hasUnknownPositiveTradingBalance, readTradingWalletEquity, toTradingBaselineEvidence } from '../services/trading-fleet-equity';
import { executeTrade } from '../services/trading-execution';
import { issueFounderPairChallenge, pairFounderAgent, provisionFleetAccount, TradingProvisioningError } from '../services/trading-provisioning';
import { readTradingLimits, TRADE_MINTS, TRADING_OBJECTIVES, TRADING_SYMBOL_TO_MINT } from '@clawville/shared';

export const adminTradingRoutes = new Hono<MoneyOperatorContext>();
adminTradingRoutes.use('*', sessionMiddleware);
adminTradingRoutes.use('*', moneyOperatorOnly);

const avatarBody = z.object({ avatarId: z.string().uuid() }).strict();
const haltBody = z.object({ scope: z.enum(['fleet', 'agent']), avatarId: z.string().uuid().nullable().optional(), reason: z.string().trim().min(1).max(240) }).strict();
const killBody = z.object({ avatarId: z.string().uuid() }).strict();
const testBody = z.object({ avatarId: z.string().uuid(), inputMint: z.string(), outputMint: z.string(), amountUsd: z.number().min(1).max(25), reason: z.string().max(240) }).strict();
const provisionBody = z.object({
  objective: z.enum(TRADING_OBJECTIVES),
  traderName: z.string().trim().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
  leaderboardEligible: z.boolean().optional().default(true),
}).strict();
const pairChallengeBody = z.object({ avatarId: z.string().uuid(), walletPubkey: z.string().trim().min(32).max(64) }).strict();
const pairBody = z.object({
  avatarId: z.string().uuid(),
  clawpumpAgentId: z.string().trim().min(1).max(128),
  walletPubkey: z.string().trim().min(32).max(64),
  objective: z.enum(TRADING_OBJECTIVES),
  nonce: z.string().trim().min(32).max(128),
  signature: z.string().trim().min(64).max(128),
}).strict();
const releaseAdmittedBody = z.object({ decisionId: z.string().uuid() }).strict();

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  try { const parsed = schema.safeParse(await c.req.json()); return parsed.success ? parsed.data : null; } catch { return null; }
}

adminTradingRoutes.get('/nonce', (c) => c.json(issueMoneyOperatorNonce(c.get('moneyOperatorId'))));

adminTradingRoutes.post('/fleet/provision', async (c) => {
  const parsed = await body(c, provisionBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  try {
    return c.json(await provisionFleetAccount({
      ...parsed,
      leaderboardEligible: parsed.leaderboardEligible ?? true,
      operatedByClawville: true,
    }));
  } catch (error) {
    if (error instanceof TradingProvisioningError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
});

adminTradingRoutes.post('/pair/challenge', async (c) => {
  const parsed = await body(c, pairChallengeBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  try {
    return c.json(await issueFounderPairChallenge(parsed));
  } catch (error) {
    if (error instanceof TradingProvisioningError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

adminTradingRoutes.post('/pair', async (c) => {
  const parsed = await body(c, pairBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  try {
    return c.json(await pairFounderAgent(parsed));
  } catch (error) {
    if (error instanceof TradingProvisioningError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
});

adminTradingRoutes.post('/arm', async (c) => {
  const parsed = await body(c, avatarBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  const link = await readTradingLink(parsed.avatarId);
  if (!link) return c.json({ error: 'No fleet link.', code: 'no_link' }, 404);
  if (!link.operatedByClawville) return c.json({ error: 'Only ClawVille-operated fleet links can arm.', code: 'not_fleet_operated' }, 409);
  if (link.armed) return c.json({ error: 'Already armed.', code: 'already_armed' }, 409);
  const equity = await readTradingWalletEquity({ walletPubkey: link.walletPubkey });
  if (!equity || equity.equityUsdMicros <= 0n) return c.json({ error: 'Equity is zero or unreadable.', code: 'zero_equity' }, 409);
  const unknownBalance = await hasUnknownPositiveTradingBalance({ walletPubkey: link.walletPubkey, minContextSlot: equity.slot });
  if (unknownBalance !== false) return c.json({ error: 'An unknown token balance is present or unreadable.', code: 'unknown_token_balance' }, 409);
  const limits = readTradingLimits();
  const usdc = equity.positions.find((position) => position.mint === TRADE_MINTS.USDC)?.amountAtomic ?? 0n;
  if (equity.nativeLamports < limits.minSolReserveLamports || usdc < limits.minUsdcReserveMicros) {
    return c.json({ error: 'The wallet is below a trading reserve floor.', code: 'reserve_floor' }, 409);
  }
  const armed = await armTradingLink({
    avatarId: parsed.avatarId,
    equityUsdMicros: equity.equityUsdMicros,
    nativeLamports: equity.nativeLamports,
    baselineSlot: equity.slot,
    baselineEvidence: toTradingBaselineEvidence(equity),
  });
  if (!armed) return c.json({ error: 'Arm state changed.', code: 'already_armed' }, 409);
  return c.json({ ok: true, floatStartUsdMicros: armed.floatStartUsdMicros, baselineSlot: armed.baselineSlot, armed: true });
});

adminTradingRoutes.post('/halt', async (c) => {
  const parsed = await body(c, haltBody);
  if (!parsed || (parsed.scope === 'agent') !== Boolean(parsed.avatarId)) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  await engageHalt({ scope: parsed.scope, scopeId: parsed.avatarId ?? null, reason: parsed.reason, by: `admin:${c.get('moneyOperatorId')}` });
  return c.json({ ok: true });
});

adminTradingRoutes.post('/unhalt', async (c) => {
  const parsed = await body(c, haltBody);
  if (!parsed || (parsed.scope === 'agent') !== Boolean(parsed.avatarId)) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  await clearHalt({ scope: parsed.scope, scopeId: parsed.avatarId ?? null, by: `admin:${c.get('moneyOperatorId')}` });
  return c.json({ ok: true });
});

adminTradingRoutes.post('/kill', async (c) => {
  const parsed = await body(c, killBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  const updated = await killTradingLink(parsed.avatarId);
  return updated ? c.json({ ok: true, killed: updated.killed, armed: updated.armed }) : c.json({ error: 'No fleet link.', code: 'no_link' }, 404);
});

adminTradingRoutes.post('/release-admitted', async (c) => {
  const parsed = await body(c, releaseAdmittedBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  const result = await releaseLegacyAdmittedDecision(parsed.decisionId);
  if (result === 'not_found') return c.json({ error: 'Decision not found.', code: 'decision_not_found' }, 404);
  if (result === 'not_releasable') return c.json({ error: 'Decision has a signature or is not admitted.', code: 'decision_not_releasable' }, 409);
  return c.json({ ok: true, releaseReason: 'operator_never_signed' });
});

adminTradingRoutes.get('/state', async (c) => c.json({ halts: await readActiveHalts() }));

adminTradingRoutes.post('/test-trade', async (c) => {
  const parsed = await body(c, testBody);
  if (!parsed) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  const resolve = (value: string) => {
    const key = value.replace(/^\$/, '').toUpperCase();
    return Object.hasOwn(TRADING_SYMBOL_TO_MINT, key) ? TRADING_SYMBOL_TO_MINT[key as keyof typeof TRADING_SYMBOL_TO_MINT] : value;
  };
  return c.json(await executeTrade({
    avatarId: parsed.avatarId, inputMint: resolve(parsed.inputMint), outputMint: resolve(parsed.outputMint),
    amountUsdMicros: BigInt(Math.round(parsed.amountUsd * 1_000_000)), reason: parsed.reason,
    origin: 'admin-test', sessionId: null, agentId: null, directiveId: null, directiveOrdinal: null,
    operatorId: c.get('moneyOperatorId'),
  }));
});
