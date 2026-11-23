import {createHash} from 'node:crypto';
import {encodeFunctionData,parseAbi,parseTransaction,recoverTransactionAddress,recoverMessageAddress,keccak256,type Hex} from 'viem';
import {z} from 'zod';
import {canonical} from './purchase-policy';
import type {BrainChainExitTerms} from './public-client';

/** Pinned worker b71f3b24ddbda4fe31026dfa66fc23c12194c800. No runtime route substitution. */
export const FUNDING_EXIT_TESTNET={parentChainId:46630,parentRpc:'https://rpc.testnet.chain.robinhood.com',childChainId:274630,
 childRpc:'https://rpc.testnet.usebrainchain.com',inbox:'0xd5b98547aa58db0abc75c06f5a62a7acdf9cb977',
 desk:'0xf848984c8a0d9e49cc9c97380c62b34c6f3b97d1',childToken:'0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2',
 parentToken:'0x1ec185467ca2d5d1c24f0edcb91301bca4d0a787',origin:'https://brain.testnet.usebrainchain.com'} as const;
export class FundingExitError extends Error{constructor(readonly code:'invalid_request'|'operation_not_found'|'operation_conflict'|'owner_required'|'approval_required'|'unsupported_route'|'terms_unavailable'|'receipt_unavailable'|'execution_disabled'|'operation_uncertain'){super(code);}}
export const fundingAddress=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v=>v.toLowerCase());
export const fundingHash=z.string().regex(/^0x[0-9a-f]{64}$/);
export const fundingAtomic=z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(v=>BigInt(v)<2n**256n);
export const fundingDraftSchema=z.object({environment:z.literal('testnet'),workerId:z.string().uuid(),idempotencyKey:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
 kind:z.enum(['parent_eth','parent_exit']),amountAtomic:fundingAtomic.refine(v=>BigInt(v)>0n),maxGasCostWei:fundingAtomic.refine(v=>BigInt(v)>0n),
 maxFeeAtomic:fundingAtomic,minimumDestinationAtomic:fundingAtomic}).strict();
export type FundingDraft=z.infer<typeof fundingDraftSchema>;
export const fundingArtifactSchema=z.object({version:z.literal(1),operationId:z.string().uuid(),workerId:z.string().uuid(),kind:z.enum(['parent_eth','parent_exit']),
 source:fundingAddress,destination:fundingAddress,chainId:z.union([z.literal(46630),z.literal(274630)]),destinationChainId:z.union([z.literal(46630),z.literal(274630)]),
 token:fundingAddress.nullable(),destinationToken:fundingAddress.nullable(),amountAtomic:fundingAtomic,feeAtomic:fundingAtomic,minimumDestinationAtomic:fundingAtomic,
 nonce:z.number().int().nonnegative().safe(),gas:fundingAtomic,maxFeePerGas:fundingAtomic,maxPriorityFeePerGas:fundingAtomic,
 to:fundingAddress,data:z.string().regex(/^0x(?:[0-9a-f]{2})*$/).max(138),value:fundingAtomic,
 issuedAt:z.string().datetime(),expiresAt:z.string().datetime(),termsHash:z.string().regex(/^[0-9a-f]{64}$/).nullable()}).strict();
export type FundingArtifact=z.infer<typeof fundingArtifactSchema>;
export function fundingDigest(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
export function fundingExitFee(amount:bigint,terms:BrainChainExitTerms){const proportional=amount*BigInt(terms.feeBps)/10000n;const fee=proportional>BigInt(terms.minFeeUnits)?proportional:BigInt(terms.minFeeUnits);return fee>amount?amount:fee;}
export function validateExitTerms(terms:BrainChainExitTerms){const p=FUNDING_EXIT_TESTNET;
 if(terms.desk.toLowerCase()!==p.desk||terms.token.toLowerCase()!==p.childToken||terms.payoutChainId!==p.parentChainId||terms.payoutToken.toLowerCase()!==p.parentToken)throw new FundingExitError('terms_unavailable');
 return terms;
}
export function buildFundingArtifact(input:{id:string;draft:FundingDraft;source:string;nonce:number;gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint;now:number;terms?:BrainChainExitTerms}):FundingArtifact{
 const d=fundingDraftSchema.parse(input.draft),p=FUNDING_EXIT_TESTNET,source=fundingAddress.parse(input.source),amount=BigInt(d.amountAtomic);
 let fee=0n,termsHash:string|null=null;
 if(d.kind==='parent_exit'){
  if(!input.terms)throw new FundingExitError('terms_unavailable');const terms=validateExitTerms(input.terms);
  if(amount<BigInt(terms.minUnits)||amount>BigInt(terms.maxUnits))throw new FundingExitError('invalid_request');
  fee=fundingExitFee(amount,terms);termsHash=fundingDigest(terms);
 }else if(amount>10n**18n)throw new FundingExitError('invalid_request');
 if(fee>BigInt(d.maxFeeAtomic)||amount-fee<BigInt(d.minimumDestinationAtomic)||input.gas<=0n||input.gas>1000000n||input.maxFeePerGas<=0n||input.maxPriorityFeePerGas<0n||input.maxPriorityFeePerGas>input.maxFeePerGas||input.gas*input.maxFeePerGas>BigInt(d.maxGasCostWei))throw new FundingExitError('invalid_request');
 const exit=d.kind==='parent_exit';
 return fundingArtifactSchema.parse({version:1,operationId:input.id,workerId:d.workerId,kind:d.kind,source,destination:source,chainId:exit?p.childChainId:p.parentChainId,destinationChainId:exit?p.parentChainId:p.childChainId,
 token:exit?p.childToken:null,destinationToken:exit?p.parentToken:null,amountAtomic:amount.toString(),feeAtomic:fee.toString(),minimumDestinationAtomic:d.minimumDestinationAtomic,
 nonce:input.nonce,gas:input.gas.toString(),maxFeePerGas:input.maxFeePerGas.toString(),maxPriorityFeePerGas:input.maxPriorityFeePerGas.toString(),
 to:exit?p.childToken:p.inbox,data:exit?encodeFunctionData({abi:parseAbi(['function transfer(address,uint256) returns (bool)']),functionName:'transfer',args:[p.desk,amount]}):encodeFunctionData({abi:parseAbi(['function depositEth() payable returns (uint256)']),functionName:'depositEth'}),
 value:exit?'0':amount.toString(),issuedAt:new Date(input.now).toISOString(),expiresAt:new Date(input.now+120000).toISOString(),termsHash});
}
export function fundingIntent(a:FundingArtifact){return `ClawVille BrainChain testnet funding/exit consent\n${canonical(fundingArtifactSchema.parse(a))}\nNo alternative asset or destination is authorized. The source receipt does not prove destination arrival.`;}
export function fundingAccountMessage(a:FundingArtifact,nonce:string,wallet:string,version:string,expiresAt:string){return `ClawVille account approval\noperation:${a.operationId}\nartifact:${fundingDigest(a)}\nwallet:${wallet}\nauthorityVersion:${version}\nnonce:${nonce}\nexpires:${expiresAt}`;}
export async function verifyFundingCapture(a:FundingArtifact,raw:unknown){
 const input=z.object({signedTransaction:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(4096),intentSignature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict().parse(raw);
 const signed=input.signedTransaction.toLowerCase() as Hex;
 try{
  const tx=parseTransaction(signed);if(tx.type!=='eip1559'||tx.chainId!==a.chainId||tx.to?.toLowerCase()!==a.to||(tx.nonce??0)!==a.nonce||(tx.value??0n)!==BigInt(a.value)||tx.gas!==BigInt(a.gas)||tx.maxFeePerGas!==BigInt(a.maxFeePerGas)||(tx.maxPriorityFeePerGas??0n)!==BigInt(a.maxPriorityFeePerGas)||(tx.data??'0x')!==a.data||(tx.accessList?.length??0)!==0)throw Error('shape');
  if(!signed.startsWith('0x02'))throw Error('type');
  const [signer,intent]=await Promise.all([recoverTransactionAddress({serializedTransaction:signed as `0x02${string}`}),recoverMessageAddress({message:fundingIntent(a),signature:input.intentSignature as Hex})]);
  if(signer.toLowerCase()!==a.source||intent.toLowerCase()!==a.source)throw Error('signer');
  return {signedTransaction:signed,transactionHash:keccak256(signed)};
 }catch{throw new FundingExitError('invalid_request');}
}
