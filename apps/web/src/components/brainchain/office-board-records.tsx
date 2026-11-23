'use client';

import { useOfficeBoardData } from './office-board-data';
import { OfficeWorkerRecord } from './office-worker-record';
import styles from './brainchain-office.module.css';

/** The window and canvas receive the same bounded list from the same cache. */
export function OfficeBoardRecords({kind}: {kind: 'task' | 'receipts'}) {
  const {summary, workers, retry} = useOfficeBoardData();
  const board = summary[kind];
  return <section aria-label={kind === 'task' ? 'Indexed worker tasks' : 'Account receipts'}>
    <h3>{kind === 'task' ? 'Task index and purchase orders' : 'Receipt records'}</h3>
    <ul>{board.lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
    {board.footer && <p className={styles.small}>{board.footer}</p>}
    <button type="button" className={styles.textButton} onClick={retry}>Refresh Office records</button>
    {kind === 'receipts' && summary.ownerId && workers.map(worker => <article key={`${summary.ownerId}:${worker.id}`}>
      <h4>{worker.environment} worker {worker.address}</h4>
      <OfficeWorkerRecord workerId={worker.id} ownerKey={summary.ownerId!} />
    </article>)}
  </section>;
}
