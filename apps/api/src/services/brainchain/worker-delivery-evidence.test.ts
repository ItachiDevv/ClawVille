/** Isolated module mocks replace bytecode evidence only; no RPC leaves this fixture. */
import {test,expect,mock,afterAll} from 'bun:test';
import {encodeFunctionResult,keccak256,pad,type Hex} from 'viem';
import {taskReadAbi} from './chain-client';
import {BRAINCHAIN_CONTRACTS} from './contracts';
const evidence=await import('./signer-code-evidence'),code='0x6000';
mock.module('./signer-code-evidence',()=>({TESTNET_SIGNER_CODE_EVIDENCE:{...evidence.TESTNET_SIGNER_CODE_EVIDENCE,contracts:{[BRAINCHAIN_CONTRACTS.testnet.contracts.board]:keccak256(code)}}}));
const {createWorkerDeliveryEvidenceReader}=await import('./worker-delivery-evidence');
afterAll(()=>mock.restore());
const address=`0x${'1'.repeat(40)}` as Hex,hash=`0x${'a'.repeat(64)}` as Hex,model=pad(address,{size:32});
const snapshot={environment:'testnet' as const,chainId:274630 as const,board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task:'1',model,expectedPayee:address,briefHash:hash,hireBlock:'99',hireBlockHash:hash,hireTxHash:hash,hireLogIndex:0};
for(const mode of ['idle','reorg','ttl','code'] as const)test(`worker recovery evidence ${mode}`,async()=>{
  const native=Date.now;let clock=native(),anchors=0;Date.now=()=>clock;
  const methods:string[]=[];
  try{
    const reader=createWorkerDeliveryEvidenceReader({validateUrl:async url=>({ok:true,url}),fetch:(async(_url,init)=>{
      const request=JSON.parse(String(init?.body));methods.push(request.method);let result:unknown;
      if(request.method==='eth_chainId')result='0x430c6';
      else if(request.method==='eth_blockNumber')result='0x64';
      else if(request.method==='eth_getCode')result=mode==='code'?'0x6001':code;
      else if(request.method==='eth_getBlockByNumber'){
        if(request.params[0]==='0x64')anchors++;
        if(anchors===2&&mode==='ttl')clock+=30001;
        result={number:request.params[0],hash:anchors===2&&mode==='reorg'?`0x${'b'.repeat(64)}`:hash,timestamp:'0x1'};
      }else if(request.method==='eth_call'){
        expect(request.params[1]).toBe('0x64');
        result=encodeFunctionResult({abi:taskReadAbi,functionName:'get',result:{poster:address,bounty:1n,deadline:9999999999n,status:2,accepted:false,disputed:false,disputedByModel:false,model,briefHash:hash,resultHash:hash,submittedAt:0n,gradedAt:0n,disputedAt:0n,postedAt:0n,payee:address,feeRecipient:address,feeBps:0,hireThresholdBps:0,gradeThresholdBps:0,ruleThresholdBps:0,gradeWindow:0n,disputeWindow:0n,ruleWindow:0n}});
      }else throw Error('Unexpected method');
      return Response.json({jsonrpc:'2.0',id:request.id,result});
    }) as typeof fetch});
    if(mode==='idle'){
      const result=await reader(snapshot);expect(result.observationPolicy).toBe('nitro-testnet-latest-v1');expect(result.blockNumber).toBe(100n);
      expect(result.authorityPolicyVersion).toBeUndefined();expect(methods.filter(method=>method==='eth_call')).toHaveLength(1);expect(result.hireBlockHash).toBe(hash);expect(methods.at(-1)).toBe('eth_getBlockByNumber');expect(anchors).toBe(2);
    }else await expect(reader(snapshot)).rejects.toThrow();
  }finally{Date.now=native;}
});
