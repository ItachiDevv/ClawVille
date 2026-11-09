import { beforeAll,afterAll,expect,test } from 'bun:test';
import postgres,{type Sql} from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {admitOutboundVendorPayment,SOLANA_MAINNET} from '../outbound-x402';
import {readAccountSpendLiability,accountSpendLockKey} from '../account-spend-liability';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {BrainchainPurchases,type BuyerOwner} from './purchases';
import {BrainchainPurchaseClient} from './purchase-client';
import {BrainchainBuyerReceipts} from './purchase-receipts';
import {BUYER_LANE,selectBuyerQuote,type BuyerQuote,type BuyerTaskBody,type BuyerTerms} from './purchase-policy';
const enabled=process.env.BRAINCHAIN_DB_FIXTURE==='1';
let sql:Sql;
const account=privateKeyToAccount(generatePrivateKey());
const body={title:'Public fixture task',brief:'Controlled test data only.',levels:['fail','pass']};
function challenge(){return {x402Version:2,resource:{url:BUYER_LANE.endpoint},accepts:[{scheme:'exact',network:BUYER_LANE.network,asset:BUYER_LANE.token,payTo:BUYER_LANE.recipient,amount:'1000000',maxTimeoutSeconds:300,extra:{name:'USDC',version:'2'}}]};}
class Client extends BrainchainPurchaseClient { calls=0;headers:string[]=[];fail=true;remote=`0x${randomUUID().replaceAll('-','').repeat(2)}`;payment:string|undefined;refund:string|undefined;
 override async quote(_body:BuyerTaskBody):Promise<BuyerQuote>{return selectBuyerQuote(challenge());}
 override async send(_body:BuyerTaskBody,header:string){this.calls++;this.headers.push(header);if(this.fail)throw new Error('controlled transport failure');return {order:this.remote,state:'paid' as const};}
 override async order(order:string){return {order,state:'posted' as const,...(this.payment?{paymentTx:this.payment}:{}),...(this.refund?{refundTx:this.refund}:{})};}
}
class Receipts extends BrainchainBuyerReceipts { failRefund=false; override async verifyPayer(_payer:string){}; override async verify(transaction:string,_terms:BuyerTerms,kind:'payment'|'refund',_after?:bigint){if(kind==='refund'&&this.failRefund)throw new Error('controlled refund reorg');return {transaction,logIndex:0,blockNumber:kind==='payment'?'100':'101',blockHash:`0x${'ab'.repeat(32)}`,observedAt:new Date().toISOString(),headNumber:'200',headHash:`0x${'cd'.repeat(32)}`,headTimestamp:String(Math.floor(Date.now()/1000)),provisional:true as const};}}
function service(client=new Client(),execute=true){const receipts=new Receipts();return {client,receipts,service:new BrainchainPurchases(sql,{executeTestnet:execute,client,receipts,codec:{seal:async value=>({enc:Buffer.from(value).toString('base64'),iv:'controlled',tag:'controlled'}),open:async value=>Buffer.from(value.enc,'base64').toString()}})};}
async function owner(cap=200,approval=false):Promise<BuyerOwner>{const userId=randomUUID(),avatarId=randomUUID();await sql`INSERT INTO users(id,is_guest) VALUES(${userId},false)`;await sql`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;await sql`INSERT INTO user_spend_policies(avatar_id,daily_cap_usd_cents,per_call_cap_usd_cents,allowed_vendors,require_approval) VALUES(${avatarId},${cap},100,ARRAY['brainchain'],${approval})`;return {userId,avatarId,actor:'agent',assertCurrent:async()=>{}};}
async function draft(s:BrainchainPurchases,o:BuyerOwner,key=randomUUID()){return s.draft(o,{idempotencyKey:key,body,publicDataConsent:true,environment:'testnet',network:BUYER_LANE.network});}
async function reserved(s:BrainchainPurchases,o:BuyerOwner,payer=account.address){const row=await draft(s,o);await s.quote(o,row.id);return s.intent(o,row.id,{payer});}
async function captured(s:BrainchainPurchases,o:BuyerOwner){const signer=privateKeyToAccount(generatePrivateKey());const row=await reserved(s,o,signer.address);if(!row.terms||!('intent'in row.terms))throw new Error('Expected fixture unsigned terms');await s.capture(o,row.order.id,{intentSignature:await signer.signTypedData(row.terms.intent),paymentSignature:await signer.signTypedData(row.terms.payment)});return row.order.id;}
async function refuses(action:()=>Promise<unknown>,code?:string){let error:unknown;try{await action();}catch(cause){error=cause;}expect(error).toBeDefined();if(code)expect((error as {code:string}).code).toBe(code);}
beforeAll(async()=>{if(!enabled)return;const settings=await getBrainchainFixtureSettings();sql=postgres(settings.url,{max:8,onnotice:()=>{}});
 await sql`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,is_guest boolean NOT NULL DEFAULT false,linked_wallet_pubkey varchar(64))`;
 await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS user_id uuid`;await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false`;
 await sql`CREATE TABLE IF NOT EXISTS user_spend_policies(avatar_id uuid PRIMARY KEY,daily_cap_usd_cents integer,per_call_cap_usd_cents integer,allowed_vendors text[] NOT NULL,require_approval boolean NOT NULL)`;
 await sql`ALTER TABLE user_spend_policies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`;
 const migration=await readFile(new URL('../../../../../packages/database/migrations/0108_brainchain_buyer_orders.sql',import.meta.url),'utf8');await sql.unsafe(migration);await sql.unsafe(migration);
 await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_wallet_at timestamptz`;
 const authority=await readFile(new URL('../../../../../packages/database/migrations/0110_brainchain_buyer_authority.sql',import.meta.url),'utf8');await sql.unsafe(authority);await sql.unsafe(authority);
 const solana=await readFile(new URL('../../../../../packages/database/migrations/0111_brainchain_solana_buyer.sql',import.meta.url),'utf8');await sql.unsafe(solana);await sql.unsafe(solana);
 const vendor=await readFile(new URL('../../../../../packages/database/migrations/0090_vendor_spend_ledger.sql',import.meta.url),'utf8');await sql.unsafe(vendor);
 await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS signed_at timestamptz`;await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0`;await sql`ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS reconcile_next_at timestamptz`;
});
afterAll(async()=>{if(sql)await sql.end();});
test.skipIf(!enabled)('buyer owner/idempotency and disabled execution use actual database rows',async()=>{const o=await owner(),{service:s}=service();const key=randomUUID(),first=await draft(s,o,key);expect((await draft(s,o,key)).id).toBe(first.id);await refuses(()=>s.draft(o,{idempotencyKey:key,body:{...body,title:'Different'},publicDataConsent:true,environment:'testnet',network:BUYER_LANE.network}),'order_conflict');await refuses(()=>s.get({...o,avatarId:randomUUID()},first.id));const off=service(new Client(),false).service;await s.quote(o,first.id);await refuses(()=>off.intent(o,first.id,{payer:account.address}),'execution_disabled');expect((await s.get(o,first.id)).state).toBe('quoted');});
test.skipIf(!enabled)('concurrent intents reserve the daily cap once and issued signatures never cancel by expiry',async()=>{const o=await owner(100),{service:s}=service();const a=await draft(s,o),b=await draft(s,o);await s.quote(o,a.id);await s.quote(o,b.id);const outcomes=await Promise.allSettled([s.intent(o,a.id,{payer:account.address}),s.intent(o,b.id,{payer:account.address})]);expect(outcomes.filter(x=>x.status==='fulfilled').length).toBe(1);const selected=outcomes.find(x=>x.status==='fulfilled');if(selected?.status!=='fulfilled')throw new Error('missing reservation');await refuses(()=>s.cancel(o,selected.value.order.id),'order_conflict');expect((await s.get(o,selected.value.order.id)).state).toBe('reserved');});
test.skipIf(!enabled)('required human approval withholds typed payment and rejects agent approval',async()=>{const o=await owner(200,true),{service:s}=service();const held=await reserved(s,o);expect(held.terms).toBeNull();await refuses(()=>s.humanChallenge(o,held.order.id),'human_approval_required');});
test.skipIf(!enabled)('capture commits before send, uncertain restart retains exact bytes and duplicate dispatch refuses',async()=>{const o=await owner(),{service:s,client}=service();const id=await captured(s,o);expect((await s.get(o,id)).state).toBe('captured');expect(client.calls).toBe(0);const first=await s.submit(o,id);expect(first.state).toBe('uncertain');expect(client.calls).toBe(1);await refuses(()=>s.submit(o,id),'order_conflict');const next=service(client).service;client.fail=false;const recovered=await next.submit(o,id,true);expect(recovered.state).toBe('uncertain');expect(client.calls).toBe(2);expect(client.headers[0]).toBe(client.headers[1]);expect(recovered.remoteOrder).toBe(client.remote);expect(recovered.taskBoard).toBeNull();await refuses(()=>next.submit(o,id,true),'order_conflict');});
test.skipIf(!enabled)('session revocation after capture blocks dispatch without a provider call',async()=>{const o=await owner(),{service:s,client}=service();const id=await captured(s,o);o.assertCurrent=async()=>{throw new Error('expired fixture session');};await refuses(()=>s.submit(o,id));expect(client.calls).toBe(0);});
test.skipIf(!enabled)('policy revocation after capture retains the original hold',async()=>{const o=await owner(),{service:s,client}=service();const id=await captured(s,o);await sql`UPDATE user_spend_policies SET allowed_vendors=ARRAY[]::text[] WHERE avatar_id=${o.avatarId}`;await refuses(()=>s.submit(o,id),'owner_grant_required');expect(client.calls).toBe(0);expect((await s.get(o,id)).state).toBe('captured');});
test.skipIf(!enabled)('provisional full refund observation never reuses one receipt across orders',async()=>{const o=await owner(400),{service:s,client}=service();client.fail=false;const id=await captured(s,o);await s.submit(o,id);client.payment=`0x${randomUUID().replaceAll('-','').repeat(2)}`;client.refund=`0x${randomUUID().replaceAll('-','').repeat(2)}`;const result=await s.reconcile(o,id);expect(result.state).toBe('refunded');expect(result.refundTransaction).toBe(client.refund);const second=await captured(s,o);client.remote=`0x${randomUUID().replaceAll('-','').repeat(2)}`;await s.submit(o,second);await refuses(()=>s.reconcile(o,second),'order_conflict');expect((await s.get(o,second)).state).toBe('uncertain');});
test.skipIf(!enabled)('SQL refuses owner changes, null capture hashes and mutable evidence',async()=>{const o=await owner(),{service:s}=service();const held=await reserved(s,o),id=held.order.id;await refuses(()=>sql`UPDATE brainchain_buyer_orders SET avatar_id=${randomUUID()} WHERE id=${id}`);await refuses(()=>sql`UPDATE brainchain_buyer_orders SET captured='{}'::jsonb,captured_at=clock_timestamp(),state='captured' WHERE id=${id}`);await refuses(()=>sql`UPDATE brainchain_buyer_events SET evidence='{}'::jsonb WHERE order_id=${id}`);expect((await s.get(o,id)).state).toBe('reserved');});

test.skipIf(!enabled)('stored refund proof is rechecked when the desk omits its hash',async()=>{const o=await owner(),{service:s,client,receipts}=service();client.fail=false;const id=await captured(s,o);await s.submit(o,id);client.payment=`0x${randomUUID().replaceAll('-','').repeat(2)}`;client.refund=`0x${randomUUID().replaceAll('-','').repeat(2)}`;expect((await s.reconcile(o,id)).state).toBe('refunded');client.refund=undefined;receipts.failRefund=true;await refuses(()=>s.reconcile(o,id),'receipt_unavailable');expect((await s.get(o,id)).state).toBe('reorg_suspended');});

test.skipIf(!enabled)('human approval expiry during the final session read retains uncertainty without dispatch',async()=>{
 const o={...await owner(200,true),actor:'human' as const},human=nacl.sign.keyPair(),payer=privateKeyToAccount(generatePrivateKey()),{service:s,client}=service();
 await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(human.publicKey)} WHERE id=${o.userId}`;
 const row=await reserved(s,o,payer.address),challenge=await s.humanChallenge(o,row.order.id);
 const approval=await s.humanApprove(o,row.order.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),human.secretKey))});expect(approval.ok).toBe(true);
 const prepared=await s.intent(o,row.order.id,{payer:payer.address});if(!prepared.terms||!('intent'in prepared.terms))throw new Error('missing approved fixture terms');
 await s.capture(o,row.order.id,{intentSignature:await payer.signTypedData(prepared.terms.intent),paymentSignature:await payer.signTypedData(prepared.terms.payment)});
 await sql`UPDATE brainchain_buyer_orders SET human_approval_expires_at=clock_timestamp()+interval '1 second' WHERE id=${row.order.id}`;
 let reads=0;o.assertCurrent=async()=>{reads++;if(reads===7)await new Promise(resolve=>setTimeout(resolve,1200));};
 const result=await s.submit(o,row.order.id);expect(reads).toBeGreaterThanOrEqual(7);expect(client.calls).toBe(0);expect(result.state).toBe('uncertain');
});

async function approvedFixture(s:BrainchainPurchases,o:BuyerOwner){
 o.actor='human';const human=nacl.sign.keyPair(),payer=privateKeyToAccount(generatePrivateKey());
 await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(human.publicKey)},linked_wallet_at=clock_timestamp() WHERE id=${o.userId}`;
 const initial=await reserved(s,o,payer.address),id=initial.order.id;
 await approveFixture(s,o,id,human);
 const prepared=await s.intent(o,id,{payer:payer.address});if(!prepared.terms||!('intent'in prepared.terms))throw new Error('Missing approved fixture terms');
 return {id,human,signatures:{intentSignature:await payer.signTypedData(prepared.terms.intent),paymentSignature:await payer.signTypedData(prepared.terms.payment)}};
}
async function approveFixture(s:BrainchainPurchases,o:BuyerOwner,id:string,human:nacl.SignKeyPair){
 const challenge=await s.humanChallenge(o,id);const response=await s.humanApprove(o,id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),human.secretKey))});expect(response.ok).toBe(true);
}
test.skipIf(!enabled)('B1 wallet rotation, unlink, and away-and-back invalidate captured approval',async()=>{
 for(const change of ['rotate','unlink','away-back','same-key-proof'] as const){
  const o=await owner(200,true),{service:s,client}=service(),approved=await approvedFixture(s,o);await s.capture(o,approved.id,approved.signatures);
  const before=await sql`SELECT capture_hash,captured FROM brainchain_buyer_orders WHERE id=${approved.id}`;
  if(change==='same-key-proof')await sql`UPDATE users SET linked_wallet_at=clock_timestamp() WHERE id=${o.userId}`;
  else{await sql`UPDATE users SET linked_wallet_pubkey=${change==='unlink'?null:bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${o.userId}`;
   if(change==='away-back')await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(approved.human.publicKey)} WHERE id=${o.userId}`;}
  expect((await s.get(o,approved.id)).humanApproved).toBe(false);await refuses(()=>s.submit(o,approved.id),'human_approval_required');expect(client.calls).toBe(0);
  const after=await sql`SELECT capture_hash,captured FROM brainchain_buyer_orders WHERE id=${approved.id}`;expect(after[0]!.capture_hash).toBe(before[0]!.capture_hash);expect(after[0]!.captured).toEqual(before[0]!.captured);
 }
});
test.skipIf(!enabled)('B1 rotation before capture and legacy unbound proof refuse without signing replacement data',async()=>{
 const o=await owner(200,true),{service:s,client}=service(),approved=await approvedFixture(s,o);
 await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${o.userId}`;
 await refuses(()=>s.capture(o,approved.id,approved.signatures),'human_approval_required');expect(client.calls).toBe(0);
 await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(approved.human.publicKey)} WHERE id=${o.userId}`;
 await approveFixture(s,o,approved.id,approved.human);
 await sql`UPDATE brainchain_buyer_orders SET human_approval_wallet=NULL,human_approval_wallet_version=NULL WHERE id=${approved.id}`;
 await refuses(()=>s.capture(o,approved.id,approved.signatures),'human_approval_required');
 await refuses(()=>sql`UPDATE users SET linked_wallet_authority_version=0 WHERE id=${o.userId}`);
});
test.skipIf(!enabled)('B1 a fresh owner proof renews the frozen captured order without replacing bytes',async()=>{
 const o=await owner(200,true),{service:s}=service(),approved=await approvedFixture(s,o);await s.capture(o,approved.id,approved.signatures);
 const [before]=await sql`SELECT capture_hash,payment_nonce FROM brainchain_buyer_orders WHERE id=${approved.id}`;
 const next=nacl.sign.keyPair();await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(next.publicKey)} WHERE id=${o.userId}`;
 await approveFixture(s,o,approved.id,next);expect((await s.get(o,approved.id)).humanApproved).toBe(true);
 const [after]=await sql`SELECT capture_hash,payment_nonce FROM brainchain_buyer_orders WHERE id=${approved.id}`;expect(after).toEqual(before);
});
async function vendorPolicy(o:BuyerOwner){await sql`UPDATE user_spend_policies SET allowed_vendors=ARRAY['brainchain','studios'] WHERE avatar_id=${o.avatarId}`;}
function vendorAdmission(o:BuyerOwner,amount=1000000n){
 const recipient='HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa';
 return admitOutboundVendorPayment({avatarId:o.avatarId,actor:'agent',pin:{vendor:'studios',payTo:[recipient],maxCallAtomic:amount},tool:'fixture',idempotencyKey:randomUUID(),url:'https://vendor.example.test',body:{}},
  {scheme:'exact',network:SOLANA_MAINNET,asset:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',payTo:recipient,amount:String(amount),maxTimeoutSeconds:300,extra:{}},amount,'controlled-public-payer',drizzle(sql) as unknown as NonNullable<Parameters<typeof admitOutboundVendorPayment>[4]>);
}
test.skipIf(!enabled)('B2 vendor then buyer and buyer then vendor enforce the same global daily cap',async()=>{
 const first=await owner(100);await vendorPolicy(first);expect((await vendorAdmission(first)).ok).toBe(true);await refuses(()=>reserved(service().service,first),'over_daily_cap');
 const second=await owner(100);await vendorPolicy(second);await reserved(service().service,second);const refused=await vendorAdmission(second);expect(refused.ok).toBe(false);if(!refused.ok)expect(refused.code).toBe('over_daily_cap');
});
test.skipIf(!enabled)('B2 concurrent buyer and vendor admission reserve only one account cap',async()=>{
 const o=await owner(100);await vendorPolicy(o);const s=service().service,row=await draft(s,o);await s.quote(o,row.id);
 const [buyer,vendor]=await Promise.allSettled([s.intent(o,row.id,{payer:account.address}),vendorAdmission(o)]);
 const admitted=Number(buyer.status==='fulfilled')+Number(vendor.status==='fulfilled'&&vendor.value.ok);expect(admitted).toBe(1);
 const total=await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${accountSpendLockKey(o.avatarId)},0))`;return readAccountSpendLiability(tx,o.avatarId);});expect(total).toBe(1000000n);
});
test.skipIf(!enabled)('B2 old ambiguous and pending vendor liabilities carry, paid/failed rows follow their exact day policy',async()=>{
 for(const status of ['ambiguous','pending','paid','failed'] as const){const o=await owner(100);await vendorPolicy(o);const admitted=await vendorAdmission(o);if(!admitted.ok)throw new Error('fixture admission refused');
  await sql`UPDATE vendor_spend_ledger SET status=${status},created_at=clock_timestamp()-interval '2 days' WHERE id=${admitted.ledgerId}`;
  if(status==='pending'||status==='ambiguous')await refuses(()=>reserved(service().service,o),'over_daily_cap');else expect((await reserved(service().service,o)).order.state).toBe('reserved');
 }
});

test.skipIf(!enabled)('canonical factory retains the actual Drizzle pool and normalizes its JSON/timestamps',async()=>{
 const settings=await getBrainchainFixtureSettings(),o=await owner();
 const source=`
  const {getPostgresClient}=await import('@clawville/database');
  const {getBrainchainPurchases}=await import('./src/services/brainchain/purchases.ts');
  const pool=getPostgresClient();
  try{
   if(pool!==getPostgresClient())throw new Error('Pool identity changed');
   const [raw]=await pool\`SELECT clock_timestamp() AS now\`;
   if(typeof raw.now!=='string')throw new Error('Installed adapter composition absent');
   const owner={...${JSON.stringify({avatarId:o.avatarId,userId:o.userId,actor:'agent'})},assertCurrent:async()=>{}};
   const service=await getBrainchainPurchases();
   const drafted=await service.draft(owner,{idempotencyKey:${JSON.stringify(randomUUID())},body:${JSON.stringify(body)},publicDataConsent:true,environment:'testnet',network:'eip155:84532'});
   const read=await service.get(owner,drafted.id);
   if(read.brief!==${JSON.stringify(body.brief)}||!Number.isFinite(Date.parse(read.createdAt)))throw new Error('Factory round trip failed');
   process.stdout.write(JSON.stringify({samePool:true,bodyRoundTrip:true,dateRoundTrip:true,executionEnabled:service.availability().executionEnabled}));
  }finally{await pool.end();}
 `;
 const child=Bun.spawn({cmd:[process.execPath,'-e',source],cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,NODE_ENV:'production',DATABASE_URL:settings.url},stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{const [exit,out]=await Promise.all([child.exited,new Response(child.stdout).text()]);expect(exit).toBe(0);expect(JSON.parse(out)).toEqual({samePool:true,bodyRoundTrip:true,dateRoundTrip:true,executionEnabled:false});}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
});

test.skipIf(!enabled)('B2 exact atomic sum counts each vendor and buyer authorization once',async()=>{
 const o=await owner(150);await vendorPolicy(o);expect((await vendorAdmission(o,500000n)).ok).toBe(true);await reserved(service().service,o);
 const total=await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${accountSpendLockKey(o.avatarId)},0))`;return readAccountSpendLiability(tx,o.avatarId);});expect(total).toBe(1500000n);
 const extra=await vendorAdmission(o,1n);expect(extra.ok).toBe(false);if(!extra.ok)expect(extra.code).toBe('over_daily_cap');
});
test.skipIf(!enabled)('actual Drizzle serializers preserve full capture, final fences and receipt reconciliation',async()=>{
 drizzle(sql);const o=await owner(200,true),{service:s,client}=service(),approved=await approvedFixture(s,o);
 await s.capture(o,approved.id,approved.signatures);expect((await s.get(o,approved.id)).humanApproved).toBe(true);
 client.fail=false;expect((await s.submit(o,approved.id)).state).toBe('uncertain');expect(client.calls).toBe(1);
 client.payment=`0x${randomUUID().replaceAll('-','').repeat(2)}`;client.refund=`0x${randomUUID().replaceAll('-','').repeat(2)}`;
 const reconciled=await s.reconcile(o,approved.id);expect(reconciled.state).toBe('refunded');expect(Number.isFinite(Date.parse(reconciled.updatedAt))).toBe(true);
});

test.skipIf(!enabled)('captured order DTO follows a later owner restriction to require approval',async()=>{
 const o=await owner(),{service:s,client}=service(),id=await captured(s,o);await sql`UPDATE user_spend_policies SET require_approval=true WHERE avatar_id=${o.avatarId}`;
 const read=await s.get(o,id);expect(read.requiresHumanApproval).toBe(true);expect(read.humanApproved).toBe(false);await refuses(()=>s.submit(o,id),'human_approval_required');expect(client.calls).toBe(0);
});
