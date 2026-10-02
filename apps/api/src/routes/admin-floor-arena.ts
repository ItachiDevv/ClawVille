import { Hono } from 'hono';
import { z } from 'zod';
import {
  FLOOR_ARENA_WITHDRAW_STATES,
  diffFloorArenaParams,
  validateFloorArenaParams,
  type FloorArenaWithdrawState,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { moneyOperatorOnly, type MoneyOperatorContext } from '../middleware/money-operator-only';
import { pauseFloorArenaEngine, readFloorArenaEngineState, resumeFloorArenaEngine } from '../services/floor-arena';
import {
  markArenaWithdrawalNeedsReview,
  readArenaAgent,
  readArenaWithdrawalsAdmin,
  resetArenaProvision,
  toPublicAgent,
  updateArenaAgentParams,
  type ArenaWithdrawalRecord,
} from '../services/floor-arena/queries';
import { describeChanges } from './floor-arena';

/**
 * Trading Floor Arena operator routes (docs/trading-floor-arena.md §5), mounted
 * at `/api/admin/floor-arena`. Same guard as admin-trading: a Lucia session of
 * an ADMIN_USER_IDS user, an allowed Origin, and a JSON content type on writes.
 * No route here moves money: house param edits are logged publicly
 * (`floor_arena_param_changes` source 'admin' + a 'param_change' event), and the
 * P5 withdraw routes only LIST withdrawals and mark a `sent` or `unknown` one
 * `needs_review` (I8). No admin route sends a withdrawal or edits a money field.
 */

export const adminFloorArenaRoutes = new Hono<MoneyOperatorContext>();
adminFloorArenaRoutes.use('*', sessionMiddleware);
adminFloorArenaRoutes.use('*', moneyOperatorOnly);

// ─── Withdraw review (P5, contract §6). Read + mark only; never a send. ────

export interface AdminArenaWithdrawDeps {
  listWithdrawals: typeof readArenaWithdrawalsAdmin;
  markNeedsReview: typeof markArenaWithdrawalNeedsReview;
}

export const defaultAdminArenaWithdrawDeps: AdminArenaWithdrawDeps = {
  listWithdrawals: readArenaWithdrawalsAdmin,
  markNeedsReview: markArenaWithdrawalNeedsReview,
};

const withdrawListQuery = z.object({
  state: z.enum([...FLOOR_ARENA_WITHDRAW_STATES] as [FloorArenaWithdrawState, ...FloorArenaWithdrawState[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const needsReviewBody = z.object({ note: z.string().trim().min(1).max(280) }).strict();

/** The full record for an operator. Atomic amounts are decimal STRINGS (int64), times ISO. No proof message or signature exists here. */
function adminWithdrawalJson(row: ArenaWithdrawalRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** Mounted on adminFloorArenaRoutes below, so the session + moneyOperatorOnly guard runs first. Tests mount it bare. */
export function createAdminArenaWithdrawRoutes(deps: AdminArenaWithdrawDeps = defaultAdminArenaWithdrawDeps) {
  const routes = new Hono<MoneyOperatorContext>();

  routes.get('/withdrawals', async (c) => {
    const query = withdrawListQuery.safeParse({ state: c.req.query('state') || undefined, limit: c.req.query('limit') });
    if (!query.success) {
      return c.json({ error: 'state must be a withdrawal state; limit 1..200.', code: 'invalid_query' }, 400);
    }
    const list = await deps.listWithdrawals({ state: query.data.state ?? null, limit: query.data.limit ?? 50 });
    return c.json({ withdrawals: list.map(adminWithdrawalJson) });
  });

  routes.post('/withdrawals/:id/needs-review', async (c) => {
    const id = c.req.param('id') ?? '';
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Withdrawal not found.', code: 'withdrawal_not_found' }, 404);
    let json: unknown;
    try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400); }
    const parsed = needsReviewBody.safeParse(json);
    if (!parsed.success) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
    // The query moves ONLY a 'sent' or 'unknown' row (CAS); false also covers an unknown id.
    if (!(await deps.markNeedsReview(id, parsed.data.note))) {
      return c.json({
        error: 'Only a sent or unknown withdrawal can be marked for review (or no withdrawal has this id).',
        code: 'not_reviewable',
      }, 409);
    }
    return c.json({ ok: true });
  });

  return routes;
}

adminFloorArenaRoutes.route('/', createAdminArenaWithdrawRoutes());

const houseParamsBody = z.object({
  params: z.unknown(),
  reason: z.string().trim().min(1).max(280),
}).strict();

adminFloorArenaRoutes.post('/house/:id/params', async (c) => {
  const id = c.req.param('id');
  if (!/^house:[a-z0-9-]{1,40}$/.test(id)) return c.json({ error: 'Not a house agent.', code: 'not_house_agent' }, 400);
  let json: unknown;
  try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400); }
  const parsed = houseParamsBody.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body.', code: 'invalid_body' }, 400);
  const agent = await readArenaAgent(id);
  if (!agent || agent.kind !== 'house') return c.json({ error: 'House agent not found.', code: 'agent_not_found' }, 404);
  const params = validateFloorArenaParams(parsed.data.params);
  if (!params.ok) return c.json({ error: 'Invalid params.', code: 'invalid_params', errors: params.errors }, 400);
  const changes = diffFloorArenaParams(agent.params, params.params);
  if (changes.length === 0) return c.json({ agent: toPublicAgent(agent), changes, paramsVersion: agent.paramsVersion });
  const written = await updateArenaAgentParams({
    agentId: agent.id,
    expectedVersion: agent.paramsVersion,
    params: params.params,
    changes,
    source: 'admin',
    reason: parsed.data.reason,
    summary: describeChanges(changes, 'Operator changed'),
  });
  if (!written.ok) return c.json({ error: 'The params changed at the same time. Reload and retry.', code: 'params_conflict' }, 409);
  const fresh = (await readArenaAgent(agent.id)) ?? agent;
  return c.json({ agent: toPublicAgent(fresh), changes, paramsVersion: written.paramsVersion });
});

// PAUSE IS IN MEMORY on the process that serves this request (lead decision,
// 2026-09-30): it stops NEW entries AND paid add-on calls (real USDC; money
// audit M2) on that process only, exits keep running, and a restart clears it.
// Use it to stop add-on spending immediately: the env switch
// FLOOR_ARENA_ADDON_PAYMENTS_ENABLED is read from the container environment,
// so changing it needs a restart. Correct while prod runs one api container;
// during a deploy flip (two containers) the leader may be the other one, so
// check `GET /engine/state` (`leader`, `entriesPaused`) after pausing.
adminFloorArenaRoutes.post('/engine/pause', (c) => {
  pauseFloorArenaEngine(`admin:${c.get('moneyOperatorId')}`);
  return c.json({ ok: true, state: readFloorArenaEngineState() });
});

adminFloorArenaRoutes.post('/engine/resume', (c) => {
  resumeFloorArenaEngine(`admin:${c.get('moneyOperatorId')}`);
  return c.json({ ok: true, state: readFloorArenaEngineState() });
});

adminFloorArenaRoutes.get('/engine/state', (c) => c.json({ state: readFloorArenaEngineState() }));

// Money audit N4: re-provision a user agent whose ClawPump setup FAILED (also
// after all 5 attempts were used, e.g. a ClawPump outage longer than the retry
// window). Resets it to 'pending' with a fresh attempt budget; the engine
// leader's 30 s provisioning tick runs the attempts. Any state but 'failed'
// is refused, so a ready or in-flight agent is never re-pointed.
adminFloorArenaRoutes.post('/agents/:id/reprovision', async (c) => {
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Not a user arena agent id.', code: 'invalid_agent_id' }, 400);
  const agent = await readArenaAgent(id);
  if (!agent || agent.kind !== 'user') return c.json({ error: 'Arena agent not found.', code: 'agent_not_found' }, 404);
  if (!(await resetArenaProvision(id))) {
    return c.json({ error: 'Only a failed provisioning can be retried.', code: 'not_failed', provisionState: agent.provisionState }, 409);
  }
  // Codex r19 (single writer): no ClawPump call here. The row is 'pending'
  // again; the engine leader provisions it on its next tick (every 30 s).
  const fresh = (await readArenaAgent(id)) ?? agent;
  return c.json({ ok: true, agent: toPublicAgent(fresh), provisionState: fresh.provisionState });
});
