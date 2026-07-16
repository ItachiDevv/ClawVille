/**
 * GUEST EXCLUSION from the contribution leaderboard CTE (`buildAgentSnapshot`
 * in `leaderboard.ts`). Regression for the pre-existing leak found during the
 * reef-race adversarial audit (2026-07-10):
 *
 *   A not-logged-in GUEST (auto-created via `POST /api/auth/guest`, `is_guest=
 *   true`, `subjectType='human'`, `agent_id` NULL) who placed in an activity —
 *   or chatted a teacher — earned REAL placement/chat points on the PUBLIC
 *   free-agent board, violating the product rule that guest/demo play feeds
 *   nothing persistent (Brand Identity §3 / CLAUDE.md Rule E5). The activity
 *   FILTERs excluded only `subjectType='bot'`; there was NO guest guard, and
 *   the reward-pipeline's `leaderboardPoints=0` guest carve-out is IGNORED by
 *   this board (the CTE RECOMPUTES points from placement buckets).
 *
 * The FIX is a subject-level exclusion by the `is_guest` FLAG in BOTH legs —
 *   avatar leg: `NOT EXISTS (SELECT 1 FROM avatars ag WHERE ag.id = events.avatar_id AND ag.is_guest)`
 *   agent leg:  `NOT EXISTS (SELECT 1 FROM openclaw_bots ob2 JOIN users u2 ON u2.id = ob2.user_id WHERE ob2.agent_id = events.agent_id AND u2.is_guest)`
 * — mirroring the house-agent carve-out in the SAME function. It keys on the
 * `is_guest` FLAG, not a `payload.isGuest` tag, precisely because the system-
 * agent (Nori) chat emitter OMITS that tag: a payload-only filter would still
 * leak guest teacher-chat points. Both legs are guarded because a guest CAN
 * carry a non-null `agent_id`: `connect-token` (agent-gateway.ts) does NOT gate
 * on `is_guest`, so a guest holding a valid Lucia session + owning their guest
 * avatar can bind an agent (openclaw_bots row owned by a guest user).
 *
 * DURABILITY (closes Codex round-2 + round-4/5 BLOCKING): the PRIMARY guard is
 * the frozen event-time stamp `events.subject_was_guest` (event-logger
 * `resolveSubjectWasGuest` freezes users.is_guest at write), and the CTE makes it
 * AUTHORITATIVE: per leg `subject_was_guest = false OR (subject_was_guest IS NULL
 * AND NOT EXISTS(<live is_guest join>))`. So `true` excluded, `false` KEEPS
 * ranking even after a rebind, and the live join is consulted ONLY for NULL rows.
 * A guest stays excluded after a bot rebind (/connect reassigns user_id) or a
 * guest-account delete (agent_id is immutable TEXT; user_id/avatar_id go NULL) —
 * see the passing DURABILITY (rebind) + DURABILITY (deletion) tests, the RESOLVER
 * tests that drive the real write path (user/avatar/agent/mixed-id branches), and
 * NO OVER-EXCLUSION (a stamped-false real user is not re-excluded on rebind).
 *
 * GOVERNANCE: adding this filter was gated on a founder decision — FOUNDER-
 * CONFIRMED 2026-07-10 (guests fully excluded, not grandfathered), following the
 * guest-ALL-DEMO ruling. Recorded in users.ts is_guest comment + TODO.md.
 *
 * Harness mirrors `leaderboard-land-service-scoring.test.ts`: `describeIfDb()`-
 * gated (skips without DATABASE_URL), inserts controlled `events` rows directly,
 * asserts `buildAgentSnapshot` output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as dbMod from '@clawville/database';
import { Hono } from 'hono';
import { eq, and, desc, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import { buildAgentSnapshot } from '../leaderboard';
import { logEvent } from '../../services/event-logger';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;
// Setup creates avatars through the real routes, which mint custodial wallets
// via the Cloudflare worker — without real worker creds (or with a sibling
// suite's 'example.invalid' placeholder) the hooks fail, so gate like HAS_DB.
const HAS_WALLET_INFRA =
  !!process.env.CLOUDFLARE_WORKER_URL &&
  !process.env.CLOUDFLARE_WORKER_URL.includes('example.invalid') &&
  !!process.env.CLOUDFLARE_WORKER_BEARER;
const describeIfDb = HAS_DB && HAS_WALLET_INFRA ? describe : describe.skip;

// Canonical scheme (Q3 plan §2.4 — mirrored in AGENT_SCORE_WEIGHTS /
// ACTIVITY_PLACEMENT_WEIGHTS, which are module-private in leaderboard.ts).
// Hardcoded here like the sibling suite's SERVICE_SOLD_WEIGHT — a retune of
// the canonical scheme should update these + the docs in the same diff.
const TEACHER_CHAT_WEIGHT = 10;
const ACTIVITY_WIN_WEIGHT = 12; // 1st place

function buildApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/avatars', avatarRoutes);
  return app;
}

describeIfDb('leaderboard guest exclusion — scoring CTE (requires DATABASE_URL)', () => {
  const TEST_TAG = `lbguest${Date.now()}`;
  const PASSWORD = 'lbguestpassword123';

  let app: ReturnType<typeof buildApp>;

  // Real logged-in Player (is_guest=false) — the control that MUST still score.
  let realUserId = '';
  let realAvatarId = '';

  // Guest (is_guest=true) — MUST be fully excluded regardless of event volume.
  let guestUserId = '';
  let guestAvatarId = '';

  // Bot subject (is_guest=false, distinct avatar) — subjectType='bot' events
  // MUST still score 0 (existing carve-out, kept as regression).
  let botUserId = '';
  let botAvatarId = '';

  // Guest who BOUND an agent — a guest holds a valid Lucia session + owns their
  // guest avatar, and connect-token/connect do NOT gate on is_guest, so a guest
  // CAN obtain a non-null agent_id (openclaw_bots owned by a guest user). Its
  // agent-leg rows MUST be excluded by the agent_daily mirror guard.
  const guestAgentId = `test-guestbot-${TEST_TAG}`;
  let guestBotId = '';

  // Non-guest Trainer with a bound agent — CONTROL proving the agent-leg guest
  // guard does NOT over-exclude a legitimate Trainer (its owner is not a guest).
  const trainerAgentId = `test-trainerbot-${TEST_TAG}`;
  let trainerBotId = '';

  const insertedEventIds: bigint[] = [];

  async function signupAndCreateAvatar(email: string): Promise<{ userId: string; avatarId: string }> {
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'LB Guest Tester' }),
    });
    expect(signup.status).toBe(200);
    const signupData = (await signup.json()) as { avatar?: { id: string } };
    let avatarId = signupData.avatar?.id ?? '';
    if (!avatarId) {
      const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;
      const avatarRes = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: `LBG${Date.now()}${Math.floor(Math.random() * 10000)}`,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
        }),
      });
      expect(avatarRes.status).toBe(200);
      const avatarData = (await avatarRes.json()) as { avatar: { id: string } };
      avatarId = avatarData.avatar.id;
    }
    const userRow = await dbMod.db.query.users.findFirst({ where: eq(dbMod.users.email, email) });
    if (!userRow) throw new Error(`test fixture: no users row for ${email}`);
    return { userId: userRow.id as string, avatarId };
  }

  /**
   * Emit one `activity.match.placed` — faithful to reward-pipeline's payload.
   * `agentId` defaults null (avatar leg); pass a value for the agent leg (a
   * bound-agent Player / guest-bound-agent / Trainer).
   */
  async function emitPlacement(opts: {
    avatarId: string | null;
    placement: number;
    subjectType: 'human' | 'agent' | 'bot';
    isGuest: boolean;
    userId: string;
    agentId?: string | null;
    // Durable event-time stamp. Direct inserts bypass logEvent's resolver, so
    // tests set it explicitly to simulate what the write path freezes. Default
    // null (unstamped) makes the row rely on the LIVE flag-join layer instead.
    subjectWasGuest?: boolean | null;
  }): Promise<void> {
    const [row] = await dbMod.db
      .insert(dbMod.events)
      .values({
        eventType: 'activity.match.placed',
        userId: opts.userId,
        agentId: opts.agentId ?? null,
        avatarId: opts.avatarId,
        sessionId: null,
        payload: {
          activityId: 'reef-race',
          roomId: randomUUID(),
          placement: opts.placement,
          score: 100,
          tokensAwarded: 0,
          leaderboardPoints: 0, // pipeline zeroes this for guests/bots — CTE ignores it
          subjectType: opts.subjectType,
          isGuest: opts.isGuest,
        },
        subjectWasGuest: opts.subjectWasGuest ?? null,
        fpHash: null,
        ipPrefixHash: null,
      })
      .returning({ id: dbMod.events.id });
    insertedEventIds.push(row.id as bigint);
  }

  /**
   * Emit one `agent.chat.turn`. `tagGuest=false` mimics the SYSTEM-AGENT (Nori)
   * emitter, which does NOT set `payload.isGuest` — the exact case a payload-
   * only filter would leak but the durable flag-join catches.
   */
  async function emitChat(opts: {
    avatarId: string;
    userId: string;
    chatType: 'location' | 'system-agent';
    tagGuest: boolean;
    isGuest: boolean;
  }): Promise<void> {
    const [row] = await dbMod.db
      .insert(dbMod.events)
      .values({
        eventType: 'agent.chat.turn',
        userId: opts.userId,
        agentId: null,
        avatarId: opts.avatarId,
        sessionId: null,
        payload: {
          chatType: opts.chatType,
          messageLength: 20,
          ...(opts.tagGuest ? { isGuest: opts.isGuest } : {}),
        },
        fpHash: null,
        ipPrefixHash: null,
      })
      .returning({ id: dbMod.events.id });
    insertedEventIds.push(row.id as bigint);
  }

  async function avatarRow(avatarId: string) {
    const snap = await buildAgentSnapshot('all', 1_000_000);
    return snap.agents.find((e) => e.subjectType === 'avatar' && e.avatarId === avatarId);
  }

  async function agentRow(agentId: string) {
    const snap = await buildAgentSnapshot('all', 1_000_000);
    return snap.agents.find((e) => e.subjectType === 'agent' && e.agentId === agentId);
  }

  beforeAll(async () => {
    app = buildApp();

    const real = await signupAndCreateAvatar(`${TEST_TAG}-real@clawville-test.com`);
    realUserId = real.userId;
    realAvatarId = real.avatarId;

    const guest = await signupAndCreateAvatar(`${TEST_TAG}-guest@clawville-test.com`);
    guestUserId = guest.userId;
    guestAvatarId = guest.avatarId;
    // Promote to a guest — the CTE fix keys on avatars.is_guest (the durable,
    // denormalized flag). Set the users row too for fidelity, though the CTE
    // only reads the avatar flag.
    await dbMod.db.update(dbMod.avatars).set({ isGuest: true }).where(eq(dbMod.avatars.id, guestAvatarId));
    await dbMod.db.update(dbMod.users).set({ isGuest: true }).where(eq(dbMod.users.id, guestUserId));

    const bot = await signupAndCreateAvatar(`${TEST_TAG}-bot@clawville-test.com`);
    botUserId = bot.userId;
    botAvatarId = bot.avatarId;

    // A bound agent owned by the GUEST user (is_guest=true) — the agent-leg
    // leak Codex flagged: connect-token doesn't gate on is_guest.
    const [guestBot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({ agentId: guestAgentId, mode: 'autonomous', userId: guestUserId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    guestBotId = guestBot.id as string;

    // A bound agent owned by the REAL (non-guest) user — Trainer control.
    const [trainerBot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({ agentId: trainerAgentId, mode: 'autonomous', userId: realUserId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    trainerBotId = trainerBot.id as string;
  });

  afterAll(async () => {
    if (!dbMod) return;
    if (insertedEventIds.length > 0) {
      await dbMod.db.delete(dbMod.events).where(inArray(dbMod.events.id, insertedEventIds));
    }
    for (const bid of [guestBotId, trainerBotId].filter(Boolean)) {
      await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, bid));
    }
    for (const uid of [realUserId, guestUserId, botUserId].filter(Boolean)) {
      await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, uid));
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, uid));
    }
  });

  it('CONTROL: a real (non-guest) Player scores placement + teacher-chat points', async () => {
    await emitPlacement({ avatarId: realAvatarId, placement: 1, subjectType: 'human', isGuest: false, userId: realUserId });
    await emitChat({ avatarId: realAvatarId, userId: realUserId, chatType: 'location', tagGuest: true, isGuest: false });

    const row = await avatarRow(realAvatarId);
    expect(row).toBeDefined();
    expect(row!.breakdown.activity_wins).toBe(1);
    expect(row!.breakdown.teacher_chats).toBe(1);
    // Fresh subject — only these two scored events — so the score is exactly
    // 1×12 (1st place) + 1×10 (chat).
    expect(row!.score).toBe(ACTIVITY_WIN_WEIGHT + TEACHER_CHAT_WEIGHT);
  });

  it('LEAK FIX: a guest with an activity WIN never appears on the board', async () => {
    await emitPlacement({ avatarId: guestAvatarId, placement: 1, subjectType: 'human', isGuest: true, userId: guestUserId });
    const row = await avatarRow(guestAvatarId);
    expect(row).toBeUndefined(); // score 0 → filtered by WHERE score > 0
  });

  it('LEAK FIX: a guest teacher-chat WITHOUT a payload.isGuest tag (Nori-style) is still excluded', async () => {
    // location chat DOES tag isGuest; system-agent (Nori) chat does NOT. Emit
    // both for the guest — the durable flag-join must exclude BOTH, proving the
    // flag beats a payload-only filter (which would leak the untagged one).
    await emitChat({ avatarId: guestAvatarId, userId: guestUserId, chatType: 'location', tagGuest: true, isGuest: true });
    await emitChat({ avatarId: guestAvatarId, userId: guestUserId, chatType: 'system-agent', tagGuest: false, isGuest: true });
    const row = await avatarRow(guestAvatarId);
    expect(row).toBeUndefined(); // still 0 despite a win + two chats
  });

  it('REGRESSION: a bot-tagged placement (subjectType=bot) still scores 0', async () => {
    await emitPlacement({ avatarId: botAvatarId, placement: 1, subjectType: 'bot', isGuest: false, userId: botUserId });
    const row = await avatarRow(botAvatarId);
    expect(row).toBeUndefined(); // subjectType='bot' filtered → no score → off board
  });

  it('AGENT-LEG LEAK FIX (flag-join): a guest who BOUND an agent, with NO durable isGuest stamp, is excluded via the live flag-join', async () => {
    // Codex-found: connect-token doesn't gate on is_guest, so a guest can obtain
    // an agent_id. Here the row carries subjectType='agent' and payload.isGuest
    // = 'false' (NOT 'true'), so the durable payload filter does NOT catch it —
    // ONLY the users.is_guest flag-join in agent_daily does. Proves the flag-join
    // covers agent-leg events that lack a durable stamp.
    await emitPlacement({
      avatarId: null,
      agentId: guestAgentId,
      placement: 1,
      subjectType: 'agent',
      isGuest: false, // not 'true' → durable payload filter passes it → flag-join must catch it
      userId: guestUserId,
    });
    const row = await agentRow(guestAgentId);
    expect(row).toBeUndefined(); // excluded via openclaw_bots→users.is_guest join
  });

  it('AGENT-LEG CONTROL: a non-guest Trainer with a bound agent still scores', async () => {
    await emitPlacement({
      avatarId: null,
      agentId: trainerAgentId,
      placement: 1,
      subjectType: 'agent',
      isGuest: false,
      userId: realUserId,
    });
    const row = await agentRow(trainerAgentId);
    expect(row).toBeDefined();
    expect(row!.breakdown.activity_wins).toBe(1);
    expect(row!.score).toBe(ACTIVITY_WIN_WEIGHT); // 1st place = 12, guard does NOT over-exclude
  });

  // DURABILITY / REBIND — the event-time stamp (subject_was_guest=true, frozen)
  // keeps a guest-era row excluded EVEN AFTER the bot is rebound to a non-guest
  // (`/connect` reassigns user_id). The live flag-join alone would fail this
  // (it now finds a non-guest owner); the frozen stamp is what holds. Closes the
  // Codex round-2 BLOCKING durability finding.
  it('DURABILITY (rebind): a stamped guest-agent event stays excluded after the bot is rebound to a non-guest', async () => {
    const launderAgentId = `test-launder-${TEST_TAG}`;
    const [bot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({ agentId: launderAgentId, mode: 'autonomous', userId: guestUserId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    // Guest-era win, stamped at write time (subject_was_guest=true).
    await emitPlacement({ avatarId: null, agentId: launderAgentId, placement: 1, subjectType: 'agent', isGuest: true, userId: guestUserId, subjectWasGuest: true });
    // Launder: rebind the bot to the REAL (non-guest) user.
    await dbMod.db.update(dbMod.agentBots).set({ userId: realUserId }).where(eq(dbMod.agentBots.id, bot.id as string));
    const row = await agentRow(launderAgentId);
    expect(row).toBeUndefined(); // frozen stamp holds after rebind (flag-join alone would not)
    await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, bot.id as string));
  });

  // DURABILITY / DELETION — a guest-era row with a frozen stamp stays excluded
  // after the guest ACCOUNT is deleted (events.agent_id is immutable TEXT and
  // survives; openclaw_bots.user_id / events.user_id go NULL on delete → the
  // flag-join finds no guest owner). The stamp is what holds.
  it('DURABILITY (deletion): a stamped guest-agent event stays excluded after the guest user is deleted', async () => {
    // Fresh throwaway guest user + bot so we can delete the user safely.
    const delUser = await signupAndCreateAvatar(`${TEST_TAG}-del@clawville-test.com`);
    await dbMod.db.update(dbMod.users).set({ isGuest: true }).where(eq(dbMod.users.id, delUser.userId));
    const delAgentId = `test-del-${TEST_TAG}`;
    const [delBot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({ agentId: delAgentId, mode: 'autonomous', userId: delUser.userId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    await emitPlacement({ avatarId: null, agentId: delAgentId, placement: 1, subjectType: 'agent', isGuest: true, userId: delUser.userId, subjectWasGuest: true });
    // Delete the USER (+ avatar) FIRST, keeping the bot — this exercises the
    // real openclaw_bots.user_id ON DELETE SET NULL (+ events.user_id SET NULL);
    // the live flag-join now finds NO guest owner, so only the frozen stamp holds.
    await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, delUser.userId));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, delUser.userId));
    const nulled = await dbMod.db.select({ u: dbMod.agentBots.userId })
      .from(dbMod.agentBots).where(eq(dbMod.agentBots.id, delBot.id as string));
    expect(nulled[0]?.u).toBeNull(); // confirms the SET NULL fired (flag-join now blind)
    const row = await agentRow(delAgentId);
    expect(row).toBeUndefined(); // frozen stamp holds after the owner is gone
    await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, delBot.id as string));
  });

  // RESOLVER (write-path integration) — drive the REAL logEvent chokepoint (not a
  // direct insert) and assert it FROZE subject_was_guest by resolving
  // users.is_guest. Uses a guest user that is is_guest=true FROM CREATION (as the
  // real POST /api/auth/guest route mints it) — NOT the beforeAll flip-after-
  // signup fixture, whose signup event would have cached it non-guest first (the
  // resolver caches on the immutable-in-prod assumption; the test fixture's
  // artificial flip violates that, real guests never flip).
  it('RESOLVER: logEvent freezes subject_was_guest=true for a from-birth guest userId (and false for a real user)', async () => {
    const PROBE = 'test.resolver.probe';
    const freshGuestId = randomUUID();
    await dbMod.db.insert(dbMod.users).values({
      id: freshGuestId,
      email: `${TEST_TAG}-fresh-${freshGuestId}@guest.clawville`,
      passwordHash: `$guest$disabled$${freshGuestId}`,
      name: 'Guest',
      isGuest: true,
    });
    await logEvent({ eventType: PROBE, userId: freshGuestId, payload: { probe: 'g' } });
    await logEvent({ eventType: PROBE, userId: realUserId, payload: { probe: 'r' } });
    const guestRows = await dbMod.db.select({ id: dbMod.events.id, g: dbMod.events.subjectWasGuest })
      .from(dbMod.events).where(and(eq(dbMod.events.eventType, PROBE), eq(dbMod.events.userId, freshGuestId)));
    const realRows = await dbMod.db.select({ id: dbMod.events.id, g: dbMod.events.subjectWasGuest })
      .from(dbMod.events).where(and(eq(dbMod.events.eventType, PROBE), eq(dbMod.events.userId, realUserId)));
    for (const r of [...guestRows, ...realRows]) insertedEventIds.push(r.id as bigint);
    expect(guestRows.length).toBeGreaterThan(0);
    expect(realRows.length).toBeGreaterThan(0);
    expect(guestRows[0]!.g).toBe(true);   // guest → frozen true (resolver read users.is_guest)
    expect(realRows[0]!.g).toBe(false);   // real user → frozen false
    // cleanup the fresh guest user (its events are in insertedEventIds)
    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.userId, freshGuestId));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, freshGuestId));
  });

  // RESOLVER (avatar path) — an event with ONLY avatarId (as reward-pipeline
  // emits activity.match.placed) resolves via the avatar's OWNER users.is_guest
  // (SoT), not the avatars.is_guest mirror.
  it('RESOLVER (avatar path): freezes true from the avatar owner is_guest', async () => {
    const PROBE = 'test.resolver.avatar';
    const gUserId = randomUUID();
    await dbMod.db.insert(dbMod.users).values({
      id: gUserId, email: `${TEST_TAG}-av-${gUserId}@guest.clawville`,
      passwordHash: `$guest$disabled$${gUserId}`, name: 'Guest', isGuest: true,
    });
    const [av] = await dbMod.db.insert(dbMod.avatars).values({
      userId: gUserId, name: `RA${Date.now()}${Math.floor(Math.random() * 100000)}`,
      species: 'cat', color: 'green', gender: 'male', archetype: 'brave-adventurer',
      personality: { habitat: 'x', hobby: 'y', greeting: 'z' },
      stats: { strength: 5, defence: 5, movement: 5 },
      agentCategory: 'openclaw', harness: 'milady', modelKey: 'milady_official_1', isGuest: true,
    }).returning({ id: dbMod.avatars.id });
    await logEvent({ eventType: PROBE, avatarId: av.id as string, payload: { p: 'a' } });
    const rows = await dbMod.db.select({ id: dbMod.events.id, g: dbMod.events.subjectWasGuest })
      .from(dbMod.events).where(and(eq(dbMod.events.eventType, PROBE), eq(dbMod.events.avatarId, av.id as string)));
    for (const r of rows) insertedEventIds.push(r.id as bigint);
    expect(rows[0]!.g).toBe(true);
    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.avatarId, av.id as string));
    await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.id, av.id as string));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, gUserId));
  });

  // RESOLVER (agent path) — the critical adversarial-review cases: (a) a missing
  // bot row must NOT poison a later binding with a stale `false`; (b) the agent
  // path is NEVER cached (bot ownership is mutable) so a rebind is seen fresh.
  it('RESOLVER (agent path): no false-poison on missing row; resolves fresh across a rebind (never cached)', async () => {
    const PROBE = 'test.resolver.agent';
    const gUserId = randomUUID();
    await dbMod.db.insert(dbMod.users).values({
      id: gUserId, email: `${TEST_TAG}-ag-${gUserId}@guest.clawville`,
      passwordHash: `$guest$disabled$${gUserId}`, name: 'Guest', isGuest: true,
    });
    const aId = `test-resolveagent-${TEST_TAG}-${Math.floor(Math.random() * 100000)}`;

    // Returns the LATEST probe row's {found, g} — distinguishes "row exists with
    // NULL stamp" from "no row" (the round-5 assertion-gap fix).
    async function latestStamp(): Promise<{ found: boolean; g: boolean | null }> {
      const [r] = await dbMod.db.select({ id: dbMod.events.id, g: dbMod.events.subjectWasGuest })
        .from(dbMod.events).where(and(eq(dbMod.events.eventType, PROBE), eq(dbMod.events.agentId, aId)))
        .orderBy(desc(dbMod.events.id)).limit(1);
      if (r) insertedEventIds.push(r.id as bigint);
      return { found: !!r, g: r?.g ?? null };
    }

    // (a) MISSING bot row → the event IS written (row exists) with an
    // INDETERMINATE NULL stamp, NOT a cached false (anti-poison).
    await logEvent({ eventType: PROBE, agentId: aId, payload: { p: 'missing' } });
    const missing = await latestStamp();
    expect(missing.found).toBe(true); // the event row was inserted
    expect(missing.g).toBeNull();     // with a NULL stamp (not false)

    // (b) bind the bot to the GUEST → next event resolves fresh → true (proves
    // the earlier missing lookup did NOT poison the cache with false).
    const [bot] = await dbMod.db.insert(dbMod.agentBots)
      .values({ agentId: aId, mode: 'autonomous', userId: gUserId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    await logEvent({ eventType: PROBE, agentId: aId, payload: { p: 'bound-guest' } });
    expect((await latestStamp()).g).toBe(true);

    // (c) rebind the bot to the REAL user → next event resolves fresh → false
    // (proves the agent path is NOT cached — a stale true would fail this).
    await dbMod.db.update(dbMod.agentBots).set({ userId: realUserId }).where(eq(dbMod.agentBots.id, bot.id as string));
    await logEvent({ eventType: PROBE, agentId: aId, payload: { p: 'rebound-real' } });
    expect((await latestStamp()).g).toBe(false);

    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.agentId, aId));
    await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, bot.id as string));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, gUserId));
  });

  // RESOLVER (mixed id, round-5 fix) — a DEFINITIVE-false id must NOT be
  // laundered into an authoritative `false` when a sibling id is INDETERMINATE.
  // realUserId → false; a nonexistent agentId → no bot row → null (agentId is
  // plain TEXT, no FK, so the event still inserts — unlike a bogus avatarId which
  // an FK would reject). Correct three-way OR returns NULL (not false) so the
  // CTE's live-join backstop still applies.
  it('RESOLVER (mixed id): definitive-false userId + unresolvable agentId → NULL stamp, not false', async () => {
    const PROBE = 'test.resolver.mixed';
    const ghostAgent = `test-mixed-noexist-${randomUUID()}`;
    await logEvent({ eventType: PROBE, userId: realUserId, agentId: ghostAgent, payload: { p: 'mixed' } });
    const [r] = await dbMod.db.select({ id: dbMod.events.id, g: dbMod.events.subjectWasGuest })
      .from(dbMod.events).where(eq(dbMod.events.eventType, PROBE)).orderBy(desc(dbMod.events.id)).limit(1);
    insertedEventIds.push(r.id as bigint);
    expect(r).toBeDefined();
    expect(r.g).toBeNull(); // indeterminate agentId blocks an authoritative false
    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.eventType, PROBE));
  });

  // NO OVER-EXCLUSION (adversarial-review finding) — the frozen stamp is
  // AUTHORITATIVE: a REAL user's event stamped false must keep ranking even if
  // their bot LATER rebinds to a guest owner. An UNCONDITIONAL live flag-join
  // would wrongly re-exclude this real user (the live join sees a guest current
  // owner); scoping the join to NULL stamps only is what prevents that.
  it('NO OVER-EXCLUSION: a real Trainer stamped false stays ranked after the bot rebinds to a guest owner', async () => {
    const oAgentId = `test-overexcl-${TEST_TAG}`;
    const [bot] = await dbMod.db.insert(dbMod.agentBots)
      .values({ agentId: oAgentId, mode: 'autonomous', userId: realUserId, isHouse: false })
      .returning({ id: dbMod.agentBots.id });
    // Real Trainer's win, frozen non-guest (subject_was_guest=false).
    await emitPlacement({ avatarId: null, agentId: oAgentId, placement: 1, subjectType: 'agent', isGuest: false, userId: realUserId, subjectWasGuest: false });
    // Rebind the bot to a GUEST owner (guestUserId is is_guest=true).
    await dbMod.db.update(dbMod.agentBots).set({ userId: guestUserId }).where(eq(dbMod.agentBots.id, bot.id as string));
    const row = await agentRow(oAgentId);
    expect(row).toBeDefined();                       // frozen false is authoritative
    expect(row!.score).toBe(ACTIVITY_WIN_WEIGHT);    // still scores 12 — NOT re-excluded
    await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, bot.id as string));
  });

  // EVIDENCE LOCK — the ACTIONABLE latent-leak class (Grok/Codex round-6/7): an
  // agent-only scored event (no user_id/avatar_id) whose bot is CURRENTLY guest-
  // owned but is NOT durably stamped `true`. Such a row is excluded NOW by the
  // live join, but would LEAK if the owner rebinds away. After the backfill
  // (which stamps current-guest-owned agent rows) + the write-time resolver, this
  // MUST be 0 — i.e. every live guest's agent events are durably frozen, not
  // riding the mutable live join. Fails loudly if a live guest agent event ever
  // escapes stamping.
  //
  // NOTE — why this is NOT the "count currently-guest-owned rows == 0" test the
  // prior version wrongly used: an INNER JOIN to a live guest owner CANNOT see
  // the OWNERLESS residue (a former-guest bot whose user was deleted → user_id
  // NULL) — the class that actually ranks. That class is UNRECONSTRUCTABLE (no
  // query can prove an ownerless row's write-time identity), so it is ENUMERATED
  // + manually assessed in the migration + ARCHITECTURE §5b (staging: 19 rows,
  // all test/mock `agent.connected`, non-guest), and closed going-forward by the
  // companion branch's guest-agent-binding block (deploy-ordering constraint) —
  // not asserted here.
  it('EVIDENCE: every live guest-owned agent-only scored row is durably stamped (0 latent leaks)', async () => {
    const SCORED = [
      'activity.match.placed', 'agent.chat.turn', 'agent.collaboration.turn',
      'building.visited', 'skill_md.fetched', 'agent.connected', 'identity.issued',
      'land.parcel.purchased', 'land.structure.placed', 'land.structure.upgraded',
      'land.service.sold',
    ];
    const rows = await dbMod.db
      .select({ c: sql<number>`count(*)::int` })
      .from(dbMod.events)
      .innerJoin(dbMod.agentBots, eq(dbMod.agentBots.agentId, dbMod.events.agentId))
      .innerJoin(dbMod.users, eq(dbMod.users.id, dbMod.agentBots.userId))
      .where(and(
        isNull(dbMod.events.userId),
        isNull(dbMod.events.avatarId),
        eq(dbMod.users.isGuest, true),
        // Not durably excluded (NULL or false) ⇒ leaks on rebind-away.
        sql`${dbMod.events.subjectWasGuest} IS DISTINCT FROM true`,
        inArray(dbMod.events.eventType, SCORED),
      ));
    expect(Number(rows[0]!.c)).toBe(0);
  });
});
