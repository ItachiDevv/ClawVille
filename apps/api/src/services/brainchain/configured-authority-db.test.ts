import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {CONFIGURED_AUTHORITY_VERSION as version,CONFIGURED_AUTHORITY_DIGEST as digest} from './configured-authority';
import {assertPersistedConfiguredAuthority} from './configured-authority-reader';
describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('configured authority PostgreSQL linkage',()=>{
 let q:ReturnType<typeof postgres>,migration:string;const owned:string[]=[];
 beforeAll(async()=>{const settings=await getBrainchainFixtureSettings();q=postgres({...settings.options,max:4,onnotice:()=>{}});migration=await readFile(new URL('../../../../../packages/database/migrations/0118_brainchain_configured_authority.sql',import.meta.url),'utf8');await q.unsafe(migration);await q.unsafe(migration);});
 afterAll(async()=>{await q?.end();});
 async function grant(current:boolean){const id=randomUUID();await q`INSERT INTO brainchain_signer_authorities SELECT (jsonb_populate_record(NULL::brainchain_signer_authorities,to_jsonb(a)||jsonb_build_object('id',${id}::text,'authority_policy_version',${current?version:null}::text,'authority_policy_digest',${current?digest:null}::text))).* FROM brainchain_signer_authorities a LIMIT 1`;owned.push(id);return id;}
 async function refusal(action:()=>PromiseLike<unknown>){try{await action();return false;}catch{return true;}}
 test('replay retains historical NULL and pair immutability includes NULL-to-current',async()=>{
  const id=await grant(false);await q.unsafe(migration);
  const [row]=await q`SELECT * FROM brainchain_signer_authorities WHERE id=${id}`;
  expect(row!.authority_policy_version).toBeNull();expect(row!.authority_policy_digest).toBeNull();expect(()=>assertPersistedConfiguredAuthority(row!)).toThrow();
  expect(await refusal(()=>q`UPDATE brainchain_signer_authorities SET authority_policy_version=${version},authority_policy_digest=${digest} WHERE id=${id}`)).toBe(true);
 });
 test('current pair persists but partial, unknown, and changed pairs refuse',async()=>{
  const id=await grant(true),[row]=await q`SELECT * FROM brainchain_signer_authorities WHERE id=${id}`;
  expect(()=>assertPersistedConfiguredAuthority(row!)).not.toThrow();
  for(const pair of [[version,null],[null,digest],['unknown',digest],[version,'a'.repeat(64)]]){
   const bad=randomUUID();expect(await refusal(()=>q`INSERT INTO brainchain_signer_authorities SELECT (jsonb_populate_record(NULL::brainchain_signer_authorities,to_jsonb(a)||jsonb_build_object('id',${bad}::text,'authority_policy_version',${pair[0]??null}::text,'authority_policy_digest',${pair[1]??null}::text))).* FROM brainchain_signer_authorities a WHERE id=${id}`)).toBe(true);
  }
  expect(await refusal(()=>q`UPDATE brainchain_signer_authorities SET authority_policy_digest=${'b'.repeat(64)} WHERE id=${id}`)).toBe(true);
 });
 test('operation insertion cannot mix current intent with historical gas',async()=>{
  const [source]=await q`SELECT * FROM brainchain_signer_operations LIMIT 1`;if(!source)throw Error('Signer fixture prerequisite absent');
  async function cloneAuthority(sourceId:string,current:boolean){const id=randomUUID();await q`INSERT INTO brainchain_signer_authorities SELECT (jsonb_populate_record(NULL::brainchain_signer_authorities,to_jsonb(a)||jsonb_build_object('id',${id}::text,'authority_policy_version',${current?version:null}::text,'authority_policy_digest',${current?digest:null}::text))).* FROM brainchain_signer_authorities a WHERE id=${sourceId}`;return id;}
  const intent=await cloneAuthority(source.authority_id,true),gas=await cloneAuthority(source.gas_authority_id,false);
  const id=randomUUID();expect(await refusal(()=>q`INSERT INTO brainchain_signer_operations SELECT (jsonb_populate_record(NULL::brainchain_signer_operations,to_jsonb(o)||jsonb_build_object('id',${id}::text,'authority_id',${intent}::text,'gas_authority_id',${gas}::text,'idempotency_key',${id}::text,'state','prepared','nonce',NULL,'accepted_at',NULL,'transaction_hash',NULL,'signed_payload_ref',NULL,'authority_policy_version',${version}::text,'authority_policy_digest',${digest}::text))).* FROM brainchain_signer_operations o WHERE id=${source.id}`)).toBe(true);
  expect(await q`SELECT id FROM brainchain_signer_operations WHERE id=${id}`).toHaveLength(0);
 });
});
