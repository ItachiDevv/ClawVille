import { describe, expect, test } from 'bun:test';
import { EMPTY_OFFICE_BOARDS, BOARD_ERROR, clipBoardText, formatOfficeBoards, officeBoardPublication, officeBoardRefreshInterval, type BoardInput, type OfficeWorker } from './office-board-summary';

const worker: OfficeWorker = {id:'worker', environment:'testnet', chainId:46630, address:'0x12345678901234567890123456789012345678abcd', requestedState:'paused', observedEligibility:'unknown'};
const empty = (): BoardInput => ({ownerId:'alice', workers:{data:[],loading:false,error:false}, tasks:{data:[],loading:false,error:false}, purchases:{data:[],loading:false,error:false}, funding:{data:[],loading:false,error:false}});
describe('Office board owner summaries', () => {
  test('signed out and guest use no private rows', () => {
    const input = empty(); input.ownerId = null; input.workers.data = [worker];
    expect(formatOfficeBoards(input)).toEqual(EMPTY_OFFICE_BOARDS);
    expect(EMPTY_OFFICE_BOARDS.task.lines).toEqual(['Sign in to see your workers']);
    expect(EMPTY_OFFICE_BOARDS.receipts.lines).toEqual(['Sign in to see your receipts']);
  });
  test('no worker and empty records have honest finished text', () => {
    const summary = formatOfficeBoards(empty());
    expect(summary.task.lines).toContain('No worker connected. Visit a pod to set one up.');
    expect(summary.task.lines).toContain('No tasks indexed yet');
    expect(summary.receipts.lines).toContain('No settled receipts yet');
    expect(summary.receipts.lines).toContain('Open Earnings to read paid bounties');
    expect(summary.receipts.footer).toBe('Income counts only after settlement.');
  });
  test('loading and failure do not become zero or empty records', () => {
    const input = empty(); input.workers.loading = true; input.purchases.loading = true; input.funding.loading = true;
    const loading = formatOfficeBoards(input);
    expect(loading.task.lines).toContain('Load your workers...');
    expect(loading.task.lines).not.toContain('No tasks indexed yet');
    expect(loading.receipts.lines).not.toContain('No settled receipts yet');
    input.workers.error = true; input.purchases.error = true; input.funding.error = true;
    const error = formatOfficeBoards(input);
    expect(error.task.lines).toContain(BOARD_ERROR);
    expect(error.receipts.lines).toContain(BOARD_ERROR);
    expect(error.receipts.lines).not.toContain('No settled receipts yet');
  });
  test('filled task lines preserve atomic precision and contain no invented rows', () => {
    const input = empty(); input.workers.data = [worker]; input.tasks.data = [{worker, task:{id:'row', taskId:'47', status:2, bountyAtomic:'1234567', deadlineUnix:'1800000000', hireBlock:'9', updatedAt:'2026-11-13T00:00:00Z', provisional:true}}];
    const summary = formatOfficeBoards(input);
    expect(summary.task.lines).toContain('testnet 0x1234...abcd | paused | unknown');
    expect(summary.task.lines.filter(line => line.includes('Status'))).toHaveLength(1);
    expect(summary.task.lines.join('\n')).toContain('#47 Status 2 | 1.234567 tUSDG | Due ');
    expect(summary.task.lines).toContain('Work status | Provisional index');
    expect(summary.task.lines.join('\n')).not.toContain('Balance');
  });
  test('bounded summaries clip long text and task counts', () => {
    expect(clipBoardText('x'.repeat(100))).toHaveLength(88);
    expect(clipBoardText('x'.repeat(100))).toEndWith('…');
    const input = empty(); input.workers.data = [worker, worker, worker];
    input.tasks.data = Array.from({length:8}, (_, index) => ({worker, task:{id:String(index), taskId:String(index), status:1, bountyAtomic:'0', deadlineUnix:'0', hireBlock:'1', updatedAt:'2026-11-13T00:00:00Z', provisional:true as const}}));
    const summary = formatOfficeBoards(input);
    expect(summary.task.lines.filter(line => line.includes('Status'))).toHaveLength(5);
    expect(summary.task.lines.length).toBeLessThanOrEqual(12);
    expect(summary.receipts.lines.length).toBeLessThanOrEqual(10);
    expect(summary.task.lines.every(line => line.length <= 88)).toBe(true);
  });
  test('auth errors hide cached private data', () => {
    const input = empty(); input.authError = true; input.workers.data = [worker];
    expect(formatOfficeBoards(input).task.lines).toEqual([BOARD_ERROR]);
  });
  test('purchase references and pending source records never claim paid income', () => {
    const input = empty(); input.workers.data = [worker];
    const transaction = `0x${'a'.repeat(64)}`;
    input.purchases.data = [{id:'order', environment:'testnet', chainId:84532, state:'payment_observed', title:'x'.repeat(120), brief:'brief', levels:['pass','fail'], bodyHash:'a'.repeat(64), payer:null, amountAtomic:'1000000', quoteExpiresAt:null, authorizationExpiresAt:null, remoteOrder:null, remoteState:null, taskId:null, taskBoard:null, paymentTransaction:transaction, refundTransaction:transaction, provisional:true, requiresHumanApproval:true, humanApproved:false, createdAt:'2026-11-13T00:00:00Z', updatedAt:'2026-11-13T00:00:00Z'}];
    input.funding.data = [{id:'operation', workerId:worker.id, kind:'parent_exit', state:'reserved', amountAtomic:'1', feeAtomic:'0', minimumDestinationAtomic:'1', maxGasCostWei:'1', artifactHash:'a'.repeat(64), source:'0xsource', destination:'0xdestination', sourceChain:46630, destinationChain:274630, sourceToken:null, destinationToken:null, artifactExpiresAt:'2026-11-13T00:00:00Z', sourceTransaction:null, destinationState:'unresolved', liabilityState:'reserved', executionEnabled:false, deskReport:null}];
    const summary = formatOfficeBoards(input);
    expect(summary.task.lines).toContain(`${'x'.repeat(47)}… | payment_observed`);
    expect(summary.receipts.lines).toContain('Account records | Provisional');
    expect(summary.receipts.lines).toContain('payment_observed | eip155:84532 | Payment 0xaaaa...aaaa');
    expect(summary.receipts.lines).toContain('payment_observed | eip155:84532 | Refund 0xaaaa...aaaa');
    expect(summary.receipts.lines).toContain('parent_exit | reserved | operation');
    expect(summary.receipts.lines).toContain('Source records do not confirm destination payment.');
    expect(summary.receipts.lines).not.toContain('No settled receipts yet');
    input.purchases.error = true;
    expect(formatOfficeBoards(input).receipts.lines).toContain(BOARD_ERROR);
    expect(formatOfficeBoards(input).receipts.lines).not.toContain('No settled receipts yet');
  });
  test('late owner renders cannot restore private rows after account changes', () => {
    const old = formatOfficeBoards(empty());
    expect(officeBoardPublication(old, null, false)).toBeNull();
    expect(officeBoardPublication(old, 'bob', false)).toBeNull();
    expect(officeBoardPublication(old, 'alice', true)?.task.lines).toEqual([BOARD_ERROR]);
    expect(officeBoardPublication(old, 'alice', false)).toBe(old);
  });
  test('only the active visible room schedules automatic reads', () => {
    expect(officeBoardRefreshInterval(true, true, true)).toBe(60_000);
    expect(officeBoardRefreshInterval(true, true, false)).toBe(false);
    expect(officeBoardRefreshInterval(true, false, true)).toBe(false);
    expect(officeBoardRefreshInterval(false, true, true)).toBe(false);
  });
});
