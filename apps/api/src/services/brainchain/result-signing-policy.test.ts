import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {encodeFunctionData} from 'viem';
import {freezeResultSignatureIntent,resultSignatureClaimHash,verifyResultSignature} from './result-signing-policy';
import {resultUploadMessage} from './result-signing-message';
import {assertDriverTransaction} from './signer-linux-driver';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {signerAbi,signerRequestSchema} from './signer-policy';
import type {FrozenSignerTransaction} from './signer-service';

test('result signatures have a fixed message, domain, chain and exact primitive snapshot',async()=>{
  const raw={domain:'brainchain-result-v2' as const,chainId:274630 as const,resultId:randomUUID(),board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task:'17',hash:`0x${'a'.repeat(64)}`,worker:`0x${'1'.repeat(40)}`};
  const intent=freezeResultSignatureIntent(raw),hash=resultSignatureClaimHash('brainchain-testnet:fixture',intent);
  raw.task='18';expect(intent.task).toBe('17');expect(Object.isFrozen(intent)).toBe(true);
  expect(resultUploadMessage(intent.board,intent.task,intent.hash)).toBe(`BrainChain result v2\nchain 274630\nboard ${intent.board}\ntask 17\nhash ${intent.hash}`);
  expect(resultSignatureClaimHash('brainchain-testnet:other',intent)).not.toBe(hash);
  expect(()=>freezeResultSignatureIntent({...intent,chainId:274663})).toThrow();
  expect(()=>freezeResultSignatureIntent({...intent,message:'arbitrary'})).toThrow();
  expect(()=>freezeResultSignatureIntent({...intent,task:(2n**256n).toString()})).toThrow();
  await expect(verifyResultSignature(`0x${'ａ'.repeat(130)}`,intent)).rejects.toThrow('signature differs');
});
test('submit driver requires exact typed result authority and rejects foreign URI or calldata',()=>{
  const hash=`0x${'a'.repeat(64)}` as const,request={kind:'submit' as const,resultId:randomUUID(),task:'17',hash,uri:`https://brain.testnet.usebrainchain.com/records/${hash}.txt`};
  const transaction:FrozenSignerTransaction={chainId:274630,type:'eip1559',to:BRAINCHAIN_CONTRACTS.testnet.contracts.board,data:encodeFunctionData({abi:signerAbi,functionName:'submit',args:[17n,hash,request.uri]}),value:0n,nonce:0,gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n};
  const worker=`0x${'1'.repeat(40)}`;
  expect(()=>assertDriverTransaction(transaction,worker)).toThrow('Typed submit');
  expect(()=>assertDriverTransaction(transaction,worker,request)).not.toThrow();
  expect(()=>assertDriverTransaction(transaction,worker,{...request,task:'18'})).toThrow();
  expect(()=>assertDriverTransaction(transaction,worker,{...request,uri:request.uri+'?x=1'})).toThrow();
  expect(()=>assertDriverTransaction({...transaction,to:worker as `0x${string}`},worker,request)).toThrow();
  expect(()=>signerRequestSchema.parse({...request,endpoint:'https://example.com'})).toThrow();
});
