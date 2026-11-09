'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useQuery} from '@tanstack/react-query';
import {parsePolicyAmount,formatPolicyAmount} from './worker-policy-amounts';
import {officeAccountRequest} from './office-api';
import {signMessageWithSolanaWallet} from '@/lib/solana-wallet';
import styles from './brainchain-office.module.css';

const actions=['faucet','approve-stake','approve-bond','stake','apply','submit','leave','withdraw'] as const;
const taskKinds=['text-research','text-extraction','text-code','text-writing'] as const;
const fields=[['maxStakeAtomic','Maximum stake (BRAIN)',18],['maxBondAtomic','Maximum application bond (BRAIN)',18],['maxBrainTotalAtomic','Cumulative BRAIN limit',18],['priceAtomic','Worker price (USDG)',6],['maxGasPerOperationWei','Gas limit per operation (ETH)',18],['maxGasTotalWei','Cumulative gas limit (ETH)',18],['openaiMicros','Cumulative OpenAI limit (USD)',6],['openrouterMicros','Cumulative OpenRouter limit (USD)',6]] as const;
type AmountField=typeof fields[number][0];
type Policy={environment:'testnet';chainId:274630;actions:string[];taskKinds:string[];maxTasks:number;expiresAt:string}&Record<AmountField,string>;
type PolicyView={id:string;revision:number;policy:Policy;policyHash:string;state:string;ownerApproved:boolean;executionEnabled:false;recovery:{reason:string}};
type Response={policy:PolicyView|null;liabilities:Record<string,string|number>|null;workerControlVersion:string;executionEnabled:false};
export function OfficeWorkerPolicy({workerId,userId}:{workerId:string;userId:string}){
  const [values,setValues]=useState<Record<AmountField,string>>({maxStakeAtomic:'0',maxBondAtomic:'0',maxBrainTotalAtomic:'0',priceAtomic:'0',maxGasPerOperationWei:'0',maxGasTotalWei:'0',openaiMicros:'0',openrouterMicros:'0'});
  const [allowed,setAllowed]=useState<string[]>([]),[kinds,setKinds]=useState<string[]>([]),[maxTasks,setMaxTasks]=useState('0'),[hours,setHours]=useState('1'),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const active=useRef<AbortController|null>(null),mounted=useRef(true);
  const query=useQuery({queryKey:['brainchain-worker-policy',userId,workerId],retry:false,gcTime:0,queryFn:({signal})=>officeAccountRequest<Response>(`workers/${workerId}/policy`,signal)});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();};},[userId,workerId]);
  async function perform(action:(signal:AbortSignal)=>Promise<void>){
    if(active.current)return;const controller=new AbortController();active.current=controller;setBusy(true);setError('');setNotice('');
    try{await action(controller.signal);controller.signal.throwIfAborted();if(mounted.current){setConsent(false);await query.refetch();}}
    catch(cause){if(mounted.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'The Office refused this policy operation.');}
    finally{if(active.current===controller)active.current=null;if(mounted.current)setBusy(false);}
  }
  function policy(expiryCeiling?:string):Policy{
    if(!allowed.length)throw Error('Select at least one permitted action.');
    const expiry=Math.min(Date.now()+Number(hours)*3600000,expiryCeiling?Date.parse(expiryCeiling):Infinity);
    const payload={environment:'testnet',chainId:274630,actions:allowed,taskKinds:kinds,maxTasks:Number(maxTasks),expiresAt:new Date(expiry).toISOString()} as Policy;
    for(const [key,,decimals]of fields)payload[key]=parsePolicyAmount(values[key],decimals);
    return payload;
  }
  function request(event:FormEvent){event.preventDefault();void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/policy`,signal,policy());setNotice('Policy request saved. The linked account wallet must approve it.');});}
  const current=query.data?.policy;
  async function approve(){if(!current||!consent)return;await perform(async signal=>{
    const challenge=await officeAccountRequest<{nonce:string;messageToSign:string;walletPubkey:string;expiresAt:string;policy:PolicyView}>(`workers/${workerId}/policy/${current.id}/challenge`,signal,{});
    if(challenge.policy.policyHash!==current.policyHash||challenge.policy.id!==current.id||Date.parse(challenge.expiresAt)<=Date.now()||!challenge.messageToSign.includes(`policy-sha256: ${current.policyHash}`))throw Error('The owner challenge differs from the displayed policy.');
    const proof=await signMessageWithSolanaWallet(challenge.messageToSign,challenge.walletPubkey);signal.throwIfAborted();
    await officeAccountRequest(`workers/${workerId}/policy/${current.id}/approve`,signal,{nonce:challenge.nonce,signature:proof.signatureBase58});setNotice('Owner grant saved. Testnet execution remains disabled pending review.');
  });}
  return <section className={styles.lesson} aria-label="Worker owner policy">
    <h4>Worker permissions</h4><p>Set exact testnet limits. A worker binding alone cannot authorize spending.</p>
    <p>Execution remains disabled pending review. Policy approval does not prove that Jev accepted this worker.</p>
    <form className={styles.purchaseForm} onSubmit={request}>
      <fieldset><legend>Permitted actions</legend>{actions.map(action=><label key={action}><input type="checkbox" checked={allowed.includes(action)} onChange={event=>setAllowed(old=>event.target.checked?[...old,action]:old.filter(value=>value!==action))}/>{action}</label>)}</fieldset>
      <fieldset><legend>Text output task types</legend>{taskKinds.map(kind=><label key={kind}><input type="checkbox" checked={kinds.includes(kind)} onChange={event=>setKinds(old=>event.target.checked?[...old,kind]:old.filter(value=>value!==kind))}/>{kind.replace('text-','')}</label>)}</fieldset>
      {fields.map(([key,label])=><label key={key}>{label}<input inputMode="decimal" required value={values[key]} onChange={event=>setValues(old=>({...old,[key]:event.target.value}))}/></label>)}
      <label>Maximum tasks<input type="number" min="0" max="100" required value={maxTasks} onChange={event=>setMaxTasks(event.target.value)}/></label>
      <label>Policy duration (hours)<input type="number" min="1" max="24" required value={hours} onChange={event=>setHours(event.target.value)}/></label>
      <button type="submit" className={styles.primaryButton} disabled={busy}>Request policy</button>
      {current?.state==='active'&&<button type="button" className={styles.secondaryLink} disabled={busy} onClick={()=>void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/policy/narrow`,signal,{policyId:current.id,revision:current.revision,policy:policy(current.policy.expiresAt)});setNotice('Lower limits saved. Prior permissions were revoked.');})}>Apply lower limits</button>}
    </form>
    {query.isPending&&<p role="status">Check worker policy...</p>}{query.isError&&<p role="alert">The Office cannot load this policy.</p>}
    {current&&<div><p>Revision {current.revision}: {current.state}. {current.ownerApproved?'Owner wallet grant recorded.':'Owner wallet grant required.'}</p>
      <dl>{fields.map(([key,label,decimals])=><div key={key}><dt>{label}</dt><dd>{formatPolicyAmount(current.policy[key],decimals)}</dd></div>)}</dl>
      <p>Actions: {current.policy.actions.join(', ')}. Tasks: {current.policy.taskKinds.join(', ')||'none'}.</p>
      <p>Maximum tasks: {current.policy.maxTasks}. Expires: {current.policy.expiresAt}.</p><p className={styles.small}>Policy hash: {current.policyHash}</p>
      {current.state==='active'&&<button className={styles.primaryButton} disabled={busy} onClick={()=>void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/policy/control`,signal,{policyId:current.id,revision:current.revision,action:'start',workerControlVersion:query.data?.workerControlVersion});setNotice('Start requested within the owner policy. Execution remains disabled pending review.');})}>Start within policy</button>}
      {current.state!=='revoked'&&<><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>I approve these exact testnet limits. Existing liabilities remain reserved after pause or revocation.</label>
        <button className={styles.primaryButton} disabled={busy||!consent} onClick={()=>void approve()}>Approve with linked owner wallet</button>
        {(['pause','revoke'] as const).map(action=><button key={action} className={styles.secondaryLink} disabled={busy} onClick={()=>void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/policy/control`,signal,{policyId:current.id,revision:current.revision,action});setNotice('Policy stopped. Captured evidence and liabilities remain retained.');})}>{action==='pause'?'Pause policy':'Revoke policy'}</button>)}</>}
      <p>{current.recovery.reason}</p></div>}
    {query.data?.liabilities&&<p className={styles.small}>Cumulative liabilities: {JSON.stringify(query.data.liabilities)}. Policy changes do not reset these amounts.</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
