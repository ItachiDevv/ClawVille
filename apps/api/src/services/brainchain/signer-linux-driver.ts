import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {decodeFunctionData,encodeFunctionData,parseTransaction,recoverTransactionAddress,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {z} from 'zod';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {assertSignerActivation,BrainChainSignerError,signerAbi,type SignerRequest} from './signer-policy';
import type {DedicatedSignerDriver,FrozenSignerTransaction} from './signer-service';
import type {ProtectedSignerJournal} from './signer-payload-store';
import {freezeResultSignatureIntent,resultSignatureClaimHash,verifyResultSignature,type DedicatedResultSignerDriver} from './result-signing-policy';
import {resultUploadMessage} from './result-signing-message';

export type ApprovedSignerKey={reference:string;filename:string;address:string};
/** Defense in depth: the driver never accepts arbitrary calls even from its trusted coordinator. */
export function assertDriverTransaction(tx:FrozenSignerTransaction,address:string,submit?:Extract<SignerRequest,{kind:'submit'}>){
  const fields=['chainId','type','to','data','value','nonce','gas','maxFeePerGas','maxPriorityFeePerGas'];
  if(Object.keys(tx).length!==fields.length||Object.keys(tx).some(name=>!fields.includes(name)))throw new BrainChainSignerError('Unexpected signer transaction field');
  if(typeof tx.to!=='string'||typeof tx.data!=='string'||typeof tx.nonce!=='number'||typeof tx.value!=='bigint'
    ||typeof tx.gas!=='bigint'||typeof tx.maxFeePerGas!=='bigint'||typeof tx.maxPriorityFeePerGas!=='bigint')throw new BrainChainSignerError('Invalid signer primitive');
  if(tx.chainId!==274630||tx.type!=='eip1559'||tx.value!==0n||!Number.isSafeInteger(tx.nonce)||tx.nonce<0
    ||tx.gas<=0n||tx.maxFeePerGas<=0n||tx.maxPriorityFeePerGas<0n||tx.maxPriorityFeePerGas>tx.maxFeePerGas)
    throw new BrainChainSignerError('Invalid frozen testnet transaction');
  const c=BRAINCHAIN_CONTRACTS.testnet.contracts,decoded=decodeFunctionData({abi:signerAbi,data:tx.data});
  const canonical=encodeFunctionData({abi:signerAbi,functionName:decoded.functionName,args:decoded.args} as Parameters<typeof encodeFunctionData>[0]);
  if(canonical!==tx.data)throw new BrainChainSignerError('Noncanonical signer calldata');
  switch(decoded.functionName){
    case 'faucet':if(tx.to!==c.brain)throw new BrainChainSignerError('Faucet destination mismatch');break;
    case 'approve':if(tx.to!==c.brain||![c.staking,c.bonds].includes(decoded.args[0].toLowerCase() as typeof c.staking)||decoded.args[1]<=0n||decoded.args[1]>=2n**128n)throw new BrainChainSignerError('Approval destination mismatch');break;
    case 'stake':case 'requestUnstake':if(tx.to!==c.staking||decoded.args[0]<=0n)throw new BrainChainSignerError('Staking destination mismatch');break;
    case 'withdraw':if(tx.to!==c.staking)throw new BrainChainSignerError('Staking destination mismatch');break;
    case 'submit':
      if(!submit||tx.to!==c.board||decoded.args[0]!==BigInt(submit.task)||decoded.args[1]!==submit.hash||decoded.args[2]!==submit.uri
        ||submit.uri!==`https://brain.testnet.usebrainchain.com/records/${submit.hash}.txt`)throw new BrainChainSignerError('Typed submit authority required');break;
    case 'propose':{
      if(tx.to!==c.bonds||decoded.args[0].toLowerCase()!==c.board)throw new BrainChainSignerError('Proposal destination mismatch');
      const nested=encodeFunctionData({abi:signerAbi,functionName:'setWorkerAllowed',args:[address as Hex,true]});
      if(decoded.args[1]!==nested||!decoded.args[2].startsWith('data:application/json;base64,')||decoded.args[2].length>4096)throw new BrainChainSignerError('Proposal authority mismatch');
      const encoded=decoded.args[2].slice('data:application/json;base64,'.length);
      const profile=z.object({name:z.string().min(1).max(60),about:z.string().min(1).max(500)}).strict().parse(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')));
      if(Buffer.from(JSON.stringify(profile),'utf8').toString('base64')!==encoded)throw new BrainChainSignerError('Noncanonical proposal profile');
      break;
    }
    default:throw new BrainChainSignerError('Unsupported signer method');
  }
}

/** No environment lookup, URL, database import, or key provisioning. The signer process owns this fixed registry. */
export async function createLinuxSignerDriver(directory:string,uid:number,approved:readonly ApprovedSignerKey[],journal:ProtectedSignerJournal,resultJournal?:ProtectedSignerJournal):Promise<DedicatedSignerDriver&DedicatedResultSignerDriver>{
  if(process.platform!=='linux'||uid<=0||process.getuid?.()!==uid)throw new BrainChainSignerError('Dedicated Linux signer identity required');
  const root=resolve(directory),keys=new Map<string,Readonly<ApprovedSignerKey>>();
  async function verifyRoot(){
    const metadata=await lstat(root);
    if(!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.uid!==uid||(metadata.mode&0o777)!==0o700||await realpath(root)!==root)
      throw new BrainChainSignerError('Private signer key directory required');
  }
  await verifyRoot();
  for(const key of approved){
    if(!/^brainchain-testnet:[a-zA-Z0-9_-]{1,96}$/.test(key.reference)||!/^[-a-zA-Z0-9_]{1,96}\.key$/.test(key.filename)
      ||!/^0x[a-f0-9]{40}$/.test(key.address)||/^0x0{40}$/.test(key.address)||keys.has(key.reference)
      ||[...keys.values()].some(value=>value.filename===key.filename||value.address===key.address))throw new BrainChainSignerError('Invalid fixed key registry');
    keys.set(key.reference,Object.freeze({...key}));
  }
  function keyFor(reference:string){const key=keys.get(reference);if(!key)throw new BrainChainSignerError('Unknown key reference');return key;}
  async function withKey(key:Readonly<ApprovedSignerKey>,action:(account:ReturnType<typeof privateKeyToAccount>)=>Promise<Hex>){
    await verifyRoot();
    const handle=await open(join(root,key.filename),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer|undefined;
    try{
      const metadata=await handle.stat();
      if(!metadata.isFile()||metadata.uid!==uid||(metadata.mode&0o777)!==0o600||metadata.nlink!==1||metadata.size!==64)throw new BrainChainSignerError('Private signer key file required');
      bytes=Buffer.alloc(65);const read=await handle.read(bytes,0,65,0);
      if(read.bytesRead!==64)throw new BrainChainSignerError('Key file changed');
      const encoded=bytes.subarray(0,64).toString('latin1');
      if(!/^[a-fA-F0-9]{64}$/.test(encoded))throw new BrainChainSignerError('Invalid private key encoding');
      const account=privateKeyToAccount(`0x${encoded}`);
      if(account.address.toLowerCase()!==key.address)throw new BrainChainSignerError('Private key address mismatch');
      return await action(account);
    }finally{bytes?.fill(0);await handle.close();}
  }
  async function verifyCapture(bytes:Hex,transaction:FrozenSignerTransaction,address:string){
    const parsed=parseTransaction(bytes);
    if(parsed.type!=='eip1559'||parsed.chainId!==transaction.chainId||parsed.to?.toLowerCase()!==transaction.to||parsed.data!==transaction.data
      ||(parsed.value??0n)!==0n||parsed.nonce!==transaction.nonce||parsed.gas!==transaction.gas||parsed.maxFeePerGas!==transaction.maxFeePerGas
      ||parsed.maxPriorityFeePerGas!==transaction.maxPriorityFeePerGas||(parsed.accessList?.length??0)!==0
      ||(await recoverTransactionAddress({serializedTransaction:bytes as `0x02${string}`})).toLowerCase()!==address)
      throw new BrainChainSignerError('Driver capture differs from frozen intent');
  }
  return{
    async addressForReference(reference){return keyFor(reference).address;},
    async signResult(operationId,reference,rawIntent,assertCurrent){
      const intent=freezeResultSignatureIntent(rawIntent);assertSignerActivation();
      if(!resultJournal)throw new BrainChainSignerError('Typed result journal unavailable');
      const key=keyFor(reference);if(key.address!==intent.worker)throw new BrainChainSignerError('Result worker mismatch');
      const hash=resultSignatureClaimHash(reference,intent);
      if(!await resultJournal.claimDriverUse(operationId,hash)){
        const prior=await resultJournal.findByOperation(operationId);
        if(!prior)throw new BrainChainSignerError('Ambiguous result key use requires recovery');
        await verifyResultSignature(prior.bytes,intent);return prior.bytes;
      }
      await assertCurrent();
      return withKey(key,async account=>{
        await assertCurrent();assertSignerActivation();
        const signature=await account.signMessage({message:resultUploadMessage(intent.board,intent.task,intent.hash)});
        await verifyResultSignature(signature,intent);
        const reference=await resultJournal.putIfAbsent(operationId,signature);
        if(await resultJournal.get(reference)!==signature)throw new BrainChainSignerError('Result capture readback mismatch');
        return signature;
      });
    },
    async signTransaction(operationId,reference,proposedTransaction,rawSubmitAuthority){
      const transaction=Object.freeze({...proposedTransaction});
      const submitAuthority=rawSubmitAuthority?{result:rawSubmitAuthority.result?Object.freeze({...rawSubmitAuthority.result}):undefined,assertCurrent:rawSubmitAuthority.assertCurrent}:undefined;
      assertSignerActivation(); // Must precede key-file access, claims, and signature construction.
      const key=keyFor(reference);assertDriverTransaction(transaction,key.address,submitAuthority?.result);
      if(!submitAuthority||typeof submitAuthority.assertCurrent!=='function')throw new BrainChainSignerError('Current operation authority required');
      const intentHash=createHash('sha256').update(JSON.stringify({reference,transaction},(_name,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
      if(!await journal.claimDriverUse(operationId,intentHash)){
        const prior=await journal.findByOperation(operationId);
        if(!prior)throw new BrainChainSignerError('Ambiguous key use requires recovery');
        await verifyCapture(prior.bytes,transaction,key.address);
        return prior.bytes;
      }
      await submitAuthority.assertCurrent();
      return withKey(key,async account=>{
        await submitAuthority.assertCurrent();
        assertSignerActivation();
        const signed=await account.signTransaction(transaction);
        await verifyCapture(signed,transaction,key.address);
        // Persist here, not only in the caller: a late result after caller timeout remains recoverable.
        const payloadReference=await journal.putIfAbsent(operationId,signed);
        if(await journal.get(payloadReference)!==signed)throw new BrainChainSignerError('Driver capture readback mismatch');
        return signed;
      });
    },
  };
}
