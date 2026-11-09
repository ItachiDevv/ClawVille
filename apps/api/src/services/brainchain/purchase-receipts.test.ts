import {expect,test} from 'bun:test';
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,hashDomain,parseAbi,toHex,type Hex} from 'viem';
import {BrainchainBuyerReceipts} from './purchase-receipts';
import {BUYER_LANE,type BuyerTerms} from './purchase-policy';
const payer='0x1111111111111111111111111111111111111111',transaction=`0x${'ab'.repeat(32)}`,blockHash=`0x${'cd'.repeat(32)}`;
const terms:BuyerTerms={orderId:'6c8d8bd0-4381-4b21-9033-f6eff392a8db',avatarId:'64580794-0787-4e28-b882-ec026e0c056f',payer,bodyHash:'11'.repeat(32),quoteHash:'22'.repeat(32),intentNonce:`0x${'33'.repeat(32)}`,paymentNonce:`0x${'44'.repeat(32)}`,validAfter:'1',validBefore:'9999999999'};
const abi=parseAbi(['function name() view returns (string)','function decimals() view returns (uint8)','function DOMAIN_SEPARATOR() view returns (bytes32)','function balanceOf(address) view returns (uint256)','event Transfer(address indexed from,address indexed to,uint256 value)','event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
function fixture(){const control={chain:84532,name:'USDC',decimals:6,code:'0x',value:1000000n,canonical:true,confirmations:12,authorization:true,refund:false,age:0,domain:true};
 const client=new BrainchainBuyerReceipts({validateUrl:async url=>({ok:true,url}),fetch:(async(url,init)=>{
  expect(url).toBe(BUYER_LANE.rpc);expect(init?.redirect).toBe('manual');const request=JSON.parse(String(init?.body));let result:unknown;
  if(request.method==='eth_chainId')result=toHex(control.chain);
  else if(request.method==='eth_getCode')result=control.code;
  else if(request.method==='eth_getBlockByNumber'){const latest=request.params[0]==='latest';result={number:latest?toHex(100+control.confirmations):request.params[0],hash:control.canonical||latest?blockHash:`0x${'ef'.repeat(32)}`,timestamp:toHex(Math.floor(Date.now()/1000)-control.age)};}
  else if(request.method==='eth_call'){const data=request.params[0].data;
   if(data===encodeFunctionData({abi,functionName:'name'}))result=encodeAbiParameters([{type:'string'}],[control.name]);
   else if(data===encodeFunctionData({abi,functionName:'decimals'}))result=encodeAbiParameters([{type:'uint8'}],[control.decimals]);
   else if(data===encodeFunctionData({abi,functionName:'DOMAIN_SEPARATOR'}))result=encodeAbiParameters([{type:'bytes32'}],[hashDomain({types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]},domain:{name:control.domain?'USDC':'Other',version:'2',chainId:84532n,verifyingContract:BUYER_LANE.token}})]);
   else result=encodeAbiParameters([{type:'uint256'}],[1000000n]);
  }else if(request.method==='eth_getTransactionReceipt')result={transactionHash:transaction,status:'0x1',blockNumber:'0x64',blockHash,logs:[{address:BUYER_LANE.token,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:control.refund?BUYER_LANE.recipient:payer,to:control.refund?payer:BUYER_LANE.recipient}}),data:encodeAbiParameters([{type:'uint256'}],[control.value]),logIndex:'0x1'},...(control.authorization?[{address:BUYER_LANE.token,topics:encodeEventTopics({abi,eventName:'AuthorizationUsed',args:{authorizer:payer,nonce:terms.paymentNonce}}),data:'0x',logIndex:'0x2'}]:[])]};
  else throw new Error('Unexpected RPC');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 }) as typeof fetch});return {client,control};}
async function refused(action:()=>Promise<unknown>){let error:unknown;try{await action();}catch(cause){error=cause;}expect(error).toBeDefined();}
test('payer metadata verifies actual token name, decimals, domain, EOA and network',async()=>{const f=fixture();await f.client.verifyPayer(payer);for(const change of [{chain:8453},{name:'USD Coin'},{decimals:18},{domain:false},{code:'0x01'},{canonical:false},{age:121}]){const other=fixture();Object.assign(other.control,change);await refused(()=>other.client.verifyPayer(payer));}});
test('payment receipt requires exact transfer, authorization, canonical hash and twelve confirmations',async()=>{const f=fixture();expect((await f.client.verify(transaction,terms,'payment')).provisional).toBe(true);for(const change of [{chain:8453},{value:999999n},{authorization:false},{canonical:false},{confirmations:11},{age:121},{age:-10}]){const other=fixture();Object.assign(other.control,change);await refused(()=>other.client.verify(transaction,terms,'payment'));}});
test('refund requires a full desk-to-payer transfer strictly after the payment block',async()=>{const f=fixture();f.control.refund=true;f.control.authorization=false;expect((await f.client.verify(transaction,terms,'refund',99n)).blockNumber).toBe('100');await refused(()=>f.client.verify(transaction,terms,'refund',100n));f.control.value=500000n;await refused(()=>f.client.verify(transaction,terms,'refund',99n));});
