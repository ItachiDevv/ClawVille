import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,open,readFile,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {Hex} from 'viem';
import {BrainChainSignerError} from './signer-policy';
import type {ProtectedSignedPayloadStore} from './signer-service';

const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const missing=(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='ENOENT';
const exists=(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='EEXIST';
export interface ProtectedSignerJournal extends ProtectedSignedPayloadStore {
  /** True only for the first durable key-use claim. False never permits another signature. */
  claimKeyUse(operationId:string,intentHash:string):Promise<boolean>;
  claimDriverUse(operationId:string,intentHash:string):Promise<boolean>;
}

/** Linux-only private store. The deployment must additionally isolate the UID and omit this mount from API/cognition. */
export async function createProtectedSignerJournal(directory:string,expectedUid:number):Promise<ProtectedSignerJournal>{
  return createJournal(directory,expectedUid,'transaction');
}
/** Separate filenames and payload grammar prevent a signature from becoming a transaction payload. */
export async function createProtectedResultSignatureJournal(directory:string,expectedUid:number):Promise<ProtectedSignerJournal>{
  return createJournal(directory,expectedUid,'result-v2');
}
async function createJournal(directory:string,expectedUid:number,domain:'transaction'|'result-v2'):Promise<ProtectedSignerJournal>{
  if(process.platform!=='linux'||!Number.isInteger(expectedUid)||expectedUid<=0||process.getuid?.()!==expectedUid)
    throw new BrainChainSignerError('Dedicated Linux signer identity required');
  const root=resolve(directory);
  const prefix=domain==='transaction'?'':'result-v2-';
  const validPayload=(value:string)=>domain==='transaction'?/^0x02(?:[a-fA-F0-9]{2}){1,8191}$/.test(value):/^0x[a-fA-F0-9]{130}$/.test(value);
  async function verifyRoot(){
    const meta=await lstat(root);
    if(!meta.isDirectory()||meta.isSymbolicLink()||meta.uid!==expectedUid||(meta.mode&0o777)!==0o700||(await realpath(root))!==root)
      throw new BrainChainSignerError('Private signer directory required');
  }
  await verifyRoot();
  function operationName(id:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new BrainChainSignerError('Invalid signer operation');return id;}
  function referenceName(reference:string){if(!/^[a-f0-9]{64}$/.test(reference))throw new BrainChainSignerError('Invalid protected reference');return reference;}
  async function syncDirectory(){const handle=await open(root,'r');try{await handle.sync();}finally{await handle.close();}}
  async function privateRead(name:string,maximum:number):Promise<string|null>{
    await verifyRoot();
    const path=join(root,prefix+name);
    try{
      const meta=await lstat(path);
      if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.uid!==expectedUid||(meta.mode&0o777)!==0o600||meta.size>maximum)
        throw new BrainChainSignerError('Protected file permissions or size mismatch');
      const value=await readFile(path,'utf8');
      if(Buffer.byteLength(value)>maximum)throw new BrainChainSignerError('Protected file exceeds limit');
      return value;
    }catch(error){if(missing(error))return null;throw error;}
  }
  /** fsync data, publish without overwrite, remove the temporary link, then fsync directory metadata. */
  async function publish(name:string,content:string){
    await verifyRoot();
    const temp=join(root,`.pending-${randomUUID()}`),target=join(root,prefix+name);
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(content,'utf8');await handle.sync();}finally{await handle.close();}
    let created=false;
    try{await link(temp,target);created=true;}catch(error){if(!exists(error))throw error;}
    finally{await unlink(temp);await syncDirectory();}
    return created;
  }
  async function get(reference:string):Promise<Hex>{
    const value=await privateRead(`${referenceName(reference)}.payload`,16386);
    if(value===null||!validPayload(value)||digest(value)!==reference)throw new BrainChainSignerError('Protected payload missing or changed');
    return value as Hex;
  }
  async function findByOperation(operationId:string){
    const reference=await privateRead(`${operationName(operationId)}.capture`,64);
    if(reference===null)return null;
    return{reference:referenceName(reference),bytes:await get(reference)};
  }
  async function claim(operationId:string,intentHash:string,suffix:string){
    const name=`${operationName(operationId)}.${suffix}`;
    referenceName(intentHash);
    const first=await publish(name,intentHash);
    if((await privateRead(name,64))!==intentHash)throw new BrainChainSignerError('Operation already claimed different intent');
    return first;
  }
  return{
    get,findByOperation,
    async putIfAbsent(operationId,bytes){
      operationName(operationId);
      if(!validPayload(bytes))throw new BrainChainSignerError('Invalid protected payload');
      const reference=digest(bytes);
      await publish(`${reference}.payload`,bytes);
      if((await get(reference))!==bytes)throw new BrainChainSignerError('Protected payload collision');
      await publish(`${operationId}.capture`,reference);
      const captured=await findByOperation(operationId);
      if(captured?.reference!==reference||captured.bytes!==bytes)throw new BrainChainSignerError('Operation already captured different bytes');
      return reference;
    },
    claimKeyUse:(operationId,intentHash)=>claim(operationId,intentHash,'key-use'),
    async claimDriverUse(operationId,intentHash){
      if(await privateRead(`${operationName(operationId)}.key-use`,64)!==referenceName(intentHash))
        throw new BrainChainSignerError('Durable coordinator claim required');
      return claim(operationId,intentHash,'driver-use');
    },
  };
}
