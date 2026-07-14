/**
 * Internal E1/E2 job/admin surface. DOUBLE default-off gate:
 * literal TOKENOMICS_EARN_ENABLED=true plus a named Lucia ADMIN_USER_IDS member.
 * The shared cv_dash cookie is insufficient for every liability-changing path.
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import type { AppContext } from '../types';
import {
  clawBackEarnEvent,
  earnFromExternalSettlement,
  loadTokenomicsEarnConfig,
  runPayerVerificationBatch,
} from '../services/earned-import';

export const tokenomicsEarnRoutes = new Hono<AppContext>();
tokenomicsEarnRoutes.use('*', sessionMiddleware);

export function assertTokenomicsEarnEnabled(): void {
  if (!loadTokenomicsEarnConfig().enabled) {
    throw new HTTPException(503, { message: 'tokenomics_earn_disabled' });
  }
}

// Route-level half of the dark double gate. This runs before route-specific
// admin middleware so a disabled money surface is uniformly unavailable.
tokenomicsEarnRoutes.use('*', async (_c, next) => {
  assertTokenomicsEarnEnabled();
  await next();
});

function requireNamedAdmin(c: Context<AppContext>) {
  const user = c.get('user');
  const ids = (process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!user || !ids.includes(user.id)) {
    throw new HTTPException(403, { message: 'named_admin_required' });
  }
  return user;
}

const importSchema = z.object({
  earnerAvatarId: z.string().uuid(),
  payerWallet: z.string().min(32).max(44),
  usdcAmountAtomic: z.string().regex(/^\d+$/),
  source: z.enum(['sap_escrow', 'x402', 'admin_test']).default('admin_test'),
  /** Stale clients may send it, but only the founder-locked zero is accepted. */
  rakeBps: z.literal(0).optional().default(0),
  idempotencyKey: z.string().min(8).max(128),
  backingTxSignature: z.string().trim().min(32).max(128),
  backingNetwork: z.enum(['mainnet', 'devnet']),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

tokenomicsEarnRoutes.post('/import', adminOnly, async (c) => {
  requireNamedAdmin(c);
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_body' });
  const result = await earnFromExternalSettlement(parsed.data);
  if (result.status === 'gated_off') throw new HTTPException(503, { message: 'tokenomics_earn_disabled' });
  if (result.status === 'rejected') {
    const status = result.reason === 'idempotency_conflict' ? 409 : 422;
    return c.json({ ok: false, ...result }, status);
  }
  return c.json({ ok: true, replay: result.status === 'duplicate', ...result });
});

/** Real async job surface: each call actually transitions pending rows. */
tokenomicsEarnRoutes.post('/verify-payers', adminOnly, async (c) => {
  requireNamedAdmin(c);
  return c.json({ ok: true, ...(await runPayerVerificationBatch()) });
});

const clawbackSchema = z.object({ reason: z.string().trim().min(3).max(500) });
tokenomicsEarnRoutes.post('/claw-back/:earnEventId', adminOnly, async (c) => {
  const admin = requireNamedAdmin(c);
  const earnEventId = z.string().uuid().safeParse(c.req.param('earnEventId'));
  const body = clawbackSchema.safeParse(await c.req.json().catch(() => null));
  if (!earnEventId.success || !body.success) {
    throw new HTTPException(400, { message: 'invalid_body' });
  }
  const result = await clawBackEarnEvent({
    earnEventId: earnEventId.data,
    adminUserId: admin.id,
    reason: body.data.reason,
  });
  return c.json({ ok: true, ...result });
});
