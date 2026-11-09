import { decodeAbiParameters, decodeEventLog, encodeFunctionData, hashDomain, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { BUYER_LANE, BrainchainPurchaseError, buyerHash, type BuyerTerms } from './purchase-policy';
import { validateOutboundUrlResolved } from '../hatcher-config';
const quantity=z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const data=z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const tokenAbi=parseAbi(['function name() view returns (string)','function decimals() view returns (uint8)','function DOMAIN_SEPARATOR() view returns (bytes32)','function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)','event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const blockSchema=z.object({number:quantity,hash:buyerHash,timestamp:quantity});
const logSchema=z.object({address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),topics:z.array(buyerHash).max(4),data,logIndex:quantity,removed:z.boolean().optional()});
const receiptSchema=z.object({transactionHash:buyerHash,status:quantity,blockNumber:quantity,blockHash:buyerHash,logs:z.array(logSchema).max(1000)});
export interface BuyerReceiptEvidence { transaction:string;logIndex:number;blockNumber:string;blockHash:string;observedAt:string;headNumber:string;headHash:string;headTimestamp:string;provisional:true }
/** Fixed Base Sepolia reads. No send/sign/URL override exists. */
export class BrainchainBuyerReceipts {
  private id=0;
  constructor(private readonly dependencies:{fetch?:typeof fetch;validateUrl?:typeof validateOutboundUrlResolved}={}){}
  private async rpc(method:'eth_chainId'|'eth_getBlockByNumber'|'eth_getTransactionReceipt'|'eth_call'|'eth_getCode',params:unknown[]=[]):Promise<unknown>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},5000);});
    const work=async()=>{const approved=await(this.dependencies.validateUrl??validateOutboundUrlResolved)(BUYER_LANE.rpc);if(!approved.ok||controller.signal.aborted)throw new Error('refused');
      const id=++this.id,response=await(this.dependencies.fetch??fetch)(BUYER_LANE.rpc,{method:'POST',redirect:'manual',credentials:'omit',signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      if(response.status!==200||response.redirected||!response.body||!response.headers.get('content-type')?.startsWith('application/json'))throw new Error('bad response');
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262144)throw new Error('large');chunks.push(part.value);}}
      finally{controller.signal.removeEventListener('abort',cancel);if(size>262144)void reader.cancel().catch(()=>{});reader.releaseLock();}
      const envelope=z.object({jsonrpc:z.literal('2.0'),id:z.literal(id),result:z.unknown(),error:z.unknown().optional()}).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
      if(envelope.error!==undefined||!('result'in envelope))throw new Error('rpc');return envelope.result;};
    try{return await Promise.race([work(),timeout]);}catch{throw new BrainchainPurchaseError('receipt_unavailable');}finally{clearTimeout(timer);controller.abort();}
  }
  private async chain(){if(BigInt(quantity.parse(await this.rpc('eth_chainId')))!==BigInt(BUYER_LANE.chainId))throw new BrainchainPurchaseError('receipt_unavailable');}
  private async call(functionName:'name'|'decimals'|'DOMAIN_SEPARATOR'|'balanceOf',at:string,args?:readonly Address[]){
    const request=encodeFunctionData({abi:tokenAbi,functionName,args} as Parameters<typeof encodeFunctionData>[0]);return data.parse(await this.rpc('eth_call',[{to:BUYER_LANE.token,data:request},at])) as Hex;
  }
  async verifyPayer(payer:string):Promise<void>{await this.chain();const head=blockSchema.parse(await this.rpc('eth_getBlockByNumber',['latest',false]));
    const [name,decimals,separator,code,balance]=await Promise.all([this.call('name',head.number),this.call('decimals',head.number),this.call('DOMAIN_SEPARATOR',head.number),this.rpc('eth_getCode',[payer,head.number]),this.call('balanceOf',head.number,[payer as Address])]);
    const domain=hashDomain({types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]},domain:{name:BUYER_LANE.domainName,version:BUYER_LANE.domainVersion,chainId:BigInt(BUYER_LANE.chainId),verifyingContract:BUYER_LANE.token}});
    if(decodeAbiParameters(parseAbiParameters('string'),name)[0]!==BUYER_LANE.domainName||decodeAbiParameters(parseAbiParameters('uint8'),decimals)[0]!==BUYER_LANE.decimals
      ||decodeAbiParameters(parseAbiParameters('bytes32'),separator)[0].toLowerCase()!==domain.toLowerCase()||data.parse(code)!=='0x'
      ||decodeAbiParameters(parseAbiParameters('uint256'),balance)[0]<BigInt(BUYER_LANE.amountAtomic))throw new BrainchainPurchaseError('invalid_proof');
    const final=blockSchema.parse(await this.rpc('eth_getBlockByNumber',[head.number,false]));const age=Date.now()/1000-Number(BigInt(final.timestamp));if(final.hash!==head.hash||final.number!==head.number||age<0||age>120)throw new BrainchainPurchaseError('receipt_unavailable');
  }
  async verify(transaction:string,terms:BuyerTerms,kind:'payment'|'refund',afterBlock?:bigint):Promise<BuyerReceiptEvidence>{
    buyerHash.parse(transaction);await this.chain();const receipt=receiptSchema.parse(await this.rpc('eth_getTransactionReceipt',[transaction]));
    if(receipt.transactionHash!==transaction||BigInt(receipt.status)!==1n|| (kind==='refund'&&(afterBlock===undefined||BigInt(receipt.blockNumber)<=afterBlock)))throw new BrainchainPurchaseError('receipt_unavailable');
    let transfer: z.infer<typeof logSchema>|undefined,authorization=false;
    for(const log of receipt.logs){if(log.removed||log.address.toLowerCase()!==BUYER_LANE.token)continue;
      try{const parsed=decodeEventLog({abi:tokenAbi,data:log.data as Hex,topics:log.topics as [Hex,...Hex[]],strict:true});
        if(parsed.eventName==='AuthorizationUsed'&&log.topics.length===3&&log.data==='0x'&&parsed.args.authorizer.toLowerCase()===terms.payer&&parsed.args.nonce===terms.paymentNonce)authorization=true;
        if(parsed.eventName==='Transfer'&&log.topics.length===3&&parsed.args.from.toLowerCase()===(kind==='payment'?terms.payer:BUYER_LANE.recipient)
          &&parsed.args.to.toLowerCase()===(kind==='payment'?BUYER_LANE.recipient:terms.payer)&&parsed.args.value===BigInt(BUYER_LANE.amountAtomic)){
          if(transfer)throw new BrainchainPurchaseError('receipt_unavailable');transfer=log;}
      }catch(error){if(error instanceof BrainchainPurchaseError)throw error;}
    }
    if(!transfer||(kind==='payment'&&!authorization))throw new BrainchainPurchaseError('receipt_unavailable');
    await this.chain();
    const head=blockSchema.parse(await this.rpc('eth_getBlockByNumber',['latest',false]));
    const canonical=blockSchema.parse(await this.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]));
    const now=Date.now(),age=Math.floor(now/1000)-Number(BigInt(head.timestamp));
    if(canonical.hash!==receipt.blockHash||canonical.number!==receipt.blockNumber||BigInt(head.number)<BigInt(receipt.blockNumber)+12n||age<0||age>120)throw new BrainchainPurchaseError('receipt_unavailable');
    const index=BigInt(transfer.logIndex);if(index>BigInt(Number.MAX_SAFE_INTEGER))throw new BrainchainPurchaseError('receipt_unavailable');
    return {transaction,logIndex:Number(index),blockNumber:BigInt(receipt.blockNumber).toString(),blockHash:receipt.blockHash,observedAt:new Date(now).toISOString(),headNumber:BigInt(head.number).toString(),headHash:head.hash,headTimestamp:BigInt(head.timestamp).toString(),provisional:true};
  }
}
