import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Run alone. Only artifact admission is mocked for fault injection; no private key or network is used. */
import {describe,test,expect,mock} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import postgres from 'postgres';
import type {DedicatedSignerDriver,ProtectedSignedPayloadStore} from './signer-service';
import type {SignerObservation} from './signer-policy';

const authorityReader=fixtureConfiguredAuthorityReader(`0x${'b'.repeat(64)}`);

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('BrainChain capture crash boundary',()=>{
  test('acceptance commits before key access; late completion cannot cause a second key call',async()=>{
    const root=resolve(import.meta.dir,'../../../../..');
    const settings=await getBrainchainFixtureSettings();
    const fixture=postgres({...settings.options,max:4,onnotice:()=>{}});
    const prior=process.env.DATABASE_URL;
    process.env.DATABASE_URL=settings.url;
    try{
      const policy=await import('./signer-policy');
      mock.module('./signer-policy',()=>({...policy,assertSignerArtifactAdmission:()=>{}}));
      const operations=await import('./signer-operations');
      const {captureSignerOperation}=await import('./signer-service');
      const avatarId=randomUUID(),bindingId=randomUUID(),address=`0x${randomBytes(20).toString('hex')}`;
      await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
      await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)},'running')`;
      await fixture`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:'+randomUUID()},0)`;
      const request={kind:'faucet'} as const,authorityId=randomUUID(),gasAuthorityId=randomUUID(),hash=policy.signerRequestHash(request);
      for(const [id,purpose,amount] of [[authorityId,'faucet','0'],[gasAuthorityId,'gas','200']] as const)
        await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
          VALUES(${id},${bindingId},${avatarId},'testnet',274630,${address},1,${purpose},${hash},${amount},'isolated-crash-fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
      const observation:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:address,signerAddress:address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'b'.repeat(64)}`,codeHashes:{},
        brainBalance:1000n,gasBalance:10000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};
      const operation=await operations.prepareSignerOperation({avatarId,bindingId,authorityId,gasAuthorityId,idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}},observation);
      let keyCalls=0,claims=0,finish!:()=>void;
      const waiting=new Promise<void>(done=>{finish=done;});
      const driver:DedicatedSignerDriver={async addressForReference(){return address;},async signTransaction(id){
        keyCalls++;
        const [visible]=await fixture`SELECT state,accepted_at,nonce FROM brainchain_signer_operations WHERE id=${id}`;
        expect(visible!.state).toBe('accepting');expect(visible!.accepted_at).not.toBeNull();expect(String(visible!.nonce)).toBe('0');
        await waiting;
        return '0x0201'; // Deliberately invalid fixture bytes, never a signed transaction.
      }};
      const store:ProtectedSignedPayloadStore={async claimKeyUse(){claims++;return true;},async findByOperation(){return null;},async get(){throw Error('No capture');},async putIfAbsent(){throw Error('Late invalid bytes must not persist');}};
      const input={operationId:operation.id,observation,authorityReader,nonces:{canonical:0n,pending:0n},driver,store};
      expect((await captureSignerOperation(input)).state).toBe('uncertain');
      finish();await Bun.sleep(10);
      expect((await captureSignerOperation(input)).state).toBe('uncertain');
      expect(keyCalls).toBe(1);expect(claims).toBe(1);
      expect((await fixture`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.accepted_at).not.toBeNull();
    }finally{mock.restore();await fixture.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;}
  },15000);
  test('lifecycle authority changes after durable claim prevent first key use and retain uncertainty',async()=>{
    const settings=await getBrainchainFixtureSettings(),fixture=postgres({...settings.options,max:4,onnotice:()=>{}}),prior=process.env.DATABASE_URL;
    process.env.DATABASE_URL=settings.url;
    try{
      const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerArtifactAdmission:()=>{}}));
      const {prepareSignerOperation}=await import('./signer-operations'),{captureSignerOperation}=await import('./signer-service');
      for(const boundary of ['expiry','revoked','paused','draining','generation'] as const){
        const avatarId=randomUUID(),bindingId=randomUUID(),address=`0x${randomBytes(20).toString('hex')}`;
        await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
        await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)},'running')`;
        await fixture`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:'+randomUUID()},0)`;
        const request={kind:'faucet'} as const,authorityId=randomUUID(),gasAuthorityId=randomUUID(),hash=policy.signerRequestHash(request);
        for(const [id,purpose,amount] of [[authorityId,'faucet','0'],[gasAuthorityId,'gas','200']] as const)
          await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
            VALUES(${id},${bindingId},${avatarId},'testnet',274630,${address},1,${purpose},${hash},${amount},'isolated-expiry-fixture',clock_timestamp()+${boundary==='expiry'?1000:60000}*interval '1 millisecond',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
        const observation:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:address,signerAddress:address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'b'.repeat(64)}`,codeHashes:{},brainBalance:1000n,gasBalance:10000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};
        const operation=await prepareSignerOperation({avatarId,bindingId,authorityId,gasAuthorityId,idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}},observation);
        let calls=0,claims=0;
        const store:ProtectedSignedPayloadStore={async claimKeyUse(){claims++;
          if(boundary==='expiry')await Bun.sleep(1200);
          if(boundary==='revoked')await fixture`UPDATE brainchain_signer_authorities SET revoked_at=clock_timestamp() WHERE id=${authorityId}`;
          if(boundary==='draining')await fixture`UPDATE brainchain_worker_bindings SET requested_state='draining' WHERE id=${bindingId}`;
          if(boundary==='paused')await fixture`UPDATE brainchain_worker_bindings SET requested_state='paused' WHERE id=${bindingId}`;
          if(boundary==='generation')await fixture`UPDATE brainchain_signer_streams SET generation=generation+1 WHERE binding_id=${bindingId}`;
          return true;},async findByOperation(){return null;},async get(){throw Error('No capture');},async putIfAbsent(){throw Error('No key use permitted');}};
        const input={operationId:operation.id,observation,authorityReader,nonces:{canonical:0n,pending:0n},store,driver:{async addressForReference(){return address;},async signTransaction(){calls++;throw Error('Must not sign');}}};
        expect((await captureSignerOperation(input)).state).toBe('uncertain');expect(calls).toBe(0);expect(claims).toBe(1);
        expect((await captureSignerOperation(input)).state).toBe('uncertain');expect(claims).toBe(1);
        const [retained]=await fixture`SELECT nonce,accepted_at,signed_payload_ref FROM brainchain_signer_operations WHERE id=${operation.id}`;
        expect(String(retained!.nonce)).toBe('0');expect(retained!.accepted_at).not.toBeNull();expect(retained!.signed_payload_ref).toBeNull();
      }
    }finally{mock.restore();await fixture.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;}
  });
});
