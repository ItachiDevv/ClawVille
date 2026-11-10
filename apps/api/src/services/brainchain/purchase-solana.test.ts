import { beforeAll, afterAll, expect, test } from 'bun:test';
import postgres, {type Sql} from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {BrainchainPurchases, type BuyerOwner} from './purchases';
import {BrainchainPurchaseClient} from './purchase-client';
import {type BuyerTaskBody} from './purchase-policy';
import {SOLANA_BUYER_LANE as L, selectSolanaBuyerQuote} from './purchase-solana-policy';
import {buildSolanaBuyerArtifact, decodeSolanaBuyerTransaction} from './purchase-solana-transaction';
import {solanaRpcFixture} from './purchase-solana-testhelpers';
import {admitOutboundVendorPayment, SOLANA_MAINNET} from '../outbound-x402';
const enabled = process.env.BRAINCHAIN_DB_FIXTURE === '1'; let sql: Sql;
const body = {title: 'Devnet fixture', brief: 'Controlled public brief.', levels: ['fail', 'pass']};
class Client extends BrainchainPurchaseClient {
  calls = 0; headers: string[] = [];
  override async quote(_body: BuyerTaskBody) { return selectSolanaBuyerQuote({x402Version: 2, resource: {url: L.endpoint}, accepts: [{scheme: 'exact', network: L.network, asset: L.token, payTo: L.recipient, amount: L.amountAtomic, maxTimeoutSeconds: 300, extra: {feePayer: L.feePayer}}]}); }
  override async send(_body: BuyerTaskBody, header: string, fence: () => Promise<void>): Promise<never> { await fence(); this.calls++; this.headers.push(header); throw new Error('controlled uncertain response'); }
}
function setup(payer: Keypair, execute = true) {
  const artifact = buildSolanaBuyerArtifact(payer.publicKey.toBase58(), {blockhash: Keypair.generate().publicKey.toBase58(), contextSlot: 100, lastValidBlockHeight: 200});
  const rpc = solanaRpcFixture(artifact), client = new Client();
  const s = new BrainchainPurchases(sql, {executeTestnet: execute, client, solanaRpc: rpc.rpc, codec: {seal: async value => ({enc: Buffer.from(value).toString('base64'), iv: 'fixture', tag: 'fixture'}), open: async value => Buffer.from(value.enc, 'base64').toString()}});
  return {s, client, rpc};
}
async function owner(approval = false): Promise<BuyerOwner> {
  const userId = randomUUID(), avatarId = randomUUID(); await sql`INSERT INTO users(id,is_guest) VALUES(${userId},false)`; await sql`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
  await sql`INSERT INTO user_spend_policies(avatar_id,daily_cap_usd_cents,per_call_cap_usd_cents,allowed_vendors,require_approval) VALUES(${avatarId},100,100,ARRAY['brainchain','studios'],${approval})`;
  return {avatarId, userId, actor: 'agent', assertCurrent: async () => {}};
}
async function draft(s: BrainchainPurchases, o: BuyerOwner) { const row = await s.draft(o, {idempotencyKey: randomUUID(), body, publicDataConsent: true, environment: 'testnet', network: L.network}); await s.quote(o, row.id); return row.id; }
async function capture(s: BrainchainPurchases, o: BuyerOwner, id: string, payer: Keypair) {
  const prepared = await s.intent(o, id, {payer: payer.publicKey.toBase58()});
  if (!prepared.terms || !('intentMessage' in prepared.terms)) throw new Error('Expected devnet signing material');
  const tx = decodeSolanaBuyerTransaction(prepared.terms.unsignedTransaction); tx.sign([payer]);
  await s.capture(o, id, {intentSignature: bs58.encode(nacl.sign.detached(Buffer.from(prepared.terms.intentMessage), payer.secretKey)), signedTransaction: Buffer.from(tx.serialize()).toString('base64')});
}
async function refuses(action: () => Promise<unknown>, code?: string) { let error: unknown; try { await action(); } catch (cause) { error = cause; } expect(error).toBeDefined(); if (code) expect((error as {code: string}).code).toBe(code); }
beforeAll(async () => {
  if (!enabled) return; const settings = await getBrainchainFixtureSettings(); sql = postgres(settings.url, {max: 8, onnotice: () => {}}); drizzle(sql);
  await sql`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,is_guest boolean NOT NULL DEFAULT false,linked_wallet_pubkey varchar(64),linked_wallet_at timestamptz)`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_wallet_at timestamptz`;
  await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS user_id uuid`; await sql`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false`;
  await sql`CREATE TABLE IF NOT EXISTS user_spend_policies(avatar_id uuid PRIMARY KEY,daily_cap_usd_cents integer,per_call_cap_usd_cents integer,allowed_vendors text[] NOT NULL,require_approval boolean NOT NULL)`;
  for (const name of ['0109_brainchain_buyer_orders.sql', '0111_brainchain_buyer_authority.sql', '0112_brainchain_solana_buyer.sql', '0115_brainchain_solana_buyer_discovery.sql', '0090_vendor_spend_ledger.sql']) await sql.unsafe(await readFile(new URL(`../../../../../packages/database/migrations/${name}`, import.meta.url), 'utf8'));
});
afterAll(async () => { if (sql) await sql.end(); });
test.skipIf(!enabled)('actual Drizzle devnet capture preserves frozen bytes through timeout/restart and refuses a replacement', async () => {
  const payer = Keypair.generate(), o = await owner(), {s, client, rpc} = setup(payer), id = await draft(s, o); await capture(s, o, id, payer);
  const [stored] = await sql`SELECT solana_artifact,captured FROM brainchain_buyer_orders WHERE id=${id}`; expect(stored!.solana_artifact.unsignedTransaction).toBeString();
  expect((await s.get(o, id)).chainId).toBeNull(); expect(JSON.stringify(await s.get(o, id))).not.toContain(stored!.solana_artifact.unsignedTransaction);
  await s.submit(o, id); expect(client.calls).toBe(1); expect((await s.get(o, id)).state).toBe('uncertain');
  const restarted = new BrainchainPurchases(sql, {executeTestnet: true, client, solanaRpc: rpc.rpc, codec: {seal: async () => {throw new Error();}, open: async value => Buffer.from(value.enc, 'base64').toString()}});
  await restarted.submit(o, id, true); expect(client.headers[1]).toBe(client.headers[0]);
  await refuses(() => s.intent(o, id, {payer: payer.publicKey.toBase58()}), 'order_conflict');
  await refuses(() => sql`UPDATE brainchain_buyer_orders SET solana_artifact='{}'::jsonb WHERE id=${id}`);
  await refuses(() => s.get({...o, avatarId: randomUUID()}, id));
});
test.skipIf(!enabled)('block-height expiry after capture stops dispatch and retains the original liability', async () => {
  const payer = Keypair.generate(), o = await owner(), {s, client, rpc} = setup(payer), id = await draft(s, o); await capture(s, o, id, payer);
  rpc.state.height = 201; await s.submit(o, id); expect(client.calls).toBe(0); expect((await s.get(o, id)).state).toBe('uncertain');
  expect((await sql`SELECT reserved_at FROM brainchain_buyer_orders WHERE id=${id}`)[0]!.reserved_at).not.toBeNull();
});
test.skipIf(!enabled)('S1 final identity waits cannot outlive frozen block height or blockhash validity', async () => {
  for (const change of ['height', 'blockhash'] as const) {
    const payer = Keypair.generate(), o = await owner(), {s, client, rpc} = setup(payer), id = await draft(s, o); await capture(s, o, id, payer);
    const [before] = await sql`SELECT capture_hash,captured,reserved_at FROM brainchain_buyer_orders WHERE id=${id}`;
    let finalFence = false;
    client.send = async (_body, header, fence): Promise<never> => {finalFence = true; await fence(); client.calls++; client.headers.push(header); throw new Error('controlled response');};
    o.assertCurrent = async () => {if (finalFence) {if (change === 'height') rpc.state.height = 201; else rpc.state.valid = false;}};
    expect((await s.submit(o, id)).state).toBe('uncertain'); expect(client.calls).toBe(0);
    const [after] = await sql`SELECT capture_hash,captured,reserved_at FROM brainchain_buyer_orders WHERE id=${id}`; expect(after).toEqual(before);
  }
});
test.skipIf(!enabled)('S1 account approval expiry during the final RPC wait still refuses dispatch', async () => {
  const payer = Keypair.generate(), human = nacl.sign.keyPair(), o = {...await owner(true), actor: 'human' as const}, {s, client, rpc} = setup(payer), id = await draft(s, o);
  await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(human.publicKey)},linked_wallet_at=clock_timestamp() WHERE id=${o.userId}`;
  await s.intent(o, id, {payer: payer.publicKey.toBase58()}); const challenge = await s.humanChallenge(o, id);
  await s.humanApprove(o, id, {nonce: challenge.nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign), human.secretKey))}); await capture(s, o, id, payer);
  await sql`UPDATE brainchain_buyer_orders SET human_approval_expires_at=clock_timestamp()+interval '1 second' WHERE id=${id}`;
  let finalFence = false; const read = rpc.rpc.read.bind(rpc.rpc);
  rpc.rpc.read = async (method, params) => {if (finalFence && method === 'getBlockHeight') await new Promise(resolve => setTimeout(resolve, 1200)); return read(method, params);};
  client.send = async (_body, header, fence): Promise<never> => {finalFence = true; await fence(); client.calls++; client.headers.push(header); throw new Error('controlled response');};
  expect((await s.submit(o, id)).state).toBe('uncertain'); expect(finalFence).toBe(true); expect(client.calls).toBe(0);
});
test.skipIf(!enabled)('human account approval differs from the devnet payer and rotation invalidates the captured proof', async () => {
  const payer = Keypair.generate(), human = nacl.sign.keyPair(), o = {...await owner(true), actor: 'human' as const}, {s, client} = setup(payer), id = await draft(s, o);
  await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(human.publicKey)},linked_wallet_at=clock_timestamp() WHERE id=${o.userId}`;
  expect((await s.intent(o, id, {payer: payer.publicKey.toBase58()})).terms).toBeNull();
  const challenge = await s.humanChallenge(o, id); expect(challenge.walletPubkey).not.toBe(payer.publicKey.toBase58());
  expect((await s.humanApprove(o, id, {nonce: challenge.nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign), human.secretKey))})).ok).toBe(true);
  await capture(s, o, id, payer); await sql`UPDATE users SET linked_wallet_pubkey=${Keypair.generate().publicKey.toBase58()} WHERE id=${o.userId}`;
  await refuses(() => s.submit(o, id), 'human_approval_required'); expect(client.calls).toBe(0);
});
test.skipIf(!enabled)('devnet and existing vendor admission share the same atomic cap in both directions and concurrently', async () => {
  const vendor = async (o: BuyerOwner) => admitOutboundVendorPayment({avatarId: o.avatarId, actor: 'agent', pin: {vendor: 'studios', payTo: [L.recipient], maxCallAtomic: 1000000n}, tool: 'fixture', idempotencyKey: randomUUID(), url: 'https://vendor.example.test', body: {}},
    {scheme: 'exact', network: SOLANA_MAINNET, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: L.recipient, amount: '1000000', maxTimeoutSeconds: 300, extra: {}}, 1000000n, 'fixture-payer', drizzle(sql) as unknown as NonNullable<Parameters<typeof admitOutboundVendorPayment>[4]>);
  for (const direction of ['vendor-first', 'buyer-first', 'race']) {
    const payer = Keypair.generate(), o = await owner(), {s} = setup(payer), id = await draft(s, o);
    const buyer = () => s.intent(o, id, {payer: payer.publicKey.toBase58()});
    if (direction === 'vendor-first') { expect((await vendor(o)).ok).toBe(true); await refuses(buyer, 'over_daily_cap'); }
    else if (direction === 'buyer-first') { await buyer(); expect((await vendor(o)).ok).toBe(false); }
    else { const outcomes = await Promise.allSettled([buyer(), vendor(o)]); expect(Number(outcomes[0]!.status === 'fulfilled') + Number(outcomes[1]!.status === 'fulfilled' && outcomes[1]!.value.ok)).toBe(1); }
  }
});
test.skipIf(!enabled)('no-ID empty history persists evidence without inventing an order or releasing the account hold',async()=>{
 const payer=Keypair.generate(),o=await owner(),{s,client,rpc}=setup(payer),id=await draft(s,o);await capture(s,o,id,payer);await s.submit(o,id);
 const read=rpc.rpc.read.bind(rpc.rpc);let historyReads=0;
 rpc.rpc.read=async(method,params,signal)=>{if(method==='getSignaturesForAddress'){historyReads++;return [];}return read(method,params,signal);};
 const result=await s.reconcile(o,id);expect(result.state).toBe('uncertain');expect(result.remoteOrder).toBeNull();expect(result.paymentTransaction).toBeNull();
 expect(result.recovery).toMatchObject({state:'not_found',refundRelease:'unavailable',refundReleaseReason:'order_attribution_unverified'});expect(historyReads).toBe(2);expect(client.calls).toBe(1);
 const [row]=await sql`SELECT solana_discovery,reserved_at FROM brainchain_buyer_orders WHERE id=${id}`;expect(row!.solana_discovery.cursor.messageHash).toBeString();expect(row!.reserved_at).not.toBeNull();
 const another=await draft(s,o);await refuses(()=>s.intent(o,another,{payer:payer.publicKey.toBase58()}),'over_daily_cap');
 const before=historyReads;await refuses(()=>s.reconcile({...o,avatarId:randomUUID()},id));expect(historyReads).toBe(before);
});
test.skipIf(!enabled)('no-ID unavailable history retains exact captured bytes and a refunded label never releases liability',async()=>{
 const payer=Keypair.generate(),o=await owner(),{s,rpc}=setup(payer),id=await draft(s,o);await capture(s,o,id,payer);await s.submit(o,id);
 const [before]=await sql`SELECT capture_hash,captured,reserved_at FROM brainchain_buyer_orders WHERE id=${id}`;
 const read=rpc.rpc.read.bind(rpc.rpc);rpc.rpc.read=async(method,params,signal)=>{if(method==='getSignaturesForAddress')throw new Error('controlled history unavailable');return read(method,params,signal);};
 const result=await s.reconcile(o,id);expect(result.recovery?.state).toBe('unavailable');expect(result.recovery?.refundRelease).toBe('unavailable');
 const [after]=await sql`SELECT capture_hash,captured,reserved_at FROM brainchain_buyer_orders WHERE id=${id}`;expect(after).toEqual(before);
 // Deliberately false accounting label: no chain receipt exists or is claimed.
 await sql`UPDATE brainchain_buyer_orders SET state='refunded',refund_transaction=${bs58.encode(nacl.sign.detached(Buffer.from('unverified-label-only'),payer.secretKey))} WHERE id=${id}`;
 expect((await s.get(o,id)).recovery?.refundRelease).toBe('unavailable');
 const another=await draft(s,o);await refuses(()=>s.intent(o,another,{payer:payer.publicKey.toBase58()}),'over_daily_cap');
});
