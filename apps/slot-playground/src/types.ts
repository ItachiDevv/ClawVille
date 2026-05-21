/**
 * Mirrors the production SlotReels3DProps + SpinResult contracts so a rig
 * built here drops into apps/web/src/components/casino/SlotReels3D.tsx
 * with zero contract changes.
 */

export interface SpinResult {
  /** 5 reels × 3 visible rows of symbol IDs. */
  reels: number[][];
}

export interface SlotRigProps {
  /** Server-authoritative 5×3 landing window, or null pre-spin. */
  reels:         number[][] | null;
  /** True from SPIN press until onReelsSettled fires. */
  isSpinning:    boolean;
  /** Monotonic counter — increments once per SPIN press. */
  spinTrigger:   number;
  /** Called exactly once after the rig lands on `reels`. */
  onReelsSettled: () => void;
  /** Toggle layered FX overlays (bezels, payline glow, vignette). */
  showFx?:       boolean;
}
