import {expect,test} from 'bun:test';
import {decodeBrainchainRecoveryDraft,parseBrainchainActionParams,selectBrainchainActionResult,validateBrainchainAction} from '../brainchain-action';
const id='00000000-0000-4000-8000-000000000001';
const draft={resultId:id,stages:['reconcile'],maxGasWei:'0',expiresAt:new Date(Date.now()+60000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'};
test('recovery grammar permits only bound requests and restrictions, never owner approval',()=>{
 const encoded=Buffer.from(JSON.stringify(draft)).toString('base64url');
 expect(decodeBrainchainRecoveryDraft('recovery_request',encoded)).toEqual(draft);
 expect(parseBrainchainActionParams(`op=recovery_request,workerId=${id},draft=${encoded}`)?.op).toBe('recovery_request');
 expect(validateBrainchainAction({op:'recovery_approve',workerId:id,consentId:id,signature:'no'})).toBeNull();
 expect(validateBrainchainAction({op:'recovery_revoke',workerId:id,consentId:id,avatarId:id})).toBeNull();
 expect(parseBrainchainActionParams(`op=recovery_revoke,workerId=${id},consentId=${id},consentId=${id}`)).toBeNull();
 expect(validateBrainchainAction({op:'recovery_narrow',workerId:id,consentId:id,draft:encoded})).toBeNull();
});
test('recovery receipts omit original output and credentials and carry a short decision receipt',()=>{
 const view={id,workerId:id,resultId:id,state:'approved',payloadHash:'a'.repeat(64),expiresAt:draft.expiresAt,executionEnabled:false,payload:{...draft,resultHash:'0x'+'b'.repeat(64),resultSha256:'c'.repeat(64),hireSnapshotHash:'d'.repeat(64),taskGeneration:1,signerGeneration:1,resultText:'hostile output',signature:'secret signature',captured:{operationId:id,nonce:'1',transactionHash:'0x'+'e'.repeat(64),gasWei:'1000',protectedReference:'never'}}};
 const result=selectBrainchainActionResult('recovery',200,{consents:[view,view],results:Array.from({length:5},()=>({id,resultHash:'0x'+'b'.repeat(64),resultSha256:'c'.repeat(64),hireSnapshotHash:'d'.repeat(64),state:'uploaded'}))});
 expect(JSON.stringify(result)).not.toContain('hostile output');expect(JSON.stringify(result)).not.toContain('secret signature');expect(JSON.stringify(result)).not.toContain('protectedReference');
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);expect(result.expiresAt).toBeGreaterThan(Date.now());expect(result.expiresAt).toBeLessThanOrEqual(Date.now()+30000);
});
