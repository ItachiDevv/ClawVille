import {CONFIGURED_AUTHORITY_GETTERS} from './configured-authority';
/** Run alone: test-only gate and bytecode evidence replacements; controlled fetch never touches a network. */
import {test,expect,mock,spyOn} from 'bun:test';
import {serializeTransaction,keccak256,encodeFunctionData,encodeFunctionResult,parseAbi,toFunctionSelector} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';

function authorityResult(request:any){const entry=CONFIGURED_AUTHORITY_GETTERS.find(([target,name])=>target===request.params[0].to&&toFunctionSelector(`${name}()` )===request.params[0].data);if(!entry)throw Error('Unknown authority getter');const [,name,type,value]=entry;return encodeFunctionResult({abi:parseAbi([`function ${name}() view returns (${type})`]) as import('viem').Abi,functionName:name!,result:type==='address'?value:type==='uint32'?Number(value):BigInt(value!)});}

test('fixed transport sends captured bytes once and never retries ambiguous submission',async()=>{
  const policy=await import('./signer-policy'),evidence=await import('./signer-code-evidence');
  const code='0x6000',codeHash=keccak256(code);
  mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{}}));
  mock.module('./signer-code-evidence',()=>({TESTNET_SIGNER_CODE_EVIDENCE:{...evidence.TESTNET_SIGNER_CODE_EVIDENCE,
    contracts:Object.fromEntries(Object.keys(evidence.TESTNET_SIGNER_CODE_EVIDENCE.contracts).map(address=>[address,codeHash]))}}));
  try{
    const {createFixedTestnetTransport}=await import('./signer-rpc');
    const bytes=serializeTransaction({type:'eip1559',chainId:274630,to:BRAINCHAIN_CONTRACTS.testnet.contracts.brain,value:0n,nonce:0,
      data:encodeFunctionData({abi:policy.signerAbi,functionName:'faucet'}),gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},
      {r:'0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',s:`0x${'1'.padStart(64,'0')}`,yParity:0});
    let sent=0,ambiguous=false;const blockHash=`0x${'b'.repeat(64)}`;
    const fetcher=async(url:unknown,init?:RequestInit)=>{
      expect(url).toBe(BRAINCHAIN_CONTRACTS.testnet.rpc);
      const request=JSON.parse(String(init?.body));let result:unknown;
      switch(request.method){
        case 'eth_call':result=authorityResult(request);break;
        case 'eth_chainId':result='0x430c6';break;
        case 'eth_blockNumber':result='0x64';break;
        case 'eth_getBlockByNumber':result={number:'0x64',hash:blockHash,timestamp:`0x${Math.floor(Date.now()/1000).toString(16)}`};break;
        case 'eth_getCode':expect(request.params[1]).toBe('0x64');result=code;break;
        case 'eth_sendRawTransaction':sent++;expect(request.params).toEqual([bytes]);if(ambiguous)throw Error('Controlled connection loss after acceptance');result=keccak256(bytes);break;
        default:throw Error('Unexpected RPC');
      }
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
    };
    const transport=createFixedTestnetTransport({fetch:fetcher as typeof fetch,validateUrl:async url=>({ok:true,url})});
    expect(await transport.broadcastSameBytes(bytes,async()=>{})).toBe(keccak256(bytes));expect(sent).toBe(1);
    // Explicit dependencies prevent a shortened implementation map from weakening this regression.
    for(const [name,address] of [
      ['DecisionLog','0x4e4cb48f3802bd519e0eed896df82197b0ecbc09'],
      ['ModelRegistry','0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c'],
      ['TestUSDG','0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2'],
] as const){
      for(const returnedCode of ['0x','0x6001']){
        let targetedReads=0,authorityChecks=0;
        const rejecting=createFixedTestnetTransport({validateUrl:async url=>({ok:true,url}),fetch:(async(url,init)=>{
          const request=JSON.parse(String(init?.body));
          if(request.method==='eth_getCode'&&request.params[0].toLowerCase()===address){
            targetedReads++;return Response.json({jsonrpc:'2.0',id:request.id,result:returnedCode});
          }
          return fetcher(url,init);
        }) as typeof fetch});
        let refused=false;try{await rejecting.broadcastSameBytes(bytes,async()=>{authorityChecks++;});}catch{refused=true;}
        expect({name,refused,targetedReads,authorityChecks,sent}).toEqual({name,refused:true,targetedReads:1,authorityChecks:0,sent:1});
      }
    }
    for(const getter of ['owner','brain','attestation']){
      let changedReads=0,authorityChecks=0;
      const drifting=createFixedTestnetTransport({validateUrl:async url=>({ok:true,url}),fetch:(async(url,init)=>{
        const request=JSON.parse(String(init?.body));
        if(request.method==='eth_call'&&request.params[0].to==='0x4e4cb48f3802bd519e0eed896df82197b0ecbc09'&&request.params[0].data===toFunctionSelector(`${getter}()`)){
          changedReads++;return Response.json({jsonrpc:'2.0',id:request.id,result:encodeFunctionResult({abi:parseAbi([`function ${getter}() view returns (address)`]) as import('viem').Abi,functionName:getter,result:'0x'+'f'.repeat(40)})});
        }return fetcher(url,init);
      }) as typeof fetch});
      await expect(drifting.broadcastSameBytes(bytes,async()=>{authorityChecks++;})).rejects.toThrow('drift');
      expect(changedReads).toBe(1);expect(authorityChecks).toBe(0);expect(sent).toBe(1);
    }
    ambiguous=true;await expect(transport.broadcastSameBytes(bytes,async()=>{})).rejects.toThrow('unavailable');expect(sent).toBe(2);
    await Bun.sleep(20);expect(sent).toBe(2);
    let blocksBeforeSend=0,revoked=false,authorityChecks=0;
    const revoking=createFixedTestnetTransport({fetch:(async(url,init)=>{
      if(JSON.parse(String(init?.body)).method==='eth_getBlockByNumber')blocksBeforeSend++;
      return fetcher(url,init);
    }) as typeof fetch,validateUrl:async url=>{if(blocksBeforeSend===3)revoked=true;return{ok:true,url};}});
    await expect(revoking.broadcastSameBytes(bytes,async()=>{authorityChecks++;if(revoked)throw Error('owner authority revoked after URL validation');})).rejects.toThrow('unavailable');
    expect(authorityChecks).toBe(1);expect(sent).toBe(2);
    await expect(transport.broadcastSameBytes(bytes)).rejects.toThrow('Current broadcast authority');expect(sent).toBe(2);
    const initialNow=Date.now();let clock=initialNow;
    const time=spyOn(Date,'now').mockImplementation(()=>clock);
    try{
      async function expiresAt(stage:'code'|'dns'){
        clock=initialNow;let codeReads=0,blocks=0,submissions=0;
        const timestamp=`0x${(Math.floor(initialNow/1000)-119).toString(16)}`;
        const expiring=createFixedTestnetTransport({validateUrl:async url=>{
          if(stage==='dns'&&blocks===3&&clock===initialNow)clock+=2000;
          return{ok:true,url};
        },fetch:(async(_url,init)=>{
          const request=JSON.parse(String(init?.body));let result:unknown;
          switch(request.method){
            case 'eth_call':result=authorityResult(request);break;
        case 'eth_chainId':result='0x430c6';break;
            case 'eth_blockNumber':result='0x64';break;
            case 'eth_getBlockByNumber':blocks++;result={number:'0x64',hash:blockHash,timestamp};break;
            case 'eth_getCode':codeReads++;if(stage==='code'&&codeReads===5)clock+=2000;result=code;break;
            case 'eth_sendRawTransaction':submissions++;result=keccak256(bytes);break;
            default:throw Error('Unexpected RPC');
          }
          return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
        }) as typeof fetch});
        await expect(expiring.broadcastSameBytes(bytes,async()=>{})).rejects.toThrow(stage==='code'?'Fresh configured authority evidence required':'unavailable');
        expect(submissions).toBe(0);expect(clock-initialNow).toBe(2000);
      }
      await expiresAt('code');await expiresAt('dns');
      for(const mode of ['idle','expired','reorg'] as const){
        clock=initialNow;let blocks=0,sends=0;
        const provisional=createFixedTestnetTransport({validateUrl:async url=>({ok:true,url}),fetch:(async(_url,init)=>{
          const request=JSON.parse(String(init?.body));let result:unknown;
          if(request.method==='eth_call')result=authorityResult(request);
          else if(request.method==='eth_chainId')result='0x430c6';
          else if(request.method==='eth_blockNumber')result='0x64';
          else if(request.method==='eth_getCode')result=code;
          else if(request.method==='eth_getBlockByNumber'){
            blocks++;if(mode==='expired'&&blocks===4)clock+=30001;
            result={number:'0x64',hash:mode==='reorg'&&blocks===4?`0x${'c'.repeat(64)}`:blockHash,timestamp:'0x1'};
          }else if(request.method==='eth_sendRawTransaction'){sends++;result=keccak256(bytes);}
          else throw Error('Unexpected RPC');
          return Response.json({jsonrpc:'2.0',id:request.id,result});
        }) as typeof fetch},'nitro-testnet-latest-v1');
        if(mode==='idle')expect(await provisional.broadcastSameBytes(bytes,async()=>{})).toBe(keccak256(bytes));
        else await expect(provisional.broadcastSameBytes(bytes,async()=>{})).rejects.toThrow();
        expect(sends).toBe(mode==='idle'?1:0);expect(blocks).toBe(4);
      }

    }finally{time.mockRestore();}
  }finally{mock.restore();}
});
