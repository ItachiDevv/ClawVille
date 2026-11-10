/** Run separately: real sessionMiddleware + Lucia cookies; identity backing and service IO are controlled fixtures. */
import { describe, expect, mock, test } from 'bun:test';
import { Lucia, type Adapter, type DatabaseSession, type DatabaseUser } from 'lucia';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { earningsQuerySchema } from '../services/brainchain/earnings-reader';
import { identityCreditQuerySchema } from '../services/brainchain/identity-credit';

const sessions = new Map<string, DatabaseSession>();
const user = { id: 'human-owner', attributes: { name: 'Fixture', email: null, avatar_url: null, username: 'fixture' } } as DatabaseUser;
const adapter: Adapter = {
  getSessionAndUser: async (id) => [sessions.get(id) ?? null, sessions.has(id) ? user : null],
  getUserSessions: async () => [...sessions.values()],
  setSession: async (session) => { sessions.set(session.id, session); },
  updateSessionExpiration: async (id, expiresAt) => { const row = sessions.get(id); if (row) row.expiresAt = expiresAt; },
  deleteSession: async (id) => { sessions.delete(id); },
  deleteUserSessions: async () => { sessions.clear(); },
  deleteExpiredSessions: async () => {},
};
const lucia = new Lucia(adapter, { sessionCookie: { attributes: { secure: false } } });
mock.module('../lib/auth', () => ({ lucia }));
// The real auth middleware also reads the persistent probe marker. This suite
// models an ordinary unmarked human; its synthetic identity has no real DB row.
const markerChecks: string[] = [];
const database = await import('@clawville/database');
mock.module('@clawville/database', () => ({
  ...database,
  getPostgresClient: () => async (query: TemplateStringsArray, ...values: unknown[]) => {
    if (!query.join('').includes('FROM brainchain_probe_markers') || !values.includes(user.id)) {
      throw new Error('unexpected identity fixture database read');
    }
    markerChecks.push(user.id);
    return [];
  },
}));
const resolveIdentity: MiddlewareHandler<ActivityAuthContext> = async (c, next) => {
  const human = c.get('user');
  const bearer = c.req.header('X-Clawville-Agent-Session');
  if (human) c.set('identity', { kind: 'user', userId: human.id, avatarId: 'owned-avatar', agentId: null });
  else if (bearer === 'bound' || bearer === 'non-ledger') c.set('identity', {
    kind: 'agent', userId: 'agent-owner', avatarId: 'owned-avatar', agentId: 'fixture-agent',
    sessionId: bearer, ledgerCapable: bearer === 'bound',
  });
  else throw new HTTPException(401);
  await next();
};
mock.module('../middleware/require-auth-or-agent', () => ({
  AGENT_SESSION_HEADER:'X-Clawville-Agent-Session',
  resolveAgentSession:async(token:string)=>token==='bound'?{userId:'agent-owner',avatarId:'owned-avatar',agentId:'fixture-agent',ledgerCapable:true}:null,
  requireAuthOrAgentSession: resolveIdentity,
  requireLedgerCapableIdentity: (async (c, next) => {
    const identity = c.get('identity');
    if (identity.kind === 'agent' && !identity.ledgerCapable) throw new HTTPException(403);
    await next();
  }) satisfies MiddlewareHandler<ActivityAuthContext>,
}));
mock.module('../middleware/require-non-guest', () => ({
  requireNonGuestIdentity: (async (c, next) => {
    if (c.req.header('X-Fixture-Guest') === 'yes') return c.json({ error: 'guest_not_allowed' }, 403);
    await next();
  }) satisfies MiddlewareHandler<ActivityAuthContext>,
}));
mock.module('../services/brainchain/bindings', () => ({
  listBrainChainWorkers: async (avatarId: string) => [{ id: 'worker', owner: avatarId }],
  issueWorkerBindingChallenge: async (_avatarId: string, input: unknown) => ({ parsed: input }),
}));
const workerId='11111111-1111-4111-8111-111111111111';
mock.module('../services/brainchain/indexer',()=>({
  readOwnedWorkerSnapshot:async(avatarId:string,id:string)=>({avatarId,workerId:id,provisional:true}),
  syncOwnedWorker:async(avatarId:string,id:string)=>({avatarId,workerId:id,state:'observed',provisional:true}),
}));
mock.module('../services/brainchain/tasks',()=>({listWorkerTasks:async(avatarId:string,id:string)=>[{avatarId,workerId:id}]}));
const earningsCalls: string[] = [];
const identityCalls: string[] = [];
mock.module('../services/brainchain/identity-credit', () => ({ identityCreditQuerySchema,
  readOwnedWorkerIdentityCredit: async (avatarId: string, id: string, query: unknown) => {
    identityCalls.push(avatarId); return { avatarId, workerId: id, query, provisional: true };
  },
}));
mock.module('../services/brainchain/earnings-reader', () => ({ earningsQuerySchema,
  readOwnedWorkerEarnings: async (avatarId: string, id: string, query: unknown) => {
    earningsCalls.push(avatarId); return { avatarId, workerId: id, query, provisional: true };
  },
}));
const { createBrainChainRoutes } = await import('./brainchain');

describe('BrainChain HTTP session composition', () => {
  test('identity credit requires a selected ID and rejects unauthorized identities before service IO', async () => {
    const before = identityCalls.length;
    for (const [headers, status] of [[{}, 401], [{ 'X-Clawville-Agent-Session': 'non-ledger' }, 403],
      [{ 'X-Clawville-Agent-Session': 'bound', 'X-Fixture-Guest': 'yes' }, 403]] as const) {
      expect((await createBrainChainRoutes().request(`/workers/${workerId}/identity-credit?agentId=462`, { headers })).status).toBe(status);
    }
    for (const query of ['', 'agentId=01', 'agentId=462&agentId=20423', 'agentId=462&avatarId=other', 'agentId=1e3']) {
      expect((await createBrainChainRoutes().request(`/workers/${workerId}/identity-credit?${query}`, { headers: { 'X-Clawville-Agent-Session': 'bound' } })).status).toBe(400);
    }
    expect(identityCalls.length).toBe(before);
  });
  test('earnings reject unauthenticated, guest, non-ledger, authority, and duplicate cursor requests before reads', async () => {
    const before = earningsCalls.length;
    for (const [headers, status] of [[{}, 401], [{ 'X-Clawville-Agent-Session': 'non-ledger' }, 403],
      [{ 'X-Clawville-Agent-Session': 'bound', 'X-Fixture-Guest': 'yes' }, 403]] as const) {
      expect((await createBrainChainRoutes().request(`/workers/${workerId}/earnings`, { headers })).status).toBe(status);
    }
    for (const query of ['avatarId=foreign', 'fromBlock=1&fromBlock=2', 'fromBlock=01', 'fromBlock=-1']) {
      const response = await createBrainChainRoutes().request(`/workers/${workerId}/earnings?${query}`, { headers: { 'X-Clawville-Agent-Session': 'bound' } });
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(earningsCalls.length).toBe(before);
  });
  test('human cookies and ledger agent sessions reach worker reads with resolved avatar only',async()=>{
    const session=await lucia.createSession(user.id,{createdVia:'password'});
    for(const headers of [new Headers({Cookie:lucia.createSessionCookie(session.id).serialize()}),new Headers({'X-Clawville-Agent-Session':'bound'})]){
      const app=createBrainChainRoutes();
      const snapshot=await app.request(`/workers/${workerId}/snapshot`,{headers});
      expect(snapshot.status).toBe(200);expect(await snapshot.json()).toEqual({avatarId:'owned-avatar',workerId,provisional:true});
      const tasks=await app.request(`/workers/${workerId}/tasks`,{headers});
      expect(tasks.status).toBe(200);expect(await tasks.json()).toEqual({tasks:[{avatarId:'owned-avatar',workerId}],provisional:true});
      const earnings = await app.request(`/workers/${workerId}/earnings?fromBlock=965`, { headers });
      expect(earnings.status).toBe(200);
      expect(await earnings.json()).toEqual({ avatarId: 'owned-avatar', workerId, query: { fromBlock: '965' }, provisional: true });
      const identity = await app.request(`/workers/${workerId}/identity-credit?agentId=462`, { headers });
      expect(identity.status).toBe(200);
      expect(await identity.json()).toEqual({ avatarId: 'owned-avatar', workerId, query: { agentId: '462' }, provisional: true });
      const sync=await app.request(`/workers/${workerId}/sync`,{method:'POST',headers});
      expect(sync.status).toBe(200);expect(await sync.json()).toMatchObject({avatarId:'owned-avatar',workerId,state:'observed'});
    }
    expect((await createBrainChainRoutes().request(`/workers/${workerId}/snapshot`,{headers:{'X-Clawville-Agent-Session':'non-ledger'}})).status).toBe(403);
  });
  test('real Lucia cookie hydration reaches the human resolver', async () => {
    const previous = process.env.CLAWVILLE_ENV;
    process.env.CLAWVILLE_ENV = 'staging';
    try {
      markerChecks.length = 0;
      const session = await lucia.createSession(user.id, { createdVia: 'password' });
      const cookie = lucia.createSessionCookie(session.id).serialize();
      const response = await createBrainChainRoutes().request('/workers', { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(markerChecks).toContain(user.id);
      expect(await response.json()).toEqual({ workers: [{ id: 'worker', owner: 'owned-avatar' }] });
    } finally {
      if (previous === undefined) delete process.env.CLAWVILLE_ENV; else process.env.CLAWVILLE_ENV = previous;
    }
  });
  test('outside staging the human resolver performs no probe marker read', async () => {
    const previous = process.env.CLAWVILLE_ENV;
    process.env.CLAWVILLE_ENV = 'production';
    try {
      markerChecks.length = 0;
      const session = await lucia.createSession(user.id, { createdVia: 'password' });
      const cookie = lucia.createSessionCookie(session.id).serialize();
      const response = await createBrainChainRoutes().request('/workers', { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(markerChecks).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CLAWVILLE_ENV; else process.env.CLAWVILLE_ENV = previous;
    }
  });
  test('expired and unknown cookies fail; public knowledge remains accessible', async () => {
    const session = await lucia.createSession(user.id, { createdVia: 'password' });
    sessions.get(session.id)!.expiresAt = new Date(0);
    for (const id of [session.id, 'unknown']) {
      const response = await createBrainChainRoutes().request('/workers', { headers: { Cookie: lucia.createSessionCookie(id).serialize() } });
      expect(response.status).toBe(401);
    }
    expect((await createBrainChainRoutes().request('/knowledge')).status).toBe(200);
  });
  test('bound agent proceeds; ledger and guest guards retain their rejection', async () => {
    for (const [bearer, status] of [['bound', 200], ['non-ledger', 403], ['unknown', 401]] as const) {
      expect((await createBrainChainRoutes().request('/workers', { headers: { 'X-Clawville-Agent-Session': bearer } })).status).toBe(status);
    }
    expect((await createBrainChainRoutes().request('/workers', { headers: { 'X-Clawville-Agent-Session': 'bound', 'X-Fixture-Guest': 'yes' } })).status).toBe(403);
  });
  test('bounded body cache preserves normal JSON and rejects malformed JSON', async () => {
    const routes = createBrainChainRoutes();
    const headers = { 'X-Clawville-Agent-Session': 'bound', 'Content-Type': 'application/json' };
    const valid = await routes.request('/workers/challenge', { method: 'POST', headers, body: '{"environment":"testnet"}' });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ parsed: { environment: 'testnet' } });
    expect((await routes.request('/workers/challenge', { method: 'POST', headers, body: '{broken' })).status).toBe(400);
  });
});


test('purchase routes bind the canonical human or agent and recheck the current session',async()=>{
 const owners:unknown[]=[];
 const service={list:async(owner:import('../services/brainchain/purchases').BuyerOwner)=>{await owner.assertCurrent();owners.push({avatarId:owner.avatarId,userId:owner.userId,actor:owner.actor});return {orders:[],availability:{executionEnabled:false}};}} as unknown as import('../services/brainchain/purchases').BrainchainPurchases;
 const routes=createBrainChainRoutes(undefined,{purchases:async()=>service});
 for(const [headers,status]of [[{},401],[{'X-Clawville-Agent-Session':'non-ledger'},403],[{'X-Clawville-Agent-Session':'bound','X-Fixture-Guest':'yes'},403]] as const)expect((await routes.request('/purchases',{headers})).status).toBe(status);
 expect(owners).toHaveLength(0);
 expect((await routes.request('/purchases',{headers:{'X-Clawville-Agent-Session':'bound'}})).status).toBe(200);
 expect(owners).toEqual([{avatarId:'owned-avatar',userId:'agent-owner',actor:'agent'}]);
 const cookie=lucia.createSessionCookie((await lucia.createSession(user.id,{createdVia:'password'})).id).serialize();
 expect((await routes.request('/purchases',{headers:{Cookie:cookie}})).status).toBe(200);
 expect(owners[1]).toEqual({avatarId:'owned-avatar',userId:'human-owner',actor:'human'});
 const approval=await routes.request('/purchases/00000000-0000-4000-8000-000000000001/approval-challenge',{method:'POST',headers:{'X-Clawville-Agent-Session':'bound','Content-Type':'application/json'},body:'{}'});
 expect(approval.status).toBe(403);
});
