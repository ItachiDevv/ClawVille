import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession, requireLedgerCapableIdentity, type ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { executeTrade } from '../services/trading-execution';
import { readAutonomousTradingTargets } from '../services/autonomous-trading-targets';
import { TRADING_SYMBOL_TO_MINT } from '@clawville/shared';

export const tradingFloorRoutes = new Hono<ActivityAuthContext>();
tradingFloorRoutes.use('*', sessionMiddleware);
const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });

const bodySchema = z.object({
  inputMint: z.string().min(1).max(44),
  outputMint: z.string().min(1).max(44),
  amountUsd: z.number().min(1).max(25),
  reason: z.string().trim().min(1).max(240).refine((value) => !/[,=()[\]]/.test(value)),
}).strict();

function mint(value: string): string | null {
  const key = value.replace(/^\$/, '').toUpperCase();
  if (Object.hasOwn(TRADING_SYMBOL_TO_MINT, key)) return TRADING_SYMBOL_TO_MINT[key as keyof typeof TRADING_SYMBOL_TO_MINT];
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
}

tradingFloorRoutes.post('/trade', requireAuthOrAgentSession, requireNonGuestIdentity, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  if (!limiter.check(getClientIp(c))) return c.json({ error: 'Too many trade requests.', code: 'rate_limited' }, 429);
  let json: unknown;
  try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON.', code: 'invalid_body' }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid trade request.', code: 'invalid_body' }, 400);
  const inputMint = mint(parsed.data.inputMint);
  const outputMint = mint(parsed.data.outputMint);
  if (!inputMint || !outputMint) return c.json({ kind: 'refused', decisionId: null, code: 'mint_not_whitelisted', detail: 'A mint is invalid.', signature: null });
  const identity = c.get('identity');
  const micros = BigInt(Math.round(parsed.data.amountUsd * 1_000_000));
  const result = await executeTrade({
    avatarId: identity.avatarId,
    inputMint,
    outputMint,
    amountUsdMicros: micros,
    reason: parsed.data.reason,
    origin: identity.kind === 'agent' ? 'agent-tool' : 'human-rest',
    sessionId: identity.kind === 'agent' ? c.req.header('x-clawville-agent-session') ?? null : null,
    agentId: identity.agentId,
    directiveId: null,
    directiveOrdinal: null,
  });
  return c.json(result);
});

tradingFloorRoutes.get('/state', requireAuthOrAgentSession, requireNonGuestIdentity, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  return c.json(await readAutonomousTradingTargets({ avatarId: c.get('identity').avatarId }));
});
