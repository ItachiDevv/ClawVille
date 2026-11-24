import { formatAtomic } from './office-amount';

export interface OfficeWorker { id: string; environment: 'mainnet' | 'testnet'; chainId: number; address: string; requestedState: 'paused' | 'draining' | 'running'; observedEligibility: 'eligible' | 'ineligible' | 'unknown' | null }
export interface OfficeTask { id: string; taskId: string; status: number; bountyAtomic: string; deadlineUnix: string; hireBlock: string; updatedAt: string; provisional: true }
export type BoardTone = 'neutral' | 'error';
export interface BoardMessageView { kind: 'message'; heading: string; body: string[]; tone: BoardTone }
export interface BoardTaskRow { id: string; status: string; highlight: boolean; amount: string; unit: 'USDG' | 'tUSDG'; detail: string }
export interface BoardWorkerCard { network: 'MAINNET' | 'TESTNET'; address: string; state: 'Running' | 'Paused' | 'Draining'; eligibility: string; more: number }
export interface BoardTasksView { kind: 'tasks'; worker: BoardWorkerCard; rows: BoardTaskRow[]; emptyHeading?: string; emptyBody?: string }
export type BoardView = BoardMessageView | BoardTasksView;
export interface BoardText { title: string; lines: string[]; footer: string; view: BoardView; updated: string | null }
export interface OfficeBoardSummary { ownerId: string | null; task: BoardText; receipts: BoardText }
export type ReadState<T> = { data?: T; loading: boolean; error: boolean; updatedAt?: number };
export interface BoardInput {
  ownerId: string | null; authLoading?: boolean; authError?: boolean;
  workers: ReadState<OfficeWorker[]>; tasks: ReadState<{ worker: OfficeWorker; task: OfficeTask }[]>;
}
export const BOARD_ERROR = 'Data unavailable. Open the Office window to retry.';
export function clipBoardText(value: string, limit = 88) { return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; }
export function shortReference(value: string) { return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value; }
function deadline(value: string) {
  if (!/^\d{1,16}$/.test(value) || Number(value) > 8_640_000_000_000) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '') : null;
}
/** Exact amount with at least two decimals (4.5 -> 4.50, 2 -> 2.00); never rounds. */
function money(atomic: string) {
  const exact = formatAtomic(atomic, 6);
  if (!/^\d+(\.\d+)?$/.test(exact)) return exact;
  const [whole, fraction = ''] = exact.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
const STATUS_WORDS: Record<number, string> = { 1: 'OPEN', 2: 'HIRED', 3: 'SUBMITTED', 4: 'GRADED', 5: 'DISPUTED', 6: 'PAID', 7: 'REFUNDED', 8: 'RULED', 9: 'APPEALED' };
function taskRow({ worker, task }: {worker: OfficeWorker; task: OfficeTask}): BoardTaskRow {
  const status = STATUS_WORDS[task.status] ?? 'UNKNOWN';
  const due = deadline(task.deadlineUnix);
  const detail = task.status === 6 ? 'Paid' : task.status === 7 ? 'Refunded' : task.status === 4 ? 'In dispute window' : task.status === 5 || task.status === 9 ? 'In dispute' : task.status === 8 ? 'Ruled' : task.status >= 1 && task.status <= 3 ? due ? `Due ${due}` : 'Due date unavailable' : 'Status unavailable';
  return { id: `#${clipBoardText(task.taskId, 12)}`, status, highlight: task.status === 2, amount: money(task.bountyAtomic), unit: worker.environment === 'testnet' ? 'tUSDG' : 'USDG', detail };
}
export function taskLine(record: {worker: OfficeWorker; task: OfficeTask}) {
  const row = taskRow(record);
  return `${row.id} ${row.status} | ${row.amount} ${row.unit} | ${row.detail}`;
}
function message(heading: string, body: string[] = [], tone: BoardTone = 'neutral'): BoardMessageView {
  return { kind: 'message', heading, body, tone };
}
function messageBoard(title: string, view: BoardMessageView, footer = ''): BoardText {
  return { title, view, lines: view.tone === 'error' ? [BOARD_ERROR] : [view.heading, ...view.body], footer, updated: null };
}
export function formatOfficeBoards(input: BoardInput): OfficeBoardSummary {
  const { ownerId, workers, tasks } = input;
  const result: OfficeBoardSummary = {
    ownerId,
    task: messageBoard('TASK BOARD', message('Sign in to see your work', ['Your workers, hired tasks and pay show here.'])),
    receipts: messageBoard('RECEIPTS', message('Sign in to see your receipts', ['Your paid bounties show in Earnings.']), 'Income counts only after settlement.'),
  };
  const stop = input.authError || workers.error || tasks.error
    ? message('Board data unavailable', ['Open the Office window to retry.'], 'error')
    : input.authLoading ? message('Checking your account') : null;
  if (stop) {
    result.task = messageBoard('TASK BOARD', stop);
    result.receipts = messageBoard('RECEIPTS', stop, result.receipts.footer);
    return result;
  }
  if (!ownerId) return result;
  if (workers.loading) {
    result.task = messageBoard('TASK BOARD', message('Loading your workers'));
    result.receipts = messageBoard('RECEIPTS', message('Loading your workers'), result.receipts.footer);
    return result;
  }
  result.receipts = messageBoard('RECEIPTS', message('Your paid bounties are in Earnings', ['Walk up to this wall and press E to open Earnings.']), result.receipts.footer);
  const times = [workers.updatedAt, tasks.updatedAt].filter((time): time is number => typeof time === 'number' && time > 0 && Number.isFinite(time) && Number.isFinite(new Date(time).getTime()));
  const updated = times.length ? new Date(Math.max(...times)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  result.receipts.updated = updated;
  const first = workers.data?.[0];
  if (!first) {
    result.task = messageBoard('TASK BOARD', message('No worker connected yet', ['Walk to a worker pod and press E to set one up.', 'Your hired tasks and pay show here.']), 'Learn how earning works at the Cortex desk.');
    result.task.updated = updated;
    return result;
  }
  const view: BoardTasksView = {
    kind: 'tasks',
    worker: {
      network: first.environment === 'testnet' ? 'TESTNET' : 'MAINNET', address: shortReference(first.address),
      state: first.requestedState === 'running' ? 'Running' : first.requestedState === 'paused' ? 'Paused' : 'Draining',
      eligibility: first.observedEligibility === 'eligible' ? 'Eligible for customer tasks' : first.observedEligibility === 'ineligible' ? 'Not eligible yet' : 'Eligibility not checked yet',
      more: (workers.data?.length ?? 1) - 1,
    },
    rows: tasks.loading ? [] : (tasks.data ?? []).slice(0, 3).map(taskRow),
  };
  if (tasks.loading) view.emptyHeading = 'Loading tasks';
  else if (!view.rows.length) {
    view.emptyHeading = 'No tasks yet';
    view.emptyBody = 'BrainChain hires running, eligible workers. New tasks show here.';
  }
  const lines = ['Work status | Provisional index', ...(workers.data ?? []).slice(0, 2).map(worker => `${worker.environment} ${shortReference(worker.address)} | ${worker.requestedState} | ${worker.observedEligibility ?? 'unknown'}`), ...(view.emptyHeading ? [view.emptyHeading, ...(view.emptyBody ? [view.emptyBody] : [])] : (tasks.data ?? []).slice(0, 5).map(taskLine))];
  result.task = { title: 'TASK BOARD', view, lines: lines.map(line => clipBoardText(line)), footer: 'Provisional index. Income counts only after settlement.', updated };
  return result;
}
export const EMPTY_OFFICE_BOARDS = formatOfficeBoards({ ownerId: null, workers: {loading:false,error:false}, tasks: {loading:false,error:false} });

/** Re-check auth at publication time: React can commit an older render after logout. */
export function officeBoardPublication(summary: OfficeBoardSummary, currentOwner: string | null, authError: boolean): OfficeBoardSummary | null {
  if (summary.ownerId !== currentOwner) return null;
  if (!authError) return summary;
  return formatOfficeBoards({ ownerId: currentOwner, authError: true, workers: { loading: false, error: false }, tasks: { loading: false, error: false } });
}
export function officeBoardRefreshInterval(room: boolean, active: boolean, visible: boolean): 60000 | false {
  return room && active && visible ? 60_000 : false;
}
