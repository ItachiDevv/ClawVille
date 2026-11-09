import {keccak256,type Hex} from 'viem';
import {z} from 'zod';
import {createBrainChainReader,createBrainChainReadRpc,rpcQuantity} from './chain-client';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {WORKER_PROVISIONAL_POLICY,workerObservationFresh} from './worker-observation-policy';
import {DeliveryRecoveryError,type DeliveryEvidenceReader} from './delivery-recovery';

/** Read-only canonical hire evidence. Effect consumers separately enforce configured authority at the same anchor. */
export function createWorkerDeliveryEvidenceReader(overrides:Parameters<typeof createBrainChainReadRpc>[1]={}):DeliveryEvidenceReader{
  return async snapshot=>{
    if(snapshot.environment!=='testnet'||snapshot.chainId!==274630||snapshot.board!==BRAINCHAIN_CONTRACTS.testnet.contracts.board)
      throw new DeliveryRecoveryError('Current testnet recovery scope required');
    const observedAt=new Date(Date.now()),reader=createBrainChainReader('testnet',overrides),rpc=createBrainChainReadRpc('testnet',overrides);
    await reader.assertChain();
    const at=await reader.block(BigInt(rpcQuantity.parse(await rpc('eth_blockNumber'))));
    const code=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/).parse(await rpc('eth_getCode',[snapshot.board,at.number])) as Hex;
    if(keccak256(code)!==TESTNET_SIGNER_CODE_EVIDENCE.contracts[snapshot.board])throw new DeliveryRecoveryError('Pinned recovery board code required');
    const task=await reader.task(snapshot.board,BigInt(snapshot.task),at),hire=await reader.block(BigInt(snapshot.hireBlock));
    const final=await reader.block(BigInt(at.number));
    if(final.hash!==at.hash||final.timestamp!==at.timestamp||!workerObservationFresh({observedAt,blockTimestamp:BigInt(final.timestamp),observationPolicy:WORKER_PROVISIONAL_POLICY}))
      throw new DeliveryRecoveryError('Recovery acquisition expired or reorged');
    return{observedAt,observationPolicy:WORKER_PROVISIONAL_POLICY,blockNumber:BigInt(at.number),blockHash:at.hash,blockTimestamp:BigInt(at.timestamp),
      hireBlockHash:hire.hash,model:task.model.toLowerCase(),briefHash:task.briefHash.toLowerCase(),status:task.status,payee:task.payee.toLowerCase(),resultHash:task.resultHash.toLowerCase()};
  };
}
