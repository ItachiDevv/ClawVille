import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { z, ZodError } from 'zod';
import {
  BRAINCHAIN_CAPABILITIES, BRAINCHAIN_CURRICULUM_SECTIONS, BRAINCHAIN_CURRICULUM_VERSION,
  BRAINCHAIN_NETWORKS, BRAINCHAIN_RESEARCH_DATE, buildBrainchainOfficeManual,
} from '@clawville/shared';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { brainChainStatus } from '../services/brainchain/status';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountWorkerPolicyRoutes } from './brainchain-worker-policy';
import {mountFundingExitRoutes} from './brainchain-funding-exit';
import {mountExactRecoveryRoutes} from './brainchain-exact-recovery';
import type { BuyerOwner, BrainchainPurchases } from '../services/brainchain/purchases';
import type { ActivityAuthContext, ActivityIdentity } from '../middleware/require-auth-or-agent';

/** Public knowledge and bounded observations only. Private operations use a separate bound identity path. */
export function createBrainChainRoutes(status = brainChainStatus, options: {
  /** Internal hosted-action fence; never populated from an HTTP header or body. Throw to reject. */
  assertIdentity?: (identity: ActivityIdentity) => void | Promise<void>;
  purchases?: () => Promise<BrainchainPurchases>;
} = {}) {
  const routes = new Hono<ActivityAuthContext>();
  routes.use('*', async (c, next) => {
    if (c.req.raw.body) {
      // This router mounts before jsonBodyGuard. Read no more than 4 KiB before auth or parsing.
      const reader = c.req.raw.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > (c.req.path.includes('/purchases') ? 70000 : 4096)) {
            await reader.cancel();
            return c.json({ error: 'body_too_large' }, 413);
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { return c.json({ error: 'invalid_request' }, 400); }
      // Hono's runtime cache holds promises even though this installed declaration types values directly.
      (c.req.bodyCache as { text?: Promise<string> }).text = Promise.resolve(text);
    }
    await next();
  });
  const limiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
  routes.use('*', async (c, next) => {
    if (!limiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, 429);
    }
    await next();
  });
  routes.get('/knowledge', (c) => {
    const manual = buildBrainchainOfficeManual();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      version: BRAINCHAIN_CURRICULUM_VERSION,
      contentHash: createHash('sha256').update(manual, 'utf8').digest('hex'),
      manual, sections: BRAINCHAIN_CURRICULUM_SECTIONS,
      reviewedAt: BRAINCHAIN_RESEARCH_DATE, networks: BRAINCHAIN_NETWORKS,
      capabilities: BRAINCHAIN_CAPABILITIES,
    });
  });
  routes.get('/status', async (c) => {
    // Internal service coalesces all callers and caches both successful and failed probes.
    c.header('Cache-Control', 'no-store');
    return c.json({
      capabilities: BRAINCHAIN_CAPABILITIES,
      observation: await status.getStatus(),
    });
  });
  // Lazy imports keep public knowledge independent of database/runtime initialization.
  // Every owner-scoped route needs this chain; /funding-exit was missing until 2026-11-13 (its reads failed as a generic 503).
  const privatePaths = ['/workers', '/workers/*', '/install', '/purchases', '/purchases/*', '/funding-exit', '/funding-exit/*'];
  for (const path of privatePaths) routes.use(path, async (c, next) => {
    const { sessionMiddleware } = await import('../middleware/auth');
    const { requireAuthOrAgentSession, requireLedgerCapableIdentity } = await import('../middleware/require-auth-or-agent');
    const { requireNonGuestIdentity } = await import('../middleware/require-non-guest');
    // Session middleware uses only AppContext's user/session fields, which this context includes.
    const session = await (sessionMiddleware as unknown as MiddlewareHandler<ActivityAuthContext>)(c, async () => {});
    if (session instanceof Response) return session;
    const authenticated = await requireAuthOrAgentSession(c, async () => {});
    if (authenticated instanceof Response) return authenticated;
    const ledger = await requireLedgerCapableIdentity(c, async () => {});
    if (ledger instanceof Response) return ledger;
    const guest = await requireNonGuestIdentity(c, async () => {});
    if (guest instanceof Response) return guest;
    await options.assertIdentity?.(c.get('identity'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const purchases = options.purchases ?? (async () => (await import('../services/brainchain/purchases')).getBrainchainPurchases());
  function purchaseOwner(c: Context<ActivityAuthContext>): BuyerOwner {
    const identity = c.get('identity');
    const cookie = c.req.header('Cookie') ?? '';
    return { avatarId: identity.avatarId, userId: identity.userId, actor: identity.kind === 'agent' ? 'agent' : 'human',
      async assertCurrent() {
        if (identity.kind === 'agent') {
          const { resolveAgentSession } = await import('../middleware/require-auth-or-agent');
          const current = await resolveAgentSession(identity.sessionId);
          if (!current?.ledgerCapable || current.userId !== identity.userId || current.avatarId !== identity.avatarId || current.agentId !== identity.agentId) throw new HTTPException(403);
        } else {
          const { lucia } = await import('../lib/auth');
          const id = lucia.readSessionCookie(cookie);
          if (!id) throw new HTTPException(401);
          const current = await lucia.validateSession(id);
          if (!current.session || !current.user || current.user.id !== identity.userId) throw new HTTPException(403);
        }
        await options.assertIdentity?.(identity);
      } };
  }
  mountFundingExitRoutes(routes,purchaseOwner,async()=>(await import('../services/brainchain/funding-exit-operations')).getFundingExitOperations());
  mountWorkerPolicyRoutes(routes,purchaseOwner,async()=>(await import('../services/brainchain/worker-owner-policy')).getWorkerOwnerPolicies());
  mountExactRecoveryRoutes(routes,c=>({...purchaseOwner(c),humanSessionId:c.get('session')?.id}),async()=>(await import('../services/brainchain/exact-result-recovery-consent')).getExactResultRecoveryConsents());
  const noBody = async (c: Context<ActivityAuthContext>) => {
    const body = await c.req.text();
    if (body.length && body !== '{}') throw new ZodError([{ code:'custom',path:[],message:'Empty body required' }]);
  };
  routes.get('/purchases', async c => { const service = await purchases(); return c.json(await service.list(purchaseOwner(c))); });
  routes.post('/purchases', async c => c.json({order:await (await purchases()).draft(purchaseOwner(c),await c.req.json())},201));
  routes.get('/purchases/:id', async c => c.json({order:await (await purchases()).get(purchaseOwner(c),z.string().uuid().parse(c.req.param('id')))}));
  const purchaseOperation=(operation:'quote'|'submit'|'recover'|'reconcile'|'cancel')=>async(c:Context<ActivityAuthContext>)=>{
    await noBody(c); const service = await purchases(),owner = purchaseOwner(c),id=z.string().uuid().parse(c.req.param('id'));
    const order = operation === 'submit' || operation === 'recover' ? await service.submit(owner,id,operation==='recover') : await service[operation](owner,id);
    return c.json({order});
  };
  routes.post('/purchases/:id/quote',purchaseOperation('quote'));
  routes.post('/purchases/:id/submit',purchaseOperation('submit'));
  routes.post('/purchases/:id/recover',purchaseOperation('recover'));
  routes.post('/purchases/:id/reconcile',purchaseOperation('reconcile'));
  routes.post('/purchases/:id/cancel',purchaseOperation('cancel'));
  routes.post('/purchases/:id/intent',async c => c.json(await (await purchases()).intent(purchaseOwner(c),z.string().uuid().parse(c.req.param('id')),await c.req.json())));
  // Signed bytes go directly from the external payer to this private endpoint, never through model tools.
  routes.post('/purchases/:id/capture',async c => c.json({order:await (await purchases()).capture(purchaseOwner(c),z.string().uuid().parse(c.req.param('id')),await c.req.json())}));
  const purchaseApproval=(operation:'approval-challenge'|'approve')=>async(c:Context<ActivityAuthContext>)=>{
    const { refuseAgentHeader,requireHumanSessionOrigin } = await import('../middleware/require-human-session');
    const copy={humanOnlyCode:'human_approval_required',humanOnlyMessage:'The account owner must approve this purchase.',needsLoginCode:'human_approval_required',needsLoginMessage:'Sign in with a human account.'};
    for (const gate of [refuseAgentHeader(copy),requireHumanSessionOrigin(copy)]) {
      const response=await (gate as MiddlewareHandler<ActivityAuthContext>)(c,async()=>{}); if(response instanceof Response)return response;
    }
    if(c.get('identity').kind!=='user')return c.json({error:'human_approval_required'},403);
    const service=await purchases(),owner=purchaseOwner(c),id=z.string().uuid().parse(c.req.param('id'));
    if(operation==='approval-challenge'){await noBody(c);return c.json(await service.humanChallenge(owner,id));}
    const result=await service.humanApprove(owner,id,await c.req.json());return c.json(result,result.ok?200:400);
  };
  routes.post('/purchases/:id/approval-challenge',purchaseApproval('approval-challenge'));
  routes.post('/purchases/:id/approve',purchaseApproval('approve'));
  routes.get('/workers', async (c) => {
    const { listBrainChainWorkers } = await import('../services/brainchain/bindings');
    c.header('Cache-Control', 'no-store');
    return c.json({ workers: await listBrainChainWorkers(c.get('identity').avatarId) });
  });
  routes.get('/workers/:id/snapshot', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { readOwnedWorkerSnapshot } = await import('../services/brainchain/indexer');
    return c.json(await readOwnedWorkerSnapshot(c.get('identity').avatarId,id));
  });
  routes.get('/workers/:id/identity-credit', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { identityCreditQuerySchema, readOwnedWorkerIdentityCredit } = await import('../services/brainchain/identity-credit');
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await readOwnedWorkerIdentityCredit(c.get('identity').avatarId, id, identityCreditQuerySchema.parse(Object.fromEntries(params))));
  });
  routes.get('/workers/:id/earnings', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { earningsQuerySchema, readOwnedWorkerEarnings } = await import('../services/brainchain/earnings-reader');
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return c.json({ error: 'invalid_request' }, 400);
    const query = earningsQuerySchema.parse(Object.fromEntries(params));
    return c.json(await readOwnedWorkerEarnings(c.get('identity').avatarId, id, query));
  });
  routes.get('/workers/:id/tasks', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { listWorkerTasks } = await import('../services/brainchain/tasks');
    return c.json({tasks:await listWorkerTasks(c.get('identity').avatarId,id),provisional:true});
  });
  routes.post('/workers/:id/sync', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { syncOwnedWorker } = await import('../services/brainchain/indexer');
    return c.json(await syncOwnedWorker(c.get('identity').avatarId,id));
  });
  routes.post('/workers/challenge', async (c) => {
    const { issueWorkerBindingChallenge } = await import('../services/brainchain/bindings');
    return c.json(await issueWorkerBindingChallenge(c.get('identity').avatarId, await c.req.json()));
  });
  routes.post('/workers/bind', async (c) => {
    const { bindBrainChainWorker } = await import('../services/brainchain/bindings');
    return c.json({ worker: await bindBrainChainWorker(c.get('identity').avatarId, await c.req.json()) });
  });
  routes.post('/workers/:id/control', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const { requestBrainChainWorkerControl } = await import('../services/brainchain/bindings');
    return c.json({ worker: await requestBrainChainWorkerControl(c.get('identity').avatarId, id, await c.req.json()),
      notice: 'Local request only; on-chain eligibility is unchanged.' });
  });
  routes.post('/install', async (c) => {
    const { installBrainChainCurriculum } = await import('../services/brainchain/install');
    return c.json({ ok: true, ...await installBrainChainCurriculum(c.get('identity')) });
  });
  routes.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_request' }, 400);
    // Preserve middleware status without returning raw database, runtime, or vendor errors.
    if ('status' in error && typeof error.status === 'number' && [401,403].includes(error.status)) {
      return c.json({ error: error.status === 401 ? 'authentication_required' : 'access_denied' }, error.status as 401 | 403);
    }
    const codes: Record<string, 403 | 400 | 404 | 409 | 429 | 503> = {
      operation_not_found:404,operation_conflict:409,owner_required:403,approval_required:409,unsupported_route:400,terms_unavailable:503,operation_uncertain:409,
      exact_result_recovery_refused:409,exact_recovery_owner_required:403,worker_policy_refused:409,owner_policy_proof_required:403,invalid_request:400,purchase_not_found:404,unsupported_payment_lane:400,quote_refused:409,owner_grant_required:409,human_approval_required:409,over_per_call_cap:409,over_daily_cap:409,payer_conflict:409,order_conflict:409,purchase_unavailable:503,execution_disabled:503,payment_uncertain:409,receipt_unavailable:503,associated_token_account_required:409,
      rate_limited: 429, invalid_proof: 400, binding_conflict: 409, worker_not_found: 404,
      skill_not_found: 503, agent_not_connected: 409, runtime_unavailable: 503,
      chain_read_unavailable: 503, task_state_conflict: 409,
    };
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    if (codes[code]) return c.json({ error: code }, codes[code]);
    return c.json({ error: 'brainchain_unavailable' }, 503);
  });
  return routes;
}

export const brainchainRoutes = createBrainChainRoutes();
