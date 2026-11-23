import type {Context,Hono,MiddlewareHandler} from 'hono';
import {z} from 'zod';
import type {ActivityAuthContext} from '../middleware/require-auth-or-agent';
import type {ExactRecoveryOwner,ExactResultRecoveryConsents} from '../services/brainchain/exact-result-recovery-consent';

/** Uses the parent's private avatar middleware. Only the human wallet proof can grant authority. */
export function mountExactRecoveryRoutes(routes:Hono<ActivityAuthContext>,owner:(context:Context<ActivityAuthContext>)=>ExactRecoveryOwner,service:()=>Promise<ExactResultRecoveryConsents>){
  const worker=(c:Context<ActivityAuthContext>)=>z.string().uuid().parse(c.req.param('id'));
  const consent=(c:Context<ActivityAuthContext>)=>z.string().uuid().parse(c.req.param('consentId'));
  routes.get('/workers/:id/recovery',async c=>c.json(await(await service()).list(owner(c),worker(c))));
  routes.post('/workers/:id/recovery',async c=>c.json(await(await service()).request(owner(c),worker(c),await c.req.json()),201));
  routes.post('/workers/:id/recovery/:consentId/revoke',async c=>{
    const body=await c.req.text();if(body&&body!=='{}')return c.json({error:'invalid_request'},400);
    return c.json(await(await service()).revoke(owner(c),worker(c),consent(c)));
  });
  routes.post('/workers/:id/recovery/:consentId/narrow',async c=>c.json(await(await service()).narrow(owner(c),worker(c),consent(c),await c.req.json())));
  const proof=(action:'challenge'|'approve')=>async(c:Context<ActivityAuthContext>)=>{
    const {refuseAgentHeader,requireHumanSessionOrigin}=await import('../middleware/require-human-session');
    const copy={humanOnlyCode:'exact_recovery_owner_required',humanOnlyMessage:'The account wallet owner must approve this exact result.',needsLoginCode:'exact_recovery_owner_required',needsLoginMessage:'Sign in with the owner account.'};
    for(const gate of [refuseAgentHeader(copy),requireHumanSessionOrigin(copy)]){const response=await(gate as MiddlewareHandler<ActivityAuthContext>)(c,async()=>{});if(response instanceof Response)return response;}
    if(c.get('identity').kind!=='user')return c.json({error:'exact_recovery_owner_required'},403);
    if(action==='challenge'){
      const body=await c.req.text();if(body&&body!=='{}')return c.json({error:'invalid_request'},400);
      return c.json(await(await service()).challenge(owner(c),worker(c),consent(c)));
    }
    return c.json(await(await service()).approve(owner(c),worker(c),consent(c),await c.req.json()));
  };
  routes.post('/workers/:id/recovery/:consentId/challenge',proof('challenge'));
  routes.post('/workers/:id/recovery/:consentId/approve',proof('approve'));
}
