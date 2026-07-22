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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentBuildingChatRewardAvatarId,
  creditBuildingChatRewardOncePerDay,
  creditBuildingRewardOncePerDay,
  humanBuildingChatRewardAvatarId,
  type BuildingRewardDeps,
  type BuildingRewardTx,
} from '../building-reward';

describe('building-chat reward subject decisions', () => {
  it.each([
    {
      name: 'legitimate ledger-capable session uses its exact active avatar',
      subject: { ledgerCapable: true, avatarId: 'active-session-avatar' },
      expected: 'active-session-avatar',
    },
    {
      name: 'ownership-unproven reconnect may chat but cannot reward the bound victim avatar',
      subject: { ledgerCapable: false, avatarId: 'victim-active-avatar' },
      expected: null,
    },
    {
      name: 'ledger-capable session without an active avatar fails closed',
      subject: { ledgerCapable: true, avatarId: null },
      expected: null,
    },
    {
      name: 'unresolved session fails closed',
      subject: null,
      expected: null,
    },
  ])('$name', ({ subject, expected }) => {
    expect(agentBuildingChatRewardAvatarId(subject)).toBe(expected);
  });

  it('wrong-avatar regression: only the resolved active avatar can flow', () => {
    const historicalBotOwnerAvatar = 'inactive-or-wrong-avatar';
    const resolved = { ledgerCapable: true, avatarId: 'resolved-active-avatar' };

    expect(agentBuildingChatRewardAvatarId(resolved)).toBe('resolved-active-avatar');
    expect(agentBuildingChatRewardAvatarId(resolved)).not.toBe(historicalBotOwnerAvatar);
  });

  it.each([
    { name: 'real human', avatarId: 'human-avatar', isGuest: false, expected: 'human-avatar' },
    { name: 'canonical guest despite an avatar row', avatarId: 'guest-avatar', isGuest: true, expected: null },
    { name: 'no active avatar', avatarId: null, isGuest: false, expected: null },
  ])('$name', ({ avatarId, isGuest, expected }) => {
    expect(humanBuildingChatRewardAvatarId(avatarId, isGuest)).toBe(expected);
  });
});

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
  /** What INSERT ... ON CONFLICT RETURNING yields for the chat claim. */
  claimRows: Array<{ id: string }>;
  claimValues: Array<Record<string, unknown>>;
  claimConflictTargets: unknown[];
  claimUpdates: Array<Record<string, unknown>>;
  transactionTxs: BuildingRewardTx[];
  creditTxs: BuildingRewardTx[];
}

function makeHarness(probeRows: Array<{ present: number }> = []): Harness {
  const harness: Harness = {
    executed: [],
    credits: [],
    probeRows,
    claimRows: [{ id: 'claim-1' }],
    claimValues: [],
    claimConflictTargets: [],
    claimUpdates: [],
    transactionTxs: [],
    creditTxs: [],
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
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              harness.claimValues.push(values);
              const returningBuilder = {
                onConflictDoNothing: (config: unknown) => {
                  harness.claimConflictTargets.push(config);
                  return returningBuilder;
                },
                returning: async () => harness.claimRows,
              };
              return returningBuilder;
            },
          }),
          update: () => ({
            set: (values: Record<string, unknown>) => {
              harness.claimUpdates.push(values);
              return {
                where: async () => [],
              };
            },
          }),
        } as unknown as BuildingRewardTx;
        harness.transactionTxs.push(tx);
        return fn(tx);
      },
      credit: (async (input: { avatarId: string; amount: number; reason: string; metadata?: unknown }, tx?: BuildingRewardTx) => {
        harness.credits.push({
          avatarId: input.avatarId,
          amount: input.amount,
          reason: input.reason,
          metadata: input.metadata,
        });
        if (tx) harness.creditTxs.push(tx);
        return { balanceAfter: input.amount, ledgerId: 'ledger-chat-1' } as never;
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

describe('creditBuildingChatRewardOncePerDay (shared durable claim)', () => {
  const HUMAN_CHAT = {
    avatarId: 'av-coralia',
    buildingId: 'api-integrations',
    reason: 'location_chat' as const,
    metadata: { locationId: 'api-integrations', via: 'human' },
    actorKind: 'human' as const,
  };

  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('claims and credits exactly once in the same transaction', async () => {
    const credited = await creditBuildingChatRewardOncePerDay(HUMAN_CHAT, h.deps);

    expect(credited).toBe(true);
    expect(h.claimValues).toHaveLength(1);
    expect(h.claimValues[0]).toMatchObject({
      avatarId: 'av-coralia',
      buildingId: 'api-integrations',
    });
    expect(h.claimValues[0].rewardDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(h.credits).toHaveLength(1);
    expect(h.credits[0]).toMatchObject({
      avatarId: 'av-coralia',
      amount: 1,
      reason: 'location_chat',
      metadata: {
        locationId: 'api-integrations',
        buildingId: 'api-integrations',
      },
    });
    expect(h.creditTxs[0]).toBe(h.transactionTxs[0]);
    expect(h.claimUpdates).toEqual([{ ledgerId: 'ledger-chat-1' }]);
  });

  it('conflict loser returns false and never touches the ledger', async () => {
    h.claimRows = [];

    const credited = await creditBuildingChatRewardOncePerDay(HUMAN_CHAT, h.deps);

    expect(credited).toBe(false);
    expect(h.credits).toHaveLength(0);
    expect(h.claimUpdates).toHaveLength(0);
  });

  it('uses one route-agnostic key across human and agent reasons', async () => {
    const first = await creditBuildingChatRewardOncePerDay(HUMAN_CHAT, h.deps);
    h.claimRows = [];
    const second = await creditBuildingChatRewardOncePerDay(
      {
        ...HUMAN_CHAT,
        reason: 'building_chat_teaching',
        actorKind: 'agent',
        metadata: { via: 'connected-agent' },
      },
      h.deps,
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(h.credits).toHaveLength(1);
    expect(h.claimValues).toHaveLength(2);
    expect(h.claimValues[0]).toEqual(h.claimValues[1]);
    expect('reason' in h.claimValues[0]).toBe(false);
    expect(h.claimConflictTargets).toHaveLength(2);
  });

  it('is wired into all three chat paths while visits retain the legacy helper', () => {
    const chatSource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'chat.ts'),
      'utf8',
    );
    const gatewaySource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'agent-gateway.ts'),
      'utf8',
    );
    const autonomousSource = readFileSync(
      join(import.meta.dir, '..', 'world-teacher-chat.ts'),
      'utf8',
    );

    expect(chatSource.match(/await creditBuildingChatRewardOncePerDay\(/g)).toHaveLength(1);
    expect(gatewaySource.match(/await creditBuildingChatRewardOncePerDay\(/g)).toHaveLength(1);
    expect(autonomousSource.match(/await creditBuildingChatRewardOncePerDay\(/g)).toHaveLength(1);
    expect(gatewaySource.match(/await creditBuildingRewardOncePerDay\(/g)).toHaveLength(1);
    expect(autonomousSource.match(/await creditBuildingRewardOncePerDay\(/g)).toHaveLength(1);
  });

  it('connected-agent chat mints only for the canonical ledger-capable session avatar', () => {
    const gatewaySource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'agent-gateway.ts'),
      'utf8',
    );
    const routeStart = gatewaySource.indexOf(
      'agentGatewayRoutes.post(AGENT_BUILDING_CHAT_ROUTE',
    );
    const routeEnd = gatewaySource.indexOf(
      "agentGatewayRoutes.get('/:sessionId/skills/:buildingId/skill-memory'",
      routeStart,
    );
    const routeSource = gatewaySource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(routeSource).toContain('await resolveAgentSession(sessionId)');
    expect(routeSource).toContain('agentBuildingChatRewardAvatarId(rewardSubject)');
    expect(routeSource).toContain('avatarId: rewardAvatarId');
    expect(routeSource).toContain('agentId: bot.agentId');
    expect(routeSource).toContain('knowledge: [...current, entry]');
    expect(routeSource).toContain('await recordEarnedSkillLesson({');
    expect(routeSource).toContain('columns: { platformAgentId: true }');
    expect(routeSource).toContain(
      'where: eq(avatars.id, chatKnowledgeSubject.avatarId)',
    );
    expect(routeSource).not.toContain('syncHostedAgentKnowledge({');
    // Regression: the liveness-only bot.userId lookup let an ownership-unproven
    // reconnect target the row owner's avatar (and could select an inactive one).
    expect(routeSource).not.toContain('resolveAvatarIdForBot(');
  });

  it('connected-agent visits reward and attribute only the canonical ledger-capable session subject', () => {
    const gatewaySource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'agent-gateway.ts'),
      'utf8',
    );
    const routeStart = gatewaySource.indexOf(
      'agentGatewayRoutes.post(AGENT_VISIT_BUILDING_ROUTE',
    );
    const routeEnd = gatewaySource.indexOf(
      'agentGatewayRoutes.post(AGENT_BUILDING_CHAT_ROUTE',
      routeStart,
    );
    const routeSource = gatewaySource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(routeSource).toContain('await resolveAgentSession(sessionId)');
    expect(routeSource).toContain('agentBuildingChatRewardAvatarId(rewardSubject)');
    expect(routeSource).toContain('avatarId,');
    expect(routeSource).toContain(
      'visitUserId = avatarId ? (rewardSubject?.userId ?? null) : null',
    );
    expect(routeSource).not.toContain('resolveAvatarIdForBot(');
    expect(routeSource).not.toContain('visitUserId = bot.userId');
    expect(routeSource.match(/syncHostedAgentKnowledge\(\{/g)).toHaveLength(1);
  });

  it('human chat authorizes the mint and XP from canonical users.is_guest, not the avatar mirror', () => {
    const chatSource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'chat.ts'),
      'utf8',
    );

    expect(chatSource).toContain("import { isGuestUser } from '../middleware/require-non-guest'");
    expect(chatSource).toContain('const canonicalGuest = avatar ? await isGuestUser(user.id) : false');
    expect(chatSource).toContain('humanBuildingChatRewardAvatarId(avatar?.id ?? null, canonicalGuest)');
    expect(chatSource).toContain('if (rewardAvatarId)');
    expect(chatSource).toContain('isGuest: canonicalGuest');
    expect(chatSource).not.toContain('if (avatar && !avatar.isGuest)');
  });

  it('system-agent chat checks canonical guest state before consuming its limiter', () => {
    const chatSource = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'chat.ts'),
      'utf8',
    );
    const routeStart = chatSource.indexOf("chatRoutes.post('/system/:slug'");
    const routeEnd = chatSource.indexOf("chatRoutes.post('/:id/chat'", routeStart);
    const routeSource = chatSource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const guestCheckAt = routeSource.indexOf('await isGuestUser(user.id)');
    const limiterAt = routeSource.indexOf('systemAgentRewardLimiter.tryConsume(user.id, slug)');
    expect(guestCheckAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(guestCheckAt);
    expect(routeSource).toContain('avatar && !canonicalGuest &&');
    expect(routeSource).not.toContain('!avatar.isGuest');
  });

  it('0037 commits guards before split backfill/index migrations', () => {
    const migrationDir = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      '..',
      'packages',
      'database',
      'migrations',
    );
    const migration = readFileSync(join(migrationDir, '0037_supply_mint_idempotency.sql'), 'utf8');
    const backfill = readFileSync(join(migrationDir, '0038_supply_mint_chat_backfill.sql'), 'utf8');
    const activity = readFileSync(join(migrationDir, '0039_activity_result_uniqueness.sql'), 'utf8');
    const xpTriggerAt = migration.indexOf(
      'CREATE TRIGGER "guard_atomic_xp_update_before_update"',
    );
    const ledgerTriggerAt = migration.indexOf(
      'CREATE TRIGGER "capture_building_chat_reward_claim_after_insert"',
    );

    expect(xpTriggerAt).toBeGreaterThan(-1);
    expect(ledgerTriggerAt).toBeGreaterThan(xpTriggerAt);
    expect(migration).not.toContain('DROP TRIGGER');
    expect(migration).not.toContain('SELECT DISTINCT ON');
    expect(migration).toContain("NEW.\"reason\" NOT IN ('location_chat', 'building_chat_teaching')");
    expect(migration).toContain("NEW.\"metadata\"->>'buildingId'");
    expect(migration).toContain("NEW.\"metadata\"->>'locationId'");
    expect(migration).toContain('IF existing_ledger_id IS NULL THEN');
    expect(migration).toContain('SET "ledger_id" = NEW."id"');
    expect(migration).toContain('IF existing_ledger_id = NEW."id" THEN');
    expect(migration).toContain(
      "MESSAGE = 'duplicate building-chat reward rejected during rolling deploy'",
    );
    expect(migration).toContain("current_setting('clawville.xp_write_authorized', true)");
    expect(migration).toContain('BEFORE UPDATE OF "xp", "level", "total_xp"');
    expect(backfill).toContain('INSERT INTO "building_chat_reward_claims" (');
    expect(backfill).toContain('"id" AS "ledger_id"');
    expect(backfill).toContain('WHERE "building_chat_reward_claims"."ledger_id" IS NULL');
    expect(activity).toContain('activity_results has duplicate (room_id, avatar_id) rows');
    expect(activity).toContain("WHERE reason = 'activity_match_placed'");
  });
});
