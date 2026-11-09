import {createHash,randomBytes} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {z} from 'zod';
import {bindingDomain} from './binding-proof';
import {recordOwnerRecoveryControl} from './exact-result-recovery-consent';
import {databaseDate as date} from './database-values';

const atomic=z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value=>BigInt(value)<2n**256n);
const micros=z.string().regex(/^(0|[1-9][0-9]{0,7})$/).refine(value=>BigInt(value)<=10000000n);
export const workerOwnerPolicySchema=z.object({environment:z.literal('testnet'),chainId:z.literal(274630),
  actions:z.array(z.enum(['faucet','approve-stake','approve-bond','stake','apply','submit','leave','withdraw'])).min(1).max(8).refine(values=>new Set(values).size===values.length),
  taskKinds:z.array(z.enum(['text-research','text-extraction','text-code','text-writing'])).max(4).refine(values=>new Set(values).size===values.length),
  maxStakeAtomic:atomic,maxBondAtomic:atomic,maxBrainTotalAtomic:atomic,priceAtomic:atomic,
  maxGasPerOperationWei:atomic,maxGasTotalWei:atomic,maxTasks:z.number().int().min(0).max(100),
  openaiMicros:micros,openrouterMicros:micros,expiresAt:z.string().datetime(),
}).strict();
export type WorkerOwnerPolicy=z.infer<typeof workerOwnerPolicySchema>;
export type WorkerPolicyOwner={avatarId:string;userId:string;actor:'human'|'agent';assertCurrent:()=>Promise<void>};
export class WorkerPolicyError extends Error{readonly code='worker_policy_refused';}
export function workerPolicyBytes(raw:unknown){const value=workerOwnerPolicySchema.parse(raw);return JSON.stringify({...value,actions:[...value.actions].sort(),taskKinds:[...value.taskKinds].sort()});}
export const workerPolicyHash=(raw:unknown)=>createHash('sha256').update(workerPolicyBytes(raw)).digest('hex');
const digest=(raw:string)=>createHash('sha256').update(raw).digest('hex');
export function policyNarrows(next:WorkerOwnerPolicy,prior:WorkerOwnerPolicy){
  const caps=['maxStakeAtomic','maxBondAtomic','maxBrainTotalAtomic','maxGasPerOperationWei','maxGasTotalWei','openaiMicros','openrouterMicros'] as const;
  return caps.every(key=>BigInt(next[key])<=BigInt(prior[key]))&&next.priceAtomic===prior.priceAtomic&&next.maxTasks<=prior.maxTasks
    &&Date.parse(next.expiresAt)<=Date.parse(prior.expiresAt)&&next.actions.every(action=>prior.actions.includes(action))&&next.taskKinds.every(kind=>prior.taskKinds.includes(kind));
}
let ownerPolicyService:WorkerOwnerPolicies|undefined;
export async function getWorkerOwnerPolicies(){
  if(!ownerPolicyService){const {getPostgresClient}=await import('@clawville/database');ownerPolicyService=new WorkerOwnerPolicies(getPostgresClient());}
  return ownerPolicyService;
}
export function workerPolicyMessage(input:{domain:string;avatarId:string;userId:string;workerId:string;workerAddress:string;policyId:string;revision:number;policyHash:string;wallet:string;nonce:string;expiresAt:string}){
  return ['ClawVille BrainChain owner policy grant v1',`domain: ${input.domain}`,`owner-user: ${input.userId}`,`avatar: ${input.avatarId}`,
    `worker: ${input.workerId}`,`worker-address: ${input.workerAddress}`,'environment: testnet','chain: 274630',`policy: ${input.policyId}`,
    `revision: ${input.revision}`,`policy-sha256: ${input.policyHash}`,`owner-wallet: ${input.wallet}`,`nonce: ${input.nonce}`,`expires: ${input.expiresAt}`,
    'I authorize only the exact policy displayed with this hash. New signatures and testnet spending remain inside these limits.',
    'I permit autonomous task processing after an explicit start, within this policy and the independent provider budget.',
    'Unknown or captured liabilities remain reserved after pause or revocation. This grant does not increase the independent provider budget.'].join('\n');
}
type PolicyRow={id:string;binding_id:string;avatar_id:string;user_id:string;revision:number;payload:WorkerOwnerPolicy;payload_hash:string;state:string;owner_grant_id:string|null;expires_at:Date};
/** Public callers supply only a canonical resolved identity. Wallet proof never comes from an agent's task output. */
export class WorkerOwnerPolicies{
  constructor(private readonly database:Sql){}
  private async owner(tx:TransactionSql,owner:WorkerPolicyOwner,workerId:string){
    z.string().uuid().parse(owner.avatarId);z.string().uuid().parse(owner.userId);z.string().uuid().parse(workerId);
    const [row]=await tx`SELECT w.id,w.address,w.updated_at::text AS control_version,u.linked_wallet_pubkey FROM brainchain_worker_bindings w JOIN avatars a ON a.id=w.avatar_id JOIN users u ON u.id=a.user_id
      WHERE w.id=${workerId} AND w.avatar_id=${owner.avatarId} AND u.id=${owner.userId} AND w.environment='testnet' AND w.chain_id=274630 AND a.is_guest=false AND u.is_guest=false FOR UPDATE OF w,a,u`;
    if(!row)throw new WorkerPolicyError('Current account owner required');await owner.assertCurrent();return row;
  }
  private view(row:PolicyRow){return{id:row.id,workerId:row.binding_id,revision:row.revision,policy:row.payload,policyHash:row.payload_hash,state:row.state,ownerApproved:row.owner_grant_id!==null,executionEnabled:false,
    recovery:{retainedResults:true,retainedLiabilities:true,postPauseDeliveryAvailable:false,reason:'A separate exact-result owner recovery grant requires review. Pause does not erase captured evidence.'}};}
  async get(owner:WorkerPolicyOwner,workerId:string){return this.database.begin(async tx=>{
    const identity=await this.owner(tx,owner,workerId);const [row]=await tx<PolicyRow[]>`SELECT * FROM brainchain_worker_policies WHERE binding_id=${workerId} ORDER BY revision DESC LIMIT 1`;
    const [liabilities]=await tx`SELECT gas_committed,brain_committed,openai_committed,openrouter_committed,tasks_committed FROM brainchain_worker_policy_budgets WHERE binding_id=${workerId}`;
    return{policy:row?this.view(row):null,liabilities:liabilities??null,workerControlVersion:String(identity.control_version),executionEnabled:false};
  });}
  async request(owner:WorkerPolicyOwner,workerId:string,raw:unknown){
    const payload=JSON.parse(workerPolicyBytes(raw)) as WorkerOwnerPolicy,hash=workerPolicyHash(payload);
    return this.database.begin(async tx=>{
      await this.owner(tx,owner,workerId);const [clock]=await tx`SELECT clock_timestamp() AS now`;
      if(Date.parse(payload.expiresAt)<=date(clock!.now).getTime()||Date.parse(payload.expiresAt)>date(clock!.now).getTime()+86400000)throw new WorkerPolicyError('Policy expiry must be within one day');
      const [last]=await tx`SELECT COALESCE(MAX(revision),0)::int AS revision FROM brainchain_worker_policies WHERE binding_id=${workerId}`;
      await tx`INSERT INTO brainchain_worker_policy_budgets(binding_id,avatar_id) VALUES(${workerId},${owner.avatarId}) ON CONFLICT DO NOTHING`;
      const [row]=await tx<PolicyRow[]>`INSERT INTO brainchain_worker_policies(binding_id,avatar_id,user_id,revision,payload,payload_hash,expires_at)
        VALUES(${workerId},${owner.avatarId},${owner.userId},${last!.revision+1},${tx.typed(JSON.stringify(payload),25)}::jsonb,${hash},${tx.typed(payload.expiresAt,25)}::timestamptz) RETURNING *`;
      return this.view(row!);
    });
  }
  async challenge(owner:WorkerPolicyOwner,workerId:string,policyId:string){
    if(owner.actor!=='human')throw new WorkerPolicyError('Human owner grant required');z.string().uuid().parse(policyId);
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId),wallet=identity.linked_wallet_pubkey;
      if(typeof wallet!=='string'||bs58.decode(wallet).length!==32)throw new WorkerPolicyError('Proved linked wallet required');
      const [policy]=await tx<PolicyRow[]>`SELECT * FROM brainchain_worker_policies WHERE id=${policyId} AND binding_id=${workerId} FOR UPDATE`;
      const [clock]=await tx`SELECT clock_timestamp() AS now,(SELECT count(*) FROM brainchain_worker_policy_challenges WHERE avatar_id=${owner.avatarId} AND created_at>clock_timestamp()-interval '1 minute')::int AS attempts`;
      if(!policy||policy.state==='revoked'||date(policy.expires_at)<=date(clock!.now)||clock!.attempts>=5)throw new WorkerPolicyError('Policy challenge unavailable');
      const nonce=randomBytes(32).toString('hex'),expiresAt=new Date(Math.min(date(clock!.now).getTime()+120000,date(policy.expires_at).getTime())),domain=bindingDomain();
      const message=workerPolicyMessage({domain,avatarId:owner.avatarId,userId:owner.userId,workerId,workerAddress:String(identity.address),policyId,revision:policy.revision,policyHash:policy.payload_hash,wallet,nonce,expiresAt:expiresAt.toISOString()});
      await tx`INSERT INTO brainchain_worker_policy_challenges(nonce_hash,policy_id,binding_id,avatar_id,user_id,wallet,domain,message,message_hash,expires_at)
        VALUES(${digest(nonce)},${policyId},${workerId},${owner.avatarId},${owner.userId},${wallet},${domain},${message},${digest(message)},${tx.typed(expiresAt.toISOString(),25)}::timestamptz)`;
      return{nonce,messageToSign:message,walletPubkey:wallet,expiresAt:expiresAt.toISOString(),policy:this.view(policy)};
    });
  }
  async approve(owner:WorkerPolicyOwner,workerId:string,policyId:string,raw:unknown){
    if(owner.actor!=='human')throw new WorkerPolicyError('Human owner grant required');
    const input=z.object({nonce:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().min(80).max(100)}).strict().parse(raw);
    // Attempt admission commits before signature verification, including invalid signatures.
    const [admitted]=await this.database`UPDATE brainchain_worker_policy_challenges SET attempts=attempts+1 WHERE nonce_hash=${digest(input.nonce)} AND policy_id=${policyId} AND avatar_id=${owner.avatarId} AND user_id=${owner.userId}
      AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 RETURNING *`;
    if(!admitted)throw new WorkerPolicyError('Invalid owner proof');
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId);
      const [policy]=await tx<PolicyRow[]>`SELECT * FROM brainchain_worker_policies WHERE id=${policyId} AND binding_id=${workerId} FOR UPDATE`;
      const [challenge]=await tx`SELECT * FROM brainchain_worker_policy_challenges WHERE nonce_hash=${digest(input.nonce)} FOR UPDATE`;
      if(!policy||policy.state==='revoked'||!challenge||challenge.wallet!==identity.linked_wallet_pubkey||challenge.domain!==bindingDomain()||challenge.message_hash!==digest(challenge.message))throw new WorkerPolicyError('Owner proof scope changed');
      const canonical=workerPolicyMessage({domain:challenge.domain,avatarId:owner.avatarId,userId:owner.userId,workerId,workerAddress:String(identity.address),policyId,revision:policy.revision,policyHash:policy.payload_hash,wallet:challenge.wallet,nonce:input.nonce,expiresAt:date(challenge.expires_at).toISOString()});
      let valid=false;try{valid=canonical===challenge.message&&nacl.sign.detached.verify(Buffer.from(canonical),bs58.decode(input.signature),bs58.decode(challenge.wallet));}catch{}
      if(!valid)throw new WorkerPolicyError('Invalid owner proof');
      await owner.assertCurrent();
      const [consumed]=await tx`UPDATE brainchain_worker_policy_challenges SET consumed_at=clock_timestamp() WHERE nonce_hash=${digest(input.nonce)} AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING nonce_hash`;
      if(!consumed)throw new WorkerPolicyError('Owner proof expired after locks');
      await tx`UPDATE brainchain_worker_policies SET state='revoked',revoked_at=clock_timestamp() WHERE binding_id=${workerId} AND id<>${policyId} AND state<>'revoked'`;
      const [row]=await tx<PolicyRow[]>`UPDATE brainchain_worker_policies SET state='active',owner_grant_id=${consumed.nonce_hash},approved_at=clock_timestamp() WHERE id=${policyId} AND expires_at>clock_timestamp() RETURNING *`;
      if(!row)throw new WorkerPolicyError('Policy expired');return this.view(row);
    });
  }
  async control(owner:WorkerPolicyOwner,workerId:string,raw:unknown){
    const input=z.object({policyId:z.string().uuid(),revision:z.number().int().positive(),action:z.enum(['start','pause','revoke']),workerControlVersion:z.string().min(1).max(64).optional()}).strict().parse(raw);
    return this.database.begin(async tx=>{const identity=await this.owner(tx,owner,workerId);
      if(input.action==='start'){
        const [policy]=await tx<PolicyRow[]>`SELECT * FROM brainchain_worker_policies WHERE id=${input.policyId} AND binding_id=${workerId} AND revision=${input.revision} AND state='active' FOR UPDATE`;
        const [proof]=policy?.owner_grant_id?await tx`SELECT wallet,consumed_at FROM brainchain_worker_policy_challenges WHERE nonce_hash=${policy.owner_grant_id}`:[];
        if(!policy||!proof?.consumed_at||proof.wallet!==identity.linked_wallet_pubkey||!input.workerControlVersion||input.workerControlVersion!==identity.control_version)throw new WorkerPolicyError('Current owner grant and worker control version required');
        await owner.assertCurrent();
        const [started]=await tx`UPDATE brainchain_worker_bindings SET requested_state='running',updated_at=clock_timestamp()
          WHERE id=${workerId} AND updated_at::text=${input.workerControlVersion} AND ${tx.typed(date(policy.expires_at).toISOString(),25)}::timestamptz>clock_timestamp() RETURNING id`;
        if(!started)throw new WorkerPolicyError('Start grant expired or worker control changed');return this.view(policy);
      }
      await owner.assertCurrent();
      await recordOwnerRecoveryControl(tx,owner,workerId,input.policyId,input.revision,input.action);
      const [row]=await tx<PolicyRow[]>`UPDATE brainchain_worker_policies SET state=${input.action==='revoke'?'revoked':'paused'},revoked_at=CASE WHEN ${input.action}='revoke' THEN clock_timestamp() ELSE revoked_at END
        WHERE id=${input.policyId} AND binding_id=${workerId} AND revision=${input.revision} AND state<>'revoked' RETURNING *`;
      if(!row)throw new WorkerPolicyError('Policy revision unavailable');return this.view(row);});
  }
  async narrow(owner:WorkerPolicyOwner,workerId:string,raw:unknown){
    const input=z.object({policyId:z.string().uuid(),revision:z.number().int().positive(),policy:workerOwnerPolicySchema}).strict().parse(raw);
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId);
      const [prior]=await tx<PolicyRow[]>`SELECT * FROM brainchain_worker_policies WHERE id=${input.policyId} AND binding_id=${workerId} AND revision=${input.revision} AND state='active' FOR UPDATE`;
      const [grant]=prior?.owner_grant_id?await tx`SELECT wallet,consumed_at FROM brainchain_worker_policy_challenges WHERE nonce_hash=${prior.owner_grant_id}`:[];
      const [clock]=await tx`SELECT clock_timestamp() AS now`;
      if(!prior||!grant?.consumed_at||grant.wallet!==identity.linked_wallet_pubkey||!policyNarrows(input.policy,prior.payload)||Date.parse(input.policy.expiresAt)<=date(clock!.now).getTime())throw new WorkerPolicyError('Only a current owner grant can be narrowed');
      const [last]=await tx`SELECT MAX(revision)::int AS revision FROM brainchain_worker_policies WHERE binding_id=${workerId}`;
      await owner.assertCurrent();
      await recordOwnerRecoveryControl(tx,owner,workerId,prior.id,prior.revision,'narrow');
      await tx`UPDATE brainchain_worker_policies SET state='revoked',revoked_at=clock_timestamp() WHERE id=${prior.id}`;
      const [row]=await tx<PolicyRow[]>`INSERT INTO brainchain_worker_policies(binding_id,avatar_id,user_id,revision,payload,payload_hash,state,owner_grant_id,approved_at,expires_at)
        VALUES(${workerId},${owner.avatarId},${owner.userId},${last!.revision+1},${tx.typed(JSON.stringify(input.policy),25)}::jsonb,${workerPolicyHash(input.policy)},'active',${prior.owner_grant_id},clock_timestamp(),${tx.typed(input.policy.expiresAt,25)}::timestamptz) RETURNING *`;
      return this.view(row!);
    });
  }
}
