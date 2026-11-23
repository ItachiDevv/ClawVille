/** Controlled HTTP only. Run alone because the last test mocks activation inside its process. */
import {test,expect,mock} from 'bun:test';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {resultDigests,resultUploadMessage,resultSubmission,validateResultUri,createResultUploadTransport,RESULT_SERVICE} from './task-delivery-protocol';

test('exact output bytes and observed URI format remain bound to result identity',()=>{
  const text=' result\n',digest=resultDigests(text),board=BRAINCHAIN_CONTRACTS.testnet.contracts.board;
  expect(resultDigests(text.trim()).hash).not.toBe(digest.hash);
  expect(resultUploadMessage(board,'1',digest.hash)).toBe(`BrainChain result v2\nchain 274630\nboard ${board}\ntask 1\nhash ${digest.hash}`);
  expect(()=>resultDigests('\ud800')).toThrow();expect(()=>resultDigests('a\0b')).toThrow();expect(()=>resultDigests('a'.repeat(32769))).toThrow();
  expect(()=>resultUploadMessage(BRAINCHAIN_CONTRACTS.mainnet.contracts.board,'1',digest.hash)).toThrow();
  expect(()=>validateResultUri(`${RESULT_SERVICE}/records/${digest.hash}.txt?redirect=evil`,digest.hash)).toThrow();
  expect(()=>resultSubmission(board,'1',digest.hash,`${RESULT_SERVICE}/admin`)).toThrow();
});
test('closed activation refuses upload without invoking fetch',async()=>{
  let calls=0;const adapter=createResultUploadTransport({fetch:(async()=>{calls++;throw Error('must not run');}) as unknown as typeof fetch});
  await expect(adapter.upload({task:'1',text:'fixture',hash:resultDigests('fixture').hash,signature:`0x${'0'.repeat(130)}`})).rejects.toThrow('artifact equivalence');expect(calls).toBe(0);
});
test('fixed transport sends exact text and rejects redirects, wrong hashes, paths, and oversized replies',async()=>{
  const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{}}));
  try{
    const text=' fixture\n',hash=resultDigests(text).hash,input={task:'1',text,hash,signature:`0x${'0'.repeat(130)}` as const};
    let calls=0;
    function adapter(response:()=>Response){return createResultUploadTransport({validateUrl:async url=>({ok:true,url}),fetch:(async(url,init)=>{
      calls++;expect(url).toBe(`${RESULT_SERVICE}/results`);expect(init?.redirect).toBe('manual');expect(init?.credentials).toBe('omit');
      expect(JSON.parse(String(init?.body))).toEqual({task:'1',text,signature:input.signature});return response();
    }) as typeof fetch});}
    const good={hash,uri:`${RESULT_SERVICE}/records/${hash}.txt`};
    expect(await adapter(()=>Response.json(good)).upload(input)).toEqual(good);
    for(const response of [()=>new Response(null,{status:302,headers:{location:'https://example.com'}}),()=>Response.json({...good,hash:`0x${'f'.repeat(64)}`}),
      ()=>Response.json({...good,uri:`${RESULT_SERVICE}/records/${hash}.txt#extra`}),()=>Response.json({...good,uri:`https://example.com/records/${hash}.txt`}),
      ()=>new Response('a'.repeat(8193),{headers:{'content-type':'application/json'}})])
      await expect(adapter(response).upload(input)).rejects.toThrow('uncertain');
    expect(calls).toBe(6);
  }finally{mock.restore();}
});
