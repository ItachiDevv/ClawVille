import { afterEach, describe, expect, test } from 'bun:test';
import { useBrainchainInteriorStore } from './brainchain-interior-store';

afterEach(() => useBrainchainInteriorStore.setState({ section: null, teacherFocus: 0, exitRequest: 0, failed: false }));

describe('Office window intent', () => {
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
