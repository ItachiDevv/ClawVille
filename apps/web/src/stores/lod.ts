import { create } from 'zustand';

/**
 * LOD store — shared between the orchestrator (writer) and the wandering NPC
 * + remote-player renderers (readers). Holds the IDs of entities that should
 * render as FULL VRM/GLB this frame; everything else falls back to a cheap
 * proxy mesh.
 *
 * Building residents (rendered by `ArenaLocationNpcs`) are not governed by
 * this moving-entity set. They have their own adaptive-only far proxy tier so
 * nearby/interactable teachers still render as full GLBs.
 *
 * The 14-entity cap is the Iris Xe budget. Local player + visible residents +
 * up-to-14 (NPCs + remote players in range) = ≤ 25 full-skeleton VRMs on
 * screen. The proxy mesh path serves the 15th+ at ~3 draws each.
 *
 * Selectors compare via Set identity (zustand shallow). The orchestrator
 * replaces the Set reference whenever membership changes; otherwise it
 * mutates a "last write" timestamp in `_revision` for diagnostic use.
 */
interface LodStoreState {
  /** IDs of entities allowed to mount as FULL VRM/GLB this frame. */
  fullSet: Set<string>;
  /** Monotonic revision counter — bumped each time fullSet identity changes. */
  revision: number;
  setFullSet: (next: Set<string>) => void;
}

export const useLodStore = create<LodStoreState>((set, get) => ({
  fullSet: new Set<string>(),
  revision: 0,
  setFullSet: (next) => {
    const cur = get().fullSet;
    // Cheap equality check — same size + every member present.
    if (cur.size === next.size) {
      let equal = true;
      for (const id of next) {
        if (!cur.has(id)) { equal = false; break; }
      }
      if (equal) return;
    }
    set({ fullSet: next, revision: get().revision + 1 });
  },
}));

/**
 * Helper for renderers: cheap subscription that returns boolean without
 * creating new objects per render. Use inside a memo'd entry component:
 *
 *   const isFull = useLodStore((s) => s.fullSet.has(entityId));
 */
