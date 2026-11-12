'use client';

import { create } from 'zustand';
import type { SectionId } from './brainchain-office';

export const useBrainchainInteriorStore = create<{
  section: SectionId | null;
  nearbyStation: number | null;
  teacherFocus: number;
  exitRequest: number;
  failed: boolean;
  open: (section: SectionId) => void;
  talk: () => void;
  close: () => void;
  requestExit: () => void;
  fail: () => void;
}>((set) => ({
  section: null, nearbyStation: null, teacherFocus: 0, exitRequest: 0, failed: false,
  // Freeze is local to this stage slot. Never clear another modal's global freeze.
  open: (section) => set({ section, teacherFocus: 0 }),
  talk: () => {
    set((state) => ({ section: 'learn', teacherFocus: state.teacherFocus + 1 }));
  },
  close: () => set({ section: null, teacherFocus: 0 }),
  requestExit: () => set((state) => ({ exitRequest: state.exitRequest + 1 })),
  fail: () => set({ failed: true }),
}));
