import { describe,expect,test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { BUYER_LANE, canonical,buyerDigest,buyerPaymentHeader,buyerTypedData,createBuyerTerms,purchaseBodySchema,selectBuyerQuote,verifyBuyerSignatures } from './purchase-policy';
import { BrainchainPurchaseClient } from './purchase-client';
const account=privateKeyToAccount(`0x${'12'.repeat(32)}`);
export function purchaseChallenge(){return {x402Version:2,resource:{url:String(BUYER_LANE.endpoint),mimeType:'application/json'},accepts:[{scheme:'exact',network:BUYER_LANE.network,amount:BUYER_LANE.amountAtomic,asset:BUYER_LANE.token,payTo:BUYER_LANE.recipient,maxTimeoutSeconds:300,extra:{name:'USDC',version:'2'}}]};}
const body={title:'Summarize public data',brief:'Return the two public values.',levels:['incorrect','correct']};
describe('BrainChain testnet payer policy',()=>{
 test('selects the pinned quote and refuses different authority fields',()=>{
  expect(selectBuyerQuote(purchaseChallenge()).requirement.network).toBe('eip155:84532');
  for(const change of [{amount:'1'},{payTo:account.address},{extra:{name:'USD Coin',version:'2'}},{extra:{name:'USDC',version:'1'}},{maxTimeoutSeconds:301},{network:'eip155:8453'},{asset:account.address}]){
   const raw=purchaseChallenge();Object.assign(raw.accepts[0]!,change);expect(()=>selectBuyerQuote(raw)).toThrow();
  }
  const duplicated=purchaseChallenge();duplicated.accepts.push({...duplicated.accepts[0]!});expect(()=>selectBuyerQuote(duplicated)).toThrow();
  const wrong=purchaseChallenge();wrong.resource.url='https://example.com/tasks';expect(()=>selectBuyerQuote(wrong)).toThrow();
 });
 test('enforces public task byte and shape limits',()=>{
  expect(purchaseBodySchema.parse(body)).toEqual(body);
  for(const change of [{title:'one\ntwo'},{brief:'x'.repeat(32001)},{brief:'\u{1f980}'.repeat(16000)},{levels:['same','same']},{levels:['one']},{passIndex:1}])expect(purchaseBodySchema.safeParse({...body,...change}).success).toBe(false);
 });
 test('both signatures bind the exact owner, body, quote, nonce and token domain',async()=>{
  const quote=selectBuyerQuote(purchaseChallenge());
  const terms=createBuyerTerms({orderId:'6c8d8bd0-4381-4b21-9033-f6eff392a8db',avatarId:'64580794-0787-4e28-b882-ec026e0c056f',payer:account.address.toLowerCase(),bodyHash:buyerDigest(body),quoteHash:quote.hash},quote);
  const typed=buyerTypedData(terms),intent=await account.signTypedData(typed.intent),payment=await account.signTypedData(typed.payment);
  await verifyBuyerSignatures(terms,intent,payment);
  for(const changed of [{avatarId:terms.orderId},{bodyHash:'ab'.repeat(32)},{quoteHash:'ac'.repeat(32)},{paymentNonce:`0x${'11'.repeat(32)}` as const},{validBefore:String(Number(terms.validBefore)+1)}]){
   let refused=false;try{await verifyBuyerSignatures({...terms,...changed},intent,payment);}catch{refused=true;}expect(refused).toBe(true);
  }
  const foreign=await account.signTypedData({...typed.payment,domain:{...typed.payment.domain,chainId:8453}});
  let refused=false;try{await verifyBuyerSignatures(terms,intent,foreign);}catch{refused=true;}expect(refused).toBe(true);
  const header=JSON.parse(Buffer.from(buyerPaymentHeader(terms,quote,payment),'base64').toString());
  expect(header.accepted).toEqual(quote.requirement);expect(header.resource).toEqual(quote.resource);expect(header.payload.authorization.nonce).toBe(terms.paymentNonce);
  expect(JSON.stringify(typed)).not.toContain('privateKey');
 });
 test('HTTP quote is unsigned, fixed-origin and contains the exact task body',async()=>{
  let calls=0;const client=new BrainchainPurchaseClient({validateUrl:async(url)=>({ok:true,url}),fetch:(async(url: string | URL | Request,init?:RequestInit)=>{
   calls++;expect(url).toBe(BUYER_LANE.endpoint);expect(init?.redirect).toBe('manual');expect(init?.credentials).toBe('omit');expect(init?.body).toBe(canonical(body));expect(new Headers(init?.headers).has('PAYMENT-SIGNATURE')).toBe(false);
   return new Response('{}',{status:402,headers:{'content-type':'application/json','PAYMENT-REQUIRED':Buffer.from(JSON.stringify(purchaseChallenge())).toString('base64')}});
  }) as unknown as typeof fetch});
  await client.quote(body);expect(calls).toBe(1);
 });
 test('unknown or duplicate remote receipts never become a successful local order',async()=>{
  let calls=0;const client=new BrainchainPurchaseClient({validateUrl:async(url)=>({ok:true,url}),fetch:(async()=>{calls++;return new Response('{}',{status:202,headers:{'content-type':'application/json'}});}) as unknown as typeof fetch});
  let refused=false;try{await client.send(body,'opaque fixture',async()=>{});}catch{refused=true;}expect(refused).toBe(true);expect(calls).toBe(1);
 });
});

test('signed dispatch rechecks authority after DNS before any paid fetch',async()=>{
 let reads=0,calls=0;const client=new BrainchainPurchaseClient({validateUrl:async url=>{reads++;return {ok:true,url};},fetch:(async()=>{calls++;throw new Error('must not dispatch');})as unknown as typeof fetch});
 let refused=false;try{await client.send(body,'controlled-header',async()=>{expect(reads).toBe(1);throw new Error('expired authority');});}catch{refused=true;}
 expect(refused).toBe(true);expect(calls).toBe(0);
});
