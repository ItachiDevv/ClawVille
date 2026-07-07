/**
 * building-reward.ts — the extracted once-per-day building credit (P1 slice 4).
 *
 * Drives the REAL `creditBuildingRewardOncePerDay` against an injected in-memory
 * tx (the exported `deps` seam — production callers never pass it), so the
 * probe→credit gating logic, the lock-before-probe ordering, and the
 * postgres-js Date-binding trap are all locked WITHOUT a live DB:
 *
 *   1. IDEMPOTENCY — probe empty → credits exactly once (amount 1, the caller's
 *      reason) and returns true; probe present (same avatar/building/reason/day)
 *      → returns false and the ledger is NEVER touched.
 *   2. LOCK ORDER — the avatars FOR-UPDATE row lock is issued BEFORE the
 *      claw_token_transactions existence probe (the concurrency-safety spine:
 *      two same-key racers serialize on the row lock, the loser sees the
 *      committed row).
 *   3. DRIVER TRAP — the UTC-day bound is an ISO STRING, never a JS Date (raw
 *      postgres-js sql templates THROW on a Date param — this exact bug shipped
 *      once; see the comment inside the helper).
 *   4. KEY COMPOSITION — the probe binds the caller's avatarId + reason +
 *      buildingId, so a different building / reason / day is a fresh key.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  creditBuildingRewardOncePerDay,
  type BuildingRewardDeps,
  type BuildingRewardTx,
} from '../building-reward';

// ── drizzle `sql` template introspection (pattern proven in
//    claw-token-ledger.test.ts / cash-house-scaler.test.ts) ───────────────────
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((ch) => {
      const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
      if (cn === 'StringChunk') {
        const v = (ch as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return ' $param ';
    })
    .join('');
}

function sqlParams(q: unknown): unknown[] {
  const out: unknown[] = [];
  for (const ch of (q as { queryChunks?: unknown[] }).queryChunks ?? []) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === 'String') out.push(String(ch));
    else if (cn === 'Param') out.push((ch as { value: unknown }).value);
  }
  return out;
}

// ── in-memory harness ─────────────────────────────────────────────────────────
interface ExecutedQuery {
  text: string;
  params: unknown[];
}

interface Harness {
  deps: BuildingRewardDeps;
  executed: ExecutedQuery[];
  credits: Array<{ avatarId: string; amount: number; reason: string; metadata: unknown }>;
  /** What the claw_token_transactions probe returns (empty = no reward today). */
  probeRows: Array<{ present: number }>;
}

function makeHarness(probeRows: Array<{ present: number }> = []): Harness {
  const harness: Harness = {
    executed: [],
    credits: [],
    probeRows,
    deps: {
      transaction: async <T>(fn: (tx: BuildingRewardTx) => Promise<T>): Promise<T> => {
        const tx = {
          execute: async (q: unknown) => {
            const text = sqlText(q);
            harness.executed.push({ text, params: sqlParams(q) });
            // The FOR-UPDATE avatar lock returns an (ignored) row list; the
            // claw_token_transactions probe returns the scripted rows.
            if (text.includes('claw_token_transactions')) return harness.probeRows as never;
            return [] as never;
          },
        } as unknown as BuildingRewardTx;
        return fn(tx);
      },
      credit: (async (input: { avatarId: string; amount: number; reason: string; metadata?: unknown }) => {
        harness.credits.push({
          avatarId: input.avatarId,
          amount: input.amount,
          reason: input.reason,
          metadata: input.metadata,
        });
        return { balanceAfter: input.amount } as never;
      }) as BuildingRewardDeps['credit'],
    },
  };
  return harness;
}

const OPTS = {
  avatarId: 'av-coralia',
  buildingId: 'api-integrations',
  reason: 'building_chat_teaching' as const,
  metadata: { buildingId: 'api-integrations', via: 'world-autonomous' },
};

describe('creditBuildingRewardOncePerDay (extracted, behavior-identical)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('credits exactly once (amount 1, caller reason) when no same-day row exists → true', async () => {
    const credited = await creditBuildingRewardOncePerDay(OPTS, h.deps);
    expect(credited).toBe(true);
    expect(h.credits.length).toBe(1);
    expect(h.credits[0]).toMatchObject({
      avatarId: 'av-coralia',
      amount: 1,
      reason: 'building_chat_teaching',
    });
  });

  it('returns false and NEVER touches the ledger when the same-day row exists (idempotency)', async () => {
    h.probeRows = [{ present: 1 }];
    const credited = await creditBuildingRewardOncePerDay(OPTS, h.deps);
    expect(credited).toBe(false);
    expect(h.credits.length).toBe(0);
  });

  it('second same-day call credits 0 (first credits, committed row then blocks the second)', async () => {
    const first = await creditBuildingRewardOncePerDay(OPTS, h.deps);
    expect(first).toBe(true);
    // The first call committed its ledger row — the probe now sees it.
    h.probeRows = [{ present: 1 }];
    const second = await creditBuildingRewardOncePerDay(OPTS, h.deps);
    expect(second).toBe(false);
    expect(h.credits.length).toBe(1); // still exactly one credit
  });

  it('row-locks the avatars row (FOR UPDATE) BEFORE the existence probe (concurrency spine)', async () => {
    await creditBuildingRewardOncePerDay(OPTS, h.deps);
    expect(h.executed.length).toBe(2);
    expect(h.executed[0].text).toContain('FOR UPDATE');
    expect(h.executed[0].text).toContain('avatars');
    expect(h.executed[1].text).toContain('claw_token_transactions');
  });

  it('binds the UTC-day bound as an ISO STRING, never a JS Date (postgres-js trap)', async () => {
    await creditBuildingRewardOncePerDay(OPTS, h.deps);
    const probe = h.executed[1];
    for (const p of probe.params) {
      expect(p instanceof Date).toBe(false);
    }
    const isoParam = probe.params.find(
      (p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(p),
    );
    expect(isoParam).toBeDefined();
  });

  it('the probe key binds avatarId + reason + buildingId (different building/reason/day = fresh key)', async () => {
    await creditBuildingRewardOncePerDay(OPTS, h.deps);
    const probe = h.executed[1];
    expect(probe.params).toContain('av-coralia');
    expect(probe.params).toContain('building_chat_teaching');
    expect(probe.params).toContain('api-integrations');
    // And a different reason binds ITS key (visit vs chat never collide).
    h.executed = [];
    await creditBuildingRewardOncePerDay({ ...OPTS, reason: 'building_visit' }, h.deps);
    expect(h.executed[1].params).toContain('building_visit');
  });
});
