import {probeManifestSchema,probeManifestHash} from './probe-embedding-budget';
import type {TransactionSql} from 'postgres';
/** Caller holds every affected budget and envelope lock before this shared ledger check. */
export async function lockComputeAccounting(tx:TransactionSql,envelopeIds:string[]){
 if(!envelopeIds.length)return [];
 const runs=await tx`SELECT r.*,m.run_id AS marker_run,m.user_id,m.avatar_id,m.runtime_agent_id FROM brainchain_probe_runs r JOIN brainchain_probe_markers m ON m.platform_agent_id=r.platform_agent_id WHERE r.envelope_id IN ${tx(envelopeIds)} ORDER BY r.id FOR UPDATE OF r`;
 for(const r of runs){const m=probeManifestSchema.parse(r.manifest);if(probeManifestHash(m)!==r.manifest_hash||m.runId!==r.id||m.runId!==r.marker_run||m.envelopeId!==r.envelope_id||m.platformAgentId!==r.platform_agent_id||m.userId!==r.user_id||m.avatarId!==r.avatar_id||m.runtimeAgentId!==r.runtime_agent_id)throw new Error('Probe accounting ownership mismatch');}
 const task=await tx`SELECT * FROM brainchain_compute_calls WHERE envelope_id IN ${tx(envelopeIds)} ORDER BY id FOR UPDATE`;
 const probe=await tx`SELECT * FROM brainchain_probe_calls WHERE envelope_id IN ${tx(envelopeIds)} ORDER BY id FOR UPDATE`;
 return [...task,...probe];
}
export function assertComputeAccounting(envelope:Record<string,any>,calls:Record<string,any>[]){
 const entries=calls.filter(c=>c.envelope_id===envelope.id);let reserved=0n,uncertain=0n,settled=0n;
 for(const c of entries){if(c.state==='reserved')reserved+=BigInt(c.maximum_micros);else if(c.state==='dispatched'||c.state==='uncertain')uncertain+=BigInt(c.maximum_micros);else if(c.state==='settled')settled+=BigInt(c.charged_micros);else if(c.state!=='canceled')throw new Error('Unknown compute accounting state');}
 if(reserved!==BigInt(envelope.reserved_micros)||uncertain!==BigInt(envelope.uncertain_micros)||settled!==BigInt(envelope.settled_micros))throw new Error('Compute ledger counter mismatch');
 return {reserved,uncertain,settled};
}
