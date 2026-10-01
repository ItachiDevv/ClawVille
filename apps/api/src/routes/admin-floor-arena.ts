import { Hono } from 'hono';
import { z } from 'zod';
import { diffFloorArenaParams, validateFloorArenaParams } from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { moneyOperatorOnly, type MoneyOperatorContext } from '../middleware/money-operator-only';
import { pauseFloorArenaEngine, readFloorArenaEngineState, resumeFloorArenaEngine } from '../services/floor-arena';
import { readArenaAgent, resetArenaProvision, toPublicAgent, updateArenaAgentParams } from '../services/floor-arena/queries';
import { describeChanges } from './floor-arena';

/**
 * Trading Floor Arena operator routes (docs/trading-floor-arena.md §5), mounted
 * at `/api/admin/floor-arena`. Same guard as admin-trading: a Lucia session of
 * an ADMIN_USER_IDS user, an allowed Origin, and a JSON content type on writes.
 * Paper only: nothing here moves money. House param edits are logged publicly
 * (`floor_arena_param_changes` source 'admin' + a 'param_change' event).
 */

export const adminFloorArenaRoutes = new Hono<MoneyOperatorContext>();
adminFloorArenaRoutes.use('*', sessionMiddleware);
adminFloorArenaRoutes.use('*', moneyOperatorOnly);

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
