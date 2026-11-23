import {randomUUID} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import {databaseDate} from './database-values';
import {WorkerPolicyError} from './worker-owner-policy';
import type {WorkerJobLease} from './worker-authority-issuer';

export type WorkerJob=WorkerJobLease & {avatarId:string;leaseUntil:Date;pendingPlan:Record<string,unknown>|null};
/** Durable host coordination only. A job lease grants no key, provider, or transaction authority. */
export class WorkerJobs{
  constructor(private readonly database:Sql,private readonly hostId:string=randomUUID(),private readonly leaseMs=60000){
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>60000)throw new WorkerPolicyError('Invalid worker lease bound');
  }
  async claim(workerId:string):Promise<WorkerJob|null>{return this.database.begin(async tx=>{
    const [policy]=await tx`SELECT p.id,p.avatar_id,p.expires_at FROM brainchain_worker_policies p
      JOIN brainchain_worker_bindings w ON w.id=p.binding_id JOIN avatars a ON a.id=w.avatar_id JOIN users u ON u.id=a.user_id
      JOIN brainchain_worker_policy_challenges c ON c.nonce_hash=p.owner_grant_id
      WHERE p.binding_id=${workerId} AND p.state='active' AND p.expires_at>clock_timestamp() AND w.requested_state IN ('running','draining')
      AND w.environment='testnet' AND w.chain_id=274630 AND a.is_guest=false AND u.is_guest=false AND c.consumed_at IS NOT NULL AND c.wallet=u.linked_wallet_pubkey FOR UPDATE OF w,a,u,p`;
    if(!policy)return null;
    const [current]=await tx`SELECT * FROM brainchain_worker_jobs WHERE binding_id=${workerId} FOR UPDATE`;
    const [clock]=await tx`SELECT clock_timestamp() AS now`;const now=databaseDate(clock!.now);
    if(databaseDate(policy.expires_at)<=now)return null;
    if(current&&databaseDate(current.lease_until)>now){
      if(current.lease_owner!==this.hostId||current.policy_id!==policy.id)return null;
      return this.view(current);
    }
    if(current?.pending_plan&&current.policy_id!==policy.id)throw new WorkerPolicyError('Retained plan requires original owner evidence review');
    const expiry=new Date(Math.min(now.getTime()+this.leaseMs,databaseDate(policy.expires_at).getTime()));
    const [row]=current?await tx`UPDATE brainchain_worker_jobs SET generation=generation+1,lease_owner=${this.hostId},policy_id=${policy.id},claimed_at=${tx.typed(now.toISOString(),25)}::timestamptz,lease_until=${tx.typed(expiry.toISOString(),25)}::timestamptz,updated_at=clock_timestamp()
      WHERE binding_id=${workerId} AND generation=${current.generation} AND lease_until<=clock_timestamp() RETURNING *`
      :await tx`INSERT INTO brainchain_worker_jobs(binding_id,avatar_id,policy_id,generation,lease_owner,claimed_at,lease_until)
        VALUES(${workerId},${policy.avatar_id},${policy.id},1,${this.hostId},${tx.typed(now.toISOString(),25)}::timestamptz,${tx.typed(expiry.toISOString(),25)}::timestamptz) RETURNING *`;
    if(!row)return null;return this.view(row);
  });}
  private view(row:Record<string,any>):WorkerJob{return{workerId:row.binding_id,avatarId:row.avatar_id,policyId:row.policy_id,generation:row.generation,leaseOwner:row.lease_owner,leaseUntil:databaseDate(row.lease_until),pendingPlan:row.pending_plan};}
  private async lockCurrent(tx:TransactionSql,job:WorkerJob){
    // Match claim's lock order. A row-lock wait must finish before the wall-clock check.
    const [policy]=await tx`SELECT p.id FROM brainchain_worker_bindings w JOIN brainchain_worker_policies p ON p.binding_id=w.id
      WHERE w.id=${job.workerId} AND p.id=${job.policyId} FOR UPDATE OF w,p`;
    const [row]=await tx`SELECT * FROM brainchain_worker_jobs WHERE binding_id=${job.workerId} FOR UPDATE`;
    const [live]=await tx`SELECT p.id FROM brainchain_worker_policies p JOIN brainchain_worker_bindings w ON w.id=p.binding_id
      WHERE p.id=${job.policyId} AND p.state='active' AND p.expires_at>clock_timestamp() AND w.requested_state IN ('running','draining')`;
    const [clock]=await tx`SELECT clock_timestamp() AS now`;
    if(!policy||!live||!row||row.policy_id!==job.policyId||row.generation!==job.generation||row.lease_owner!==job.leaseOwner||databaseDate(row.lease_until)<=databaseDate(clock!.now))
      throw new WorkerPolicyError('Stale worker lease refused');
    return row;
  }
  async persist(job:WorkerJob,plan:Record<string,unknown>){
    const bytes=JSON.stringify(plan);if(Buffer.byteLength(bytes)>32768)throw new WorkerPolicyError('Worker plan exceeds bound');
    await this.database.begin(async tx=>{
    await this.lockCurrent(tx,job);
    const [row]=await tx`UPDATE brainchain_worker_jobs SET pending_plan=${tx.typed(bytes,25)}::jsonb,updated_at=clock_timestamp()
      WHERE binding_id=${job.workerId} AND policy_id=${job.policyId} AND generation=${job.generation} AND lease_owner=${job.leaseOwner} AND lease_until>clock_timestamp()
      AND (pending_plan IS NULL OR pending_plan=${tx.typed(bytes,25)}::jsonb) RETURNING binding_id`;
    if(!row)throw new WorkerPolicyError('Worker plan lease changed');
    });
  }
  async completeStage(job:WorkerJob,state:string){
    if(!/^[a-z][a-z0-9_-]{0,95}$/.test(state))throw new WorkerPolicyError('Invalid worker outcome');
    await this.database.begin(async tx=>{
    await this.lockCurrent(tx,job);
    const [row]=await tx`UPDATE brainchain_worker_jobs SET pending_plan=NULL,last_state=${state},updated_at=clock_timestamp()
      WHERE binding_id=${job.workerId} AND policy_id=${job.policyId} AND generation=${job.generation} AND lease_owner=${job.leaseOwner} AND lease_until>clock_timestamp() RETURNING binding_id`;
    if(!row)throw new WorkerPolicyError('Stale worker completion refused');
    });
  }
}
