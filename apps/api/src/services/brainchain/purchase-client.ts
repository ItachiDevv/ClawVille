import { z } from 'zod';
import { SOLANA_BUYER_LANE, selectSolanaBuyerQuote, solanaBuyerSignature } from './purchase-solana-policy';
import { BUYER_LANE, BrainchainPurchaseError, buyerHash, canonical, selectBuyerQuote, type BuyerQuote, type BuyerTaskBody } from './purchase-policy';
import { validateOutboundUrlResolved } from '../hatcher-config';
export const buyerRemoteOrderSchema = z.object({
  order: buyerHash, state: z.enum(['paying','unconfirmed','failed','paid','posting','posted','paid-out','refunding','refunded','refund-failed']).optional(),
  network: z.enum([BUYER_LANE.network,SOLANA_BUYER_LANE.network]).optional(), paymentTx: z.union([buyerHash,solanaBuyerSignature]).optional(), refundTx: z.union([buyerHash,solanaBuyerSignature]).optional(),
  taskId: z.union([z.string().regex(/^[1-9][0-9]{0,77}$/),z.number().int().positive().safe()]).transform(String).optional(),
  board: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value=>value.toLowerCase()).optional(),
  task: z.object({ status: z.string().regex(/^[a-z-]{1,24}$/), board: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value=>value.toLowerCase()).optional() }).passthrough().optional(),
  status: z.string().max(200).optional(),
}).passthrough();
export type BuyerRemoteOrder = z.infer<typeof buyerRemoteOrderSchema>;
export class BrainchainPurchaseClient {
  private readonly fetcher: typeof fetch;
  private readonly validate: typeof validateOutboundUrlResolved;
  constructor(dependencies: { fetch?: typeof fetch; validateUrl?: typeof validateOutboundUrlResolved } = {}) {
    this.fetcher = dependencies.fetch ?? fetch; this.validate = dependencies.validateUrl ?? validateOutboundUrlResolved;
  }
  private async request(path: string, method: 'GET'|'POST', body?: string, payment?: string,beforeDispatch?:()=>Promise<void>): Promise<{status:number;json:unknown;challenge?:unknown}> {
    const url = `${BUYER_LANE.origin}${path}`, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_,reject)=>{ timer=setTimeout(()=>{controller.abort();reject(new BrainchainPurchaseError('purchase_unavailable'));},8000); });
    const operation = async () => {
      const approved = await this.validate(url); if(!approved.ok||controller.signal.aborted)throw new Error('refused');
      if(payment){if(!beforeDispatch)throw new Error('missing dispatch fence');await beforeDispatch();if(controller.signal.aborted)throw new Error('expired');}
      const response=await this.fetcher(url,{method,redirect:'manual',credentials:'omit',signal:controller.signal,
        headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(payment?{'PAYMENT-SIGNATURE':payment}:{})},...(body?{body}:{})});
      if(response.redirected || (response.url&&response.url!==url))throw new Error('redirect');
      let challenge:unknown;
      if(response.status===402){const raw=response.headers.get('PAYMENT-REQUIRED');if(raw){if(raw.length>90000||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))throw new Error('invalid');
        const bytes=Buffer.from(raw,'base64');if(bytes.byteLength>65536||bytes.toString('base64')!==raw)throw new Error('invalid');challenge=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}}
      if(!response.body)return {status:response.status,json:null,challenge};
      if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body.cancel();throw new Error('invalid');}
      const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw new Error('large');chunks.push(part.value);}}
      finally{controller.signal.removeEventListener('abort',cancel);if(bytes>65536)void reader.cancel().catch(()=>{});reader.releaseLock();}
      const joined=Buffer.concat(chunks);return {status:response.status,json:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)),challenge};
    };
    try{return await Promise.race([operation(),stopped]);}catch{throw new BrainchainPurchaseError('purchase_unavailable');}finally{clearTimeout(timer);controller.abort();}
  }
  async quote(body:BuyerTaskBody,network:string=BUYER_LANE.network):Promise<BuyerQuote>{const response=await this.request('/x402/tasks','POST',canonical(body));if(response.status!==402)throw new BrainchainPurchaseError('quote_refused');return network===SOLANA_BUYER_LANE.network?selectSolanaBuyerQuote(response.challenge):selectBuyerQuote(response.challenge);}
  async send(body:BuyerTaskBody,header:string,beforeDispatch:()=>Promise<void>):Promise<BuyerRemoteOrder>{const response=await this.request('/x402/tasks','POST',canonical(body),header,beforeDispatch);if(response.status<200||response.status>=300)throw new BrainchainPurchaseError('payment_uncertain');
    const parsed=buyerRemoteOrderSchema.safeParse(response.json);if(!parsed.success)throw new BrainchainPurchaseError('payment_uncertain');return parsed.data;}
  async order(order:string):Promise<BuyerRemoteOrder>{buyerHash.parse(order);const response=await this.request(`/x402/tasks/${order}`,'GET');if(response.status!==200)throw new BrainchainPurchaseError('purchase_unavailable');
    const parsed=buyerRemoteOrderSchema.safeParse(response.json);if(!parsed.success||parsed.data.order!==order)throw new BrainchainPurchaseError('order_conflict');return parsed.data;}
}
