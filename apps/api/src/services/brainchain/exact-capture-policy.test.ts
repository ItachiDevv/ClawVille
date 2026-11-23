import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {encodeFunctionData} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {signerAbi} from './signer-policy';
import {freezeExactCaptureIntent,exactCaptureTransaction,exactCaptureHash} from './exact-capture-policy';
function fixture(){
 const resultHash=`0x${'a'.repeat(64)}` as const,resultUri=`https://brain.testnet.usebrainchain.com/records/${resultHash}.txt`;
 return{version:1,operationId:randomUUID(),resultId:randomUUID(),workerId:randomUUID(),avatarId:randomUUID(),chainId:274630,signer:`0x${'1'.repeat(40)}`,
 generation:1,operationHash:'b'.repeat(64),authorityId:randomUUID(),gasAuthorityId:randomUUID(),to:BRAINCHAIN_CONTRACTS.testnet.contracts.board,
 data:encodeFunctionData({abi:signerAbi,functionName:'submit',args:[1n,resultHash,resultUri]}),value:'0',nonce:'0',gas:'100',maxFeePerGas:'2',maxPriorityFeePerGas:'1',task:'1',resultHash,resultUri};
}
test('exact capture freezes the signed transaction and covers every monetary field',()=>{
 const raw=fixture(),frozen=freezeExactCaptureIntent(raw),transaction=exactCaptureTransaction(frozen),digest=exactCaptureHash(raw);
 raw.nonce='1';raw.gas='200';raw.data='0x00';
 expect(Object.isFrozen(frozen)).toBe(true);expect(Object.isFrozen(transaction)).toBe(true);expect(transaction.nonce).toBe(0);expect(transaction.gas).toBe(100n);
 for(const field of ['nonce','gas','maxFeePerGas','maxPriorityFeePerGas'] as const){const changed={...frozen,[field]:field==='maxPriorityFeePerGas'?'0':'3'};expect(exactCaptureHash(changed)).not.toBe(digest);}
 expect(exactCaptureHash({...frozen})).toBe(digest);
});
test('exact capture refuses foreign destinations, changed calldata, overflow and unsupported fields',()=>{
 const raw=fixture();
 for(const mutation of [{chainId:46630},{to:`0x${'2'.repeat(40)}`},{data:'0x00'},{value:'1'},{nonce:'9007199254740992'},{gas:'0'},{maxFeePerGas:'0'},{maxPriorityFeePerGas:'3'},
   {gas:(2n**255n).toString()},{resultUri:'https://example.com/result'},{task:'2'},{accessList:[]}])expect(()=>freezeExactCaptureIntent({...raw,...mutation})).toThrow();
});
