import {describe,expect,test} from 'bun:test';
import {captureSignerOperation,broadcastCapturedOperation,type DedicatedSignerDriver,type ProtectedSignedPayloadStore,type TestnetBroadcastTransport} from './signer-service';
import type {SignerObservation} from './signer-policy';

describe('BrainChain inactive signer admission boundary',()=>{
  test('unverified artifacts refuse before key, storage, database, or broadcast access',async()=>{
    let calls=0;
    const forbidden=async():Promise<never>=>{calls++;throw Error('Forbidden side effect');};
    const driver:DedicatedSignerDriver={addressForReference:forbidden,signTransaction:forbidden};
    const store:ProtectedSignedPayloadStore={putIfAbsent:forbidden,get:forbidden,findByOperation:forbidden,claimKeyUse:forbidden};
    const transport:TestnetBroadcastTransport={assertTestnet:forbidden,broadcastSameBytes:forbidden};
    const observation:SignerObservation={environment:'testnet',chainId:274630,bindingAddress:`0x${'1'.repeat(40)}`,signerAddress:`0x${'1'.repeat(40)}`,
      observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{},brainBalance:0n,gasBalance:0n,staked:0n,
      unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};
    await expect(captureSignerOperation({operationId:'11111111-1111-4111-8111-111111111111',observation,nonces:{canonical:0n,pending:0n},driver,store})).rejects.toThrow('artifact equivalence');
    await expect(broadcastCapturedOperation('11111111-1111-4111-8111-111111111111',observation,store,transport)).rejects.toThrow('artifact equivalence');
    expect(calls).toBe(0);
  });
});
