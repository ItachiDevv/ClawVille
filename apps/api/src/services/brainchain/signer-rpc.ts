import {readConfiguredAuthority} from './configured-authority';
import {keccak256,parseTransaction,toHex,type Hex} from 'viem';
import {z} from 'zod';
import {validateOutboundUrlResolved} from '../hatcher-config';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {assertSignerActivation,BrainChainSignerError} from './signer-policy';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import type {TestnetBroadcastTransport} from './signer-service';
import {LEGACY_WORKER_POLICY,workerObservationFresh,type WorkerObservationPolicy} from './worker-observation-policy';

const quantity=z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/),hash=z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const block=z.object({number:quantity,hash,timestamp:quantity});
const receipt=z.object({transactionHash:hash,blockHash:hash,blockNumber:quantity,status:z.enum(['0x0','0x1']),
  gasUsed:quantity,effectiveGasPrice:quantity});
export type SignerReceiptObservation={state:'pending'|'orphaned'|'included';transactionHash:Hex;observedAt:string;provisional:true;
  blockNumber?:string;blockHash?:string;successful?:boolean;confirmations?:string;gasUsed?:string;effectiveGasPrice?:string};
export interface FixedTestnetTransport extends TestnetBroadcastTransport {
  receipt(transactionHash:Hex):Promise<SignerReceiptObservation>;
  nonces(address:Hex):Promise<{canonical:bigint;pending:bigint}>;
}
/** Fixed host, no credentials, no retries. Overrides are trusted test dependencies, never HTTP parameters. */
export function createFixedTestnetTransport(overrides:{fetch?:typeof fetch;validateUrl?:typeof validateOutboundUrlResolved;timeoutMs?:number}={},policy:WorkerObservationPolicy=LEGACY_WORKER_POLICY):FixedTestnetTransport{
  const url=BRAINCHAIN_CONTRACTS.testnet.rpc;let nextId=0;
  async function rpc(method:string,params:unknown[],deadline:number,beforeFetch?:()=>Promise<void>):Promise<unknown>{
    const controller=new AbortController(),remaining=Math.min(overrides.timeoutMs??5000,deadline-Date.now());
    if(remaining<=0)throw new BrainChainSignerError('RPC session deadline');
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BrainChainSignerError('RPC deadline'));},remaining);});
    const work=async()=>{
      const validation=await(overrides.validateUrl??validateOutboundUrlResolved)(url);
      if(!validation.ok||controller.signal.aborted)throw new BrainChainSignerError('Testnet RPC host refused');
      const id=++nextId;
      await beforeFetch?.(); // Recheck send authority after asynchronous URL validation, immediately before dispatch.
      if(controller.signal.aborted||Date.now()>=deadline)throw new BrainChainSignerError('RPC deadline');
      const response=await(overrides.fetch??fetch)(url,{method:'POST',redirect:'manual',credentials:'omit',signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      if(response.status!==200||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')||!response.body){await response.body?.cancel();throw new BrainChainSignerError('RPC response refused');}
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>262144){await reader.cancel();throw new BrainChainSignerError('RPC response too large');}chunks.push(item.value);}}
      finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
      if(controller.signal.aborted)throw new BrainChainSignerError('RPC canceled');
      const body=Buffer.concat(chunks),parsed=z.object({jsonrpc:z.literal('2.0'),id:z.literal(id),result:z.unknown(),error:z.unknown().optional()})
        .parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
      if(parsed.error!==undefined||!('result' in parsed))throw new BrainChainSignerError('RPC method refused');
      return parsed.result;
    };
    try{return await Promise.race([work(),timeout]);}catch{throw new BrainChainSignerError('Fixed testnet RPC unavailable');}finally{clearTimeout(timer);controller.abort();}
  }
  async function chain(deadline:number){if(BigInt(quantity.parse(await rpc('eth_chainId',[],deadline)))!==274630n)throw new BrainChainSignerError('Testnet chain mismatch');}
  async function getBlock(number:bigint,deadline:number){const result=block.parse(await rpc('eth_getBlockByNumber',[toHex(number),false],deadline));if(BigInt(result.number)!==number)throw new BrainChainSignerError('Block mismatch');return result;}
  function assertFreshHead(timestamp:string,acquiredAt:number){
    if(!workerObservationFresh({observedAt:new Date(acquiredAt),blockTimestamp:BigInt(timestamp),observationPolicy:policy}))
      throw new BrainChainSignerError('Fresh testnet head required');
  }
  async function verifiedHead(){
    const acquiredAt=Date.now(),deadline=acquiredAt+30000;await chain(deadline);
    const head=BigInt(quantity.parse(await rpc('eth_blockNumber',[],deadline))),at=await getBlock(head,deadline);
    assertFreshHead(at.timestamp,acquiredAt);
    for(const [address,expected] of Object.entries(TESTNET_SIGNER_CODE_EVIDENCE.contracts)){
      const code=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/).parse(await rpc('eth_getCode',[address,at.number],deadline)) as Hex;
      if(keccak256(code)!==expected)throw new BrainChainSignerError('Pinned testnet bytecode mismatch');
    }
    await readConfiguredAuthority((method,params)=>rpc(method,params,deadline),at,new Date(acquiredAt),policy,{deadlineMs:deadline});
    const final=await getBlock(head,deadline);
    if(final.hash.toLowerCase()!==at.hash.toLowerCase()||final.timestamp!==at.timestamp)throw new BrainChainSignerError('Testnet head changed during verification');
    assertFreshHead(final.timestamp,acquiredAt);
    return {...final,acquiredAt};
  }
  return{
    async assertTestnet(){await verifiedHead();},
    async broadcastSameBytes(bytes,assertCurrent){
      assertSignerActivation(); // Even a direct transport call cannot bypass the inactive gate.
      if(typeof assertCurrent!=='function')throw new BrainChainSignerError('Current broadcast authority required');
      const transaction=parseTransaction(bytes);
      if(transaction.type!=='eip1559'||transaction.chainId!==274630||!transaction.r||!transaction.s||bytes.length>16386)throw new BrainChainSignerError('Signed testnet payload required');
      const at=await verifiedHead();
      const expected=keccak256(bytes),result=hash.parse(await rpc('eth_sendRawTransaction',[bytes],Math.min(at.acquiredAt+30000,Date.now()+5000),async()=>{
        // The final anchor follows URL validation and all dependent reads. No later await may widen authority.
        const final=await getBlock(BigInt(at.number),at.acquiredAt+30000);
        if(final.hash.toLowerCase()!==at.hash.toLowerCase()||final.timestamp!==at.timestamp)throw new BrainChainSignerError('Testnet head changed before dispatch');
        await assertCurrent();
        assertFreshHead(final.timestamp,at.acquiredAt);
      })).toLowerCase();
      if(result!==expected)throw new BrainChainSignerError('Broadcast hash mismatch');
      return expected;
    },
    async nonces(address){
      if(!/^0x[a-fA-F0-9]{40}$/.test(address))throw new BrainChainSignerError('Invalid signer address');
      const deadline=Date.now()+15000;await chain(deadline);
      const canonical=BigInt(quantity.parse(await rpc('eth_getTransactionCount',[address,'latest'],deadline)));
      const pending=BigInt(quantity.parse(await rpc('eth_getTransactionCount',[address,'pending'],deadline)));
      if(canonical>pending||pending>=2n**64n)throw new BrainChainSignerError('Invalid signer nonce observation');
      return{canonical,pending};
    },
    async receipt(transactionHash){
      hash.parse(transactionHash);const deadline=Date.now()+20000;await chain(deadline);
      const raw=await rpc('eth_getTransactionReceipt',[transactionHash],deadline);
      const base={transactionHash,observedAt:new Date().toISOString(),provisional:true as const};
      if(raw===null)return{...base,state:'pending'};
      const found=receipt.parse(raw);
      if(found.transactionHash.toLowerCase()!==transactionHash.toLowerCase())throw new BrainChainSignerError('Receipt transaction mismatch');
      const number=BigInt(found.blockNumber),canonical=await getBlock(number,deadline);
      if(canonical.hash.toLowerCase()!==found.blockHash.toLowerCase())return{...base,state:'orphaned',blockNumber:number.toString(),blockHash:found.blockHash};
      const head=BigInt(quantity.parse(await rpc('eth_blockNumber',[],deadline)));
      if(head<number)throw new BrainChainSignerError('Receipt is ahead of head');
      if((await getBlock(number,deadline)).hash.toLowerCase()!==found.blockHash.toLowerCase())return{...base,state:'orphaned',blockNumber:number.toString(),blockHash:found.blockHash};
      return{...base,state:'included',blockNumber:number.toString(),blockHash:found.blockHash,successful:found.status==='0x1',confirmations:(head-number+1n).toString(),gasUsed:BigInt(found.gasUsed).toString(),effectiveGasPrice:BigInt(found.effectiveGasPrice).toString()};
    },
  };
}
