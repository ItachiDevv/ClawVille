import type {Sql} from 'postgres';
import {decodeEventLog,encodeEventTopics,keccak256,parseAbi,toHex,type Hex} from 'viem';
import {z} from 'zod';
import {createBrainChainReadRpc,blockSchema,logSchema,rpcQuantity} from './chain-client';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {workerBriefSchema} from './worker-authority-issuer';
import {LEGACY_WORKER_POLICY,workerObservationFresh,type WorkerObservationPolicy} from './worker-observation-policy';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {WorkerPolicyError} from './worker-owner-policy';

// Release348cc TaskBoard.sol:129-130. The first bounded pilot accepts embedded briefs only.
const posted=parseAbi(['event Posted(uint256 indexed id,address indexed poster,uint128 bounty,uint64 deadline,bytes32 briefHash,string briefURI)']);
export function decodeWorkerBrief(uri:string,expectedHash:string):string{
  const match=/^data:(?:text\/plain|application\/json)(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if(!match||match[1]!.length>21848)throw new WorkerPolicyError('Supported embedded brief required');
  const bytes=Buffer.from(match[1]!,'base64');
  if(bytes.length===0||bytes.length>16384||bytes.toString('base64')!==match[1]||keccak256(bytes)!==expectedHash)throw new WorkerPolicyError('Exact brief hash required');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);workerBriefSchema.parse(JSON.parse(text));return text;
}

/** Fixed testnet read only. A Posted URI never becomes an outbound URL. */
export function createWorkerBriefReader(database:Sql,overrides:Parameters<typeof createBrainChainReadRpc>[1]={},policy:WorkerObservationPolicy=LEGACY_WORKER_POLICY){
  return async(workerId:string,taskId:string):Promise<string>=>{
    const [task]=await database`SELECT t.* FROM brainchain_worker_tasks t JOIN brainchain_worker_bindings w ON w.id=t.binding_id
      WHERE t.id=${taskId} AND t.binding_id=${workerId} AND t.environment='testnet' AND t.chain_id=274630 AND t.canonical=true AND t.status=2`;
    const board=BRAINCHAIN_CONTRACTS.testnet.boards[0]!;
    if(!task||task.board_address!==board.address)throw new WorkerPolicyError('Canonical current-board task required');
    const acquiredAt=new Date(Date.now()),rpc=createBrainChainReadRpc('testnet',overrides);
    if(BigInt(rpcQuantity.parse(await rpc('eth_chainId')))!==274630n)throw new WorkerPolicyError('Testnet chain mismatch');
    const at=blockSchema.parse(await rpc('eth_getBlockByNumber',[toHex(BigInt(task.observed_block)),false]));
    if(BigInt(at.number)!==BigInt(task.observed_block)||at.hash!==task.observed_block_hash)throw new WorkerPolicyError('Task observation reorged');
    const code=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/).parse(await rpc('eth_getCode',[board.address,at.number])) as Hex;
    if(keccak256(code)!==TESTNET_SIGNER_CODE_EVIDENCE.contracts[board.address])throw new WorkerPolicyError('Pinned board code required');
    const from=BigInt(board.fromBlock),to=BigInt(task.hire_block);
    if(to<from||to-from>=50000n)throw new WorkerPolicyError('Posted history exceeds bounded scan; index expansion required');
    const logs=z.array(logSchema).max(2).parse(await rpc('eth_getLogs',[{address:board.address,fromBlock:toHex(from),toBlock:toHex(to),topics:encodeEventTopics({abi:posted,eventName:'Posted',args:{id:BigInt(task.task_id)}})}]));
    if(logs.length!==1)throw new WorkerPolicyError('Unique Posted evidence required');
    const log=logs[0]!;
    if(log.removed||log.address.toLowerCase()!==board.address||BigInt(log.blockNumber)<from||BigInt(log.blockNumber)>to)throw new WorkerPolicyError('Posted evidence scope mismatch');
    const decoded=decodeEventLog({abi:posted,eventName:'Posted',data:log.data as Hex,topics:log.topics as [Hex,...Hex[]]});
    if(decoded.args.id!==BigInt(task.task_id)||decoded.args.briefHash!==task.brief_hash)throw new WorkerPolicyError('Posted task hash mismatch');
    const eventBlock=blockSchema.parse(await rpc('eth_getBlockByNumber',[log.blockNumber,false]));
    if(eventBlock.number!==log.blockNumber||eventBlock.hash!==log.blockHash)throw new WorkerPolicyError('Posted event reorged');
    const brief=decodeWorkerBrief(decoded.args.briefURI,task.brief_hash);
    const final=blockSchema.parse(await rpc('eth_getBlockByNumber',[at.number,false]));
    if(final.number!==at.number||final.hash!==at.hash||final.timestamp!==at.timestamp||!workerObservationFresh({observedAt:acquiredAt,blockTimestamp:BigInt(final.timestamp),observationPolicy:policy}))throw new WorkerPolicyError('Fresh task anchor required');
    return brief;
  };
}
