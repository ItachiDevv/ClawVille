import {beforeAll,afterAll,expect,mock,test} from 'bun:test';
import {act,createElement} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Window} from 'happy-dom';
mock.module('@/lib/fingerprint',()=>({getFingerprint:async()=>'fixture'}));
mock.module('./brainchain-office.module.css',()=>({default:{}}));
let signed=0,beforeWallet:(()=>void)|undefined;
mock.module('@/lib/solana-wallet',()=>({signMessageWithSolanaWallet:async()=>{beforeWallet?.();signed++;return{signatureBase58:'fixture-proof'};}}));
const browser=new Window({url:'http://localhost/brainchain'}),originals=new Map<string,PropertyDescriptor|undefined>();
beforeAll(()=>{for(const name of ['window','document','navigator','Node','Element','HTMLElement','Event','MouseEvent','IS_REACT_ACT_ENVIRONMENT','fetch']){originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));if(name==='fetch')continue;Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:name==='window'?browser:name==='document'?browser.document:name==='IS_REACT_ACT_ENVIRONMENT'?true:(browser as unknown as Record<string,unknown>)[name]});}});
afterAll(()=>{browser.close();for(const[name,value]of originals){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}});
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
test('the human sees exact hashes and must confirm before linked wallet proof',async()=>{
 const id='00000000-0000-4000-8000-000000000001',hash='a'.repeat(64),calls:{url:string;init?:RequestInit}[]=[];
 const consent={id,workerId:id,resultId:id,state:'requested',payloadHash:hash,expiresAt:new Date(Date.now()+60000).toISOString(),executionEnabled:false,payload:{resultHash:'0x'+'b'.repeat(64),resultSha256:'c'.repeat(64),hireSnapshotHash:'d'.repeat(64),taskGeneration:1,signerGeneration:1,stages:['reconcile'],maxGasWei:'0',observationPolicy:'nitro-testnet-latest-v1',captured:null}};
 globalThis.fetch=(async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(url),init});if(String(url).endsWith('/challenge'))return Response.json({nonce:'e'.repeat(64),messageToSign:`exact-payload-sha256: ${hash}`,walletPubkey:'fixture-wallet',expiresAt:consent.expiresAt,consent});if(String(url).endsWith('/approve'))return Response.json({...consent,state:'approved'});return Response.json({consents:[consent],results:[]});}) as typeof fetch;
 const {createRoot}=await import('react-dom/client'),{OfficeWorkerRecovery}=await import('./office-worker-recovery'),client=new QueryClient(),container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 try{
 await act(async()=>{root.render(createElement(QueryClientProvider,{client},createElement(OfficeWorkerRecovery,{workerId:id,userId:'owner'})));await settle();});await act(settle);
 expect(calls).toHaveLength(1);expect(calls[0]!.init?.credentials).toBe('include');expect(signed).toBe(0);expect(container.textContent).toContain(consent.payload.resultHash);expect(container.textContent).toContain('does not resume a paused worker or restore revoked compute permissions');
 const button=[...container.querySelectorAll('button')].find(button=>button.textContent==='Approve with linked account wallet')!;expect(button.disabled).toBe(true);
 const checkbox=[...container.querySelectorAll('input')].find(input=>input.parentElement?.textContent?.includes('I approve this exact result'))!;
 await act(async()=>{checkbox.click();await settle();});await act(async()=>{button.click();await settle();});await act(settle);
 expect(signed).toBe(1);const approved=calls.find(call=>call.url.endsWith('/approve'))!;expect(JSON.parse(String(approved.init?.body))).toEqual({nonce:'e'.repeat(64),signature:'fixture-proof'});expect(client.getQueryCache().getAll().every(query=>query.queryKey.includes('owner'))).toBe(true);
 }finally{await act(async()=>root.unmount());client.clear();container.remove();}
});

async function renderRecovery(consents:unknown[]){
 const calls:{url:string;init?:RequestInit}[]=[];
 globalThis.fetch=(async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(url),init});const consent=consents[0] as {payloadHash:string;expiresAt:string};if(String(url).endsWith('/challenge'))return Response.json({nonce:'e'.repeat(64),messageToSign:`exact-payload-sha256: ${consent.payloadHash}`,walletPubkey:'fixture-wallet',expiresAt:consent.expiresAt,consent});if(String(url).endsWith('/approve'))return Response.json(consent);return Response.json({consents,results:[]});}) as typeof fetch;
 const {createRoot}=await import('react-dom/client'),{OfficeWorkerRecovery}=await import('./office-worker-recovery'),client=new QueryClient(),container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 await act(async()=>{root.render(createElement(QueryClientProvider,{client},createElement(OfficeWorkerRecovery,{workerId:'00000000-0000-4000-8000-000000000001',userId:'owner'})));await settle();});await act(settle);
 return{container,calls,async close(){beforeWallet=undefined;await act(async()=>root.unmount());client.clear();container.remove();}};
}
const recoveryView=(payload:Record<string,unknown>)=>({id:'00000000-0000-4000-8000-000000000002',resultId:'00000000-0000-4000-8000-000000000003',state:'requested',payloadHash:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),payload:{resultHash:'0x'+'b'.repeat(64),resultSha256:'c'.repeat(64),hireSnapshotHash:'d'.repeat(64),taskGeneration:1,signerGeneration:1,stages:['broadcast'],maxGasWei:'1000000000000000000',observationPolicy:'nitro-testnet-latest-v1',...payload}});
const term=(container:HTMLElement,name:string)=>[...container.querySelectorAll('dt')].find(node=>node.textContent===name)?.nextElementSibling?.textContent;
test('broadcast approval presents exact retained integers and hash before any wallet call',async()=>{
 signed=0;const captured={operationId:'00000000-0000-4000-8000-000000000004',nonce:'9007199254740993123',transactionHash:'0x'+'f'.repeat(64),gasWei:'57896044618658097711785492504343953926634992332820282019728792003956564819968',signedBytes:'never-render-signed-bytes'};
 const view=await renderRecovery([recoveryView({captured})]);
 try{
 beforeWallet=()=>{expect(term(view.container,'Operation ID')).toBe(captured.operationId);expect(term(view.container,'Reserved nonce')).toBe(captured.nonce);expect(term(view.container,'Transaction hash')).toBe(captured.transactionHash);expect(term(view.container,'Retained gas ceiling (wei)')).toBe(captured.gasWei);};
 expect(signed).toBe(0);expect(view.container.textContent).not.toContain(captured.signedBytes);
 const checkbox=[...view.container.querySelectorAll('input')].find(input=>input.parentElement?.textContent?.includes('I approve this exact result'))!;
 const button=[...view.container.querySelectorAll('button')].find(button=>button.textContent==='Approve with linked account wallet')!;
 await act(async()=>{checkbox.click();await settle();button.click();await settle();});await act(settle);expect(signed).toBe(1);
 }finally{await view.close();}
});
test('null reservation and capture differ from absent operation or unknown fields',async()=>{
 signed=0;const base=recoveryView({stages:['reconcile'],captured:{operationId:'operation-placeholder',nonce:null,transactionHash:null}}),view=await renderRecovery([base,{...base,id:'00000000-0000-4000-8000-000000000005',payload:{...base.payload,captured:null}},{...base,id:'00000000-0000-4000-8000-000000000006',payload:{...base.payload,captured:undefined}}]);
 try{expect(term(view.container,'Reserved nonce')).toBe('Not reserved');expect(term(view.container,'Transaction hash')).toBe('Not captured');expect(term(view.container,'Retained gas ceiling (wei)')).toBe('Unknown (not recorded)');expect(view.container.textContent).toContain('No retained submit operation in this consent.');expect(view.container.textContent).toContain('Retained submit operation: unknown (not recorded).');expect(signed).toBe(0);}finally{await view.close();}
});
test('capture intent exposes the exact unsigned transaction and fees',async()=>{
 signed=0;const captureIntent={version:1,operationId:'operation-fixture',chainId:274630,signer:'0x'+'1'.repeat(40),operationHash:'9'.repeat(64),to:'0x'+'2'.repeat(40),data:'0x'+'abcd'.repeat(500),value:'0',nonce:'9007199254740993',gas:'1234567890123456789',maxFeePerGas:'9876543210987654321',maxPriorityFeePerGas:'123456789123456789'};
 const view=await renderRecovery([recoveryView({stages:['capture-submit'],captured:null,captureIntent})]);
 try{expect(term(view.container,'Exact operation ID')).toBe(captureIntent.operationId);expect(term(view.container,'Original operation digest (SHA-256)')).toBe(captureIntent.operationHash);expect(term(view.container,'Chain ID')).toBe('274630');expect(term(view.container,'Signer')).toBe(captureIntent.signer);expect(term(view.container,'Destination')).toBe(captureIntent.to);expect(term(view.container,'Transaction value (wei)')).toBe('0');expect(term(view.container,'Exact nonce')).toBe(captureIntent.nonce);expect(term(view.container,'Gas limit')).toBe(captureIntent.gas);expect(term(view.container,'Maximum fee per gas (wei)')).toBe(captureIntent.maxFeePerGas);expect(term(view.container,'Maximum priority fee per gas (wei)')).toBe(captureIntent.maxPriorityFeePerGas);expect(view.container.querySelector('details code')?.textContent).toBe(captureIntent.data);expect(signed).toBe(0);}finally{await view.close();}
});

test('incomplete broadcast terms cannot reach the wallet even after confirmation',async()=>{
 signed=0;const view=await renderRecovery([recoveryView({captured:{operationId:'retained-operation',nonce:null,transactionHash:null,gasWei:'0'}})]);
 try{
 const checkbox=[...view.container.querySelectorAll('input')].find(input=>input.parentElement?.textContent?.includes('I approve this exact result'))!,button=[...view.container.querySelectorAll('button')].find(button=>button.textContent==='Approve with linked account wallet')!;
 await act(async()=>{checkbox.click();await settle();button.click();await settle();});
 expect(button.disabled).toBe(true);expect(signed).toBe(0);expect(view.calls.some(call=>call.url.endsWith('/challenge'))).toBe(false);expect(view.container.textContent).toContain('The retained broadcast transaction is unavailable.');
 }finally{await view.close();}
});


test('human request selector exposes capture-submit without calling the wallet',async()=>{
 signed=0;const view=await renderRecovery([]);
 try{const stage=[...view.container.querySelectorAll('label')].find(label=>label.textContent==='capture-submit');expect(stage).toBeDefined();await act(async()=>{stage!.querySelector('input')!.click();await settle();});expect(stage!.querySelector('input')!.checked).toBe(true);expect(signed).toBe(0);}finally{await view.close();}
});
