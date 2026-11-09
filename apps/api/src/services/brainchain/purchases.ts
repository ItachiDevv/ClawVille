import { SOLANA_BUYER_LANE as SOL, solanaBuyerAddress } from './purchase-solana-policy';
import { SolanaBuyerDiscovery,type SolanaDiscoveryObservation } from './purchase-solana-discovery';
import { SolanaBuyerRpc } from './purchase-solana-rpc';
import { SolanaBuyerReceipts,type SolanaBuyerReceiptEvidence } from './purchase-solana-receipts';
import { buildSolanaBuyerArtifact, solanaBuyerIntent, verifySolanaBuyerIntent, verifySolanaBuyerTransaction, type SolanaBuyerArtifact } from './purchase-solana-transaction';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { BrainchainBuyerOrder, BrainchainBuyerState } from '@clawville/shared';
import { BUYER_LANE, BrainchainPurchaseError, buyerAddress, buyerDigest, buyerHumanApprovalMessage, buyerPaymentHeader, buyerTypedData,
  canonical, createBuyerTerms, purchaseBodySchema, verifyBuyerSignatures, type BuyerTaskBody, type BuyerQuote, type BuyerTerms } from './purchase-policy';
import { BrainchainPurchaseClient, type BuyerRemoteOrder } from './purchase-client';
import { BrainchainBuyerReceipts, type BuyerReceiptEvidence } from './purchase-receipts';
import {accountSpendLockKey,readAccountSpendLiability} from '../account-spend-liability';
import { BRAINCHAIN_CONTRACTS } from './contracts';
export interface BuyerOwner { avatarId:string;userId:string;actor:'human'|'agent'; assertCurrent:()=>Promise<void> }
type Cipher={enc:string;iv:string;tag:string};
export interface BuyerCaptureCodec {seal(value:string):Promise<Cipher>;open(value:Cipher):Promise<string>}
type BuyerRow={id:string;avatar_id:string;user_id:string;actor:'human'|'agent';idempotency_key:string;body:BuyerTaskBody;body_hash:string;state:BrainchainBuyerState;quote:BuyerQuote|null;quote_expires_at:Date|null;
 network:string;solana_artifact:SolanaBuyerArtifact|null;solana_discovery:{cursor:unknown;observation:SolanaDiscoveryObservation}|null;payer:string|null;terms:BuyerTerms|null;payment_nonce:string|null;valid_before:Date|null;reserved_at:Date|null;requires_human_approval:boolean;human_nonce:string|null;human_approved_at:Date|null;human_approval_expires_at:Date|null;human_approval_wallet:string|null;human_approval_wallet_version:string|null;
 captured:Cipher|null;capture_hash:string|null;captured_at:Date|null;send_generation:number;lease_owner:string|null;lease_until:Date|null;first_send_at:Date|null;last_send_at:Date|null;
 remote_order:string|null;remote_state:string|null;task_id:string|null;task_board:string|null;payment_transaction:string|null;payment_block_hash:string|null;payment_block:string|null;refund_transaction:string|null;created_at:Date;updated_at:Date};
const buyerTimestampColumns=['quote_expires_at','valid_before','reserved_at','human_approved_at','human_approval_expires_at','captured_at','lease_until','first_send_at','last_send_at','created_at','updated_at'] as const;
function buyerTimestamp(value:unknown):Date{
  if(!(value instanceof Date)&&typeof value!=='string')throw new BrainchainPurchaseError('purchase_unavailable');
  const parsed=value instanceof Date?value:new Date(value);if(!Number.isFinite(parsed.getTime()))throw new BrainchainPurchaseError('purchase_unavailable');return parsed;
}
/** Installed Drizzle uses transparent timestamp parsers on its retained postgres.js pool. */
function normalizeBuyerRow(row:BuyerRow):BuyerRow{
  for(const key of buyerTimestampColumns)if(row[key]!==null)row[key]=buyerTimestamp(row[key]);
  row.body=purchaseBodySchema.parse(row.body);return row;
}
const ownerSchema=z.object({avatarId:z.string().uuid(),userId:z.string().uuid(),actor:z.enum(['human','agent'])}).strict();
const idSchema=z.string().uuid();
const draftSchema=z.object({idempotencyKey:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),body:purchaseBodySchema,publicDataConsent:z.literal(true),environment:z.literal('testnet'),network:z.enum([BUYER_LANE.network,SOL.network])}).strict();
const solanaCaptureSchema=z.object({intentSignature:z.string().min(64).max(88),signedTransaction:z.string().min(100).max(1644)}).strict();
const captureSchema=z.object({intentSignature:z.string().regex(/^0x[0-9a-fA-F]{130}$/),paymentSignature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict();
/** Root-reviewed release gate. Test constructors use controlled transports; no automatic activation exists. */
export const BRAINCHAIN_TESTNET_PURCHASE_EXECUTION=false;
// FEATURE_GATE: brainchain_testnet_purchases
// Status: implementation under independent money-path review; live submission disabled.
// Metric to graduate: one authorized test-token purchase plus result/refund/recovery evidence and independent audit.
// Current reading: no owned test-token purchase; source/fixture evidence only (2026-11-09).
// Review deadline: 2026-11-16
// On deadline: remove the inactive submission surface unless root supplies reviewed activation evidence.
// Reference: docs/brainchain-purchase-design.md
export class BrainchainPurchases {
  private readonly walletContexts=new WeakMap<TransactionSql,{wallet:string|null;version:string;requireApproval:boolean}>();
  private readonly solanaDiscovery:SolanaBuyerDiscovery;private readonly solanaRpc:SolanaBuyerRpc;private readonly solanaReceipts:SolanaBuyerReceipts;
  private readonly client:BrainchainPurchaseClient;private readonly receipts:BrainchainBuyerReceipts;private readonly codec:BuyerCaptureCodec;private readonly execute:boolean;
  constructor(private readonly database:Sql,options:{client?:BrainchainPurchaseClient;receipts?:BrainchainBuyerReceipts;codec?:BuyerCaptureCodec;executeTestnet?:boolean;solanaRpc?:SolanaBuyerRpc;solanaReceipts?:SolanaBuyerReceipts}={}){
    this.solanaRpc=options.solanaRpc??new SolanaBuyerRpc();this.solanaReceipts=options.solanaReceipts??new SolanaBuyerReceipts(this.solanaRpc);this.solanaDiscovery=new SolanaBuyerDiscovery(this.solanaRpc,this.solanaReceipts);
    this.client=options.client??new BrainchainPurchaseClient();this.receipts=options.receipts??new BrainchainBuyerReceipts();this.execute=options.executeTestnet??BRAINCHAIN_TESTNET_PURCHASE_EXECUTION;
    this.codec=options.codec??{seal:async value=>{const {encryptToken}=await import('../keypair-vault');return encryptToken(value);},open:async value=>{const {decryptToken}=await import('../keypair-vault');return decryptToken(value.enc,value.iv,value.tag);}};
  }
  availability(){return {environment:'testnet' as const,network:BUYER_LANE.network,networks:[BUYER_LANE.network,SOL.network],executionEnabled:this.execute,unsupported:['mainnet','robinhood','permit2','solana_mainnet','contract_wallet']};}
  private async context(tx:TransactionSql,raw:BuyerOwner){const owner=ownerSchema.parse({avatarId:raw.avatarId,userId:raw.userId,actor:raw.actor});
    if(typeof raw.assertCurrent!=='function')throw new BrainchainPurchaseError('owner_grant_required');
    await tx`SET LOCAL lock_timeout='2000ms'`;await tx`SET LOCAL statement_timeout='5000ms'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${accountSpendLockKey(owner.avatarId)},0))`;
    const [subject]=await tx`SELECT a.id,u.linked_wallet_pubkey,u.linked_wallet_authority_version::text AS wallet_version,p.require_approval FROM avatars a JOIN users u ON u.id=a.user_id LEFT JOIN user_spend_policies p ON p.avatar_id=a.id WHERE a.id=${owner.avatarId} AND u.id=${owner.userId} AND a.is_guest=false AND u.is_guest=false FOR UPDATE OF a,u`;
    if(!subject)throw new BrainchainPurchaseError('owner_grant_required');this.walletContexts.set(tx,{wallet:subject.linked_wallet_pubkey as string|null,version:String(subject.wallet_version),requireApproval:subject.require_approval!==false});await raw.assertCurrent();return {owner,wallet:subject.linked_wallet_pubkey as string|null,walletVersion:String(subject.wallet_version)};
  }
  private async clock(tx:TransactionSql){const [row]=await tx<{now:Date|string}[]>`SELECT clock_timestamp() AS now`;if(!row)throw new BrainchainPurchaseError('purchase_unavailable');return {now:buyerTimestamp(row.now)};}
  private async lock(tx:TransactionSql,owner:BuyerOwner,id:string):Promise<BuyerRow>{await this.context(tx,owner);idSchema.parse(id);
    const [known]=await tx<{payer:string|null;network:string}[]>`SELECT payer,network FROM brainchain_buyer_orders WHERE id=${id} AND avatar_id=${owner.avatarId} AND user_id=${owner.userId}`;
    if(!known)throw new BrainchainPurchaseError('purchase_not_found');
    if(known.payer)await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-buyer:${known.network??BUYER_LANE.network}:${known.payer}`},0))`;
    const [row]=await tx<BuyerRow[]>`SELECT * FROM brainchain_buyer_orders WHERE id=${id} AND avatar_id=${owner.avatarId} AND user_id=${owner.userId} FOR UPDATE`;
    if(!row)throw new BrainchainPurchaseError('purchase_not_found');normalizeBuyerRow(row);await owner.assertCurrent();return row;
  }
  private async policy(tx:TransactionSql,owner:BuyerOwner,row?:BuyerRow,admit=false){
    const [policy]=await tx`SELECT daily_cap_usd_cents,per_call_cap_usd_cents,allowed_vendors,require_approval FROM user_spend_policies WHERE avatar_id=${owner.avatarId}`;
    if(!policy||policy.daily_cap_usd_cents===null||policy.per_call_cap_usd_cents===null||!policy.allowed_vendors?.includes('brainchain'))throw new BrainchainPurchaseError('owner_grant_required');
    const amount=BigInt(BUYER_LANE.amountAtomic);
    if(amount>BigInt(policy.per_call_cap_usd_cents)*10000n)throw new BrainchainPurchaseError('over_per_call_cap');
    const total=await readAccountSpendLiability(tx,owner.avatarId);
    if(total+(admit?amount:0n)>BigInt(policy.daily_cap_usd_cents)*10000n)throw new BrainchainPurchaseError('over_daily_cap');
    const policyClock=await this.clock(tx);
    if(row&&policy.require_approval&&(!row.human_approved_at||!row.human_approval_expires_at||row.human_approval_expires_at<=policyClock!.now))throw new BrainchainPurchaseError('human_approval_required');
    if(row&&policy.require_approval)await this.approvalWallet(tx,owner,row);
    return {requireApproval:policy.require_approval===true};
  }
  private async approvalWallet(tx:TransactionSql,owner:BuyerOwner,row:BuyerRow){
    const [current]=await tx`SELECT linked_wallet_pubkey,linked_wallet_authority_version::text AS version FROM users WHERE id=${owner.userId} FOR UPDATE`;
    if(!current?.linked_wallet_pubkey||!row.human_approval_wallet||row.human_approval_wallet_version===null||current.linked_wallet_pubkey!==row.human_approval_wallet||current.version!==String(row.human_approval_wallet_version))throw new BrainchainPurchaseError('human_approval_required');
  }
  private view(tx:TransactionSql,row:BuyerRow):BrainchainBuyerOrder{normalizeBuyerRow(row);const current=this.walletContexts.get(tx);return {id:row.id,environment:'testnet',chainId:row.network===SOL.network?null:84532,network:row.network===SOL.network?SOL.network:BUYER_LANE.network,state:row.state,title:row.body.title,brief:row.body.brief,levels:row.body.levels,bodyHash:row.body_hash,payer:row.payer,
    amountAtomic:BUYER_LANE.amountAtomic,quoteExpiresAt:row.quote_expires_at?.toISOString()??null,authorizationExpiresAt:row.valid_before?.toISOString()??null,remoteOrder:row.remote_order,remoteState:row.remote_state,
    taskId:row.task_id,taskBoard:row.task_board,paymentTransaction:row.payment_transaction,refundTransaction:row.refund_transaction,provisional:true,...(row.network===SOL.network?{recovery:{...(row.solana_discovery?.observation??{state:'not_started' as const,checkedAt:null,scannedTransactions:0,hasMore:true}),refundRelease:'unavailable' as const,refundReleaseReason:'order_attribution_unverified' as const}}:{}),requiresHumanApproval:current?.requireApproval??row.requires_human_approval,
    humanApproved:!!current?.wallet&&current.wallet===row.human_approval_wallet&&current.version===String(row.human_approval_wallet_version)&&!!row.human_approved_at&&!!row.human_approval_expires_at&&row.human_approval_expires_at.getTime()>Date.now(),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
  private async event(tx:TransactionSql,id:string,kind:string,evidence:unknown,receipt?:BuyerReceiptEvidence){await tx`INSERT INTO brainchain_buyer_events(order_id,kind,evidence,transaction,log_index)
    VALUES(${id},${kind},${tx.typed(canonical(evidence),25)}::jsonb,${receipt?.transaction??null},${receipt?.logIndex??null})`;}
  async list(owner:BuyerOwner){return this.database.begin(async tx=>{await this.context(tx,owner);const rows=await tx<BuyerRow[]>`SELECT * FROM brainchain_buyer_orders WHERE avatar_id=${owner.avatarId} AND user_id=${owner.userId} ORDER BY created_at DESC LIMIT 30`;return {orders:rows.map(row=>this.view(tx,row)),availability:this.availability()};});}
  async get(owner:BuyerOwner,id:string){return this.database.begin(async tx=>this.view(tx,await this.lock(tx,owner,id)));}
  async draft(owner:BuyerOwner,raw:unknown){const input=draftSchema.parse(raw),bodyHash=buyerDigest(input.body);return this.database.begin(async tx=>{await this.context(tx,owner);
    const [old]=await tx<BuyerRow[]>`SELECT * FROM brainchain_buyer_orders WHERE avatar_id=${owner.avatarId} AND idempotency_key=${input.idempotencyKey}`;
    if(old){if(old.user_id!==owner.userId||old.body_hash!==bodyHash||old.network!==input.network)throw new BrainchainPurchaseError('order_conflict');return this.view(tx,old);}
    const [row]=await tx<BuyerRow[]>`INSERT INTO brainchain_buyer_orders(id,avatar_id,user_id,actor,idempotency_key,body,body_hash,network) VALUES(${randomUUID()},${owner.avatarId},${owner.userId},${owner.actor},${input.idempotencyKey},${tx.typed(canonical(input.body),25)}::jsonb,${bodyHash},${input.network}) RETURNING *`;
    await this.event(tx,row!.id,'draft',{publicDataConsent:true,bodyHash});return this.view(tx,row!);});}
  async quote(owner:BuyerOwner,id:string){const before=await this.get(owner,id);if(!['draft','quoted'].includes(before.state))throw new BrainchainPurchaseError('order_conflict');
    const quote=await this.client.quote({title:before.title,brief:before.brief,levels:before.levels},before.network);
    return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);if(!['draft','quoted'].includes(row.state)||row.body_hash!==before.bodyHash)throw new BrainchainPurchaseError('order_conflict');
      const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET quote=${tx.typed(canonical(quote),25)}::jsonb,quote_expires_at=${tx.typed(new Date(quote.expiresAtMs).toISOString(),25)}::timestamptz,state='quoted',updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;
      await this.event(tx,id,'quote',{quoteHash:quote.hash,expiresAtMs:quote.expiresAtMs});return this.view(tx,updated!);});}
  async intent(owner:BuyerOwner,id:string,raw:unknown){const payer=z.object({payer:z.union([buyerAddress,solanaBuyerAddress])}).strict().parse(raw).payer;
    if(payer===BUYER_LANE.recipient||/^0x0{40}$/.test(payer))throw new BrainchainPurchaseError('invalid_request');
    const before=await this.get(owner,id);if(!this.execute)throw new BrainchainPurchaseError('execution_disabled');
    if(before.network===SOL.network)solanaBuyerAddress.parse(payer);else buyerAddress.parse(payer);
    if(before.state==='reserved')return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);const policy=await this.policy(tx,owner);if(row.payer!==payer||!row.terms||!row.valid_before||row.valid_before.getTime()<=Date.now())throw new BrainchainPurchaseError('order_conflict');
      let approved=!!row.human_approved_at&&!!row.human_approval_expires_at&&row.human_approval_expires_at.getTime()>Date.now();if(approved&&policy.requireApproval){try{await this.approvalWallet(tx,owner,row);}catch{approved=false;}}row.requires_human_approval=policy.requireApproval;
      await tx`UPDATE brainchain_buyer_orders SET requires_human_approval=${policy.requireApproval} WHERE id=${id}`;if(row.network===SOL.network){if(!row.solana_artifact)throw new BrainchainPurchaseError('invalid_proof');await this.solanaRpc.valid(row.solana_artifact);}await owner.assertCurrent();const final=await this.clock(tx);if(row.valid_before<=final.now)throw new BrainchainPurchaseError('order_conflict');if(policy.requireApproval&&row.human_approval_expires_at&&row.human_approval_expires_at<=final.now)approved=false;return {order:this.view(tx,row),terms:policy.requireApproval&&!approved?null:this.signingTerms(row)};});
    if(before.state!=='quoted')throw new BrainchainPurchaseError('order_conflict');
    let artifact:SolanaBuyerArtifact|null=null;
    if(before.network===SOL.network){artifact=buildSolanaBuyerArtifact(payer,await this.solanaRpc.lifetime());await this.solanaRpc.accounts(artifact);await this.solanaRpc.valid(artifact);}else await this.receipts.verifyPayer(payer);
    return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);const policy=await this.policy(tx,owner,undefined,true);const clock=await this.clock(tx);
      if(row.state!=='quoted'||!row.quote||!row.quote_expires_at||row.quote_expires_at<=clock!.now)throw new BrainchainPurchaseError('quote_refused');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-buyer:${row.network}:${payer}`},0))`;
      const [binding]=await tx`SELECT avatar_id FROM brainchain_buyer_payers WHERE network=${row.network} AND address=${payer}`;
      if(binding&&binding.avatar_id!==owner.avatarId)throw new BrainchainPurchaseError('payer_conflict');
      if(artifact)await this.solanaRpc.valid(artifact);await owner.assertCurrent();const freshClock=await this.clock(tx);
      if(row.quote_expires_at<=freshClock!.now)throw new BrainchainPurchaseError('quote_refused');
      const terms=createBuyerTerms({orderId:id,avatarId:owner.avatarId,payer,bodyHash:row.body_hash,quoteHash:row.quote.hash},row.quote,freshClock!.now.getTime());
      if(Number(terms.validBefore)*1000<=freshClock!.now.getTime()+5000)throw new BrainchainPurchaseError('quote_refused');
      const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET state='reserved',payer=${payer},solana_artifact=${artifact?tx.typed(canonical(artifact),25):null}::jsonb,terms=${tx.typed(canonical(terms),25)}::jsonb,payment_nonce=${terms.paymentNonce},valid_before=${tx.typed(new Date(Number(terms.validBefore)*1000).toISOString(),25)}::timestamptz,reserved_at=clock_timestamp(),requires_human_approval=${policy.requireApproval},updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;
      await this.event(tx,id,'intent_issued',{quoteHash:terms.quoteHash,paymentNonceHash:buyerDigest(terms.paymentNonce)});return {order:this.view(tx,updated!),terms:policy.requireApproval?null:this.signingTerms({...updated!,solana_artifact:artifact})};});}
  private signingTerms(row:BuyerRow){if(!row.terms)throw new BrainchainPurchaseError('order_conflict');return row.network===SOL.network&&row.solana_artifact?{network:SOL.network,intentMessage:solanaBuyerIntent(row.terms,row.solana_artifact),unsignedTransaction:row.solana_artifact.unsignedTransaction,payer:row.payer,messageHash:row.solana_artifact.messageHash,lastValidBlockHeight:row.solana_artifact.lastValidBlockHeight}:buyerTypedData(row.terms);}
  private approvalMessage(row:BuyerRow,nonce:string){if(!row.terms)throw new BrainchainPurchaseError('order_conflict');return row.network===SOL.network&&row.solana_artifact?['ClawVille BrainChain test purchase',solanaBuyerIntent(row.terms,row.solana_artifact),`nonce: ${nonce}`].join('\n'):buyerHumanApprovalMessage(row.terms,row.body,nonce);}
  async humanChallenge(owner:BuyerOwner,id:string){if(owner.actor!=='human')throw new BrainchainPurchaseError('human_approval_required');return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);
    const {wallet,walletVersion}=await this.context(tx,owner);if(!wallet||!row.terms||!row.valid_before||row.valid_before.getTime()<=Date.now())throw new BrainchainPurchaseError('owner_grant_required');
    const nonce=randomBytes(32).toString('hex'),expiresAt=new Date(Math.min(Date.now()+120000,row.valid_before.getTime()));
    await tx`UPDATE brainchain_buyer_orders SET human_nonce=${nonce},human_approved_at=NULL,human_approval_wallet=${wallet},human_approval_wallet_version=${walletVersion},human_approval_expires_at=${tx.typed(expiresAt.toISOString(),25)}::timestamptz WHERE id=${id}`;
    return {nonce,messageToSign:this.approvalMessage(row,nonce),walletPubkey:wallet,expiresAt:expiresAt.toISOString()};});}
  async humanApprove(owner:BuyerOwner,id:string,raw:unknown){if(owner.actor!=='human')throw new BrainchainPurchaseError('human_approval_required');const proof=z.object({nonce:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().min(80).max(100)}).strict().parse(raw);
    return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);const {wallet,walletVersion}=await this.context(tx,owner);const nonce=row.human_nonce;
      await tx`UPDATE brainchain_buyer_orders SET human_nonce=NULL WHERE id=${id}`;
      let valid=false;try{valid=!!wallet&&row.human_approval_wallet===wallet&&String(row.human_approval_wallet_version)===walletVersion&&!!nonce&&nonce===proof.nonce&&!!row.terms&&!!row.human_approval_expires_at&&row.human_approval_expires_at.getTime()>Date.now()
        &&nacl.sign.detached.verify(Buffer.from(this.approvalMessage(row,nonce),'utf8'),bs58.decode(proof.signature),bs58.decode(wallet!));}catch{}
      if(!valid)return {ok:false as const,error:'invalid_proof'};
      const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET human_approved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;
      await this.event(tx,id,'human_approved',{ownerUserId:owner.userId});return {ok:true as const,order:this.view(tx,updated!)};});}
  async capture(owner:BuyerOwner,id:string,raw:unknown){if(!this.execute)throw new BrainchainPurchaseError('execution_disabled');const signaturesRaw=raw;
    const row=await this.database.begin(tx=>this.lock(tx,owner,id));if(row.state==='captured')return this.get(owner,id);
    if(row.state!=='reserved'||!row.terms||!row.quote)throw new BrainchainPurchaseError('order_conflict');
    const solana=row.network===SOL.network;const signatures=solana?solanaCaptureSchema.parse(signaturesRaw):captureSchema.parse(signaturesRaw);
    if(solana){if(!row.solana_artifact||!('signedTransaction'in signatures))throw new BrainchainPurchaseError('invalid_proof');verifySolanaBuyerIntent(row.terms,row.solana_artifact,signatures.intentSignature);verifySolanaBuyerTransaction(row.solana_artifact,signatures.signedTransaction,false);}else{if(!('paymentSignature'in signatures))throw new BrainchainPurchaseError('invalid_proof');await verifyBuyerSignatures(row.terms,signatures.intentSignature,signatures.paymentSignature);}
    const fresh=await this.client.quote(row.body,row.network);if(fresh.hash!==row.quote.hash)throw new BrainchainPurchaseError('quote_refused');if(solana){await this.solanaRpc.accounts(row.solana_artifact!);await this.solanaRpc.valid(row.solana_artifact!);}else await this.receipts.verifyPayer(row.terms.payer);
    const header='signedTransaction'in signatures?Buffer.from(canonical({x402Version:2,resource:row.quote.resource,accepted:row.quote.requirement,payload:{transaction:signatures.signedTransaction}})).toString('base64'):buyerPaymentHeader(row.terms,row.quote,signatures.paymentSignature),captureHash=buyerDigest(header);
    const captured=await this.codec.seal(canonical({purpose:'brainchain-buyer-payment-v1',avatarId:owner.avatarId,userId:owner.userId,orderId:id,bodyHash:row.body_hash,network:row.network,header,intentSignature:signatures.intentSignature}));
    return this.database.begin(async tx=>{const current=await this.lock(tx,owner,id);await this.policy(tx,owner,current);const clock=await this.clock(tx);
      if(current.state!=='reserved'||canonical(current.terms)!==canonical(row.terms)||!current.valid_before||current.valid_before<=clock!.now||!current.quote_expires_at||current.quote_expires_at<=clock!.now)throw new BrainchainPurchaseError('order_conflict');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-buyer:${row.network}:${row.terms!.payer}`},0))`;
      const [binding]=await tx`SELECT avatar_id FROM brainchain_buyer_payers WHERE network=${row.network} AND address=${row.terms!.payer}`;
      if(binding&&binding.avatar_id!==owner.avatarId)throw new BrainchainPurchaseError('payer_conflict');
      await tx`INSERT INTO brainchain_buyer_payers(avatar_id,chain_id,network,address) VALUES(${owner.avatarId},${solana?null:84532},${row.network},${row.terms!.payer}) ON CONFLICT(network,address) DO NOTHING`;
      if(solana)await this.solanaRpc.valid(row.solana_artifact!);await owner.assertCurrent();const finalPolicy=await this.policy(tx,owner,current);const finalClock=await this.clock(tx);if(finalPolicy.requireApproval&&(!current.human_approved_at||!current.human_approval_expires_at||current.human_approval_expires_at<=finalClock.now))throw new BrainchainPurchaseError('human_approval_required');if(!current.valid_before||current.valid_before<=finalClock.now)throw new BrainchainPurchaseError('order_conflict');
      const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET captured=${tx.typed(canonical(captured),25)}::jsonb,capture_hash=${captureHash},captured_at=clock_timestamp(),state='captured',updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;
      await this.event(tx,id,'captured',{captureHash});return this.view(tx,updated!);});}
  private async decode(owner:BuyerOwner,row:BuyerRow){if(!row.captured||!row.capture_hash)throw new BrainchainPurchaseError('order_conflict');
    const value=z.object({purpose:z.literal('brainchain-buyer-payment-v1'),avatarId:z.literal(owner.avatarId),userId:z.literal(owner.userId),orderId:z.literal(row.id),bodyHash:z.literal(row.body_hash),
      network:z.literal(row.network).optional(),header:z.string().max(20000),intentSignature:z.string().min(64).max(132)}).strict().parse(JSON.parse(await this.codec.open(row.captured)));
    if(buyerDigest(value.header)!==row.capture_hash)throw new BrainchainPurchaseError('invalid_proof');
    if(row.network===SOL.network){if(!row.solana_artifact||!row.terms)throw new BrainchainPurchaseError('invalid_proof');const payload=z.object({x402Version:z.literal(2),resource:z.unknown(),accepted:z.unknown(),payload:z.object({transaction:z.string()}).strict()}).strict().parse(JSON.parse(Buffer.from(value.header,'base64').toString('utf8')));if(canonical(payload.resource)!==canonical(row.quote!.resource)||canonical(payload.accepted)!==canonical(row.quote!.requirement))throw new BrainchainPurchaseError('invalid_proof');verifySolanaBuyerIntent(row.terms,row.solana_artifact,value.intentSignature);verifySolanaBuyerTransaction(row.solana_artifact,payload.payload.transaction,false);}
    return value.header;}
  async submit(owner:BuyerOwner,id:string,recover=false){if(!this.execute)throw new BrainchainPurchaseError('execution_disabled');
    const known=await this.database.begin(tx=>this.lock(tx,owner,id));if(known.remote_order&&recover)throw new BrainchainPurchaseError('order_conflict');
    if(!known.terms||!known.quote)throw new BrainchainPurchaseError('order_conflict');const header=await this.decode(owner,known);
    const fresh=await this.client.quote(known.body,known.network);if(fresh.hash!==known.quote.hash)throw new BrainchainPurchaseError('quote_refused');
    const lease=randomUUID();
    const admitted=await this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);await this.policy(tx,owner,row);const clock=await this.clock(tx);
      if(row.capture_hash!==known.capture_hash||!row.valid_before||row.valid_before<=clock!.now||!row.quote_expires_at||row.quote_expires_at<=clock!.now)throw new BrainchainPurchaseError('order_conflict');
      if(recover){if(!['uncertain','sending'].includes(row.state)||!row.first_send_at||clock!.now.getTime()-row.first_send_at.getTime()>900000||row.lease_until&&row.lease_until>clock!.now)throw new BrainchainPurchaseError('order_conflict');}
      else if(row.state!=='captured'||row.first_send_at)throw new BrainchainPurchaseError('order_conflict');
      const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET state='sending',send_generation=send_generation+1,lease_owner=${lease},lease_until=clock_timestamp()+interval '20 seconds',first_send_at=COALESCE(first_send_at,clock_timestamp()),last_send_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;
      await this.event(tx,id,recover?'recovery_claimed':'send_claimed',{generation:updated!.send_generation,captureHash:row.capture_hash});return updated!;});
    try{
      // Recheck after commit and before the only paid request. A refusal retains the uncertain liability.
      const fence=async()=>{if(known.network===SOL.network){if(!known.solana_artifact)throw new BrainchainPurchaseError('invalid_proof');await this.solanaRpc.valid(known.solana_artifact);}
        await this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);const policy=await this.policy(tx,owner,row);await owner.assertCurrent();if(row.network===SOL.network){if(!row.solana_artifact)throw new BrainchainPurchaseError('invalid_proof');await this.solanaRpc.valid(row.solana_artifact);}if(policy.requireApproval)await this.approvalWallet(tx,owner,row);const clock=await this.clock(tx);
        if(policy.requireApproval&&(!row.human_approved_at||!row.human_approval_expires_at||row.human_approval_expires_at<=clock!.now))throw new BrainchainPurchaseError('human_approval_required');
        if(row.state!=='sending'||row.lease_owner!==lease||row.send_generation!==admitted.send_generation||!row.lease_until||row.lease_until<=clock!.now||!row.valid_before||row.valid_before<=clock!.now)throw new BrainchainPurchaseError('order_conflict');});};
      await fence();const remote=await this.client.send(admitted.body,header,fence);
      await this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);if(row.lease_owner!==lease||row.send_generation!==admitted.send_generation)throw new BrainchainPurchaseError('order_conflict');
        await this.observe(tx,row,remote);await tx`UPDATE brainchain_buyer_orders SET state='uncertain',lease_until=NULL,updated_at=clock_timestamp() WHERE id=${id}`;});
    }catch{await this.database`UPDATE brainchain_buyer_orders SET state='uncertain',failure_code='payment_outcome_uncertain',lease_until=NULL,updated_at=clock_timestamp() WHERE id=${id} AND lease_owner=${lease} AND send_generation=${admitted.send_generation} AND state='sending'`;}
    return this.get(owner,id);
  }
  private async observe(tx:TransactionSql,row:BuyerRow,remote:BuyerRemoteOrder){if(remote.network&&remote.network!==row.network)throw new BrainchainPurchaseError('order_conflict');if(row.remote_order&&row.remote_order!==remote.order||row.task_id&&remote.taskId&&row.task_id!==remote.taskId)throw new BrainchainPurchaseError('order_conflict');
    const candidate=remote.board??remote.task?.board;const board=candidate&&BRAINCHAIN_CONTRACTS.testnet.boards.some(item=>item.address===candidate)?candidate:null;
    if(row.task_board&&board&&row.task_board!==board)throw new BrainchainPurchaseError('order_conflict');
    await tx`UPDATE brainchain_buyer_orders SET remote_order=${remote.order},remote_state=${remote.state??null},task_id=COALESCE(task_id,${remote.taskId??null}),task_board=COALESCE(task_board,${board}),updated_at=clock_timestamp() WHERE id=${row.id}`;
    await this.event(tx,row.id,'remote_observation',{order:remote.order,state:remote.state??null,taskId:remote.taskId??null,board,unknownBoard:candidate&&!board?candidate:null});}
  private async discoverPayment(owner:BuyerOwner,known:BuyerRow){
    if(!known.terms||!known.solana_artifact||!known.captured||!known.first_send_at||!['uncertain','sending','payment_observed','reorg_suspended'].includes(known.state)||known.state==='sending'&&known.lease_until&&known.lease_until.getTime()>Date.now())throw new BrainchainPurchaseError('order_conflict');
    let result:{cursor:unknown;observation:SolanaDiscoveryObservation;payment?:SolanaBuyerReceiptEvidence};
    if(known.payment_transaction){
      try{const payment=await this.solanaReceipts.verify(known.payment_transaction,known.solana_artifact,'payment',undefined,'finalized');result={cursor:known.solana_discovery?.cursor??null,observation:{state:'payment_observed' as const,checkedAt:new Date().toISOString(),scannedTransactions:0,hasMore:false},payment};}
      catch{await this.database.begin(async tx=>{const row=await this.lock(tx,owner,known.id);if(row.payment_transaction===known.payment_transaction)await tx`UPDATE brainchain_buyer_orders SET state='reorg_suspended',updated_at=clock_timestamp() WHERE id=${known.id}`;});throw new BrainchainPurchaseError('receipt_unavailable');}
    }else result=await this.solanaDiscovery.scan(known.solana_artifact,known.solana_discovery?.cursor??null);
    return this.database.begin(async tx=>{
      const row=await this.lock(tx,owner,known.id);
      if(row.remote_order||row.capture_hash!==known.capture_hash||row.payment_transaction!==known.payment_transaction||canonical(row.solana_discovery?.cursor??null)!==canonical(known.solana_discovery?.cursor??null))throw new BrainchainPurchaseError('order_conflict');
      if(row.state==='sending'&&row.lease_until&&row.lease_until.getTime()>(await this.clock(tx)).now.getTime())throw new BrainchainPurchaseError('order_conflict');
      const proof=result.payment;
      if(proof){
        const [used]=await tx`SELECT order_id FROM brainchain_buyer_events WHERE kind='payment_receipt' AND transaction=${proof.transaction} AND log_index=${proof.logIndex}`;
        if(used&&used.order_id!==known.id)throw new BrainchainPurchaseError('order_conflict');
        if(!used)await this.event(tx,known.id,'payment_receipt',proof,proof);
      }
      await owner.assertCurrent();const clock=await this.clock(tx);
      if(proof&&(clock.now.getTime()-Date.parse(proof.observedAt)>5000||Date.parse(proof.observedAt)>clock.now.getTime()+1000))throw new BrainchainPurchaseError('receipt_unavailable');
      await tx`UPDATE brainchain_buyer_orders SET solana_discovery=${tx.typed(canonical({cursor:result.cursor,observation:result.observation}),25)}::jsonb,updated_at=clock_timestamp() WHERE id=${known.id}`;
      if(proof)await tx`UPDATE brainchain_buyer_orders SET state='payment_observed',lease_until=NULL,payment_transaction=${proof.transaction},payment_block_hash=${proof.blockHash},payment_block=${proof.blockNumber},updated_at=clock_timestamp() WHERE id=${known.id}`;
      await this.event(tx,known.id,'payment_discovery',{...result.observation,refundRelease:'unavailable',reason:'order_attribution_unverified'});
      const [updated]=await tx<BuyerRow[]>`SELECT * FROM brainchain_buyer_orders WHERE id=${known.id}`;return this.view(tx,updated!);
    });
  }
  private async verifyReceipt(row:BuyerRow,transaction:string,kind:'payment'|'refund',after?:bigint):Promise<BuyerReceiptEvidence>{if(row.network===SOL.network){if(!row.solana_artifact)throw new BrainchainPurchaseError('invalid_proof');return this.solanaReceipts.verify(transaction,row.solana_artifact,kind,after,'finalized');}return this.receipts.verify(transaction,row.terms!,kind,after);}
  async reconcile(owner:BuyerOwner,id:string){const known=await this.database.begin(tx=>this.lock(tx,owner,id));if(known.network===SOL.network&&!known.remote_order)return this.discoverPayment(owner,known);if(!known.remote_order||!known.terms)throw new BrainchainPurchaseError('order_conflict');
    const remote=await this.client.order(known.remote_order);
    let payment:BuyerReceiptEvidence|undefined,refund:BuyerReceiptEvidence|undefined;
    try {
      if(remote.paymentTx)payment=await this.verifyReceipt(known,remote.paymentTx,'payment');
      else if(known.payment_transaction)payment=await this.verifyReceipt(known,known.payment_transaction,'payment');
      const refundTransaction=remote.refundTx??known.refund_transaction;
      if(refundTransaction&&payment)refund=await this.verifyReceipt(known,refundTransaction,'refund',BigInt(payment.blockNumber));
    } catch {
      if(known.payment_transaction||known.refund_transaction)await this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);
        if(['payment_observed','refunded','reorg_suspended'].includes(row.state)){await tx`UPDATE brainchain_buyer_orders SET state='reorg_suspended',failure_code='receipt_verification_unavailable',updated_at=clock_timestamp() WHERE id=${id}`;await this.event(tx,id,'receipt_unavailable',{});}});
      throw new BrainchainPurchaseError('receipt_unavailable');
    }
    return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);if(row.remote_order!==known.remote_order||!row.terms)throw new BrainchainPurchaseError('order_conflict');await this.observe(tx,row,remote);
      if(payment){if(Date.now()-Date.parse(payment.observedAt)>5000)throw new BrainchainPurchaseError('receipt_unavailable');
        const [used]=await tx`SELECT order_id FROM brainchain_buyer_events WHERE kind='payment_receipt' AND transaction=${payment.transaction} AND log_index=${payment.logIndex}`;
        if(used&&used.order_id!==id)throw new BrainchainPurchaseError('order_conflict');if(!used)await this.event(tx,id,'payment_receipt',payment,payment);
        if(row.state!=='refunded')await tx`UPDATE brainchain_buyer_orders SET state='payment_observed',payment_transaction=${payment.transaction},payment_block_hash=${payment.blockHash},payment_block=${payment.blockNumber},updated_at=clock_timestamp() WHERE id=${id}`;}
      if(refund&&payment){if(Date.now()-Date.parse(refund.observedAt)>5000)throw new BrainchainPurchaseError('receipt_unavailable');
        const [used]=await tx`SELECT order_id FROM brainchain_buyer_events WHERE kind='refund_receipt' AND transaction=${refund.transaction} AND log_index=${refund.logIndex}`;
        if(used&&used.order_id!==id)throw new BrainchainPurchaseError('order_conflict');if(!used)await this.event(tx,id,'refund_receipt',refund,refund);
        await tx`UPDATE brainchain_buyer_orders SET state='refunded',refund_transaction=${refund.transaction},updated_at=clock_timestamp() WHERE id=${id}`;}
      const [updated]=await tx<BuyerRow[]>`SELECT * FROM brainchain_buyer_orders WHERE id=${id}`;return this.view(tx,updated!);});
  }
  async cancel(owner:BuyerOwner,id:string){return this.database.begin(async tx=>{const row=await this.lock(tx,owner,id);if(row.terms||row.captured||row.first_send_at||!['draft','quoted'].includes(row.state))throw new BrainchainPurchaseError('order_conflict');
    const [updated]=await tx<BuyerRow[]>`UPDATE brainchain_buyer_orders SET state='canceled',updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;return this.view(tx,updated!);});}
}
let service:BrainchainPurchases|undefined;
export async function getBrainchainPurchases(){if(!service){const {getPostgresClient}=await import('@clawville/database');service=new BrainchainPurchases(getPostgresClient());}return service;}
