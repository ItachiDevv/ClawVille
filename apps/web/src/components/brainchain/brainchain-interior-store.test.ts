import { afterEach, describe, expect, test } from 'bun:test';
import { useBrainchainInteriorStore } from './brainchain-interior-store';
import { EMPTY_OFFICE_BOARDS } from './office-board-summary';

afterEach(() => useBrainchainInteriorStore.setState({ section: null, teacherFocus: 0, exitRequest: 0, failed: false }));

describe('Office window intent', () => {
  test('board updates only notify when the summary key changes', () => {
    const store = useBrainchainInteriorStore.getState();
    store.setBoardSummary(EMPTY_OFFICE_BOARDS);
    let updates = 0;
    const unsubscribe = useBrainchainInteriorStore.subscribe(() => { updates += 1; });
    store.setBoardSummary({...EMPTY_OFFICE_BOARDS});
    expect(updates).toBe(0);
    store.setBoardSummary({...EMPTY_OFFICE_BOARDS, ownerId:'alice'});
    expect(updates).toBe(1);
    unsubscribe(); store.setBoardSummary(EMPTY_OFFICE_BOARDS);
  });
  test('account reset clears all prior private board rows', () => {
    const store = useBrainchainInteriorStore.getState();
    store.setBoardSummary({...EMPTY_OFFICE_BOARDS, ownerId:'alice', task:{...EMPTY_OFFICE_BOARDS.task, lines:['private task']}});
    store.setBoardSummary(EMPTY_OFFICE_BOARDS);
    expect(useBrainchainInteriorStore.getState().boardSummary.ownerId).toBeNull();
    expect(useBrainchainInteriorStore.getState().boardSummary.task.lines).toEqual(['Sign in to see your workers']);
  });
  test('ordinary station opens do not retain a previous Cortex focus request', () => {
    const office = useBrainchainInteriorStore.getState();
    office.talk();
    expect(useBrainchainInteriorStore.getState().section).toBe('learn');
    expect(useBrainchainInteriorStore.getState().teacherFocus).toBe(1);
    office.close();
    office.open('setup');
    expect(useBrainchainInteriorStore.getState().section).toBe('setup');
    expect(useBrainchainInteriorStore.getState().teacherFocus).toBe(0);
    office.close();
    expect(useBrainchainInteriorStore.getState().section).toBeNull();
  });
});
