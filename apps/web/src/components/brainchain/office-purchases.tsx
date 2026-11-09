'use client';
import { useEffect,useRef,useState,type FormEvent } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { BRAINCHAIN_SOLANA_BUYER_NETWORK,BRAINCHAIN_BUYER_STATES,type BrainchainBuyerOrder,type BrainchainBuyerAvailability } from '@clawville/shared';
import { useAuthMe } from '@/hooks/use-auth-me';
import { connectBrainchainSolanaPayer,signBrainchainSolanaPurchase } from '@/lib/brainchain-solana-wallet';
import { connectBrainchainPayer,signBrainchainPurchase } from '@/lib/brainchain-evm-wallet';
import { signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { officeAccountRequest } from './office-api';
import styles from './brainchain-office.module.css';
const address=z.string().regex(/^0x[0-9a-f]{40}$/),hash=z.string().regex(/^0x[0-9a-f]{64}$/),time=z.string().datetime();
const recoverySchema=z.object({state:z.enum(['not_started','incomplete','not_found','unavailable','ambiguous','payment_observed']),checkedAt:time.nullable(),scannedTransactions:z.number().int().min(0).max(12),hasMore:z.boolean(),refundRelease:z.literal('unavailable'),refundReleaseReason:z.literal('order_attribution_unverified')}).strict();
const orderSchema=z.object({id:z.string().uuid(),environment:z.literal('testnet'),chainId:z.literal(84532).nullable(),network:z.enum(['eip155:84532',BRAINCHAIN_SOLANA_BUYER_NETWORK]).optional(),state:z.enum(BRAINCHAIN_BUYER_STATES),title:z.string().max(120),brief:z.string().max(32000),levels:z.array(z.string().max(200)).min(2).max(3),bodyHash:z.string().regex(/^[a-f0-9]{64}$/),payer:z.union([address,z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)]).nullable(),amountAtomic:z.literal('1000000'),quoteExpiresAt:time.nullable(),authorizationExpiresAt:time.nullable(),remoteOrder:hash.nullable(),remoteState:z.string().regex(/^[a-z-]{1,24}$/).nullable(),taskId:z.string().regex(/^[1-9][0-9]{0,77}$/).nullable(),taskBoard:address.nullable(),paymentTransaction:z.union([hash,z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)]).nullable(),refundTransaction:z.union([hash,z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)]).nullable(),recovery:recoverySchema.optional(),provisional:z.literal(true),requiresHumanApproval:z.boolean(),humanApproved:z.boolean(),createdAt:time,updatedAt:time});
function readOrder(raw:unknown):BrainchainBuyerOrder{const value=orderSchema.parse(raw);if((value.network===BRAINCHAIN_SOLANA_BUYER_NETWORK)!==(value.chainId===null)||value.payer!==null&&!(value.network===BRAINCHAIN_SOLANA_BUYER_NETWORK?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[0-9a-f]{40}$/).test(value.payer))throw new Error('The Office cannot confirm the payment network.');return value;}
export function OfficePurchases(){const auth=useAuthMe();const userId=auth.data?.user&&!auth.data.user.isGuest?auth.data.user.id:null;
 if(auth.isLoading)return <p role="status">Check your account...</p>;
 if(!userId)return <p><Link className={styles.secondaryLink} href="/login">Sign in</Link> to prepare your own test purchase.</p>;
 return <PrivatePurchases key={userId} userId={userId}/>;
}
function PrivatePurchases({userId}:{userId:string}){
 const [network,setNetwork]=useState<'eip155:84532'|typeof BRAINCHAIN_SOLANA_BUYER_NETWORK>('eip155:84532');
 const [title,setTitle]=useState(''),[brief,setBrief]=useState(''),[fail,setFail]=useState('Incorrect or incomplete'),[pass,setPass]=useState('Accurate and complete'),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const active=useRef<AbortController|null>(null),mounted=useRef(true),key=useRef(crypto.randomUUID());
 const orders=useQuery({queryKey:['brainchain-purchases',userId],retry:false,gcTime:0,queryFn:async({signal})=>{const raw=await officeAccountRequest<{orders:unknown[];availability:BrainchainBuyerAvailability}>('purchases',signal);if(!Array.isArray(raw.orders)||raw.orders.length>30||raw.availability?.network!=='eip155:84532'||raw.availability.environment!=='testnet'||typeof raw.availability.executionEnabled!=='boolean')throw new Error('The Office cannot confirm purchase availability.');return {...raw,orders:raw.orders.map(readOrder)};}});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();};},[]);
 async function perform(action:(signal:AbortSignal)=>Promise<void>){if(active.current)return;const controller=new AbortController();active.current=controller;setBusy(true);setError('');setNotice('');try{await action(controller.signal);controller.signal.throwIfAborted();if(mounted.current)await orders.refetch();}catch(cause){if(mounted.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'The Office cannot confirm this purchase.');}finally{if(active.current===controller)active.current=null;if(mounted.current)setBusy(false);}}
 async function create(event:FormEvent){event.preventDefault();await perform(async signal=>{const result=await officeAccountRequest<{order:unknown}>('purchases',signal,{idempotencyKey:key.current,body:{title,brief,levels:[pass,fail]},publicDataConsent:consent,environment:'testnet',network});readOrder(result.order);key.current=crypto.randomUUID();if(mounted.current)setNotice('Your draft is saved. Request its current quote before you approve a purchase.');});}
 async function operation(order:BrainchainBuyerOrder,op:string){await perform(async signal=>{await officeAccountRequest(`purchases/${order.id}/${op}`,signal,{});});}
 async function signOwnerApproval(id:string,challenge:{nonce:string;messageToSign:string;walletPubkey:string;expiresAt:string},signal:AbortSignal){
  if(typeof challenge.messageToSign!=='string'||challenge.messageToSign.length>3000||!challenge.messageToSign.startsWith('ClawVille BrainChain test purchase\n')||Date.parse(challenge.expiresAt)<=Date.now())throw new Error('The owner approval request is unavailable.');
  const proof=await signMessageWithSolanaWallet(challenge.messageToSign,challenge.walletPubkey);signal.throwIfAborted();
  await officeAccountRequest(`purchases/${id}/approve`,signal,{nonce:challenge.nonce,signature:proof.signatureBase58});
 }
 async function renewOwnerApproval(order:BrainchainBuyerOrder){await perform(async signal=>{
  const challenge=await officeAccountRequest<{nonce:string;messageToSign:string;walletPubkey:string;expiresAt:string}>(`purchases/${order.id}/approval-challenge`,signal,{});
  await signOwnerApproval(order.id,challenge,signal);if(mounted.current)setNotice('The account owner approved the existing purchase. Its saved payment authorization stays unchanged.');
 });}
 async function authorize(order:BrainchainBuyerOrder){await perform(async signal=>{
  const isSolana=order.network===BRAINCHAIN_SOLANA_BUYER_NETWORK;const payer=isSolana?await connectBrainchainSolanaPayer():await connectBrainchainPayer();signal.throwIfAborted();
  let prepared=await officeAccountRequest<{order:unknown;terms:unknown}>(`purchases/${order.id}/intent`,signal,{payer});let current=readOrder(prepared.order);
  if(current.requiresHumanApproval&&!current.humanApproved){const challenge=await officeAccountRequest<{nonce:string;messageToSign:string;walletPubkey:string;expiresAt:string}>(`purchases/${order.id}/approval-challenge`,signal,{});
   await signOwnerApproval(order.id,challenge,signal);
   prepared=await officeAccountRequest(`purchases/${order.id}/intent`,signal,{payer});current=readOrder(prepared.order);
  }
  if(!prepared.terms)throw new Error('The account owner must approve this purchase first.');
  const signatures=isSolana?await signBrainchainSolanaPurchase(current,prepared.terms,signal):await signBrainchainPurchase(current,prepared.terms);signal.throwIfAborted();
  await officeAccountRequest(`purchases/${order.id}/capture`,signal,signatures);
  if(mounted.current)setNotice('The Office saved this authorization. Review its order before you submit it.');
 });}
 const enabled=orders.data?.availability.executionEnabled===true;
 return <div className={styles.accountPanel}>
  <h3>Test task purchases</h3><p>Each quoted task costs 1 test USDC. Test tokens have no cash value.</p>
  {!enabled&&<p className={styles.notice}>You can save a draft and request an unpaid quote. Test-token signatures and submission await the payment review.</p>}
  <p><Link className={styles.secondaryLink} href="/wallet">Review spend rules</Link></p>
  <form className={styles.purchaseForm} onSubmit={create}>
   <label>Test payment network<select value={network} disabled={busy} onChange={e=>{setNetwork(e.target.value as typeof network);key.current=crypto.randomUUID();}} style={{minHeight:44,minWidth:44}}><option value="eip155:84532">Base Sepolia</option><option value={BRAINCHAIN_SOLANA_BUYER_NETWORK}>Solana devnet</option></select></label>
   {network===BRAINCHAIN_SOLANA_BUYER_NETWORK&&<p>Use devnet USDC in an external Solana account. Both token accounts must already exist. Ask the desk to provision its receive account if necessary. Account spend approval uses your linked account wallet separately.</p>}
   <label>Task title<input required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label>
   <label>Public task brief<textarea required rows={5} maxLength={32000} value={brief} onChange={e=>setBrief(e.target.value)}/></label>
   <label>Pass criterion<input required maxLength={200} value={pass} onChange={e=>setPass(e.target.value)}/></label>
   <label>Fail criterion<input required maxLength={200} value={fail} onChange={e=>setFail(e.target.value)}/></label>
   <label className={styles.purchaseConsent}><input required type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I approve publication of this task brief. It contains no secrets or personal data.</label>
   <button className={styles.primaryButton} disabled={busy||!consent} type="submit">Save test draft</button>
  </form>
  {error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  {orders.isPending?<p role="status">Load your purchase orders...</p>:orders.isError?<p role="alert">The Office cannot load your orders. <button className={styles.textButton} onClick={()=>void orders.refetch()}>Refresh orders</button></p>:null}
  {orders.data?.orders.map(order=><article className={styles.lesson} key={order.id}>
   <h4>{order.title}</h4><details><summary className={styles.textButton}>Review the public brief</summary><p style={{whiteSpace:'pre-wrap'}}>{order.brief}</p><ol>{order.levels.map((level,index)=><li key={index}>{level}</li>)}</ol></details><p>{order.network===BRAINCHAIN_SOLANA_BUYER_NETWORK?'Solana devnet':'Base Sepolia'}: {order.state.replaceAll('_',' ')} · 1 test USDC</p><p className={styles.small}>Order {order.id}</p>
   {order.recovery&&<><p>{order.recovery.state==='not_started'?'Search the original payment history after a timeout.':order.recovery.state==='not_found'?'This scan found no exact payment. The hold remains reserved.':order.recovery.state==='payment_observed'?'The exact payment has chain evidence. The desk order remains separate.':order.recovery.state==='incomplete'?'The history search has another bounded page.':order.recovery.state==='ambiguous'?'The history evidence is ambiguous. The hold remains reserved.':'History evidence is unavailable. The hold remains reserved.'}</p><p>Refund budget release is unavailable because the order association remains unverified.</p></>}
   {order.remoteOrder&&<p className={styles.small}>Desk order {order.remoteOrder}</p>}
   {order.taskId&&<p>Task {order.taskId}. {order.taskBoard?'Board address verified.':'Board address remains unknown.'}</p>}
   {order.state==='payment_observed'&&<p>The Office observed a test-token payment. {order.network===BRAINCHAIN_SOLANA_BUYER_NETWORK?'Solana evidence passed finalized receipt checks.':'Base Sepolia evidence has 12 confirmations.'} The purchase hold remains reserved.</p>}
   {order.state==='refunded'&&<p>The Office observed a full test-token refund. This observation remains provisional, so the purchase hold remains reserved.</p>}
   {['reserved','captured','sending','uncertain','reorg_suspended'].includes(order.state)&&<p>The purchase hold remains reserved. Expiry alone does not release it.</p>}
   {['quoted','reserved'].includes(order.state)&&<p>Your external payer consent permanently associates this payer address with your avatar. Account spend approval remains separate.</p>}
   <div className={styles.purchaseActions}>
    {['draft','quoted'].includes(order.state)&&<button className={styles.secondaryLink} disabled={busy} onClick={()=>void operation(order,'quote')}>Request unpaid quote</button>}
    {['quoted','reserved'].includes(order.state)&&<button className={styles.secondaryLink} disabled={busy||!enabled} onClick={()=>void authorize(order)}>Approve test purchase</button>}
    {order.state==='captured'&&order.requiresHumanApproval&&!order.humanApproved&&<button className={styles.secondaryLink} disabled={busy||!enabled} onClick={()=>void renewOwnerApproval(order)}>Approve account spend</button>}
    {order.state==='captured'&&<button className={styles.primaryButton} disabled={busy||!enabled||(order.requiresHumanApproval&&!order.humanApproved)} onClick={()=>void operation(order,'submit')}>Submit saved test authorization</button>}
    {order.network===BRAINCHAIN_SOLANA_BUYER_NETWORK&&!order.remoteOrder&&['uncertain','sending','payment_observed','reorg_suspended'].includes(order.state)&&<button className={styles.secondaryLink} disabled={busy} onClick={()=>void operation(order,'reconcile')}>{order.paymentTransaction?'Recheck discovered payment':'Search original payment history'}</button>}
    {order.remoteOrder&&<button className={styles.secondaryLink} disabled={busy} onClick={()=>void operation(order,'reconcile')}>Verify original order</button>}
    {!order.remoteOrder&&['uncertain','sending'].includes(order.state)&&<button className={styles.secondaryLink} disabled={busy||!enabled} onClick={()=>void operation(order,'recover')}>Recover with identical authorization</button>}
    {['draft','quoted'].includes(order.state)&&<button className={styles.textButton} disabled={busy} onClick={()=>void operation(order,'cancel')}>Cancel draft</button>}
   </div>
  </article>)}
 </div>;
}

