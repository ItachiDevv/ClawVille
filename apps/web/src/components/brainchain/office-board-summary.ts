import type { BrainchainBuyerOrder } from '@clawville/shared';
import type { Operation } from './office-funding-exit';
import { formatAtomic } from './office-amount';

export interface OfficeWorker { id: string; environment: 'mainnet' | 'testnet'; chainId: number; address: string; requestedState: 'paused' | 'draining' | 'running'; observedEligibility: 'eligible' | 'ineligible' | 'unknown' | null }
export interface OfficeTask { id: string; taskId: string; status: number; bountyAtomic: string; deadlineUnix: string; hireBlock: string; updatedAt: string; provisional: true }
export interface BoardText { title: string; lines: string[]; footer: string }
export interface OfficeBoardSummary { ownerId: string | null; task: BoardText; receipts: BoardText }
export type ReadState<T> = { data?: T; loading: boolean; error: boolean; updatedAt?: number };
export interface BoardInput {
  ownerId: string | null; authLoading?: boolean; authError?: boolean;
  workers: ReadState<OfficeWorker[]>; tasks: ReadState<{ worker: OfficeWorker; task: OfficeTask }[]>;
  purchases: ReadState<BrainchainBuyerOrder[]>; funding: ReadState<Operation[]>;
}
export const BOARD_ERROR = 'Data unavailable. Open the Office window to retry.';
export function clipBoardText(value: string, limit = 88) { return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; }
export function shortReference(value: string) { return value.length > 16 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value; }
function deadline(value: string) {
  if (!/^\d{1,16}$/.test(value) || Number(value) > 8_640_000_000_000) return 'unavailable';
  return new Date(Number(value) * 1000).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function taskLine({ worker, task }: {worker: OfficeWorker; task: OfficeTask}) {
  return `#${clipBoardText(task.taskId, 12)} Status ${task.status} | ${formatAtomic(task.bountyAtomic, 6)} ${worker.environment === 'testnet' ? 'tUSDG' : 'USDG'} | Due ${deadline(task.deadlineUnix)}`;
}
export function formatOfficeBoards(input: BoardInput): OfficeBoardSummary {
  const { ownerId, workers, tasks, purchases, funding } = input;
  const result: OfficeBoardSummary = { ownerId, task: { title: 'TASK BOARD', lines: [], footer: '' }, receipts: { title: 'RECEIPTS', lines: [], footer: 'Income counts only after settlement.' } };
  const stop = input.authError ? BOARD_ERROR : input.authLoading ? 'Check your account...' : !ownerId ? 'Sign in' : null;
  if (stop) {
    result.task.lines = [stop === 'Sign in' ? 'Sign in to see your workers' : stop];
    result.receipts.lines = [stop === 'Sign in' ? 'Sign in to see your receipts' : stop];
    return result;
  }
  const work = result.task.lines;
  work.push('Work status | Provisional index');
  if (workers.error) work.push(BOARD_ERROR);
  else if (workers.loading) work.push('Load your workers...');
  else if (!workers.data?.length) work.push('No worker connected. Visit a pod to set one up.');
  else for (const worker of workers.data.slice(0, 2)) work.push(`${worker.environment} ${shortReference(worker.address)} | ${worker.requestedState} | ${worker.observedEligibility ?? 'unknown'}`);
  if (tasks.error) work.push(BOARD_ERROR);
  else if (tasks.loading || workers.loading) work.push('Load your tasks...');
  else if (!workers.error) work.push(...(tasks.data?.length ? tasks.data.slice(0, 5).map(taskLine) : ['No tasks indexed yet']));
  work.push('Hire help');
  if (purchases.error) work.push(BOARD_ERROR);
  else if (purchases.loading) work.push('Load your purchase orders...');
  else {
    const open = purchases.data?.filter(order => !['refunded', 'canceled'].includes(order.state)) ?? [];
    work.push(...(open.length ? open.slice(0, 2).map(order => `${clipBoardText(order.title, 48)} | ${order.state}`) : ['No open purchase orders']));
  }
  const receipts = result.receipts.lines;
  receipts.push('Account records | Provisional');
  if (workers.error) receipts.push(BOARD_ERROR);
  else if (workers.loading) receipts.push('Load your workers...');
  else if (!workers.data?.length) receipts.push('No worker connected. Visit a pod to set one up.');
  if (purchases.error || funding.error) receipts.push(BOARD_ERROR);
  else if (purchases.loading || funding.loading) receipts.push('Load your receipts...');
  else {
    const orders = (purchases.data ?? []).flatMap(order => [order.paymentTransaction ? `${order.state} | ${order.network ?? 'eip155:84532'} | Payment ${shortReference(order.paymentTransaction)}` : null, order.refundTransaction ? `${order.state} | ${order.network ?? 'eip155:84532'} | Refund ${shortReference(order.refundTransaction)}` : null].filter((line): line is string => !!line));
    receipts.push(...orders.slice(0, 3));
    receipts.push(...(funding.data ?? []).slice(0, 3).map(operation => `${operation.kind} | ${operation.state} | ${shortReference(operation.sourceTransaction ?? operation.id)}`));
    if (!orders.length && !funding.data?.length) receipts.push('No settled receipts yet');
    if (funding.data?.length) receipts.push('Source records do not confirm destination payment.');
  }
  receipts.push('Open Earnings to read paid bounties');
  const times = [workers, tasks, purchases, funding].map(read => read.updatedAt ?? 0).filter(Boolean);
  if (times.length) result.task.footer = `Updated ${new Date(Math.max(...times)).toLocaleTimeString()}`;
  result.task.lines = work.slice(0, 12).map(line => clipBoardText(line));
  result.receipts.lines = receipts.slice(0, 10).map(line => clipBoardText(line));
  return result;
}
export const EMPTY_OFFICE_BOARDS = formatOfficeBoards({ ownerId: null, workers: {loading:false,error:false}, tasks: {loading:false,error:false}, purchases: {loading:false,error:false}, funding: {loading:false,error:false} });

/** Re-check auth at publication time: React can commit an older render after logout. */
export function officeBoardPublication(summary: OfficeBoardSummary, currentOwner: string | null, authError: boolean): OfficeBoardSummary | null {
  if (summary.ownerId !== currentOwner) return null;
  if (!authError) return summary;
  return {...EMPTY_OFFICE_BOARDS, ownerId: currentOwner,
    task: {...EMPTY_OFFICE_BOARDS.task, lines: [BOARD_ERROR]},
    receipts: {...EMPTY_OFFICE_BOARDS.receipts, lines: [BOARD_ERROR]},
  };
}
export function officeBoardRefreshInterval(room: boolean, active: boolean, visible: boolean): 60000 | false {
  return room && active && visible ? 60_000 : false;
}
