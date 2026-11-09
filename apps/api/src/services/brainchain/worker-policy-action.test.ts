import {test,expect} from 'bun:test';
import {parseBrainchainActionParams,decodeBrainchainPolicyDraft,selectBrainchainActionResult} from '../brainchain-action';
const id='00000000-0000-4000-8000-000000000001';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
test('finite worker controls preserve exact owner revision and reject approval or injected authority',()=>{
  const body={policyId:id,revision:2,workerControlVersion:'2026-11-09 18:00:00+00'},draft=encode(body);
  expect(parseBrainchainActionParams(`op=policy_start,workerId=${id},draft=${draft}`)?.op).toBe('policy_start');
  expect(decodeBrainchainPolicyDraft('policy_start',draft)).toEqual({...body,action:'start'});
  expect(parseBrainchainActionParams(`op=policy_approve,workerId=${id},draft=${draft}`)).toBeNull();
  expect(parseBrainchainActionParams(`op=policy_start,workerId=${id},draft=${encode({...body,authorityId:id})}`)).toBeNull();
  expect(parseBrainchainActionParams(`op=policy_start,workerId=${id},draft=${encode({...body,revision:'2'})}`)).toBeNull();
  expect(decodeBrainchainPolicyDraft('policy_pause',encode({policyId:id,revision:2}))).toEqual({policyId:id,revision:2,action:'pause'});
});
test('policy result drops untrusted extra fields and preserves the control version',()=>{
  const result=selectBrainchainActionResult('policy',200,{policy:null,workerControlVersion:'exact version',executionEnabled:false,secret:'never',instruction:'never'});
  expect(result.data).toEqual({policy:null,workerControlVersion:'exact version',executionEnabled:false});
});
