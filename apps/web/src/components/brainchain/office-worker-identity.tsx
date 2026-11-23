'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BrainchainIdentityCredit } from '@clawville/shared';
import { officeAccountRequest, observationTime } from './office-api';
import { formatAtomic } from './office-worker-record';
import styles from './brainchain-office.module.css';

export function formatReputation(value: string, decimals: number): string {
  if (!/^-?(0|[1-9]\d{0,38})$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return 'Unavailable';
  if (decimals === 0) return value;
  return `${value.startsWith('-') ? '-' : ''}${formatAtomic(value.replace(/^-/, ''), decimals)}`;
}

export function OfficeWorkerIdentity({ workerId, ownerKey }: { workerId: string; ownerKey: string }) {
  const [input, setInput] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const query = useQuery({ queryKey: ['brainchain-office', 'identity-credit', ownerKey, workerId, agentId],
    queryFn: ({ signal }) => officeAccountRequest<BrainchainIdentityCredit>(`workers/${workerId}/identity-credit?agentId=${agentId}`, signal),
    enabled: agentId !== null, retry: false, gcTime: 0, staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^(0|[1-9]\d{0,77})$/.test(input) || BigInt(input) >= 2n ** 256n) { setError('Enter a valid ERC-8004 identity number.'); return; }
    setError('');
    if (agentId === input) void query.refetch(); else setAgentId(input);
  }
  const result = query.data;
  const record = result && 'line' in result.record ? result.record : null;
  const routes = result && 'options' in result.routes ? result.routes : null;
  return <section aria-label="Worker identity and credit observations">
    <h4>Identity and credit record</h4>
    <form onSubmit={submit}>
      <label>ERC-8004 identity number <input value={input} onChange={event => setInput(event.target.value)} inputMode="numeric" maxLength={78} pattern="[0-9]+" required autoComplete="off" /></label>
      <button className={styles.outlineButton} type="submit" disabled={query.isFetching}>{query.isFetching ? 'Check identity...' : 'Read identity and credit record'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {query.isError && <p role="alert">{query.error.message}</p>}
    {result && <>
      <p>Identity #{result.agentId}. Provisional observation: {observationTime(result.observedAt)}.</p>
      {result.identity.state === 'verified' ? <>
        <p>Current association: {result.identity.association.replace('_', ' ')}. Robinhood Chain block {result.identity.block.number}.</p>
        <p>Identity owner: <span className={styles.address}>{result.identity.owner}</span>. Registered wallet: <span className={styles.address}>{result.identity.registeredWallet}</span>.</p>
        <p>A registered wallet is separate from owner authority. This read grants no consent or loan authority. Current association does not identify earlier hires.</p>
      </> : <p>Identity status: {result.identity.state.replaceAll('_', ' ')}. The Office cannot confirm a current association for credit reads.</p>}
      {result.reputation.state === 'observed' ? <p>BrainChain issuer feedback: {result.reputation.count} entries. {result.reputation.count === '0' ? 'No feedback evidence.' : `Reported average: ${formatReputation(result.reputation.summaryValue, result.reputation.summaryValueDecimals)}.`} The reader filters the authorized BrainChain issuer.</p> : <p>BrainChain reputation: {result.reputation.state.replaceAll('_', ' ')}.</p>}
      {record ? <>
        <p>{record.state === 'stale' ? 'Stale Priors record. ' : ''}Priors snapshot: {observationTime(record.asOf)}.</p>
        <p>Credit line: {record.line} USDG. Reported available credit: {record.available} USDG. Drawn: {record.drawn} USDG. Premium: {record.premiumBps} basis points. Credit capacity is separate from wallet balance.</p>
        <p>Repaid loans: {record.loansRepaid}; qualified repayments: {record.qualifiedRepaid}; repaid volume: {record.volumeRepaid} USDG; fees paid: {record.feesPaid} USDG. Priors score: {record.score}/1000. Default: {record.defaulted ? 'reported' : 'not reported'}. Frozen: {record.frozen ? 'reported' : 'not reported'}.</p>
        <p>Backer: {record.isRoot ? 'this identity is a root backer' : record.backerId ? `identity #${record.backerId}` : 'not reported'}. Open loans: {record.openLoans.count}. {record.openLoans.state === 'terms_unavailable' ? 'Open loan terms are unavailable; the Office cannot confirm amounts or due dates.' : 'No open loans appear in this snapshot.'}</p>
      </> : <p>Priors record: {result.record.state.replaceAll('_', ' ')}.</p>}
      {routes ? <>
        <p>{routes.state === 'stale' ? 'Stale credit route observations. ' : ''}Route snapshot: {routes.asOf.snapshot ? observationTime(routes.asOf.snapshot) : 'unavailable'}. Stock snapshot: {routes.asOf.stocks ? observationTime(routes.asOf.stocks) : 'unavailable'}.</p>
        <ul>{routes.options.map(option => <li key={option.route}>{option.route.replaceAll('_', ' ')}: {option.open === null ? 'unknown' : option.open ? 'reported open' : 'reported closed'}{option.line !== null ? `; line quote ${option.line} USDG` : ''}{option.upTo !== null ? `; up to ${option.upTo} USDG` : ''}.</li>)}</ul>
        <p>Route quotes can use rounded amounts. A reported open route is not a credit offer or permission to use collateral.</p>
      </> : <p>Credit routes: {result.routes.state.replaceAll('_', ' ')}.</p>}
    </>}
  </section>;
}
