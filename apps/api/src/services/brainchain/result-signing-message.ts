import {BRAINCHAIN_CONTRACTS} from './contracts';
/** Exact official result-v2 EIP-191 body. No network or database imports belong in the signer process. */
export function resultUploadMessage(board:string,task:string,hash:string){
  if(board!==BRAINCHAIN_CONTRACTS.testnet.contracts.board||!/^(0|[1-9][0-9]{0,77})$/.test(task)||BigInt(task)>=2n**256n||!/^0x[a-f0-9]{64}$/.test(hash))
    throw new Error('Unsupported result target');
  return ['BrainChain result v2','chain 274630',`board ${board}`,`task ${task}`,`hash ${hash}`].join('\n');
}
