import {describe,expect,test} from 'bun:test';
import {decodeFunctionData} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {TESTNET_SIGNER_ARTIFACT_REVIEW,assertObservedSignerCode,assertPreparedIntentMatches,assertSignerArtifactAdmission,prepareSignerIntent,signerAbi,signerRequestHash,type SignerObservation,type SignerRequest} from './signer-policy';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';

const now=new Date('2026-11-09T15:00:00Z');
export function signerFixtureState():SignerObservation{return{environment:'testnet',chainId:274630,bindingAddress:`0x${'1'.repeat(40)}`,signerAddress:`0x${'1'.repeat(40)}`,
  observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{},
  brainBalance:1000n,gasBalance:100000n,staked:500n,unstaking:500n,unlocksAt:1n,held:0n,minStake:500n,bond:100n,stakingAllowance:1000n,bondAllowance:100n,
  allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};}
const fixture=()=>({...signerFixtureState(),observedAt:now,blockTimestamp:BigInt(Math.floor(now.getTime()/1000))});
const approve=(request:SignerRequest,amount=0n)=>({requestHash:signerRequestHash(request),amount,price:'price' in request?BigInt(request.price):0n,gasCeilingWei:1000n});
describe('BrainChain exact testnet signer intent policy',()=>{
  test('every full runtime hash must match, including metadata bytes',()=>{
    const state={...fixture(),codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts}};
    expect(()=>assertObservedSignerCode(state)).not.toThrow();
    for(const address of Object.keys(state.codeHashes))expect(()=>assertObservedSignerCode({...state,codeHashes:{...state.codeHashes,[address]:`0x${'0'.repeat(64)}`}})).toThrow('code mismatch');
    expect(()=>assertSignerArtifactAdmission(state)).toThrow('artifact equivalence');
  });
  test('application is only the exact own-worker allow proposal with bounded profile',()=>{
    const request={kind:'apply',name:'Office worker',about:'Bounded research'} as const;
    const intent=prepareSignerIntent(request,fixture(),approve(request,100n),now);
    expect(intent.to).toBe(BRAINCHAIN_CONTRACTS.testnet.contracts.bonds);expect(intent.value).toBe('0');
    const outer=decodeFunctionData({abi:signerAbi,data:intent.data});expect(outer.functionName).toBe('propose');
    if(outer.functionName!=='propose')throw Error('unexpected');
    expect(outer.args[0].toLowerCase()).toBe(BRAINCHAIN_CONTRACTS.testnet.contracts.board);
    const inner=decodeFunctionData({abi:signerAbi,data:outer.args[1]});
    expect(inner.functionName).toBe('setWorkerAllowed');expect(inner.args).toEqual([fixture().signerAddress as `0x${string}`,true]);
    expect(JSON.parse(Buffer.from(outer.args[2].split(',')[1]!,'base64').toString())).toEqual({name:request.name,about:request.about});
    for(const changes of [{allowed:true},{applicationPending:true},{applicationVetoed:true},{bond:101n}])expect(()=>prepareSignerIntent(request,{...fixture(),...changes},approve(request,100n),now)).toThrow();
  });
  test('mainnet, stale evidence, foreign signer and supplied transaction fields fail',()=>{
    const request={kind:'faucet'} as const;
    for(const changes of [{chainId:274663},{environment:'mainnet' as const},{signerAddress:`0x${'2'.repeat(40)}`},{blockTimestamp:fixture().blockTimestamp-121n},{observedAt:new Date(now.getTime()-30001)}])
      expect(()=>prepareSignerIntent(request,{...fixture(),...changes},approve(request),now)).toThrow();
    expect(()=>prepareSignerIntent({...request,to:'0xattacker'},fixture(),approve(request),now)).toThrow();
    expect(()=>prepareSignerIntent({kind:'deliver',task:'1'},fixture(),approve(request),now)).toThrow();
    expect(()=>assertSignerArtifactAdmission(fixture())).toThrow('artifact equivalence');
  });
  test('allowances, exact stake price, gas ceiling, and frozen calldata stay bounded',()=>{
    const request={kind:'stake',amount:'500',price:'3'} as const;
    const intent=prepareSignerIntent(request,fixture(),approve(request,500n),now);
    for(const field of ['to','from','data','value','chainId'])expect(()=>assertPreparedIntentMatches(intent,{...intent,[field]:'altered'})).toThrow();
    expect(()=>prepareSignerIntent({...request,amount:'501'},fixture(),approve(request,500n),now)).toThrow();
    expect(()=>prepareSignerIntent(request,fixture(),{...approve(request,500n),price:4n},now)).toThrow();
    expect(()=>prepareSignerIntent(request,{...fixture(),gasBalance:999n},approve(request,500n),now)).toThrow();
    const allowance={kind:'approve-bond',amount:'100'} as const;
    const decoded=decodeFunctionData({abi:signerAbi,data:prepareSignerIntent(allowance,fixture(),approve(allowance,100n),now).data});
    expect(decoded.functionName).toBe('approve');
    if(decoded.functionName==='approve')expect(decoded.args[0].toLowerCase()).toBe(BRAINCHAIN_CONTRACTS.testnet.contracts.bonds);
  });
  test('drain preserves outstanding delivery but withdrawal requires released holds and cooldown',()=>{
    const leave={kind:'leave',amount:'500'} as const;
    expect(prepareSignerIntent(leave,{...fixture(),held:2n},approve(leave,500n),now).kind).toBe('leave');
    const withdraw={kind:'withdraw'} as const;
    for(const changes of [{held:1n},{unstaking:0n},{unlocksAt:fixture().blockTimestamp+1n}])expect(()=>prepareSignerIntent(withdraw,{...fixture(),...changes},approve(withdraw),now)).toThrow();
  });
});

test('DecisionLog full hash is pinned and missing or mismatched evidence refuses admission',()=>{
  const address='0x4e4cb48f3802bd519e0eed896df82197b0ecbc09', expected='0x917216bf47f6d0240fbf0646de38b45f32a4205015cbf61ef26c51b0faa20d58';
  const hashes:Record<string,`0x${string}`>={...TESTNET_SIGNER_CODE_EVIDENCE.contracts};
  expect(hashes[address]).toBe(expected);
  delete hashes[address];
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
  hashes[address]=`0x${'0'.repeat(64)}`;
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
});
test('ModelRegistry full hash is pinned and missing or mismatched evidence refuses admission',()=>{
  const address='0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c', expected='0xdd1e96eb781459c608ff34b82469c957ce90e408bccaaa39c5c86e60ea6d326b';
  const hashes:Record<string,`0x${string}`>={...TESTNET_SIGNER_CODE_EVIDENCE.contracts};
  expect(hashes[address]).toBe(expected);
  delete hashes[address];
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
  hashes[address]=`0x${'0'.repeat(64)}`;
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
});
test('TestUSDG full hash is pinned and missing or mismatched evidence refuses admission',()=>{
  const address='0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2', expected='0x085a09654a7ff2ea410a62fff9309557c953bf29a0ccaa12b5ef4b830e33c226';
  const hashes:Record<string,`0x${string}`>={...TESTNET_SIGNER_CODE_EVIDENCE.contracts};
  expect(hashes[address]).toBe(expected);
  delete hashes[address];
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
  hashes[address]=`0x${'0'.repeat(64)}`;
  expect(()=>assertObservedSignerCode({...fixture(),codeHashes:hashes})).toThrow('code mismatch');
});

test('dependency review does not activate signing',()=>{expect(TESTNET_SIGNER_CODE_EVIDENCE.approvedForSigning).toBe(false);expect(TESTNET_SIGNER_ARTIFACT_REVIEW.verified).toBe(false);});
