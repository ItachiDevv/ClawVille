import {readConfiguredAuthority} from './configured-authority';
﻿import type {Sql} from 'postgres';
import {decodeFunctionResult,encodeFunctionData,parseAbi,keccak256,toHex,type Hex,type Abi} from 'viem';
import {z} from 'zod';
import {createBrainChainReadRpc,blockSchema,rpcQuantity} from './chain-client';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {assertFreshTestnetObservation,assertObservedSignerCode,BrainChainSignerError,type SignerObservation} from './signer-policy';
import {LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY,type WorkerObservationPolicy} from './worker-observation-policy';

const hex=z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/),uint=z.bigint().nonnegative();
/** Exact release 3.5 getters. Read-only; artifact equality never opens the activation gate. */
export function createOwnedSignerObserver(database:Sql,overrides:Parameters<typeof createBrainChainReadRpc>[1]={},policy:WorkerObservationPolicy=LEGACY_WORKER_POLICY){
  return async(workerId:string):Promise<SignerObservation & {blockNumber:bigint}>=>{
    z.string().uuid().parse(workerId);
    const [binding]=await database`SELECT w.address,s.signer_address FROM brainchain_worker_bindings w JOIN brainchain_signer_streams s ON s.binding_id=w.id
      WHERE w.id=${workerId} AND w.environment='testnet' AND w.chain_id=274630 AND s.stopped=false`;
    if(!binding||binding.address!==binding.signer_address)throw new BrainChainSignerError('Dedicated testnet signer binding required');
    const address=z.string().regex(/^0x[a-f0-9]{40}$/).parse(binding.address),rpc=createBrainChainReadRpc('testnet',overrides),c=BRAINCHAIN_CONTRACTS.testnet.contracts;
    const observedAt=new Date(Date.now());
    if(BigInt(rpcQuantity.parse(await rpc('eth_chainId')))!==274630n)throw new BrainChainSignerError('Testnet chain mismatch');
    const head=BigInt(rpcQuantity.parse(await rpc('eth_blockNumber'))),number=policy===WORKER_PROVISIONAL_POLICY?head:head>12n?head-12n:0n,tag=toHex(number);
    const block=blockSchema.parse(await rpc('eth_getBlockByNumber',[tag,false]));
    if(BigInt(block.number)!==number)throw new BrainChainSignerError('Observation block mismatch');
    const call=async(target:Hex,signature:string,args:readonly unknown[]=[])=>{
      const abi:Abi=parseAbi([signature]);const name=signature.slice('function '.length).split('(')[0]!;
      const data=encodeFunctionData({abi,functionName:name,args});
      return decodeFunctionResult({abi,functionName:name,data:hex.parse(await rpc('eth_call',[{to:target,data},tag])) as Hex});
    };
    const codeHashes:Record<string,Hex>={};
    for(const [target,expected]of Object.entries(TESTNET_SIGNER_CODE_EVIDENCE.contracts)){
      const hash=keccak256(hex.parse(await rpc('eth_getCode',[target,tag])) as Hex);
      if(hash!==expected)throw new BrainChainSignerError('Pinned signer code changed');codeHashes[target]=hash;
    }
    const setAllowed=encodeFunctionData({abi:parseAbi(['function setWorkerAllowed(address,bool)']),functionName:'setWorkerAllowed',args:[address as Hex,true]});
    const subject=z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(await call(c.executor,'function changeSubject(address,bytes) view returns (bytes32)',[c.board,setAllowed]));
    const staking=z.object({staked:uint,unstaking:uint,unlocksAt:uint,price:uint,registered:z.boolean()}).parse(await call(c.staking,'function get(address) view returns ((uint128 staked,uint128 unstaking,uint64 unlocksAt,uint128 price,bool registered))',[address]));
    const [minStake,held,bond,allowed,balance,stakingAllowance,bondAllowance,lastClaim,faucetInterval,open,vetoed,gas]=await Promise.all([
      call(c.staking,'function minStake() view returns (uint128)'),call(c.staking,'function held(address) view returns (uint32)',[address]),
      call(c.bonds,'function bond() view returns (uint128)'),call(c.board,'function workerAllowed(address) view returns (bool)',[address]),
      call(c.brain,'function balanceOf(address) view returns (uint256)',[address]),call(c.brain,'function allowance(address,address) view returns (uint256)',[address,c.staking]),
      call(c.brain,'function allowance(address,address) view returns (uint256)',[address,c.bonds]),call(c.brain,'function lastClaim(address) view returns (uint256)',[address]),
      call(c.brain,'function FAUCET_INTERVAL() view returns (uint256)'),call(c.bonds,'function openProposal(bytes32) view returns (uint256)',[subject]),
      call(c.executor,'function vetoed(address,bytes4) view returns (bool)',[c.board,setAllowed.slice(0,10)]),rpc('eth_getBalance',[address,tag]),
    ]);
    let applicationPending=uint.parse(open)>0n;
    if(applicationPending){
      const proposal=z.object({proposer:z.string().regex(/^0x[a-fA-F0-9]{40}$/),bond:uint,createdAt:uint,state:z.number().int(),subject:z.string(),deadline:uint,thresholdBps:z.number().int()})
        .parse(await call(c.bonds,'function get(uint256) view returns ((address proposer,uint128 bond,uint64 createdAt,uint8 state,bytes32 subject,uint64 deadline,uint16 thresholdBps))',[open]));
      if(proposal.state!==1||proposal.subject.toLowerCase()!==subject.toLowerCase()||proposal.proposer===`0x${'0'.repeat(40)}`)throw new BrainChainSignerError('Ambiguous application proposal');
    }
    if(!z.boolean().parse(allowed)){
      const count=uint.parse(await call(c.executor,'function changeCount() view returns (uint256)'));
      if(count>32n)throw new BrainChainSignerError('Application queue requires indexed evidence');
      for(let id=1n;id<=count;id++){
        const change=z.object({target:z.string(),data:hex.max(4098),eta:uint,executed:z.boolean(),vetoed:z.boolean()})
          .parse(await call(c.executor,'function getChange(uint256) view returns ((address target,bytes data,uint64 eta,bool executed,bool vetoed))',[id]));
        if(change.target.toLowerCase()===c.board&&change.data.toLowerCase()===setAllowed.toLowerCase()&&!change.executed&&!change.vetoed)applicationPending=true;
      }
    }
    const authorityEvidence=await readConfiguredAuthority(rpc,block,observedAt,policy);
    const final=blockSchema.parse(await rpc('eth_getBlockByNumber',[tag,false]));
    if(final.hash!==block.hash||final.number!==block.number||final.timestamp!==block.timestamp)throw new BrainChainSignerError('Observation reorg');
    const state={...authorityEvidence,environment:'testnet' as const,chainId:274630,bindingAddress:address,signerAddress:address,observedAt,observationPolicy:policy,blockNumber:number,blockHash:block.hash as Hex,blockTimestamp:BigInt(block.timestamp),codeHashes,
      brainBalance:uint.parse(balance),gasBalance:BigInt(rpcQuantity.parse(gas)),staked:staking.staked,unstaking:staking.unstaking,unlocksAt:staking.unlocksAt,
      held:BigInt(z.union([uint,z.number().int().nonnegative()]).parse(held)),minStake:uint.parse(minStake),bond:uint.parse(bond),stakingAllowance:uint.parse(stakingAllowance),bondAllowance:uint.parse(bondAllowance),
      allowed:z.boolean().parse(allowed),applicationPending,applicationVetoed:z.boolean().parse(vetoed),lastClaim:uint.parse(lastClaim),faucetInterval:uint.parse(faucetInterval)};
    assertFreshTestnetObservation(state,new Date(Date.now()));assertObservedSignerCode(state);return state;
  };
}


