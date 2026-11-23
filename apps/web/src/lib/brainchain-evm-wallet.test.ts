import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {BRAINCHAIN_BUYER_LANE as lane,type BrainchainBuyerOrder} from '@clawville/shared';
import {connectBrainchainPayer,signBrainchainPurchase} from './brainchain-evm-wallet';
const payer=`0x${'1'.repeat(40)}`,id='00000000-0000-4000-8000-000000000001';
const digest=(value:string)=>`0x${createHash('sha256').update(value).digest('hex')}`;
function fixture(){const expiry=String(Math.floor(Date.now()/1000)+200),nonce=`0x${'2'.repeat(64)}`;
 const field=(name:string,type:string)=>({name,type});
 const order={id,environment:'testnet',chainId:84532,state:'reserved',bodyHash:'a'.repeat(64),payer,authorizationExpiresAt:new Date(Number(expiry)*1000).toISOString()} as BrainchainBuyerOrder;
 const payment={domain:{name:'USDC',version:'2',chainId:84532,verifyingContract:lane.token},primaryType:'TransferWithAuthorization',types:{TransferWithAuthorization:[field('from','address'),field('to','address'),field('value','uint256'),field('validAfter','uint256'),field('validBefore','uint256'),field('nonce','bytes32')]},message:{from:payer,to:lane.recipient,value:'1000000',validAfter:String(Number(expiry)-300),validBefore:expiry,nonce}};
 const intent={domain:{name:'ClawVille BrainChain Purchase',version:'1',chainId:84532,salt:digest(lane.endpoint)},primaryType:'PurchaseIntent',types:{PurchaseIntent:[field('order','bytes32'),field('avatar','bytes32'),field('bodyHash','bytes32'),field('quoteHash','bytes32'),field('endpointHash','bytes32'),field('token','address'),field('recipient','address'),field('payer','address'),field('amount','uint256'),field('permanentAvatarBinding','bool'),field('paymentNonce','bytes32'),field('intentNonce','bytes32'),field('validBefore','uint256')]},message:{order:digest(id),avatar:digest('fixture-avatar'),bodyHash:`0x${order.bodyHash}`,quoteHash:digest('quote'),endpointHash:digest(lane.endpoint),token:lane.token,recipient:lane.recipient,payer,amount:'1000000',permanentAvatarBinding:true,paymentNonce:nonce,intentNonce:digest('nonce'),validBefore:expiry}};
 return {order,typed:{intent,payment}};
}
test('browser payer refuses mismatched domains, amounts, bodies and arbitrary types before a signature',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let signatures=0;
 Object.defineProperty(globalThis,'window',{configurable:true,value:{ethereum:{request:async(input:{method:string;params?:unknown[]})=>{if(input.method==='eth_chainId')return '0x14a34';if(input.method==='eth_accounts'||input.method==='eth_requestAccounts')return [payer];if(input.method==='eth_signTypedData_v4'){signatures++;expect(input.params?.[0]).toBe(payer);return `0x${'11'.repeat(65)}`;}throw new Error('Unexpected wallet method');}}}});
 try{expect(await connectBrainchainPayer()).toBe(payer);const valid=fixture();await signBrainchainPurchase(valid.order,valid.typed);expect(signatures).toBe(2);
  for(const tamper of [(f:ReturnType<typeof fixture>)=>{f.typed.payment.domain.chainId=8453;},(f:ReturnType<typeof fixture>)=>{f.typed.payment.message.value='2000000';},(f:ReturnType<typeof fixture>)=>{f.typed.intent.message.bodyHash=digest('other');},(f:ReturnType<typeof fixture>)=>{f.typed.payment.types.TransferWithAuthorization.push({name:'extra',type:'address'});}]){const f=fixture();tamper(f);let refused=false;try{await signBrainchainPurchase(f.order,f.typed);}catch{refused=true;}expect(refused).toBe(true);}
  expect(signatures).toBe(2);
 }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
