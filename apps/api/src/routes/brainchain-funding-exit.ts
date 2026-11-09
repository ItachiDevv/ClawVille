import type {Context,Hono,MiddlewareHandler} from 'hono';
import {z} from 'zod';
import type {ActivityAuthContext} from '../middleware/require-auth-or-agent';
import type {BuyerOwner} from '../services/brainchain/purchases';
import type {FundingExitOperations} from '../services/brainchain/funding-exit-operations';
export function mountFundingExitRoutes(routes:Hono<ActivityAuthContext>,owner:(c:Context<ActivityAuthContext>)=>BuyerOwner,service:()=>Promise<FundingExitOperations>){
 const id=(c:Context<ActivityAuthContext>)=>z.string().uuid().parse(c.req.param('operationId'));
 routes.get('/funding-exit',async c=>c.json(await(await service()).list(owner(c))));
 routes.post('/funding-exit',async c=>c.json({operation:await(await service()).create(owner(c),await c.req.json())},201));
 routes.get('/funding-exit/:operationId',async c=>c.json({operation:await(await service()).get(owner(c),id(c))}));
 const operation=(op:'intent'|'submit'|'recover'|'reconcile')=>async(c:Context<ActivityAuthContext>)=>{
  const body=await c.req.text();if(body&&body!=='{}')return c.json({error:'invalid_request'},400);const s=await service(),o=owner(c),key=id(c);
  if(op==='intent')return c.json(await s.intent(o,key));return c.json({operation:op==='recover'?await s.submit(o,key,true):await s[op](o,key)});
 };
 routes.post('/funding-exit/:operationId/intent',operation('intent'));
 routes.post('/funding-exit/:operationId/submit',operation('submit'));
 routes.post('/funding-exit/:operationId/recover',operation('recover'));
 routes.post('/funding-exit/:operationId/reconcile',operation('reconcile'));
 routes.post('/funding-exit/:operationId/capture',async c=>c.json({operation:await(await service()).capture(owner(c),id(c),await c.req.json())}));
 const proof=(op:'challenge'|'approve')=>async(c:Context<ActivityAuthContext>)=>{const {refuseAgentHeader,requireHumanSessionOrigin}=await import('../middleware/require-human-session');
  const copy={humanOnlyCode:'approval_required',humanOnlyMessage:'The account owner must approve this transaction.',needsLoginCode:'approval_required',needsLoginMessage:'Sign in with the owner account.'};
  for(const gate of [refuseAgentHeader(copy),requireHumanSessionOrigin(copy)]){const r=await(gate as MiddlewareHandler<ActivityAuthContext>)(c,async()=>{});if(r instanceof Response)return r;}
  if(c.get('identity').kind!=='user')return c.json({error:'approval_required'},403);
  if(op==='challenge'){const body=await c.req.text();if(body&&body!=='{}')return c.json({error:'invalid_request'},400);return c.json(await(await service()).challenge(owner(c),id(c)));}
  return c.json(await(await service()).approve(owner(c),id(c),await c.req.json()));
 };
 routes.post('/funding-exit/:operationId/challenge',proof('challenge'));routes.post('/funding-exit/:operationId/approve',proof('approve'));
}
