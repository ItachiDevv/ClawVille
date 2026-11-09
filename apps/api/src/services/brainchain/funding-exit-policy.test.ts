import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {buildFundingArtifact,fundingDraftSchema,FUNDING_EXIT_TESTNET as P,fundingIntent,verifyFundingCapture,fundingExitFee} from './funding-exit-policy';
const account=privateKeyToAccount(generatePrivateKey());
const terms={desk:P.desk,token:P.childToken,payoutChainId:P.parentChainId,payoutToken:P.parentToken,feeBps:50,minFeeUnits:'10000',minUnits:'1000000',maxUnits:'100000000',dailyUnits:'200000000'};
export function fundingFixture(kind:'parent_eth'|'parent_exit'='parent_eth'){
 const draft={environment:'testnet' as const,workerId:randomUUID(),idempotencyKey:randomUUID(),kind,amountAtomic:kind==='parent_eth'?'1000000000000000':'1000000',maxGasCostWei:'1000000000000000',maxFeeAtomic:'10000',minimumDestinationAtomic:kind==='parent_eth'?'1000000000000000':'990000'};
 return buildFundingArtifact({id:randomUUID(),draft,source:account.address,nonce:3,gas:100000n,maxFeePerGas:1000000n,maxPriorityFeePerGas:0n,now:Date.now(),terms});
}
test('funding artifacts pin both testnet routes and forbid caller destinations',()=>{const eth=fundingFixture(),exit=fundingFixture('parent_exit');expect(eth.to).toBe(P.inbox);expect(eth.data).toBe('0x439370b1');expect(eth.destination).toBe(account.address.toLowerCase());expect(eth.chainId).toBe(46630);expect(exit.to).toBe(P.childToken);expect(exit.data.length).toBe(138);expect(exit.feeAtomic).toBe('10000');expect(exit.destinationChainId).toBe(46630);expect(fundingDraftSchema.safeParse({...eth,destination:P.desk}).success).toBe(false);expect(fundingExitFee(1n,terms)).toBe(1n);});
test('real EVM signatures must match exact nonce, chain, fees, call, source and intent',async()=>{const a=fundingFixture();
 const transaction={type:'eip1559' as const,chainId:a.chainId,to:a.to as `0x${string}`,nonce:a.nonce,value:BigInt(a.value),gas:BigInt(a.gas),maxFeePerGas:BigInt(a.maxFeePerGas),maxPriorityFeePerGas:BigInt(a.maxPriorityFeePerGas),data:a.data as `0x${string}`};
 const intentSignature=await account.signMessage({message:fundingIntent(a)}),signedTransaction=await account.signTransaction(transaction);
 expect((await verifyFundingCapture(a,{intentSignature,signedTransaction})).signedTransaction).toBe(signedTransaction);
 for(const mutation of [{nonce:4},{chainId:1},{to:P.desk},{value:1n},{gas:1n},{data:'0x00' as const}])await expect(verifyFundingCapture(a,{intentSignature,signedTransaction:await account.signTransaction({...transaction,...mutation})})).rejects.toThrow();
 const foreign=privateKeyToAccount(generatePrivateKey());await expect(verifyFundingCapture(a,{signedTransaction,intentSignature:await foreign.signMessage({message:fundingIntent(a)})})).rejects.toThrow();
 for(const kind of ['parent_eth','parent_exit'] as const){const zero={...fundingFixture(kind),nonce:0};const signed=await account.signTransaction({...transaction,chainId:zero.chainId,to:zero.to as `0x${string}`,data:zero.data as `0x${string}`,value:BigInt(zero.value),nonce:0});expect((await verifyFundingCapture(zero,{signedTransaction:signed,intentSignature:await account.signMessage({message:fundingIntent(zero)})})).signedTransaction).toBe(signed);}
});
