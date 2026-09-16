import { beforeEach, describe, expect, test } from 'bun:test';

import { useWorldStreamStore } from '@/stores/world-stream-state';

describe('world stream state', () => {
  beforeEach(() => {
    useWorldStreamStore.setState({
      state: 'stopped',
      generation: 0,
      hasOpened: false,
    });
  });

  test('skips generation on the first successful open', () => {
    useWorldStreamStore.getState().setStreamState('live');

    expect(useWorldStreamStore.getState()).toMatchObject({
      state: 'live',
      generation: 0,
      hasOpened: true,
    });
  });

  test('increments once for a synchronous reconnect', () => {
    const store = useWorldStreamStore.getState();
    store.setStreamState('live');
    store.setStreamState('reconnecting');
    store.setStreamState('live');

    expect(useWorldStreamStore.getState()).toMatchObject({
      state: 'live',
      generation: 1,
    });
  });

  test('increments when a consumer starts during reconnecting', () => {
    const store = useWorldStreamStore.getState();
    store.setStreamState('live');
    store.setStreamState('reconnecting');

    const mountedGeneration = useWorldStreamStore.getState().generation;
    useWorldStreamStore.getState().setStreamState('live');

    expect(useWorldStreamStore.getState().generation).toBe(mountedGeneration + 1);
  });

  test('does not increment for duplicate live publications', () => {
    const store = useWorldStreamStore.getState();
    store.setStreamState('live');
    store.setStreamState('live');

    expect(useWorldStreamStore.getState().generation).toBe(0);
  });
});
