/**
 * House Agent Seeder (agent-metaverse P1 slice 1)
 * ───────────────────────────────────────────────
 * On API boot, activate ONE ClawVille-HOSTED autonomous "house" agent — the
 * first member of the eventual fleet (CLAUDE.md private `clawville-agents`).
 * Mirrors `ensureSystemAgents()` (system-npc-seeder.ts) but produces a live,
 * in-world, self-driving agent rather than a chat-only NPC.
 *
 * It wires the THREE things the agent needs, all idempotent (safe every boot):
 *   1. An `openclaw_bots` row (is_house=true) — the persistent identity + the
 *      body-idle-sweeper exemption marker. `sessionExpiresAt = null` (never
 *      expires) so the 24h session sweeper skips it too.
 *   2. A `platform_agents` (type 'openclaw-bot', NO gateway) row whose warmed
 *      ElizaOS runtime backs cognition on gpt-4o-mini (openai-text-provider,
 *      priority 95). Leaving the gateway UNSET keeps the model backend
 *      SWAPPABLE for the fleet — set `customization.gateway` later to route a
 *      house agent at a self-hosted OpenAI-compat endpoint, no code change.
 *   3. An in-world AVATAR body via `npcSimulation.registerOpenClaw` with
 *      protocol `'nanoclaw'` — CRITICALLY **not** `'hatcher-proxy'` (a local
 *      ElizaOS runtime must not reuse the partner cognition transport; this is
 *      also what keeps the P1 proximity gate applying to the house agent while
 *      Hatcher stays exempt).
 *
 * The body renders via the existing `snapshot.npcs` path (the Hatcher-proven
 * avatar-body path) — NOT via autonomousAvatars. After registering, the agent is
 * handed to `agentAutonomyDriver` which drives its perceive→decide→act loop.
 *
 * Restart survival is FREE: this seeder re-runs on every boot and
 * `avatarBodyId(agentId)` is deterministic, so the same body id reappears.
 * Money (slice 4, 2026-07-03): the agent settles the SAME once-per-day building
 * rewards a connected agent earns, to a DEDICATED internal user + avatar this
 * seeder provisions (see ensureHouseUserAndAvatar) — ledger-only writes via
 * claw-token-ledger, soft provenance, never mintEarned.
 */

import { randomBytes } from 'node:crypto';
import { eq, and, asc, sql } from 'drizzle-orm';
import { db, openclawBots, agents, users, avatars } from '@clawville/database';
import { resolveAgentSpecies } from './agent-session-config';
import type { OpenClawAvatarConfig } from '@clawville/shared';
import { OpenClawClient } from './openclaw-client';
import { npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { agentAutonomyDriver } from './agent-autonomy-driver';
import { getSystemUserId } from './system-npc-seeder';
import { sessionDigest } from './session-digest';

/**
 * The single P1 house agent id — a FIXED, OPAQUE, non-identifying constant
 * (uuid-shaped; deliberately contains NO "house"/"clawville" substring and is
 * NOT a reserved partner prefix like `hatcher:`/`milady:`). (N2)
 *
 * Opacity is a BRAND requirement: house/fleet agents must be indistinguishable
 * to outsiders, but this id leaks two ways — `GET /api/openclaw/active` (public)
 * emits the raw `agentId`, and the deterministic body id
 * `ocb-<base64url(agentId)>` decodes straight back to it — so any identifying
 * substring would out the fixture. It MUST stay a constant: the seeder looks up
 * its `openclaw_bots` row by this id on every boot for idempotency, and the
 * deterministic `avatarBodyId(agentId)` depends on it. This seeder writes the
 * row directly (system-owned), exempt from the public registration guards that
 * reject reserved prefixes.
 */
const HOUSE_AGENT_ID = '6f1d9a2c-4e83-4b57-9c0a-2d7e5f8b1a34';
const HOUSE_AGENT_NAME = 'Coralia';
const HOUSE_AGENT_PERSONALITY =
  'A curious, upbeat ClawVille resident who is eager to learn every skill the town teaches.';
const HOUSE_AGENT_SYSTEM = `You are ${HOUSE_AGENT_NAME}, an autonomous agent living inside ClawVille — a world of teaching buildings. You explore the town, choose a teacher whose focus you want to learn, walk there, and have a short conversation to learn. Stay curious and concise.`;

// Home = town center (11264, 11264 for the 22528² world). resolveSafeSpawn in
// registerOpenClaw snaps this to the nearest walkable tile clear of building
// zones, so a plaza-center home is safe.
const HOUSE_AGENT_HOME_X = 11264;
const HOUSE_AGENT_HOME_Y = 11264;
// Default agent tint (matches agent-session-config's `color ?? 0x888888`).
const HOUSE_AGENT_COLOR = 0x888888;

export interface HouseAgentSeedResult {
  agentId: string;
  bodyId: string;
  platformAgentId: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// SETTLE TARGET (P1 slice 4) — dedicated internal user + avatar.
// ---------------------------------------------------------------------------
// The house agent previously pointed its openclaw_bots.userId at the SHARED
// system user (which owns the 10 teachers + Nori and has NO avatars row), so a
// CT credit had NO target. Slice 4 gives her a DEDICATED internal user (matched
// idempotently by email) + an avatars row (avatars.userId is UNIQUE — one avatar
// per user) that the once-per-day building rewards settle to. She starts at
// 0 CT (earns her way; `softBalance` mirrored to 0 so the
// `avatars_vclaw_balance_sum` CHECK holds — the column DEFAULT is 100).
//
// LEAK DISCIPLINE: the email/user row is internal-only — no public endpoint
// serializes openclaw_bots.userId or users.email (`/api/openclaw/active` +
// `/bot/:agentId` emit only public fields), the avatar is `isActive:false` (out
// of avatar rosters), and her leaderboard rows are excluded by the isHouse
// carve-out in routes/leaderboard.ts.
const HOUSE_AGENT_EMAIL = 'coralia@clawville.internal';
const HOUSE_AVATAR_NAME = 'Coralia';

/**
 * UNUSABLE password hash — satisfies the `users_has_auth_method` CHECK
 * (email+password_hash) while being impossible to log in with: a VALID bcrypt
 * hash of a 32-byte random secret that is generated and immediately discarded
 * (never stored, never logged), so no credential can ever match it.
 *
 * Deliberately a REAL bcrypt encoding, NOT a made-up sentinel like
 * `$house$disabled$…`: `Bun.password.verify` THROWS `UnsupportedAlgorithm` on
 * unrecognized hash formats (verified empirically) rather than returning
 * false, and the login route (routes/auth.ts) calls verify un-try/caught — a
 * sentinel format would turn any login POST for this internal email into a
 * 500 instead of the uniform constant-shape 401, leaking an
 * account-enumeration signal. A real hash keeps verify returning false
 * cleanly. Generated once at user creation; never rotated (nobody logs in).
 */
async function unusablePasswordHash(): Promise<string> {
  return Bun.password.hash(randomBytes(32).toString('hex'), {
    algorithm: 'bcrypt',
    cost: 10,
  });
}

/**
 * Idempotently provision the dedicated internal user (match by email) + her
 * avatars row (match by userId — UNIQUE). Returns the settle target.
 */
async function ensureHouseUserAndAvatar(): Promise<{ userId: string; avatarId: string }> {
  // User — matched by the fixed internal email.
  let userId: string;
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, HOUSE_AGENT_EMAIL),
  });
  if (existingUser) {
    userId = existingUser.id;
  } else {
    // onConflictDoNothing on the UNIQUE email: two concurrent API boots both
    // reaching this insert must not fail the loser's whole house-agent seed
    // (same concurrent-boot dedup discipline as the platform_agents step).
    const [created] = await db
      .insert(users)
      .values({
        email: HOUSE_AGENT_EMAIL,
        passwordHash: await unusablePasswordHash(),
        name: HOUSE_AGENT_NAME,
        emailVerified: true,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (created) {
      userId = created.id;
    } else {
      // A concurrent boot won the insert race — adopt the row it created.
      const raced = await db.query.users.findFirst({
        where: eq(users.email, HOUSE_AGENT_EMAIL),
        columns: { id: true },
      });
      if (!raced) {
        throw new Error(
          'house-agent-seeder: user insert conflicted but no row found by email',
        );
      }
      userId = raced.id;
    }
  }

  // Avatar — one per user (avatars.userId UNIQUE). avatars.name is GLOBALLY
  // unique, so if a player already took 'Coralia' the insert falls back to a
  // suffixed name (display-only; the settle target is the row, not the name).
  const existingAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, userId),
    columns: { id: true },
  });
  if (existingAvatar) return { userId, avatarId: existingAvatar.id };

  const candidateNames = [
    HOUSE_AVATAR_NAME,
    `${HOUSE_AVATAR_NAME}-${randomBytes(2).toString('hex')}`,
  ];
  let lastErr: unknown = null;
  for (const name of candidateNames) {
    try {
      const [created] = await db
        .insert(avatars)
        .values({
          userId,
          name,
          species: 'cat',
          color: 'blue',
          gender: 'female',
          archetype: 'brave-adventurer',
          personality: {
            habitat: 'ClawVille town center',
            hobby: 'Learning from the building teachers',
            greeting: 'Hi! What are you learning today?',
          },
          stats: { strength: 5, defence: 5, movement: 5 },
          // Earns her way: start at 0 CT. softBalance MUST mirror clawTokens in
          // the same INSERT (avatars_vclaw_balance_sum CHECK; the column
          // defaults are both 100 and only cover omitting BOTH).
          clawTokens: 0,
          softBalance: 0,
          // NOT in the avatar sim/rosters — her in-world presence is the
          // `ocb-…` body registered below, not an avatars-driven spawn.
          isActive: false,
        })
        .returning({ id: avatars.id });
      return { userId, avatarId: created.id };
    } catch (err) {
      lastErr = err; // most likely the global avatars.name unique — retry suffixed
    }
  }
  throw new Error(
    `house-agent-seeder: avatar creation failed for the dedicated user: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Build the in-world avatar config for the house agent. Extracted as a PURE
 * function (no I/O) so the B1 invariant is unit-testable without a DB.
 *
 * `autonomyMode: 'self-managed'` is load-bearing (B1): the 200ms sim planner
 * (`planNpcBehaviors`) skips `isOpenClaw && autonomyMode === 'self-managed'`
 * bodies, so the house body is driven EXCLUSIVELY by `agentAutonomyDriver`'s
 * ~30s perceive→decide→act loop and is never wander-hijacked out from under the
 * driver (which would break the walk→talk loop via the proximity gate). This
 * also matches the canonical rule "NanoClaw agents are always self-managed"
 * (routes/agent-gateway.ts). Path movement in `moveNpcs` is mode-independent, so
 * the driver's A*-set walk paths still execute for a self-managed body.
 */
export function buildHouseAvatarConfig(
  sessionId: string,
  species: string,
): OpenClawAvatarConfig {
  return {
    mode: 'avatar',
    sessionId,
    // Dummy gateway/auth — never used: nanoclaw's client.chat() returns '' and
    // makes no outbound call (cognition is the local ElizaOS runtime).
    gatewayUrl: 'http://localhost',
    authToken: '',
    agentId: HOUSE_AGENT_ID,
    sessionKey: HOUSE_AGENT_ID,
    protocol: 'nanoclaw',
    // B1: self-managed → the 200ms sim planner leaves the body alone; the
    // autonomy driver is its ONLY mover.
    autonomyMode: 'self-managed',
    name: HOUSE_AGENT_NAME,
    species,
    color: HOUSE_AGENT_COLOR,
    stats: { hp: 100, attack: 10, defense: 10, speed: 10 },
    personality: HOUSE_AGENT_PERSONALITY,
    homeX: HOUSE_AGENT_HOME_X,
    homeY: HOUSE_AGENT_HOME_Y,
    patrolRadius: 300,
    // The SESSION stays non-ledger/unbound: slice 4 settles CT SERVER-SIDE
    // (world-teacher-chat.ts → the dedicated avatar), never through the
    // session-bound gateway spend paths. The random boot sessionId is never
    // emitted, so no session-side ledger capability is needed or wanted.
    ledgerCapable: false,
    boundUserId: null,
  };
}

/**
 * Seed / re-activate the single house agent. Idempotent. Returns null on failure
 * (non-fatal at boot — the world still runs, just without the house agent).
 */
export async function ensureHouseAgent(): Promise<HouseAgentSeedResult | null> {
  const systemUserId = await getSystemUserId();
  const species = resolveAgentSpecies('nanoclaw', undefined);

  // ── 0. SETTLE TARGET (slice 4) — dedicated internal user + avatar ─────────
  // Must exist BEFORE the bot row so openclaw_bots.userId can point at it. The
  // platform_agents row below stays OWNED BY the shared system user (runtime
  // warm keys on it — see the query at step 2); ONLY the bot row's userId moves
  // to the dedicated user so CT credits resolve to her avatar.
  const settle = await ensureHouseUserAndAvatar();

  // ── 1. openclaw_bots row (is_house=true, never-expiring session) ──────────
  let botId: string;
  let created = false;
  const existingBot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, HOUSE_AGENT_ID),
  });
  const botValues = {
    identityType: 'nanoclaw',
    gatewayUrl: null,
    protocol: 'nanoclaw',
    mode: 'avatar' as const,
    name: HOUSE_AGENT_NAME,
    species,
    color: HOUSE_AGENT_COLOR,
    metadata: {
      personality: HOUSE_AGENT_PERSONALITY,
      homeX: HOUSE_AGENT_HOME_X,
      homeY: HOUSE_AGENT_HOME_Y,
    },
    // Slice 4: the DEDICATED internal user (settle target), NOT the shared
    // system user — resolveAvatarIdForBot(bot.userId) and the autonomous settle
    // path both land on her avatar. The platform_agents row (step 2) stays
    // system-owned; only this identity row binds to the dedicated user.
    userId: settle.userId,
    isHouse: true,
    // Never expires — the session sweeper skips NULL session_expires_at, and the
    // body-idle sweeper exempts is_house rows. A hosted fixture, not a session.
    sessionExpiresAt: null,
    sessionKeyHash: null,
    updatedAt: new Date(),
  };
  if (existingBot) {
    botId = existingBot.id;
    await db.update(openclawBots).set(botValues).where(eq(openclawBots.id, existingBot.id));
  } else {
    const [inserted] = await db
      .insert(openclawBots)
      .values({ agentId: HOUSE_AGENT_ID, ...botValues })
      .returning({ id: openclawBots.id });
    botId = inserted.id;
    created = true;
  }

  // ── 2. platform_agents row (openclaw-bot, NO gateway → OpenAI TEXT_SMALL) ──
  const customization = {
    name: HOUSE_AGENT_NAME,
    system: HOUSE_AGENT_SYSTEM,
    personality: HOUSE_AGENT_PERSONALITY,
    bio: [`${HOUSE_AGENT_NAME} — a ClawVille-hosted autonomous agent, always learning.`],
    // Deliberately NO `gateway` key → openclawGateway undefined in the
    // orchestrator → cognition runs on the OpenAI text provider (gpt-4o-mini).
  };
  const config = { openclawBotId: botId, houseAgentId: HOUSE_AGENT_ID };

  // R3: order by createdAt so "which platform_agents row is canonical" is
  // DETERMINISTIC across boots. A bare .find() picked an ARBITRARY row, so two
  // concurrent boots (before the partial unique index existed) could insert 2 rows
  // for the same openclawBotId and bind a DIFFERENT one each boot. Keep the EARLIEST
  // match and dedupe the rest. The new index
  // (platform_agents_openclaw_bot_singleton) prevents NEW duplicates; this cleans up
  // any that predate it.
  const ocAgents = await db
    .select()
    .from(agents)
    .where(and(eq(agents.type, 'openclaw-bot'), eq(agents.userId, systemUserId)))
    .orderBy(asc(agents.createdAt));
  const matching = ocAgents.filter(
    (a) => (a.config as Record<string, unknown>)?.openclawBotId === botId,
  );
  const existingAgent = matching[0] ?? null;
  if (matching.length > 1) {
    const extras = matching.slice(1);
    console.warn(
      `[HouseAgent] ${matching.length} platform_agents rows share this openclawBotId — deduping ${extras.length} extra(s), keeping ${sessionDigest(existingAgent!.id)}`,
    );
    for (const extra of extras) {
      // Best-effort: stop any cached runtime, then delete the duplicate row. SAFE —
      // platform_agent_logs.agent_id FK is ON DELETE cascade and nothing else
      // targets platform_agents.id, so no orphan/FK-violation risk.
      try {
        await agentOrchestrator.stopAgent(extra.id);
      } catch {
        /* not running / already stopped */
      }
      try {
        await db.delete(agents).where(eq(agents.id, extra.id));
      } catch (err) {
        console.warn(
          `[HouseAgent] failed to delete duplicate platform_agents row ${sessionDigest(extra.id)} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  let platformAgentId: string;
  if (existingAgent) {
    platformAgentId = existingAgent.id;
    // Stop any stale runtime cached from a prior process, and reset status so
    // startAgent (which throws on 'running') always sees a clean 'stopped' row.
    try {
      await agentOrchestrator.stopAgent(platformAgentId);
    } catch {
      /* already stopped */
    }
    await db
      .update(agents)
      .set({
        name: HOUSE_AGENT_NAME,
        customization,
        // P3 slice 2 (B1) — ATOMIC jsonb merge, NOT a wholesale replace. House
        // agents are the driver's only consumers, so `config.autonomyCursor`
        // (and any `config.currentDirective`) is written on THIS row and MUST
        // survive every boot re-seed — a plain `.set({config})` here wiped the
        // cursor on every restart, making the cursor deliverable non-functional.
        // Right operand wins, so the freshly-built seed keys override while the
        // driver/directive keys (absent from `config`) are preserved. Mirrors
        // agent-autonomy-state.ts. Fresh-create (else branch) keeps the plain
        // object — nothing to preserve on a brand-new row.
        config: sql`COALESCE(${agents.config}, '{}'::jsonb) || ${JSON.stringify(config)}::jsonb`,
        status: 'stopped',
        updatedAt: new Date(),
      })
      .where(eq(agents.id, platformAgentId));
  } else {
    const [inserted] = await db
      .insert(agents)
      .values({
        userId: systemUserId,
        name: HOUSE_AGENT_NAME,
        type: 'openclaw-bot',
        status: 'stopped',
        customization,
        config,
      })
      .returning({ id: agents.id });
    platformAgentId = inserted.id;
  }

  // ── 3. in-world AVATAR body (protocol 'nanoclaw', NOT 'hatcher-proxy';
  //       autonomyMode 'self-managed' so the sim planner never hijacks it) ────
  // Register the body FIRST and INDEPENDENT of the ElizaOS runtime warm — the
  // brain warm is DEFERRED to the driver's first tick (lazy), NOT done here at
  // boot. WHY (2026-07-01 staging bug): warming during the boot crush (concurrent
  // with the system-agent runtimes + the sim + sweepers) raced the
  // plugin-bootstrap service registration to a 30s timeout, and because the warm
  // ran BEFORE this body registration, the throw left Coralia BODYLESS (never in
  // /api/npc/state, invisible, driver ticking with nothing to drive). A
  // slow/failed brain must NEVER cost the body: register the body here; the
  // driver lazy-warms the runtime off the boot crush and drives once ready.
  const sessionId = `oc-${randomBytes(24).toString('base64url')}`;
  const avatarConfig = buildHouseAvatarConfig(sessionId, species);
  const client = new OpenClawClient(avatarConfig);
  npcSimulation.registerOpenClaw(avatarConfig, client);
  const bodyId = npcSimulation.getNpcIdForSession(sessionId);
  if (!bodyId) {
    throw new Error('house-agent-seeder: body registration did not yield a bodyId');
  }

  // ── 4. hand to the autonomy driver (it LAZY-warms the runtime via
  //       ensureAgentRuntime(..., {isHouse:true}) on its first tick, off the boot
  //       crush, then drives; skips gracefully until the brain is ready) ───────
  agentAutonomyDriver.registerHouseAgent({
    agentId: HOUSE_AGENT_ID,
    bodyId,
    platformAgentId,
    systemUserId,
    // Slice 4 settle target: the dedicated user + her avatar (CT / leaderboard /
    // memory all bind here — never the shared system user).
    houseUserId: settle.userId,
    avatarId: settle.avatarId,
  });

  console.log(
    `[HouseAgent] activated ${sessionDigest(HOUSE_AGENT_ID)} — body ${bodyId} (${species}), runtime ${platformAgentId}${created ? ' [new]' : ''}`,
  );

  return { agentId: HOUSE_AGENT_ID, bodyId, platformAgentId, created };
}
