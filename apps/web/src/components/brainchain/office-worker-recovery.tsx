'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useQuery} from '@tanstack/react-query';
import {officeAccountRequest} from './office-api';
import {signMessageWithSolanaWallet} from '@/lib/solana-wallet';
import {parsePolicyAmount,formatPolicyAmount} from './worker-policy-amounts';
import styles from './brainchain-office.module.css';
const stages=['signature','upload','prepare-submit','capture-submit','broadcast','reconcile'] as const;
type RetainedSubmit={operationId:string;nonce:string|null;transactionHash:string|null;gasWei:string};
type ExactCaptureIntent={version:1;operationId:string;resultId:string;workerId:string;avatarId:string;chainId:274630;signer:string;generation:number;operationHash:string;authorityId:string;gasAuthorityId:string;to:string;data:string;value:'0';nonce:string;gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string;task:string;resultHash:string;resultUri:string};
type RecoveryPayload={resultHash:string;resultSha256:string;hireSnapshotHash:string;stages:string[];maxGasWei:string;observationPolicy:string;taskGeneration:number;signerGeneration:number;captured?:RetainedSubmit|null;captureIntent?:ExactCaptureIntent|null};
type Consent={id:string;resultId:string;state:string;payloadHash:string;expiresAt:string;payload:RecoveryPayload};
const unknownTerm='Unknown (not recorded)';
function integerTerm(value:unknown,nullLabel=unknownTerm):string{return value===null?nullLabel:typeof value==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(value)?value:unknownTerm;}
function textTerm(value:unknown,nullLabel=unknownTerm):string{return value===null?nullLabel:typeof value==='string'&&value.length>0?value:unknownTerm;}
function approvalProblem(payload:RecoveryPayload):string|null{
 const retained=payload.captured,intent=payload.captureIntent;
 if(payload.stages.includes('broadcast')&&(!retained||textTerm(retained.operationId)===unknownTerm||integerTerm(retained.nonce)===unknownTerm||integerTerm(retained.gasWei)===unknownTerm||!/^0x[a-f0-9]{64}$/.test(retained.transactionHash??'')))return 'The retained broadcast transaction is unavailable. Wallet approval is unavailable.';
 if(payload.stages.includes('capture-submit')&&(!intent||intent.chainId!==274630||textTerm(intent.operationId)===unknownTerm||!/^0x[a-f0-9]{40}$/.test(intent.signer)||!/^0x[a-f0-9]{40}$/.test(intent.to)||!/^0x(?:[a-f0-9]{2})+$/.test(intent.data)||!/^[a-f0-9]{64}$/.test(intent.operationHash)||intent.value!=='0'||[intent.nonce,intent.gas,intent.maxFeePerGas,intent.maxPriorityFeePerGas].some(value=>integerTerm(value)===unknownTerm)))return 'Exact transaction terms are unavailable. Wallet approval is unavailable.';
 return null;
}
function TransactionTerms({payload}:{payload:RecoveryPayload}){
 const retained=payload.captured,intent=payload.captureIntent;
 const terms=retained?[['Operation ID',textTerm(retained.operationId)],['Reserved nonce',integerTerm(retained.nonce,'Not reserved')],['Transaction hash',textTerm(retained.transactionHash,'Not captured')],['Retained gas ceiling (wei)',integerTerm(retained.gasWei)]]:[];
 const transaction=intent?[['Exact operation ID',textTerm(intent.operationId)],['Original operation digest (SHA-256)',textTerm(intent.operationHash)],['Chain ID',intent.chainId===274630?'274630':unknownTerm],['Signer',textTerm(intent.signer)],['Destination',textTerm(intent.to)],['Transaction value (wei)',integerTerm(intent.value)],['Exact nonce',integerTerm(intent.nonce)],['Gas limit',integerTerm(intent.gas)],['Maximum fee per gas (wei)',integerTerm(intent.maxFeePerGas)],['Maximum priority fee per gas (wei)',integerTerm(intent.maxPriorityFeePerGas)]]:[];
 return <>
 <h6>Retained submit operation</h6>
 {retained?<dl aria-label="Retained submit operation">{terms.map(([name,value])=><div key={name}><dt>{name}</dt><dd className={`${styles.small} ${styles.address}`}>{value}</dd></div>)}</dl>:<p>{retained===null?'No retained submit operation in this consent.':'Retained submit operation: unknown (not recorded).'}</p>}
 {intent&&<><h6>Exact unsigned transaction</h6><dl aria-label="Exact unsigned transaction">{transaction.map(([name,value])=><div key={name}><dt>{name}</dt><dd className={`${styles.small} ${styles.address}`}>{value}</dd></div>)}</dl><details><summary style={{minHeight:44,display:'flex',alignItems:'center'}}>Exact calldata</summary><code className={styles.address} style={{display:'block',whiteSpace:'pre-wrap'}}>{textTerm(intent.data)}</code></details><p>This consent retains this transaction. It does not authorize a different nonce, destination, calldata, value, or fee.</p></>}
 {approvalProblem(payload)&&<p role="alert">{approvalProblem(payload)}</p>}
 </>;
}
type RecordView={consents:Consent[];results:{id:string;resultHash:string;resultSha256:string;hireSnapshotHash:string;state:string}[]};
export function OfficeWorkerRecovery({workerId,userId}:{workerId:string;userId:string}){
 const [resultId,setResultId]=useState(''),[selected,setSelected]=useState<string[]>(['reconcile']),[gas,setGas]=useState('0'),[minutes,setMinutes]=useState('5'),[confirmed,setConfirmed]=useState(''),[error,setError]=useState('');
 const [busy,setBusy]=useState(false),active=useRef<AbortController|null>(null);
 const query=useQuery({queryKey:['brainchain-recovery',userId,workerId],retry:false,gcTime:0,queryFn:({signal})=>officeAccountRequest<RecordView>(`workers/${workerId}/recovery`,signal)});
 useEffect(()=>{setBusy(false);setError('');setConfirmed('');return()=>{active.current?.abort();active.current=null;};},[workerId,userId]);
 async function perform(action:(signal:AbortSignal)=>Promise<void>){if(active.current)return;const control=new AbortController();active.current=control;setBusy(true);setError('');try{await action(control.signal);control.signal.throwIfAborted();setConfirmed('');await query.refetch();}catch(cause){if(!control.signal.aborted)setError(cause instanceof Error?cause.message:'The Office refused this consent.');}finally{if(active.current===control){active.current=null;if(!control.signal.aborted)setBusy(false);}}}
 function limits(ceiling?:string){return{stages:selected,maxGasWei:parsePolicyAmount(gas,18),expiresAt:new Date(Math.min(Date.now()+Number(minutes)*60000,ceiling?Date.parse(ceiling):Infinity)).toISOString()};}
 function request(event:FormEvent){event.preventDefault();void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/recovery`,signal,{resultId,...limits(),observationPolicy:'nitro-testnet-latest-v1'});});}
 async function approve(consent:Consent){if(approvalProblem(consent.payload))return;await perform(async signal=>{
  const proof=await officeAccountRequest<{nonce:string;messageToSign:string;walletPubkey:string;expiresAt:string;consent:Consent}>(`workers/${workerId}/recovery/${consent.id}/challenge`,signal,{});
  if(proof.consent.payloadHash!==consent.payloadHash||proof.consent.id!==consent.id||!proof.messageToSign.includes(consent.payloadHash)||Date.parse(proof.expiresAt)<=Date.now())throw Error('The exact consent changed.');
  const signature=await signMessageWithSolanaWallet(proof.messageToSign,proof.walletPubkey);signal.throwIfAborted();
  await officeAccountRequest(`workers/${workerId}/recovery/${consent.id}/approve`,signal,{nonce:proof.nonce,signature:signature.signatureBase58});
 });}
 return <section className={styles.lesson} aria-label="Exact result recovery"><h4>Recover one retained result</h4>
 <p>A separate owner signature permits only the displayed result and stages. This consent does not resume a paused worker or restore revoked compute permissions.</p>
 <p>Execution stays disabled pending review. An unknown upload permits evidence checks only. Retained unsigned operations use capture-submit with fresh approval of the exact transaction.</p>
 <form className={styles.purchaseForm} onSubmit={request}>
 <label>Retained result<select style={{width:'100%',minWidth:0,minHeight:44,fontSize:16}} required value={resultId} onChange={event=>setResultId(event.target.value)}><option value="">Select a result</option>{query.data?.results.map(result=><option key={result.id} value={result.id}>{result.id}: {result.state}</option>)}</select></label>
 <fieldset><legend>Exact remaining stages</legend>{stages.map(stage=><label key={stage} style={{minHeight:44,display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={selected.includes(stage)} onChange={event=>setSelected(old=>event.target.checked?[...old,stage]:old.filter(value=>value!==stage))}/>{stage}</label>)}</fieldset>
 <label>Maximum transaction gas (ETH)<input required inputMode="decimal" value={gas} onChange={event=>setGas(event.target.value)}/></label>
 <label>Consent duration (minutes)<input required type="number" min="1" max="10" value={minutes} onChange={event=>setMinutes(event.target.value)}/></label>
 <button disabled={busy||!selected.length} className={styles.primaryButton}>Request exact consent</button></form>
 {query.isError&&<p role="alert">The Office cannot load retained results.</p>}
 {query.data?.consents.map(consent=><article key={consent.id}><h5 className={styles.address}>{consent.state}: {consent.resultId}</h5>
 <dl><dt>Result hash</dt><dd className={`${styles.small} ${styles.address}`}>{consent.payload.resultHash}</dd><dt>Output SHA-256</dt><dd className={`${styles.small} ${styles.address}`}>{consent.payload.resultSha256}</dd><dt>Hire snapshot hash</dt><dd className={`${styles.small} ${styles.address}`}>{consent.payload.hireSnapshotHash}</dd><dt>Consent hash</dt><dd className={`${styles.small} ${styles.address}`}>{consent.payloadHash}</dd></dl>
 <p>Stages: {consent.payload.stages.join(', ')}. Maximum gas: {formatPolicyAmount(consent.payload.maxGasWei,18)} ETH.</p>
 <p>Task generation: {consent.payload.taskGeneration}. Signer generation: {consent.payload.signerGeneration}.</p><p>Expires: {new Date(consent.expiresAt).toLocaleString()}. Observation policy: {consent.payload.observationPolicy}.</p>
 <TransactionTerms payload={consent.payload}/>
 {consent.state!=='revoked'&&<><label style={{minHeight:44,display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={confirmed===consent.id} onChange={event=>setConfirmed(event.target.checked?consent.id:'')}/>I approve this exact result, stages, and gas limit.</label>
 {consent.state==='requested'&&<button disabled={busy||confirmed!==consent.id||Boolean(approvalProblem(consent.payload))} onClick={()=>void approve(consent)} className={styles.primaryButton}>Approve with linked account wallet</button>}
 <button className={styles.secondaryLink} disabled={busy} onClick={()=>void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/recovery/${consent.id}/revoke`,signal,{});})}>Revoke exact consent</button>
 <button className={styles.secondaryLink} disabled={busy||!selected.length} onClick={()=>void perform(async signal=>{await officeAccountRequest(`workers/${workerId}/recovery/${consent.id}/narrow`,signal,limits(consent.expiresAt));})}>Revoke and request lower limits</button></>}
 </article>)}{error&&<p role="alert">{error}</p>}</section>;
}
