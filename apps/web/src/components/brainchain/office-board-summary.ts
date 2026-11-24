import { formatAtomic } from './office-amount';

export interface OfficeWorker { id: string; environment: 'mainnet' | 'testnet'; chainId: number; address: string; requestedState: 'paused' | 'draining' | 'running'; observedEligibility: 'eligible' | 'ineligible' | 'unknown' | null }
export interface OfficeTask { id: string; taskId: string; status: number; bountyAtomic: string; deadlineUnix: string; hireBlock: string; updatedAt: string; provisional: true }
export type BoardTone = 'neutral' | 'error';
export interface BoardMessageView { kind: 'message'; heading: string; body: string[]; tone: BoardTone }
export interface BoardTaskRow { id: string; status: string; highlight: boolean; amount: string; unit: 'USDG' | 'tUSDG'; detail: string; displayAmount: string; progress: number; muted: boolean }
export interface BoardWorkerCard { network: 'MAINNET' | 'TESTNET'; address: string; state: 'Running' | 'Paused' | 'Finishing jobs'; eligibility: string; more: number }
export interface BoardTasksView { kind: 'tasks'; worker: BoardWorkerCard; rows: BoardTaskRow[]; emptyHeading?: string; emptyBody?: string }
export interface BoardStepsView { kind: 'steps'; heading: string; steps: [string, string][] }
export type BoardView = BoardMessageView | BoardStepsView | BoardTasksView;
export interface BoardText { title: string; lines: string[]; footer: string; view: BoardView; updated: string | null }
export interface OfficeBoardSummary { ownerId: string | null; task: BoardText; receipts: BoardText }
export type ReadState<T> = { data?: T; loading: boolean; error: boolean; updatedAt?: number };
export interface BoardInput {
  ownerId: string | null; authLoading?: boolean; authError?: boolean;
  workers: ReadState<OfficeWorker[]>; tasks: ReadState<{ worker: OfficeWorker; task: OfficeTask }[]>;
}
export const BOARD_ERROR = 'Board data unavailable. Open the Office window to retry.';
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
export const STATUS_WORDS: Readonly<Record<number, string>> = Object.freeze({ 1: 'OPEN', 2: 'WORKING ON IT', 3: 'BEING CHECKED', 4: 'CHECKED', 5: 'IN DISPUTE', 6: 'PAID', 7: 'NOT PAID', 8: 'DECIDED', 9: 'APPEALED' });
const STATUS_DETAILS: Readonly<Record<number, string>> = Object.freeze({ 1: 'Open for workers', 3: 'Result sent, waiting for the checker', 4: 'Waiting out the dispute window', 5: 'Someone disputed the grade', 6: 'Good work, money sent', 7: 'The money went back to the customer', 8: 'The dispute was decided', 9: 'The decision was appealed' });
export function taskRow({ worker, task }: {worker: OfficeWorker; task: OfficeTask}): BoardTaskRow {
  const status = STATUS_WORDS[task.status] ?? 'UNKNOWN';
  const due = deadline(task.deadlineUnix);
  const detail = task.status >= 1 && task.status <= 3 && !due ? 'Due date unavailable'
    : task.status === 2 ? `Due ${due}` : STATUS_DETAILS[task.status] ?? 'Status unavailable';
  const amount = money(task.bountyAtomic);
  const unit = worker.environment === 'testnet' ? 'tUSDG' : 'USDG';
  return { id: `#${clipBoardText(task.taskId, 12)}`, status, highlight: task.status === 2, amount, unit, detail,
    displayAmount: unit === 'USDG' ? `$${amount}` : `${amount} tUSDG`,
    progress: task.status === 2 ? 2 : task.status === 3 || task.status === 4 ? 3 : task.status >= 5 && task.status <= 9 ? 4 : 0,
    muted: task.status >= 5 && task.status <= 9 };
}
export function workerCard(worker: OfficeWorker, more = 0): BoardWorkerCard {
  return { network: worker.environment === 'testnet' ? 'TESTNET' : 'MAINNET', address: shortReference(worker.address),
    state: worker.requestedState === 'running' ? 'Running' : worker.requestedState === 'paused' ? 'Paused' : 'Finishing jobs',
    eligibility: worker.observedEligibility === 'eligible' ? 'Can take paid jobs' : worker.observedEligibility === 'ineligible' ? 'Not ready for paid jobs yet' : 'Not checked yet', more };
}
/** Counts cover every fetched row, before the display takes its five rows. */
export function countOfficeTasks(rows: {task: OfficeTask}[], pageLimited = false) {
  const total = rows.length, inProgress = rows.filter(({task}) => task.status === 2 || task.status === 3).length;
  const needsWork = rows.filter(({task}) => task.status === 2).length, paid = rows.filter(({task}) => task.status === 6).length;
  const label = (value: number) => `${value}${pageLimited ? '+' : ''}`;
  return { total, inProgress, needsWork, paid, limited: pageLimited, totalLabel: pageLimited ? '100+' : label(total), inProgressLabel: label(inProgress), paidLabel: label(paid) };
}
export function taskLine(record: {worker: OfficeWorker; task: OfficeTask}) {
  const row = taskRow(record);
  return `${row.id} ${row.status} | ${row.displayAmount} | ${row.detail}`;
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
    task: messageBoard('JOB BOARD', message('Your AI can earn money here', ['It does small paid jobs for BrainChain customers.', 'Sign in to see its jobs and pay.']), 'New here? Talk to Cortex at the front desk.'),
    receipts: messageBoard('EARNINGS', message('Your AI can earn money here', ['It does small paid jobs for BrainChain customers.', 'Sign in to see its jobs and pay.']), 'New here? Talk to Cortex at the front desk.'),
  };
  const stop = input.authError || workers.error || tasks.error
    ? message('Board data unavailable', ['Open the Office window to retry.'], 'error')
    : input.authLoading ? message('Checking your account') : null;
  if (stop) {
    result.task = messageBoard('JOB BOARD', stop);
    result.receipts = messageBoard('EARNINGS', stop, result.receipts.footer);
    return result;
  }
  if (!ownerId) return result;
  if (workers.loading) {
    result.task = messageBoard('JOB BOARD', message('Loading your AI'));
    result.receipts = messageBoard('EARNINGS', message('Loading your AI'), result.receipts.footer);
    return result;
  }
  result.receipts = messageBoard('EARNINGS', message('Your paid jobs are in Earnings', ['Walk up to this wall and press E to see them.']), 'Pay counts only after the review ends.');
  const times = [workers.updatedAt, tasks.updatedAt].filter((time): time is number => typeof time === 'number' && time > 0 && Number.isFinite(time) && Number.isFinite(new Date(time).getTime()));
  const updated = times.length ? new Date(Math.max(...times)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  result.receipts.updated = updated;
  const first = workers.data?.[0];
  if (!first) {
    const view: BoardStepsView = { kind: 'steps', heading: 'Your AI is not doing jobs yet', steps: [
      ['Talk to Cortex', 'She explains how AI jobs and pay work.'],
      ['Set up your AI at a pod', 'A pod connects your AI to BrainChain.'],
      ['Watch this board', 'Jobs and pay show up here.'],
    ] };
    result.task = { title: 'JOB BOARD', view, lines: [view.heading, ...view.steps.flat()],
      footer: 'Joining needs a BRAIN stake. Cortex explains the costs first.', updated };
    return result;
  }
  const view: BoardTasksView = {
    kind: 'tasks',
    worker: workerCard(first, (workers.data?.length ?? 1) - 1),
    rows: tasks.loading ? [] : (tasks.data ?? []).slice(0, 5).map(taskRow),
  };
  if (tasks.loading) view.emptyHeading = 'Loading jobs';
  else if (!view.rows.length) {
    view.emptyHeading = 'No jobs yet';
    view.emptyBody = 'BrainChain hires running workers that can take paid jobs. New jobs show here.';
  }
  const lines = ['YOUR AI', `${view.worker.state} | ${view.worker.eligibility} | ${view.worker.address}`,
    ...(view.worker.more ? [`+${view.worker.more} more`] : []),
    ...(view.emptyHeading ? [view.emptyHeading, ...(view.emptyBody ? [view.emptyBody] : [])] : (tasks.data ?? []).slice(0, 5).map(taskLine))];
  result.task = { title: 'JOB BOARD', view, lines: lines.map(line => clipBoardText(line)), footer: 'Pay is final after the review ends. $ = USDG, a dollar coin.', updated };
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
