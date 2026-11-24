'use client';

import { useOfficeBoardData } from './office-board-data';
import type { BoardTaskRow } from './office-board-summary';
import { OfficeWorkerRecord } from './office-worker-record';
import styles from './brainchain-office.module.css';

function OfficeJobRow({ row }: { row: BoardTaskRow }) {
  return <article className={styles.job}>
    <span className={styles.jobId}>{row.id}</span>
    <div className={styles.jobDetail}>
      <strong>{row.status}</strong><small>{row.detail}</small>
      <span className={styles.jobTrack} data-muted={row.muted && row.status !== 'PAID'} role="img" aria-label={`${row.progress} of 4 job stages`}>
        {[0, 1, 2, 3].map(segment => <i key={segment} data-filled={segment < row.progress} />)}
      </span>
    </div>
    <span className={styles.jobPill} data-solid={row.highlight} data-muted={row.muted}>{row.status}</span>
    <span className={styles.jobAmount}>{row.displayAmount}</span>
  </article>;
}

const EXAMPLE_JOBS: BoardTaskRow[] = [
  { id: '#1042', status: 'WORKING ON IT', highlight: true, amount: '4.50', unit: 'USDG', displayAmount: '$4.50', detail: 'Due today 3:00 PM', progress: 2, muted: false },
  { id: '#1038', status: 'BEING CHECKED', highlight: false, amount: '2.00', unit: 'USDG', displayAmount: '$2.00', detail: 'Result sent, waiting for the checker', progress: 3, muted: false },
  { id: '#1031', status: 'PAID', highlight: false, amount: '6.25', unit: 'USDG', displayAmount: '$6.25', detail: 'Good work, money sent', progress: 4, muted: true },
];

export function OfficeExampleJobs() {
  return <section aria-label="Example jobs" className={styles.exampleJobs}>
    <div className={styles.exampleHeader}><strong>JOB BOARD</strong><span className={styles.jobPill}>EXAMPLE</span></div>
    <div className={styles.jobs}>{EXAMPLE_JOBS.map(row => <OfficeJobRow key={row.id} row={row} />)}</div>
  </section>;
}

/** The window and canvas receive the same bounded list from the same cache. */
export function OfficeBoardRecords({kind}: {kind: 'task' | 'receipts'}) {
  const {summary, workers, retry} = useOfficeBoardData();
  const board = summary[kind];
  const view = board.view;
  const receiptsAvailable = kind === 'receipts' && summary.ownerId !== null && view.kind === 'message'
    && view.heading === 'Your paid jobs are in Earnings';
  return <section className={styles.records} aria-label={kind === 'task' ? 'Indexed worker tasks' : 'Account receipts'}>
    {view.kind === 'tasks' && <>
      {view.emptyHeading ? <div className={styles.notice}><h3>{view.emptyHeading}</h3>{view.emptyBody && <p>{view.emptyBody}</p>}</div>
        : <div className={styles.jobs}>{view.rows.slice(0, 5).map((row, index) => <OfficeJobRow row={row} key={`${index}:${row.id}`} />)}</div>}
    </>}
    {view.kind === 'steps' && <div className={styles.notice}><h3>{view.heading}</h3><ol>
      {view.steps.map(([heading, body]) => <li key={heading}><strong>{heading}</strong><p>{body}</p></li>)}
    </ol></div>}
    {view.kind === 'message' && !receiptsAvailable && <div className={styles.notice} role={view.tone === 'error' ? 'alert' : undefined}>
      <h3>{view.heading}</h3>{view.body.map(line => <p key={line}>{line}</p>)}
    </div>}
    {receiptsAvailable && (workers.length ? <>
      <p className={styles.small}>Read your worker records to check balances and payment receipts.</p>
      {workers.map(worker => <article className={styles.recordCard} key={`${summary.ownerId}:${worker.id}`}>
        <h3>{worker.environment === 'testnet' ? 'Testnet worker' : 'Mainnet worker'}</h3>
        <p className={styles.address}>{worker.address}</p>
        <OfficeWorkerRecord workerId={worker.id} ownerKey={summary.ownerId!} />
      </article>)}
    </> : <div className={styles.notice}><h3>No AI connected yet</h3><p>Connect your AI to see its worker records here.</p></div>)}
    {board.footer && <p className={styles.small}>{board.footer}</p>}
    <button type="button" className={styles.textButton} onClick={retry}>Refresh</button>
  </section>;
}
