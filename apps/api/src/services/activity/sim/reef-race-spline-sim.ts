/**
 * Reef Race v2 — spline-based sim. Replaces the ellipse sim when
 * REEF_RACE_USE_SPLINE=true. Skeleton only as of this commit;
 * Phase 1 implementation lands in a follow-up.
 *
 * Public method shape mirrors `ReefRaceSim` in `./reef-race-sim.ts` so the
 * activity-ws-hub dispatcher can swap implementations behind the
 * `REEF_RACE_USE_SPLINE` flag with zero call-site churn (architecture doc §8).
 *
 * Architecture: .claude/plans/reef-race-v2-spline-architecture.md
 * Spec:         .claude/plans/reef-race-v2.md
 *
 * FEATURE_GATE: reef_race_spline_sim
 * Status: Skeleton — every method throws NotImplemented. Wave 1.b scaffolding.
 * Metric to graduate: Phase 1 ship gate met (races complete end-to-end on
 *   the spline track per `.claude/plans/reef-race-v2.md` Phase 1).
 * Current reading: 0 — sim not wired into the dispatcher yet.
 * Review deadline: 2026-05-12
 * On deadline: If the spline sim hasn't graduated past skeleton by then,
 *   delete this file and reopen the v2 plan instead of carrying dead code.
 * Reference: `.claude/plans/reef-race-v2.md` "Phased Implementation"
 */

import type { ServerFrame } from '@clawville/shared';
import type { InputBounds } from '../anti-cheat/shared';
import type { BotController } from '../bots/bot-controller';
import type { PetRacingProfile } from './reef-race-config';
// Spline math primitives — locked Wave 1.a deliverable. Imported eagerly so
// the skeleton fails to compile if the spline module ever drifts on its
// public surface; the actual sim implementation will replace the `void`.
import * as ReefSplineModule from './reef-race-spline';

void ReefSplineModule;

// ─── Types — mirror reef-race-sim.ts public exports ─────────────────────────

type SimBroadcastFn = (roomId: string, frame: ServerFrame) => void;

const NOT_IMPLEMENTED = 'NotImplemented — Phase 1 sim port pending';

/**
 * Spline-sim equivalent of `ReefRaceSim`. Every method throws — this exists
 * only to give the dispatcher a typed handle to swap to once the migration
 * gate flips. See `.claude/plans/reef-race-v2.md` Phase 1 for the porting
 * plan.
 */
export class ReefRaceSplineSim {
  setBroadcastFn(_fn: SimBroadcastFn): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  setEndedFn(_fn: (roomId: string) => void): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  setIntegrityForfeitFn(_fn: (roomId: string, petId: string) => void): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  startRoom(
    _roomId: string,
    _activityId: string,
    _participantPetIds: string[],
    _opts?: {
      seed?: number;
      isBot?: (petId: string) => boolean;
      bots?: BotController[];
      startedAt?: number;
      launchBoosts?: Map<string, 'boost' | 'stall'>;
      petProfiles?: Map<string, PetRacingProfile>;
    },
  ): unknown {
    throw new Error(NOT_IMPLEMENTED);
  }

  stopRoom(_roomId: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  getStateSnapshot(_roomId: string): unknown {
    throw new Error(NOT_IMPLEMENTED);
  }

  applyInput(
    _roomId: string,
    _petId: string,
    _seq: number,
    _dt: number,
    _rawInput: InputBounds,
  ): { ok: boolean; forfeit: boolean; flagsAdded: number } {
    throw new Error(NOT_IMPLEMENTED);
  }

  forfeit(
    _roomId: string,
    _petId: string,
    _reason: 'integrity' | 'timeout' | 'voluntary',
  ): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  computeResults(
    _roomId: string,
  ): Array<{
    petId: string;
    placement: number;
    score: number;
    scoreMs: number | null;
  }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  getFlagCount(_roomId: string, _petId: string): number {
    throw new Error(NOT_IMPLEMENTED);
  }

  __resetForTest(): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  __tickOnceForTest(_roomId: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  __getState(_roomId: string): unknown {
    throw new Error(NOT_IMPLEMENTED);
  }
}

/**
 * Singleton — matches the export pattern of `reefRaceSim` in
 * `./reef-race-sim.ts` so the dispatcher can swap by reference.
 */
export const reefRaceSplineSim = new ReefRaceSplineSim();
