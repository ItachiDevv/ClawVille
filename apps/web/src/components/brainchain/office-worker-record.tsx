'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BrainchainEarningsPage } from '@clawville/shared';
import { officeAccountRequest, observationTime } from './office-api';
import styles from './brainchain-office.module.css';

import { formatAtomic } from './office-amount';
export { formatAtomic } from './office-amount';

export function formatUnlockTime(value: string): string {
  if (!/^(0|[1-9]\d{0,19})$/.test(value)) return 'Unlock time unavailable';
  const seconds = BigInt(value);
  if (seconds === 0n) return 'No unlock time set';
  if (seconds > 8_640_000_000_000n) return 'Unlock time unavailable';
  return new Date(Number(seconds) * 1000).toLocaleString();
}

export function OfficeWorkerRecord({ workerId, ownerKey }: { workerId: string; ownerKey: string }) {
  const [requested, setRequested] = useState(false);
  const [board, setBoard] = useState<string>();
  const [fromBlock, setFromBlock] = useState<string>();
  const query = useQuery({
    queryKey: ['brainchain-office', 'earnings', ownerKey, workerId, board, fromBlock],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (board) params.set('board', board);
      if (fromBlock) params.set('fromBlock', fromBlock);
      const path = params.size ? `workers/${workerId}/earnings?${params}` as const : `workers/${workerId}/earnings` as const;
      return officeAccountRequest<BrainchainEarningsPage>(path, signal);
    },
    enabled: requested, retry: false, staleTime: 30_000, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const page = query.data;
  const unit = page?.environment === 'testnet' ? 'tUSDG' : 'USDG';
  return <section aria-label="Worker balances and payment receipts">
    <button type="button" className={styles.outlineButton} disabled={query.isFetching} onClick={() => requested ? void query.refetch() : setRequested(true)}>
      {query.isFetching ? 'Check chain observations...' : requested ? 'Refresh observations' : 'Read balances and payment receipts'}
    </button>
    {query.isError && <p role="alert">{query.error.message}</p>}
    {page && <>
      <p>Provisional {page.environment} observation at block {page.block.number}. {observationTime(page.observedAt)}.</p>
      <p>{page.freshness.state === 'stale' ? 'Stale chain observation. ' : ''}These observations do not confirm a cash-out or final settlement.</p>
      <p>Wallet balance: {formatAtomic(page.balances.usdgAtomic, 6)} {unit}; {formatAtomic(page.balances.brainAtomic, 18)} {page.environment === 'testnet' ? 'tBRAIN' : 'BRAIN'}; gas: {formatAtomic(page.balances.gasWei, 18)} ETH.</p>
      <p>Stake: {formatAtomic(page.stake.stakedAtomic, 18)} {page.environment === 'testnet' ? 'tBRAIN' : 'BRAIN'}. Pending unstake: {formatAtomic(page.stake.unstakingAtomic, 18)}. Unstake unlock time: {formatUnlockTime(page.stake.unlocksAtUnix)}. Held slots: {page.stake.held}. Registration: {page.stake.registered ? 'observed' : 'not observed'}. Stake is separate from the wallet balance. This panel cannot withdraw it.</p>
      <label>Task board <select value={board ?? page.history.boardAddress} onChange={event => { setBoard(event.target.value); setFromBlock(undefined); }}>
        {page.history.boards.map(entry => <option key={entry.address} value={entry.address}>{entry.release}: {entry.address}</option>)}
      </select></label>
      <p>Receipt coverage: this board, blocks {page.history.fromBlock}–{page.history.throughBlock ?? 'not scanned'}. This is not lifetime income.</p>
      <p>Observed net payments on this page: {formatAtomic(page.history.pageNetAtomic, 6)} {unit}.</p>
      {page.history.receipts.length ? <ul>{page.history.receipts.map(receipt => <li key={`${receipt.transactionHash}:${receipt.logIndex}`}>
        Task {receipt.taskId}: {formatAtomic(receipt.netAtomic, 6)} {unit} net; fee {formatAtomic(receipt.feeAtomic, 6)} {unit}. Block {receipt.blockNumber}. Transaction <span className={styles.address}>{receipt.transactionHash}</span>.
      </li>)}</ul> : <p>No matching payment receipts appear in this range.</p>}
      {page.history.nextBlock && <button type="button" className={styles.outlineButton} disabled={query.isFetching} onClick={() => { setBoard(page.history.boardAddress); setFromBlock(page.history.nextBlock ?? undefined); }}>Read next range</button>}
      {fromBlock && <button type="button" className={styles.textButton} onClick={() => setFromBlock(undefined)}>Return to first range</button>}
    </>}
  </section>;
}
