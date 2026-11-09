import {createHash} from 'node:crypto';
import {encodeFunctionData,keccak256,parseAbi,type Hex} from 'viem';
import {z} from 'zod';
import {validateOutboundUrlResolved} from '../hatcher-config';
import {assertSignerActivation} from './signer-policy';
import {resultUploadMessage} from './result-signing-message';
export {resultUploadMessage} from './result-signing-message';

export class TaskDeliveryError extends Error {readonly code='task_delivery_refused';}
export const RESULT_SERVICE='https://brain.testnet.usebrainchain.com';
export function resultDigests(text:string){
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length<1||bytes.length>32768||bytes.toString('utf8')!==text||text.includes('\0'))throw new TaskDeliveryError('Invalid exact result bytes');
  return{sha256:createHash('sha256').update(bytes).digest('hex'),hash:keccak256(bytes)};
}
export function validateResultUri(uri:string,hash:string){
  if(!/^0x[a-f0-9]{64}$/.test(hash)||uri!==`${RESULT_SERVICE}/records/${hash}.txt`)throw new TaskDeliveryError('Unexpected result URI');
  return uri;
}
export function resultSubmission(board:string,task:string,hash:Hex,uri:string){
  resultUploadMessage(board,task,hash);validateResultUri(uri,hash);
  return{chainId:274630 as const,to:board,value:'0' as const,data:encodeFunctionData({abi:parseAbi(['function submit(uint256 id,bytes32 resultHash,string resultURI)']),functionName:'submit',args:[BigInt(task),hash,uri]})};
}
export interface ResultUploadTransport {upload(input:Readonly<{task:string;text:string;signature:Hex;hash:Hex}>):Promise<{uri:string;hash:Hex}>;}
/** Official worker b71f3b chain.ts:412-435. No URI returned by the service is fetched. */
export function createResultUploadTransport(overrides:{fetch?:typeof fetch;validateUrl?:typeof validateOutboundUrlResolved}={}):ResultUploadTransport{
  return{async upload(raw){
    assertSignerActivation(); // No actual upload can start under the inactive signer gate.
    const input=Object.freeze({...raw});
    if(resultDigests(input.text).hash!==input.hash||!/^0x[a-fA-F0-9]{130}$/.test(input.signature)||!/^(0|[1-9][0-9]{0,77})$/.test(input.task))throw new TaskDeliveryError('Invalid upload payload');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new TaskDeliveryError('Upload outcome uncertain'));},5000);});
    const work=async()=>{
      const url=`${RESULT_SERVICE}/results`,checked=await(overrides.validateUrl??validateOutboundUrlResolved)(url);
      if(!checked.ok||controller.signal.aborted)throw new TaskDeliveryError('Upload endpoint unavailable');
      const response=await(overrides.fetch??fetch)(url,{method:'POST',redirect:'manual',credentials:'omit',signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({task:input.task,text:input.text,signature:input.signature})});
      if(!response.ok||!response.body||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body?.cancel();throw new TaskDeliveryError('Upload outcome uncertain');}
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192){await reader.cancel();throw new TaskDeliveryError('Upload reply too large');}chunks.push(part.value);}}
      finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
      if(controller.signal.aborted)throw new TaskDeliveryError('Upload outcome uncertain');
      const body=z.object({uri:z.string().max(2048),hash:z.string().regex(/^0x[a-fA-F0-9]{64}$/)}).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
      if(body.hash.toLowerCase()!==input.hash)throw new TaskDeliveryError('Upload hash mismatch');
      return{uri:validateResultUri(body.uri,input.hash),hash:input.hash};
    };
    try{return await Promise.race([work(),timeout]);}catch{throw new TaskDeliveryError('Upload outcome uncertain');}finally{clearTimeout(timer);controller.abort();}
  }};
}
