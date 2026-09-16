import { create } from 'zustand';

export type WorldStreamState = 'live' | 'reconnecting' | 'stopped';

interface WorldStreamStore {
  state: WorldStreamState;
  generation: number;
  hasOpened: boolean;
  setStreamState: (next: WorldStreamState) => void;
}

export const useWorldStreamStore = create<WorldStreamStore>((set) => ({
  state: 'stopped',
  generation: 0,
  hasOpened: false,
  setStreamState: (next) => {
    set((current) => {
      if (current.state === next) return current;
      if (next !== 'live') return { ...current, state: next };

      return {
        state: next,
        hasOpened: true,
        generation: current.hasOpened
          ? current.generation + 1
          : current.generation,
        setStreamState: current.setStreamState,
      };
    });
  },
}));
