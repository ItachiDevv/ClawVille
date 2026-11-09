'use client';
import { BRAINCHAIN_BUYER_LANE, type BrainchainBuyerOrder } from '@clawville/shared';
import { z } from 'zod';
const lane=BRAINCHAIN_BUYER_LANE;
interface EvmProvider { request(input:{method:string;params?:unknown[]}):Promise<unknown> }
function provider():EvmProvider{const value=(window as unknown as {ethereum?:EvmProvider}).ethereum;if(!value?.request)throw new Error('Connect an EVM wallet that supports Base Sepolia.');return value;}
export async function connectBrainchainPayer(){const wallet=provider();const accounts=z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).parse(await wallet.request({method:'eth_requestAccounts'}));const chain=await wallet.request({method:'eth_chainId'});if(chain!=='0x14a34')await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]});if(await wallet.request({method:'eth_chainId'})!=='0x14a34')throw new Error('Select Base Sepolia before this test purchase.');return accounts[0]!.toLowerCase();}
const hex=z.string().regex(/^0x[0-9a-f]{64}$/),address=z.string().regex(/^0x[0-9a-fA-F]{40}$/),seconds=z.string().regex(/^[1-9][0-9]{0,12}$/);
const paymentFields=[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}];
const intentFields=[{name:'order',type:'bytes32'},{name:'avatar',type:'bytes32'},{name:'bodyHash',type:'bytes32'},{name:'quoteHash',type:'bytes32'},{name:'endpointHash',type:'bytes32'},{name:'token',type:'address'},{name:'recipient',type:'address'},{name:'payer',type:'address'},{name:'amount',type:'uint256'},{name:'permanentAvatarBinding',type:'bool'},{name:'paymentNonce',type:'bytes32'},{name:'intentNonce',type:'bytes32'},{name:'validBefore',type:'uint256'}];
const field=z.object({name:z.string(),type:z.string()}).strict();
const types=z.record(z.string(),z.array(field));
const paymentSchema=z.object({domain:z.object({name:z.literal(lane.domainName),version:z.literal(lane.domainVersion),chainId:z.literal(lane.chainId),verifyingContract:z.literal(lane.token)}).strict(),primaryType:z.literal('TransferWithAuthorization'),types,message:z.object({from:address,to:z.literal(lane.recipient),value:z.literal(lane.amountAtomic),validAfter:seconds,validBefore:seconds,nonce:hex}).strict()}).strict();
const intentSchema=z.object({domain:z.object({name:z.literal('ClawVille BrainChain Purchase'),version:z.literal('1'),chainId:z.literal(lane.chainId),salt:hex}).strict(),primaryType:z.literal('PurchaseIntent'),types,message:z.object({order:hex,avatar:hex,bodyHash:hex,quoteHash:hex,endpointHash:hex,token:z.literal(lane.token),recipient:z.literal(lane.recipient),payer:address,amount:z.literal(lane.amountAtomic),permanentAvatarBinding:z.literal(true),paymentNonce:hex,intentNonce:hex,validBefore:seconds}).strict()}).strict();
async function digest(text:string){return `0x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),value=>value.toString(16).padStart(2,'0')).join('')}`;}
/** Reconstruct only the reviewed typed-data shape. Never sign arbitrary server types or domains. */
export async function signBrainchainPurchase(order:BrainchainBuyerOrder,raw:unknown){
 const {intent,payment}=z.object({intent:intentSchema,payment:paymentSchema}).strict().parse(raw);
 if(JSON.stringify(intent.types)!==JSON.stringify({PurchaseIntent:intentFields})||JSON.stringify(payment.types)!==JSON.stringify({TransferWithAuthorization:paymentFields}))throw new Error('The signature request has an unsupported format.');
 const endpoint=await digest(lane.endpoint);
 if(!order.payer||order.environment!=='testnet'||order.chainId!==lane.chainId||order.state!=='reserved'||intent.domain.salt!==endpoint||intent.message.endpointHash!==endpoint||intent.message.order!==await digest(order.id)||intent.message.bodyHash!==`0x${order.bodyHash}`||intent.message.payer.toLowerCase()!==order.payer||payment.message.from.toLowerCase()!==order.payer||intent.message.paymentNonce!==payment.message.nonce||intent.message.validBefore!==payment.message.validBefore||Number(payment.message.validBefore)*1000!==Date.parse(order.authorizationExpiresAt??''))throw new Error('The signature request does not match this purchase.');
 const wallet=provider();
 async function sign(value:typeof intent|typeof payment){
  if(Number(payment.message.validBefore)*1000<=Date.now()+5000)throw new Error('The purchase authorization expired. Its hold remains reserved.');
  const accounts=z.array(address).parse(await wallet.request({method:'eth_accounts'}));if(accounts[0]?.toLowerCase()!==order.payer||await wallet.request({method:'eth_chainId'})!=='0x14a34')throw new Error('The payer account or test network changed.');
  const domainFields=[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},...('salt'in value.domain?[{name:'salt',type:'bytes32'}]:[{name:'verifyingContract',type:'address'}])];
  return z.string().regex(/^0x[0-9a-fA-F]{130}$/).parse(await wallet.request({method:'eth_signTypedData_v4',params:[order.payer,JSON.stringify({...value,types:{EIP712Domain:domainFields,...value.types}})]}));
 }
 return {intentSignature:await sign(intent),paymentSignature:await sign(payment)};
}
