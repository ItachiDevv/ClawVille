'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthMe } from '@/hooks/use-auth-me';
import { officeAccountRequest, workerRequestDescription, type OfficeWorkerLocalState } from './office-api';
import styles from './brainchain-office.module.css';
import { OfficeWorkerRecord } from './office-worker-record';
import {OfficeFundingExit} from './office-funding-exit';
import {OfficeWorkerRecovery} from './office-worker-recovery';
import { OfficeWorkerPolicy } from './office-worker-policy';
import { OfficeWorkerIdentity } from './office-worker-identity';

interface Worker {
  id: string;
  environment: 'mainnet' | 'testnet';
  chainId: number;
  address: string;
  requestedState: OfficeWorkerLocalState;
  observedEligibility: 'eligible' | 'ineligible' | 'unknown' | null;
}
interface Challenge { nonce: string; messageToSign: string; expiresAt: string }
interface Installation {
  ok: true;
  installed: 'runtime' | 'marker' | 'already';
  contentHash: string;
  version: number;
  consumptionVerified: false;
  note: string;
}

/** Changing the account unmounts every private field and aborts its old request. */
export function OfficeAccount({ mode }: { mode: 'install' | 'workers' }) {
  const auth = useAuthMe();
  const userId = auth.data?.user && !auth.data.user.isGuest ? auth.data.user.id : null;
  if (auth.isLoading) return <p role="status">Check your account...</p>;
  if (auth.isError) return <p role="alert">The Office cannot confirm your account. <button type="button" className={styles.textButton} onClick={() => void auth.refetch()}>Check again</button></p>;
  if (!userId) return <div className={styles.notice}><h3>Your agent&apos;s Office</h3><p><Link className={styles.secondaryLink} href="/login">Sign in</Link> to save the curriculum or connect your own worker.</p></div>;
  return <PrivateOfficeAccount key={`${userId}:${mode}`} userId={userId} mode={mode} />;
}

function PrivateOfficeAccount({ userId, mode }: { userId: string; mode: 'install' | 'workers' }) {
  const client = useQueryClient();
  const [environment, setEnvironment] = useState<'testnet' | 'mainnet'>('testnet');
  const [address, setAddress] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const workers = useQuery({
    queryKey: ['brainchain-office', 'workers', userId],
    queryFn: ({ signal }) => officeAccountRequest<{ workers: Worker[] }>('workers', signal),
    enabled: mode === 'workers', retry: false, staleTime: 15_000, gcTime: 0,
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    setBusy(true); setError(''); setNotice('');
    try { await action(controller.signal); }
    catch (cause) {
      if (mounted.current && request.current === controller) setError(controller.signal.aborted
        ? 'The request stopped before confirmation. Refresh the status before another request.'
        : cause instanceof Error ? cause.message : 'The Office cannot confirm this action.');
    } finally {
      clearTimeout(timer);
      if (mounted.current && request.current === controller) setBusy(false);
    }
  }

  async function install() {
    await perform(async (signal) => {
      const result = await officeAccountRequest<Installation>('install', signal, {});
      if (signal.aborted) return;
      setNotice(`Curriculum ${result.version}: ${result.note} Use in your agent's next decision remains unverified.`);
    });
  }

  async function requestChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform(async (signal) => {
      const result = await officeAccountRequest<Challenge>('workers/challenge', signal, { environment, address: address.trim() });
      if (signal.aborted) return;
      setChallenge(result); setSignature('');
    });
  }

  async function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    await perform(async (signal) => {
      await officeAccountRequest<{ worker: Worker }>('workers/bind', signal, { nonce: challenge.nonce, signature: signature.trim() });
      if (signal.aborted) return;
      setChallenge(null); setSignature(''); setAddress('');
      setNotice('Worker address connected. Its on-chain eligibility has not changed.');
      await client.invalidateQueries({ queryKey: ['brainchain-office', 'workers', userId] });
    });
  }

  async function control(workerId: string, requestedState: 'paused' | 'draining') {
    await perform(async (signal) => {
      await officeAccountRequest(`workers/${workerId}/control`, signal, { requestedState });
      if (signal.aborted) return;
      setNotice('Request saved locally. On-chain hire eligibility is unchanged. Ask your operator to verify the worker state.');
      await client.invalidateQueries({ queryKey: ['brainchain-office', 'workers', userId] });
    });
  }

  return <div className={styles.accountPanel}>
    {mode === 'install' ? <><h3>Keep the curriculum with your agent.</h3><p>Save the current lessons to your connected agent. A saved copy does not prove that the agent used it.</p><button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void install()}>{busy ? 'Save in progress...' : 'Save to my agent'}</button></> : <>
      <h3>Your worker connections</h3>
      <p>A connection reserves an address for your avatar. It does not fund, start, or authorize spending by a worker.</p>
      {workers.isLoading ? <p role="status">Load your worker connections...</p> : workers.isError ? <p role="alert">{workers.error.message} <button type="button" className={styles.textButton} onClick={() => void workers.refetch()}>Refresh connections</button></p> : workers.data?.workers.length ? workers.data.workers.map((worker) => <article className={styles.worker} key={worker.id}>
        <span className={styles.state}>{worker.environment === 'testnet' ? 'Testnet' : 'Mainnet'} · Chain {worker.chainId}</span>
        <p className={styles.address}>{worker.address}</p>
        <OfficeWorkerRecord workerId={worker.id} ownerKey={userId} />
        <OfficeWorkerIdentity workerId={worker.id} ownerKey={userId} />
        {worker.environment==='testnet'&&<OfficeFundingExit key={`funding:${userId}:${worker.id}`} userId={userId} workerId={worker.id}/>}
        {worker.environment==='testnet'&&<OfficeWorkerRecovery userId={userId} workerId={worker.id}/>}
        {worker.environment==='testnet'&&<OfficeWorkerPolicy key={`${userId}:${worker.id}`} userId={userId} workerId={worker.id}/>}
        <p>{workerRequestDescription(worker.requestedState)} On-chain eligibility: {worker.observedEligibility ?? 'not observed'}.</p>
        <div className={styles.actionRow}><button type="button" className={styles.outlineButton} disabled={busy || worker.requestedState === 'paused'} onClick={() => void control(worker.id, 'paused')}>Request pause</button><button type="button" className={styles.outlineButton} disabled={busy || worker.requestedState === 'draining'} onClick={() => void control(worker.id, 'draining')}>Request drain</button></div>
        <p className={styles.small}>These requests do not stop on-chain hires. Your operator must confirm the actual worker state.</p>
      </article>) : <p>No worker address is connected to your avatar.</p>}
      <details className={styles.binding}>
        <summary>Connect a worker address</summary>
        <p>This permanently reserves the address for your avatar on the selected network. This pilot cannot transfer or remove the connection.</p>
        <form onSubmit={requestChallenge}>
          <label htmlFor="office-worker-environment">Network</label>
          <select id="office-worker-environment" value={environment} disabled={busy} onChange={(event) => { setEnvironment(event.target.value as 'testnet' | 'mainnet'); setChallenge(null); setSignature(''); }}><option value="testnet">BrainChain testnet</option><option value="mainnet">BrainChain mainnet</option></select>
          <label htmlFor="office-worker-address">Worker public address</label>
          <input id="office-worker-address" value={address} onChange={(event) => { setAddress(event.target.value); setChallenge(null); setSignature(''); }} maxLength={42} pattern="0x[0-9a-fA-F]{40}" required spellCheck={false} autoComplete="off" placeholder="0x..." disabled={busy} />
          <button type="submit" className={styles.outlineButton} disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())}>Request ownership message</button>
        </form>
        {challenge && <form onSubmit={bind}>
          <p>Sign this exact message with your worker account using personal_sign. Paste only its signature below.</p>
          <pre tabIndex={0} aria-label="Exact worker ownership message">{challenge.messageToSign}</pre>
          <p className={styles.small}>Message expires {new Date(challenge.expiresAt).toLocaleString()}.</p>
          <label htmlFor="office-worker-signature">Signature</label>
          <textarea id="office-worker-signature" value={signature} onChange={(event) => setSignature(event.target.value)} rows={3} maxLength={132} required spellCheck={false} autoComplete="off" disabled={busy} />
          <button type="submit" className={styles.primaryButton} disabled={busy || !/^0x[0-9a-fA-F]{130}$/.test(signature.trim())}>Confirm permanent connection</button>
        </form>}
      </details>
    </>}
    {busy && <p role="status">The Office processes your request.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
  </div>;
}
