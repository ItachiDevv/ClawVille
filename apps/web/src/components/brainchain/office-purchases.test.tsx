import {afterAll,afterEach,beforeAll,beforeEach,expect,mock,test} from 'bun:test';
import {createElement,act} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Window} from 'happy-dom';
import type {Root} from 'react-dom/client';
mock.module('@/lib/fingerprint',()=>({getFingerprint:async()=>''}));
mock.module('./brainchain-office.module.css',()=>({default:{}}));
const browser=new Window({url:'http://localhost/brainchain'}),names=['window','document','navigator','Node','Element','HTMLElement','Event','MouseEvent','IS_REACT_ACT_ENVIRONMENT','fetch'] as const;
const originals=new Map<string,PropertyDescriptor|undefined>();let createRoot:typeof import('react-dom/client').createRoot,OfficePurchases:typeof import('./office-purchases').OfficePurchases,root:Root,container:HTMLElement,client:QueryClient;
let recovery=false;let postBodies:unknown[]=[];let solana=false;let enabled=false,rowState='quoted';let guest=false,calls:string[]=[],pending:((r:Response)=>void)|null=null,signal:AbortSignal|null=null;
const auth=(id:string)=>({user:{id,isGuest:guest,email:null,name:id,username:id,emailVerified:true}});
const order={id:'00000000-0000-4000-8000-000000000001',environment:'testnet',chainId:84532,state:'quoted',title:'<script>public task</script>',brief:'public requirements',levels:['fail','pass'],bodyHash:'a'.repeat(64),payer:null,amountAtomic:'1000000',quoteExpiresAt:null,authorizationExpiresAt:null,remoteOrder:null,remoteState:null,taskId:null,taskBoard:null,paymentTransaction:null,refundTransaction:null,provisional:true,requiresHumanApproval:true,humanApproved:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
beforeAll(async()=>{for(const name of names)originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));for(const name of ['window','document','navigator','Node','Element','HTMLElement','Event','MouseEvent']as const)Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:name==='window'?browser:name==='document'?browser.document:browser[name]});Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{configurable:true,value:true});createRoot=(await import('react-dom/client')).createRoot;OfficePurchases=(await import('./office-purchases')).OfficePurchases;});
beforeEach(()=>{recovery=false;postBodies=[];solana=false;enabled=false;rowState='quoted';guest=false;calls=[];pending=null;signal=null;globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{const path=new URL(String(input),'http://localhost').pathname;if(path==='/api/auth/me')return Response.json(auth('owner-a'));if(init?.method==='POST'){calls.push(path);postBodies.push(JSON.parse(String(init.body)));signal=init.signal??null;return new Promise<Response>(resolve=>{pending=resolve;});}return Response.json({orders:[{...order,state:rowState,...(solana?{network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',chainId:null}:{}),...(recovery?{recovery:{state:'not_found',checkedAt:new Date().toISOString(),scannedTransactions:0,hasMore:false,refundRelease:'unavailable',refundReleaseReason:'order_attribution_unverified'}}:{})}],availability:{environment:'testnet',network:'eip155:84532',executionEnabled:enabled,unsupported:[]}});}) as unknown as typeof fetch;client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();container.remove();});
afterAll(()=>{browser.close();for(const name of names){const original=originals.get(name);if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);}});
async function render(){
 await act(async()=>{root.render(createElement(QueryClientProvider,{client},createElement(OfficePurchases)));await Promise.resolve();});
 for(let turn=0;turn<50;turn++){await act(async()=>{await new Promise(r=>setTimeout(r,20));});if(guest?container.textContent?.includes('Sign in'):container.textContent?.includes(order.title))return;}
 throw new Error('Purchase panel did not reach its fixture state');
}
const button=(label:string)=>[...container.querySelectorAll('button')].find(item=>item.textContent===label)!;
test('guests cannot create an order or access payer controls',async()=>{guest=true;await render();expect(container.textContent).toContain('Sign in');expect(container.querySelector('form')).toBeNull();expect(calls).toHaveLength(0);});
test('the real panel shows test tokens and blocks money controls under the release gate',async()=>{await render();expect(container.textContent).toContain('1 test USDC');expect(container.textContent).toContain('await the payment review');expect(button('Approve test purchase').disabled).toBe(true);expect(button('Request unpaid quote').disabled).toBe(false);expect(container.querySelector('script')).toBeNull();expect(calls).toHaveLength(0);});
test('quote uses the own-order route and aborts when the account changes',async()=>{await render();await act(async()=>{button('Request unpaid quote').click();await Promise.resolve();});expect(calls).toEqual([`/api/brainchain/purchases/${order.id}/quote`]);expect(pending).not.toBeNull();await act(async()=>{client.setQueryData(['auth-me'],auth('owner-b'));await new Promise(r=>setTimeout(r,10));});expect(signal?.aborted).toBe(true);await act(async()=>{pending!(Response.json({order}));await new Promise(r=>setTimeout(r,10));});expect(button('Request unpaid quote').disabled).toBe(false);});

test('a captured purchase with revoked approval needs a fresh account proof before submit',async()=>{
 enabled=true;rowState='captured';await render();expect(button('Approve account spend').disabled).toBe(false);expect(button('Submit saved test authorization').disabled).toBe(true);
 await act(async()=>{button('Approve account spend').click();await Promise.resolve();});expect(calls).toEqual([`/api/brainchain/purchases/${order.id}/approval-challenge`]);
});


test('Solana devnet orders keep their explicit network and the same disabled money controls',async()=>{
 solana=true;await render();expect(container.textContent).toContain('Solana devnet: quoted');expect(button('Approve test purchase').disabled).toBe(true);
 const select=container.querySelector('select')!;expect([...select.options].map(option=>option.textContent)).toEqual(['Base Sepolia','Solana devnet']);
 await act(async()=>{select.value='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(container.textContent).toContain('Both token accounts must already exist');expect(calls).toHaveLength(0);
});


test('missing-ID recovery uses a read-only own-order reconciliation while refund release remains unavailable',async()=>{
 solana=true;recovery=true;rowState='uncertain';await render();expect(container.textContent).toContain('This scan found no exact payment. The hold remains reserved.');expect(container.textContent).toContain('Refund budget release is unavailable');
 expect(button('Search original payment history').disabled).toBe(false);await act(async()=>{button('Search original payment history').click();await Promise.resolve();});
 expect(calls).toEqual([`/api/brainchain/purchases/${order.id}/reconcile`]);expect(postBodies).toEqual([{}]);
 await act(async()=>{pending!(Response.json({order}));await Promise.resolve();});
});
test('human draft submits the exact best-first level order from the pinned desk contract',async()=>{
 await render();const title=container.querySelector('input[maxlength="120"]')!,brief=container.querySelector('textarea')!,consent=container.querySelector('input[type="checkbox"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value')!.set!.call(title,'New title');title.dispatchEvent(new browser.Event('input',{bubbles:true}) as unknown as Event);
  Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value')!.set!.call(brief,'New public brief');brief.dispatchEvent(new browser.Event('input',{bubbles:true}) as unknown as Event);
  (consent as HTMLInputElement).click();
 });
 await act(async()=>{container.querySelector('form')!.dispatchEvent(new browser.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await Promise.resolve();});
 expect(calls).toEqual(['/api/brainchain/purchases']);expect(postBodies[0]).toMatchObject({body:{title:'New title',brief:'New public brief',levels:['Accurate and complete','Incorrect or incomplete']},publicDataConsent:true,network:'eip155:84532'});
 await act(async()=>{pending!(Response.json({order}));await Promise.resolve();});
});
