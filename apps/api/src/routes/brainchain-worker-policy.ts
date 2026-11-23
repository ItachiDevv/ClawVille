import type {Context,Hono,MiddlewareHandler} from 'hono';
import {z} from 'zod';
import type {ActivityAuthContext} from '../middleware/require-auth-or-agent';
import type {WorkerOwnerPolicies,WorkerPolicyOwner} from '../services/brainchain/worker-owner-policy';

/** Mount after the canonical session/agent middleware and bounded body reader. */
export function mountWorkerPolicyRoutes(routes:Hono<ActivityAuthContext>,owner:(context:Context<ActivityAuthContext>)=>WorkerPolicyOwner,service:()=>Promise<WorkerOwnerPolicies>){
  const worker=(c:Context<ActivityAuthContext>)=>z.string().uuid().parse(c.req.param('id'));
  routes.get('/workers/:id/policy',async c=>c.json(await(await service()).get(owner(c),worker(c))));
  routes.post('/workers/:id/policy',async c=>c.json(await(await service()).request(owner(c),worker(c),await c.req.json()),201));
  routes.post('/workers/:id/policy/control',async c=>c.json(await(await service()).control(owner(c),worker(c),await c.req.json())));
  routes.post('/workers/:id/policy/narrow',async c=>c.json(await(await service()).narrow(owner(c),worker(c),await c.req.json())));
  const ownerProof=(action:'challenge'|'approve')=>async(c:Context<ActivityAuthContext>)=>{
    const {refuseAgentHeader,requireHumanSessionOrigin}=await import('../middleware/require-human-session');
    const copy={humanOnlyCode:'owner_policy_proof_required',humanOnlyMessage:'The linked account owner must approve this policy.',needsLoginCode:'owner_policy_proof_required',needsLoginMessage:'Sign in with the owner account.'};
    for(const gate of [refuseAgentHeader(copy),requireHumanSessionOrigin(copy)]){
      const response=await(gate as MiddlewareHandler<ActivityAuthContext>)(c,async()=>{});if(response instanceof Response)return response;
    }
    if(c.get('identity').kind!=='user')return c.json({error:'owner_policy_proof_required'},403);
    const policyId=z.string().uuid().parse(c.req.param('policyId'));
    if(action==='challenge'){
      const body=await c.req.text();if(body&&body!=='{}')return c.json({error:'invalid_request'},400);
      return c.json(await(await service()).challenge(owner(c),worker(c),policyId));
    }
    return c.json(await(await service()).approve(owner(c),worker(c),policyId,await c.req.json()));
  };
  routes.post('/workers/:id/policy/:policyId/challenge',ownerProof('challenge'));
  routes.post('/workers/:id/policy/:policyId/approve',ownerProof('approve'));
}
