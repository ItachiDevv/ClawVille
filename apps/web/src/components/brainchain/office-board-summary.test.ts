import { describe, expect, test } from 'bun:test';
import { EMPTY_OFFICE_BOARDS, BOARD_ERROR, clipBoardText, formatOfficeBoards, officeBoardPublication, officeBoardRefreshInterval, type BoardInput, type OfficeWorker } from './office-board-summary';

const worker: OfficeWorker = {id:'worker', environment:'testnet', chainId:46630, address:'0x12345678901234567890123456789012345678abcd', requestedState:'paused', observedEligibility:'unknown'};
const empty = (): BoardInput => ({ownerId:'alice', workers:{data:[],loading:false,error:false}, tasks:{data:[],loading:false,error:false}});
const record = (status = 2, bountyAtomic = '1234567', deadlineUnix = '1800000000') => ({worker, task:{id:'row', taskId:'47', status, bountyAtomic, deadlineUnix, hireBlock:'9', updatedAt:'2026-11-13T00:00:00Z', provisional:true as const}});
const populated = (): BoardInput => ({...empty(), workers:{data:[worker],loading:false,error:false}, tasks:{data:[record()],loading:false,error:false}});
describe('Office board owner summaries', () => {
  test('signed out and guest use no private rows', () => {
    const input = populated(); input.ownerId = null;
    expect(formatOfficeBoards(input)).toEqual(EMPTY_OFFICE_BOARDS);
    expect(EMPTY_OFFICE_BOARDS.task.view).toEqual({kind:'message', heading:'Sign in to see your work', body:['Your workers, hired tasks and pay show here.'], tone:'neutral'});
    expect(EMPTY_OFFICE_BOARDS.receipts.view).toEqual({kind:'message', heading:'Sign in to see your receipts', body:['Your paid bounties show in Earnings.'], tone:'neutral'});
    expect(EMPTY_OFFICE_BOARDS.task.updated).toBeNull();
  });
  test('auth loading hides cached rows and precedes signed out', () => {
    const input = populated(); input.ownerId = null; input.authLoading = true;
    const summary = formatOfficeBoards(input);
    for (const board of [summary.task, summary.receipts]) expect(board.view).toEqual({kind:'message', heading:'Checking your account', body:[], tone:'neutral'});
  });
  test('each error precedes loading and signed out on both boards', () => {
    for (const source of ['auth', 'workers', 'tasks'] as const) {
      const input = populated(); input.ownerId = null; input.authLoading = true; input.workers.loading = true;
      if (source === 'auth') input.authError = true;
      else input[source].error = true;
      const summary = formatOfficeBoards(input);
      for (const board of [summary.task, summary.receipts]) {
        expect(board.view).toEqual({kind:'message', heading:'Board data unavailable', body:['Open the Office window to retry.'], tone:'error'});
        expect(board.lines).toEqual([BOARD_ERROR]);
        expect(board.updated).toBeNull();
      }
    }
  });
  test('workers loading precedes cached workers and tasks', () => {
    const input = populated(); input.workers.loading = true;
    const summary = formatOfficeBoards(input);
    for (const board of [summary.task, summary.receipts]) expect(board.view).toEqual({kind:'message', heading:'Loading your workers', body:[], tone:'neutral'});
  });
  test('no worker gives setup instructions and Earnings directions', () => {
    const summary = formatOfficeBoards(empty());
    expect(summary.task.view).toEqual({kind:'message', heading:'No worker connected yet', body:['Walk to a worker pod and press E to set one up.', 'Your hired tasks and pay show here.'], tone:'neutral'});
    expect(summary.task.footer).toBe('Learn how earning works at the Cortex desk.');
    expect(summary.receipts.view).toEqual({kind:'message', heading:'Your paid bounties are in Earnings', body:['Walk up to this wall and press E to open Earnings.'], tone:'neutral'});
    expect(summary.receipts.footer).toBe('Income counts only after settlement.');
  });
  test('tasks loading retains worker but hides cached tasks', () => {
    const input = populated(); input.tasks.loading = true;
    const view = formatOfficeBoards(input).task.view;
    expect(view.kind).toBe('tasks');
    if (view.kind !== 'tasks') throw new Error('Expected tasks view');
    expect(view.rows).toEqual([]);
    expect(view.emptyHeading).toBe('Loading tasks');
    expect(view.emptyBody).toBeUndefined();
  });
  test('worker without tasks has honest empty text', () => {
    const input = populated(); input.tasks.data = [];
    const view = formatOfficeBoards(input).task.view;
    if (view.kind !== 'tasks') throw new Error('Expected tasks view');
    expect(view.emptyHeading).toBe('No tasks yet');
    expect(view.emptyBody).toBe('BrainChain hires running, eligible workers. New tasks show here.');
    expect(view.worker).toEqual({network:'TESTNET', address:'0x1234\u2026abcd', state:'Paused', eligibility:'Eligibility not checked yet', more:0});
  });
  test('worker states and eligibility map to card words', () => {
    for (const [requestedState, observedEligibility, state, eligibility] of [
      ['running', 'eligible', 'Running', 'Eligible for customer tasks'],
      ['draining', 'ineligible', 'Draining', 'Not eligible yet'],
      ['paused', null, 'Paused', 'Eligibility not checked yet'],
    ] as const) {
      const input = populated(); input.workers.data = [{...worker, environment:'mainnet', requestedState, observedEligibility}, worker];
      const view = formatOfficeBoards(input).task.view;
      if (view.kind !== 'tasks') throw new Error('Expected tasks view');
      expect(view.worker).toMatchObject({network:'MAINNET', state, eligibility, more:1});
    }
  });
  test('all contract statuses have words and only HIRED highlights', () => {
    const statuses = ['UNKNOWN', 'OPEN', 'HIRED', 'SUBMITTED', 'GRADED', 'DISPUTED', 'PAID', 'REFUNDED', 'RULED', 'APPEALED', 'UNKNOWN'];
    for (const [status, word] of statuses.entries()) {
      const input = populated(); input.tasks.data = [record(status)];
      const summary = formatOfficeBoards(input);
      if (summary.task.view.kind !== 'tasks') throw new Error('Expected tasks view');
      expect(summary.task.view.rows[0]).toMatchObject({id:'#47', status:word, highlight:status === 2, amount:'1.234567', unit:'tUSDG'});
      expect(summary.task.lines.join(' ')).toContain(`#47 ${word}`);
      expect(summary.task.lines.join(' ')).not.toContain('Status ' + status);
      const detail = summary.task.view.rows[0]!.detail;
      if (status >= 1 && status <= 3) expect(detail).toStartWith('Due ');
      else expect(detail).toBe(({4:'In dispute window', 5:'In dispute', 6:'Paid', 7:'Refunded', 8:'Ruled', 9:'In dispute'} as Record<number,string>)[status] ?? 'Status unavailable');
    }
  });
  test('amount precision and per-task network remain exact', () => {
    const input = populated();
    input.tasks.data = [record(2, '1'), {...record(6, '1230000'), worker:{...worker, environment:'mainnet'}}, record(1, '1000000')];
    const view = formatOfficeBoards(input).task.view;
    if (view.kind !== 'tasks') throw new Error('Expected tasks view');
    expect(view.rows.map(row => [row.amount, row.unit])).toEqual([['0.000001','tUSDG'], ['1.23','USDG'], ['1.00','tUSDG']]);
  });
  test('invalid deadlines cannot become Invalid Date', () => {
    for (const value of ['invalid', '8640000000001', '9999999999999999']) {
      const input = populated(); input.tasks.data = [record(1, '1', value)];
      const view = formatOfficeBoards(input).task.view;
      if (view.kind !== 'tasks') throw new Error('Expected tasks view');
      expect(view.rows[0]!.detail).toBe('Due date unavailable');
    }
  });
  test('bounded summaries keep five window rows and three canvas rows', () => {
    expect(clipBoardText('x'.repeat(100))).toHaveLength(88);
    expect(clipBoardText('x'.repeat(100))).toEndWith('\u2026');
    const input = populated(); input.tasks.data = Array.from({length:8}, () => record());
    const summary = formatOfficeBoards(input);
    if (summary.task.view.kind !== 'tasks') throw new Error('Expected tasks view');
    expect(summary.task.view.rows).toHaveLength(3);
    expect(summary.task.lines.filter(line => line.startsWith('#'))).toHaveLength(5);
    expect(summary.task.lines.every(line => line.length <= 88)).toBe(true);
    expect(summary.task.footer).toBe('Provisional index. Income counts only after settlement.');
  });
  test('receipts never expose task amounts and header uses fixed read time', () => {
    const input = populated(); input.workers.updatedAt = 1800000000000; input.tasks.updatedAt = 1800000060000;
    const summary = formatOfficeBoards(input);
    expect(JSON.stringify(summary.receipts)).not.toContain('1.234567');
    expect(JSON.stringify(summary.receipts)).not.toContain('tUSDG');
    expect(summary.task.updated).toBe(new Date(1800000060000).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'}));
    expect(summary.receipts.updated).toBe(summary.task.updated);
  });
  test('unset read timestamps omit the live chip', () => {
    const input = populated(); input.workers.updatedAt = 0; input.tasks.updatedAt = 0;
    const summary = formatOfficeBoards(input);
    expect(summary.task.updated).toBeNull();
    expect(summary.receipts.updated).toBeNull();
  });
  test('late owner renders cannot restore private rows after account changes', () => {
    const old = formatOfficeBoards(populated());
    expect(officeBoardPublication(old, null, false)).toBeNull();
    expect(officeBoardPublication(old, 'bob', false)).toBeNull();
    const error = officeBoardPublication(old, 'alice', true);
    expect(error?.task.lines).toEqual([BOARD_ERROR]);
    for (const board of [error?.task, error?.receipts]) {
      expect(board?.view).toEqual({kind:'message', heading:'Board data unavailable', body:['Open the Office window to retry.'], tone:'error'});
      expect(board?.updated).toBeNull();
    }
    expect(officeBoardPublication(old, 'alice', false)).toBe(old);
  });
  test('only the active visible room schedules automatic reads', () => {
    expect(officeBoardRefreshInterval(true, true, true)).toBe(60_000);
    expect(officeBoardRefreshInterval(true, true, false)).toBe(false);
    expect(officeBoardRefreshInterval(true, false, true)).toBe(false);
    expect(officeBoardRefreshInterval(false, true, true)).toBe(false);
  });
});
