import {describe,test,expect} from 'bun:test';
import {encodeFunctionData,type Hex} from 'viem';
import {assertDriverTransaction,createLinuxSignerDriver} from './signer-linux-driver';
import {signerAbi} from './signer-policy';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import type {FrozenSignerTransaction} from './signer-service';
import type {ProtectedSignerJournal} from './signer-payload-store';
const address=`0x${'1'.repeat(40)}` as Hex,c=BRAINCHAIN_CONTRACTS.testnet.contracts;
const transaction:FrozenSignerTransaction={chainId:274630,type:'eip1559',to:c.brain,data:encodeFunctionData({abi:signerAbi,functionName:'faucet'}),value:0n,nonce:0,gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n};
describe('BrainChain concrete driver restrictions',()=>{
  test('only exact typed testnet destinations and fields are accepted',()=>{
    expect(()=>assertDriverTransaction(transaction,address)).not.toThrow();
    expect(()=>assertDriverTransaction({...transaction,chainId:1} as unknown as FrozenSignerTransaction,address)).toThrow();
    expect(()=>assertDriverTransaction({...transaction,to:address},address)).toThrow();
    expect(()=>assertDriverTransaction({...transaction,data:`${transaction.data}00`},address)).toThrow();
    expect(()=>assertDriverTransaction({...transaction,accessList:[]} as FrozenSignerTransaction,address)).toThrow();
  });
  test('driver rejects arbitrary approval recipients and general proposals',()=>{
    expect(()=>assertDriverTransaction({...transaction,data:encodeFunctionData({abi:signerAbi,functionName:'approve',args:[address,1n]})},address)).toThrow();
    expect(()=>assertDriverTransaction({...transaction,data:encodeFunctionData({abi:signerAbi,functionName:'approve',args:[c.staking,1n]})},address)).not.toThrow();
    const nested=encodeFunctionData({abi:signerAbi,functionName:'setWorkerAllowed',args:[address,true]});
    const profile=`data:application/json;base64,${Buffer.from(JSON.stringify({name:'Fixture',about:'Isolated fixture'})).toString('base64')}`;
    const valid={...transaction,to:c.bonds,data:encodeFunctionData({abi:signerAbi,functionName:'propose',args:[c.board,nested,profile]})};
    expect(()=>assertDriverTransaction(valid,address)).not.toThrow();
    expect(()=>assertDriverTransaction(valid,`0x${'2'.repeat(40)}`)).toThrow();
    expect(()=>assertDriverTransaction({...transaction,to:c.board,data:nested},address)).toThrow();
  });
  test.skipIf(process.platform==='linux')('non-Linux process refuses before registry or file access',async()=>{
    const journal={} as ProtectedSignerJournal;
    await expect(createLinuxSignerDriver('unused',10001,[],journal)).rejects.toThrow('Dedicated Linux');
  });
});
