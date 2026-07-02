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
 * Money: NONE — the house agent settles no CT this dispatch (slice 4 deferred).
 */

import { randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, openclawBots, agents } from '@clawville/database';
import { resolveAgentSpecies } from './agent-session-config';
import type { OpenClawAvatarConfig } from '@clawville/shared';
import { OpenClawClient } from './openclaw-client';
import { npcSimulation } from './npc-simulation';
import { agentOrchestrator } from './agent-orchestrator';
import { agentAutonomyDriver } from './agent-autonomy-driver';
import { getSystemUserId } from './system-npc-seeder';
import { sessionDigest } from './session-digest';

/**
 * The single P1 house agent. A plain (non-reserved) agentId — MUST NOT start
 * with a reserved partner prefix (`hatcher:`), which the public registration
 * guards reject; this seeder writes the row directly (system-owned) so it is
 * exempt from those public guards, but a plain id keeps it unambiguous.
 */
const HOUSE_AGENT_ID = 'clawville-house-01';
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

/**
 * Seed / re-activate the single house agent. Idempotent. Returns null on failure
 * (non-fatal at boot — the world still runs, just without the house agent).
 */
export async function ensureHouseAgent(): Promise<HouseAgentSeedResult | null> {
  const systemUserId = await getSystemUserId();
  const species = resolveAgentSpecies('nanoclaw', undefined);

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
    userId: systemUserId,
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

  const ocAgents = await db
    .select()
    .from(agents)
    .where(and(eq(agents.type, 'openclaw-bot'), eq(agents.userId, systemUserId)));
  const existingAgent =
    ocAgents.find((a) => (a.config as Record<string, unknown>)?.openclawBotId === botId) ?? null;

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
      .set({ name: HOUSE_AGENT_NAME, customization, config, status: 'stopped', updatedAt: new Date() })
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

  // Warm the ElizaOS runtime (gpt-4o-mini). isHouse=true → the orchestrator's
  // 30-min inactivity sweep skips it (the driver uses useModel, which does not
  // bump lastActivity). Failure is non-fatal — the driver retries once warmed.
  await agentOrchestrator.startAgent(platformAgentId, systemUserId, { isHouse: true });

  // ── 3. in-world AVATAR body (protocol 'nanoclaw', NOT 'hatcher-proxy') ─────
  const sessionId = `oc-${randomBytes(24).toString('base64url')}`;
  const avatarConfig: OpenClawAvatarConfig = {
    mode: 'avatar',
    sessionId,
    // Dummy gateway/auth — never used: nanoclaw's client.chat() returns '' and
    // makes no outbound call (cognition is the local ElizaOS runtime above).
    gatewayUrl: 'http://localhost',
    authToken: '',
    agentId: HOUSE_AGENT_ID,
    sessionKey: HOUSE_AGENT_ID,
    protocol: 'nanoclaw',
    autonomyMode: 'server-managed',
    name: HOUSE_AGENT_NAME,
    species,
    color: HOUSE_AGENT_COLOR,
    stats: { hp: 100, attack: 10, defense: 10, speed: 10 },
    personality: HOUSE_AGENT_PERSONALITY,
    homeX: HOUSE_AGENT_HOME_X,
    homeY: HOUSE_AGENT_HOME_Y,
    patrolRadius: 300,
    // No CT this dispatch (slice 4 deferred) — non-ledger, unbound.
    ledgerCapable: false,
    boundUserId: null,
  };
  const client = new OpenClawClient(avatarConfig);
  npcSimulation.registerOpenClaw(avatarConfig, client);
  const bodyId = npcSimulation.getNpcIdForSession(sessionId);
  if (!bodyId) {
    throw new Error('house-agent-seeder: body registration did not yield a bodyId');
  }

  // ── 4. hand to the autonomy driver ────────────────────────────────────────
  agentAutonomyDriver.registerHouseAgent({ agentId: HOUSE_AGENT_ID, bodyId, platformAgentId });

  console.log(
    `[HouseAgent] activated ${sessionDigest(HOUSE_AGENT_ID)} — body ${bodyId} (${species}), runtime ${platformAgentId}${created ? ' [new]' : ''}`,
  );

  return { agentId: HOUSE_AGENT_ID, bodyId, platformAgentId, created };
}
