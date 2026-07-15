/**
 * Operational repair loop for wager create/join capture-before-send intents.
 * Forward-only: it never signs or broadcasts. Confirmed/PDA-proven deposits
 * finalize their off-chain Player witness; ambiguous evidence remains fenced;
 * stale unsigned reservations become retryable failed intents.
 */

import {
  and,
  asc,
  db,
  inArray,
  lte,
  or,
  wagerChainIntents,
} from '@clawville/database';
import {
  reconcileWagerChainIntent,
  withResolvedWagerLobbyFence,
} from './wager-program-client';

const SWEEP_INTERVAL_MS = 30_000;
const PREPARED_STALE_MS = 5 * 60_000;
const DEFAULT_LIMIT = 25;

export interface WagerIntentSweepCandidate {
  id: string;
  lobbyId: string;
  status: string;
}

export interface WagerIntentSweepResult {
  attempted: number;
  repaired: number;
  failed: number;
}

interface SweepOptions {
  limit?: number;
  listCandidates?: (limit: number) => Promise<WagerIntentSweepCandidate[]>;
  processCandidate?: (candidate: WagerIntentSweepCandidate) => Promise<void>;
}

async function listCandidates(limit: number): Promise<WagerIntentSweepCandidate[]> {
  const staleBefore = new Date(Date.now() - PREPARED_STALE_MS);
  return db
    .select({
      id: wagerChainIntents.id,
      lobbyId: wagerChainIntents.lobbyId,
      status: wagerChainIntents.status,
    })
    .from(wagerChainIntents)
    .where(
      or(
        inArray(wagerChainIntents.status, ['sending', 'confirmed', 'reconcile']),
        and(
          inArray(wagerChainIntents.status, ['prepared']),
          lte(wagerChainIntents.updatedAt, staleBefore),
        ),
      ),
    )
    .orderBy(asc(wagerChainIntents.updatedAt))
    .limit(limit);
}

async function processCandidate(candidate: WagerIntentSweepCandidate): Promise<void> {
  if (candidate.status === 'prepared') {
    // The lifecycle fence owns the guarded prepared->failed expiry under the
    // same advisory lock as broadcast capture, so a live capture can never be
    // invalidated concurrently by the worker.
    await withResolvedWagerLobbyFence(candidate.lobbyId, async () => undefined);
    return;
  }
  await reconcileWagerChainIntent(candidate.id);
}

export async function sweepOutstandingWagerIntents(
  options: SweepOptions = {},
): Promise<WagerIntentSweepResult> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 100));
  const candidates = await (options.listCandidates ?? listCandidates)(limit);
  const result: WagerIntentSweepResult = { attempted: candidates.length, repaired: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      await (options.processCandidate ?? processCandidate)(candidate);
      result.repaired += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[wager-intent-reconciler] intent ${candidate.id} failed:`, err);
    }
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startWagerIntentReconciler(): void {
  if (sweepTimer) return;
  const run = () => {
    void sweepOutstandingWagerIntents().then((result) => {
      if (result.attempted > 0) {
        console.log('[wager-intent-reconciler] sweep', result);
      }
    }).catch((err) => {
      console.error('[wager-intent-reconciler] sweep failed:', err);
    });
  };
  run();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopWagerIntentReconciler(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
