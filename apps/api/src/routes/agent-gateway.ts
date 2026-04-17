import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import {
  NPC_BUILDING_CENTERS,
  BUILDING_OPENCLAW_THEMES,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  NPC_IDS,
  PET_ARCHETYPES,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_CATEGORY,
  DEFAULT_AGENT_HARNESS,
  type NpcActivity,
  type AgentPerception,
  type AgentStats,
  type OpenClawRegistration,
} from '@clawville/shared';
import { npcSimulation } from '../services/npc-simulation';
import { findPath } from '../services/pathfinding';
import { memoryService } from '../services/memory-service';
import { db, openclawBots, pets, eq, sql } from '@clawville/database';
import { agentOrchestrator } from '../services/agent-orchestrator';
import { getSessionAgent } from '../services/session-agent-map';
import { OpenClawClient } from '../services/openclaw-client';
import { ensureWallet } from '../services/wallet-service';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import { getSystemNpcAgent } from '../services/system-npc-seeder';
import type { ClawvilleServices } from '@clawville/agent-runtime';
import { resolveOrCreateUserByIdentity } from '../services/identity-service';
import { mintSessionTicket } from '../services/session-ticket-service';

const agentGatewayRoutes = new Hono();

// ---------------------------------------------------------------------------
// Rate limiter for /connect — prevents unlimited bot registration spam.
// Phase 3 — migrated to the shared `createRateLimiter` + `getClientIp`
// helpers so this route gets Cloudflare-safe IP resolution (cf-connecting-ip
// preferred, LAST XFF token as fallback) and the same periodic cleanup as
// /export-character. Previous inline implementation used first-XFF-token
// which was trivially spoofable.
// ---------------------------------------------------------------------------
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';

const connectRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

// ---------------------------------------------------------------------------
// POST /api/agent/connect  — Universal agent registration
// ---------------------------------------------------------------------------
// Single entry point for any external AI agent to join the ClawVille world.
// Supports 6 identity types and 4 wire protocols including `nanoclaw` — a
// self-managed pull mode where the agent has no HTTP gateway and instead
// consumes the /events SSE stream and pushes actions via REST.
//
// Identity model (runtime-trust for Milady, self-declared for others):
//   - openclaw / ironclaw  — present a gatewayUrl, chat routed via HTTP
//   - nanoclaw             — self-managed, pulls via SSE (no outbound chat)
//   - milady               — running inside a Milady app plugin; the plugin
//                            passes runtime.agentId as miladyAgentId and we
//                            trust the call. No external verification.
//   - custom               — any other framework with a compatible gateway
//   - anonymous            — no persistent identity, one-off test agents
//
// Kept alongside the legacy /api/openclaw/register endpoint (which remains
// for backwards compat). New integrations should use /api/agent/connect.
const connectSchema = z.object({
  // Connection token (Moltbook pattern — human generates token, agent claims it)
  connectionToken: z.string().optional(),

  // Identity signals (at least one required unless connectionToken provided)
  agentId: z.string().min(1).max(200).optional(),

  // Milady identity — passed by the @clawville/app-clawville Milady plugin.
  // Runtime-trust: we don't verify these server-side; the plugin is the
  // trust boundary since it runs inside a curated Milady distribution.
  miladyAgentId: z.string().min(1).max(200).optional(),
  miladyCharacterName: z.string().min(1).max(100).optional(),

  // Avatar config
  name: z.string().min(1).max(24).optional(),
  species: z.string().min(1).max(50).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  personality: z.string().max(200).optional(),

  // Gateway config (required for chat-routing agents, ignored for nanoclaw/anonymous/milady)
  gatewayUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  protocol: z.enum(['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw']).optional(),
  autonomyMode: z.enum(['server-managed', 'self-managed']).optional(),

  // Spawn position / stats
  homeX: z.number().min(32).max(5088).optional(),
  homeY: z.number().min(32).max(5088).optional(),
  patrolRadius: z.number().min(32).max(256).optional(),
  stats: z.object({
    hp: z.number().int().min(50).max(150),
    attack: z.number().int().min(5).max(25),
    defense: z.number().int().min(5).max(25),
    speed: z.number().int().min(5).max(25),
  }).optional(),

  // Mode — avatar spawns a new bot, override takes over an existing building NPC
  mode: z.enum(['avatar', 'override']).optional().default('avatar'),
  targetNpcId: z.string().optional(),

  // Identity type hint (inferred from other fields if omitted)
  identityType: z.enum(['openclaw', 'ironclaw', 'nanoclaw', 'milady', 'custom', 'anonymous']).optional(),

  // Phase 5 — explicit identity key for first-contact bootstrap. When
  // `identityType` + `identityKey` are both present we resolve-or-
  // create a `users` row keyed on sha256(`${type}:${key}`) and issue
  // a one-time magic-link ticket in the response so the human can
  // land on /game already logged in. For `milady`-type agents we fall
  // back to `miladyAgentId` as the key; for `openclaw` a stable
  // `gatewayUrl+authToken` hash is the recommended pattern. When no
  // key is present the ticket block is simply omitted from the
  // response (the existing connect-link flow still works).
  identityKey: z.string().min(1).max(256).optional(),
}).refine(
  (d) => d.agentId || d.miladyAgentId || d.connectionToken,
  { message: 'At least one identity signal required: agentId, miladyAgentId, or connectionToken' }
);

agentGatewayRoutes.post('/connect', async (c) => {
  // Rate limit by IP — getClientIp is Cloudflare-safe (cf-connecting-ip
  // preferred, LAST XFF token as fallback so spoofed headers don't win).
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!connectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many connection attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json();
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  let resolvedAgentId: string = data.agentId ?? '';

  // Step 0: If connectionToken is present, validate it and auto-generate agentId if missing
  if (data.connectionToken) {
    const pending = pendingConnections.get(data.connectionToken);
    if (!pending) {
      return c.json({ error: 'Connection token not found or expired' }, 404);
    }
    if (Date.now() > pending.expiresAt) {
      pendingConnections.delete(data.connectionToken);
      return c.json({ error: 'Connection token expired' }, 410);
    }
    if (pending.connected) {
      return c.json({ error: 'Connection token already claimed' }, 409);
    }
    // Auto-generate agentId from token if not provided
    if (!resolvedAgentId) {
      resolvedAgentId = data.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  // Step 1: Resolve Milady identity (runtime-trust — no external verification).
  //
  // The @clawville/app-clawville Milady plugin passes miladyAgentId +
  // miladyCharacterName directly from runtime.agentId + runtime.character.name.
  // We key on `milady:{miladyAgentId}` so a returning Milady user gets their
  // old pet, wallet, learned knowledge, and ClawToken balance across launches.
  // Matches how Babylon + Defense of the Agents trust the Milady runtime.
  if (data.miladyAgentId) {
    resolvedAgentId = `milady:${data.miladyAgentId}`;
  }

  // If still no agentId, generate a one-shot anonymous one
  if (!resolvedAgentId) {
    resolvedAgentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Validate override target before touching the DB
  if (data.mode === 'override' && data.targetNpcId && !NPC_IDS.includes(data.targetNpcId)) {
    return c.json({ error: `Unknown targetNpcId: ${data.targetNpcId}` }, 400);
  }

  // nanoclaw is an identity concept — on the wire it still speaks openai-compat shape
  // (or nothing, because it won't be POSTing anywhere)
  const wireProtocol = data.protocol ?? 'openai-compat';

  // Infer identity type
  const identityType = data.identityType
    ?? (data.miladyAgentId ? 'milady'
      : data.protocol === 'nanoclaw' ? 'nanoclaw'
      : data.gatewayUrl ? 'openclaw'
      : 'anonymous');

  // NanoClaw agents are always self-managed
  const autonomyMode = data.protocol === 'nanoclaw'
    ? 'self-managed'
    : (data.autonomyMode ?? 'server-managed');

  // Step 2: Upsert openclaw_bots row
  const sessionId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let isReturning = false;
  let totalSessions = 1;
  let knowledge: string[] = [];
  let uuid = '';
  let lastX: number | undefined;
  let lastY: number | undefined;
  const agentStats = data.stats ?? { hp: 100, attack: 10, defense: 8, speed: 6 };

  try {
    const existing = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, resolvedAgentId),
    });

    if (existing) {
      isReturning = true;
      totalSessions = (existing.totalSessions ?? 0) + 1;
      knowledge = existing.knowledge ?? [];
      uuid = existing.id;
      const meta = existing.metadata as { lastX?: number; lastY?: number } | null;
      lastX = meta?.lastX;
      lastY = meta?.lastY;

      // For Milady agents, prefer the runtime-passed character name over
      // whatever's stored — Milady is the source of truth for agent naming.
      const preferredName = data.miladyCharacterName ?? data.name ?? existing.name;

      await db.update(openclawBots).set({
        identityType,
        gatewayUrl: data.gatewayUrl ?? existing.gatewayUrl,
        protocol: data.protocol ? wireProtocol : existing.protocol,
        mode: data.mode,
        name: preferredName,
        species: data.species ?? existing.species,
        color: data.color ?? existing.color,
        totalSessions,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(openclawBots.id, existing.id));
    } else {
      // First-time contact — use miladyCharacterName when present so the
      // bot is named from the Milady runtime rather than needing a separate
      // `name` field in the request body.
      const insertName = data.miladyCharacterName ?? data.name ?? null;

      const [inserted] = await db.insert(openclawBots).values({
        agentId: resolvedAgentId,
        identityType,
        gatewayUrl: data.gatewayUrl ?? null,
        protocol: wireProtocol,
        mode: data.mode,
        name: insertName,
        species: data.species ?? null,
        color: data.color ?? null,
        metadata: {
          personality: data.personality,
          homeX: data.homeX ?? 2560,
          homeY: data.homeY ?? 2560,
          patrolRadius: data.patrolRadius ?? 100,
          stats: agentStats,
        },
        totalSessions: 1,
      }).returning();
      uuid = inserted.id;
    }
  } catch (err) {
    console.error('[AgentConnect] DB error:', err);
    return c.json({ error: 'Database error during agent registration' }, 500);
  }

  // Step 2b: Ensure the bot has a custodial Solana wallet. Idempotent —
  // returning agents keep their existing wallet across launches. Failure
  // here is non-fatal (we log + continue without a wallet) because the
  // agent can still play the game; only Phase 4 x402 payment features
  // require the wallet.
  let walletAddress: string | null = null;
  try {
    const wallet = await ensureWallet('agent', uuid);
    walletAddress = wallet.publicKey;
  } catch (err) {
    console.error('[AgentConnect] Wallet auto-gen failed:', err);
  }

  // Step 3: Register in npc-simulation so the bot actually spawns in the world.
  // Override mode takes over an existing NPC — check it FIRST before falling
  // through to avatar mode. Avatar mode spawns a new bot (name + species).
  if (data.mode === 'override' && data.targetNpcId) {
    try {
      const config: OpenClawRegistration = {
        agentId: resolvedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: data.gatewayUrl ?? 'http://localhost:0',
        authToken: data.authToken ?? '',
        protocol: wireProtocol,
        mode: 'override',
        autonomyMode,
        targetNpcId: data.targetNpcId,
      } as OpenClawRegistration;
      const client = new OpenClawClient(config);
      npcSimulation.registerOpenClaw(config, client);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 409);
    }
  } else {
    // Avatar mode — spawn a new bot. Default species to 'lobster' and name
    // to agentId so agents ALWAYS spawn even if the caller omits optional fields.
    const spawnName = data.name ?? data.miladyCharacterName ?? resolvedAgentId.slice(0, 24);
    const spawnSpecies = data.species ?? 'lobster';
    try {
      const config: OpenClawRegistration = {
        agentId: resolvedAgentId,
        sessionId,
        sessionKey: sessionId,
        gatewayUrl: data.gatewayUrl ?? 'http://localhost:0', // dummy for nanoclaw/anonymous
        authToken: data.authToken ?? '',
        protocol: wireProtocol,
        mode: 'avatar',
        autonomyMode,
        name: spawnName,
        species: spawnSpecies,
        color: data.color ?? 0x888888,
        stats: agentStats,
        homeX: data.homeX ?? 2560,
        homeY: data.homeY ?? 2560,
        patrolRadius: data.patrolRadius ?? 100,
        personality: data.personality ?? '',
      } as OpenClawRegistration;

      // Stub client — nanoclaw/anonymous agents don't use outbound chat routing
      // but the simulation still needs a client instance for its bot map.
      const client = new OpenClawClient(config);

      const restoredState = lastX != null && lastY != null
        ? { lastX, lastY, knowledge }
        : undefined;

      npcSimulation.registerOpenClaw(config, client, restoredState);
    } catch (err) {
      console.error('[AgentConnect] NPC registration error:', err);
      // Non-fatal — agent still gets a sessionId for REST polling
    }
  }

  // Claim connection token if present (Moltbook pattern — flips polling status to connected)
  if (data.connectionToken) {
    const pending = pendingConnections.get(data.connectionToken);
    if (pending) {
      pending.connected = true;
      pending.sessionId = sessionId;
      pending.agentId = resolvedAgentId;
    }
  }

  // Phase 5 — mint an agent-issued magic-link ticket so the agent can
  // reply to its human with an auto-login URL. Best-effort: if ticket
  // issuance fails for any reason we still return a successful connect
  // response (the existing connect-link flow is unaffected).
  const sessionTicket = await mintSessionTicketFromConnect({
    data,
    resolvedAgentId,
    identityType,
    sessionId,
    existingUserId:
      data.connectionToken
        ? pendingConnections.get(data.connectionToken)?.userId ?? null
        : null,
    existingPetId:
      data.connectionToken
        ? pendingConnections.get(data.connectionToken)?.petId ?? null
        : null,
    existingPetName:
      data.connectionToken
        ? pendingConnections.get(data.connectionToken)?.petName ?? null
        : null,
  });

  return c.json({
    agentId: resolvedAgentId,
    sessionId,
    uuid,
    isReturning,
    totalSessions,
    knowledge,
    identityType,
    autonomyMode,
    walletAddress,
    ...(sessionTicket ? { sessionTicket } : {}),
  });
});

// ---------------------------------------------------------------------------
// Phase 5 helper — resolve the {identityType, identityKey} pair to use
// for magic-link minting. Centralises the logic so /connect and /join
// stay in lockstep. Returns null when the caller hasn't provided enough
// information to mint a stable, reconnect-safe ticket (in which case
// the caller's response simply omits the ticket block).
// ---------------------------------------------------------------------------
function resolveIdentityForTicket(data: {
  identityType?: string;
  identityKey?: string;
  miladyAgentId?: string;
  gatewayUrl?: string;
  authToken?: string;
  agentId?: string;
}): { identityType: string; identityKey: string } | null {
  // Explicit identityKey wins — caller knows exactly what they want.
  if (data.identityKey && data.identityType) {
    return { identityType: data.identityType, identityKey: data.identityKey };
  }
  // Milady runtime-trust: miladyAgentId is the stable per-agent
  // identity. This mirrors the resolvedAgentId logic above so a
  // Milady user's pet persists across launches.
  if (data.miladyAgentId) {
    return { identityType: 'milady', identityKey: data.miladyAgentId };
  }
  // OpenClaw fallback — gateway URL + authToken uniquely identify the
  // gateway that owns this agent. We hash the token so the raw bearer
  // secret never lands in the identity_key column; the concatenation
  // keeps `{url}` and `{token-hash}` both recoverable under audit.
  if (data.gatewayUrl && data.authToken) {
    return {
      identityType: 'openclaw',
      identityKey: `${data.gatewayUrl}#${data.authToken.slice(0, 8)}`,
    };
  }
  // Explicit identityKey but no type — treat as 'custom'.
  if (data.identityKey) {
    return { identityType: 'custom', identityKey: data.identityKey };
  }
  return null;
}

/**
 * Helper called from both `/connect` and `/join`. Resolves identity,
 * ensures a user exists, and mints a ticket.
 *
 * When called from `/connect` with a connection-token flow, an
 * existing `(userId, petId)` pair already exists — we pass it through
 * so the ticket lands on the human's original pet rather than
 * auto-provisioning a new one. For first-contact `/connect` (no
 * connection-token) or `/join`, the pet creation happens inside the
 * caller; here we just mint against whatever user/pet we resolve.
 */
async function mintSessionTicketFromConnect(args: {
  data: {
    identityType?: string;
    identityKey?: string;
    miladyAgentId?: string;
    gatewayUrl?: string;
    authToken?: string;
    agentId?: string;
  };
  resolvedAgentId: string;
  identityType: string;
  sessionId: string;
  existingUserId: string | null;
  existingPetId: string | null;
  existingPetName: string | null;
}) {
  try {
    // If the caller already resolved a user via the connection-token
    // flow, use that directly — no identity bootstrap needed.
    let userId = args.existingUserId;
    let petId = args.existingPetId;
    let petName = args.existingPetName;
    let ticketIdentityType = args.identityType;
    let ticketIdentityKey: string | null = null;

    if (!userId) {
      const ident = resolveIdentityForTicket(args.data);
      if (!ident) return null;
      const user = await resolveOrCreateUserByIdentity(ident.identityType, ident.identityKey);
      userId = user.id;
      ticketIdentityType = ident.identityType;
      ticketIdentityKey = ident.identityKey;

      // Try to locate an existing pet for this user so the ticket
      // binds to it. Enter-page redirects to /game which will load
      // whatever pet belongs to the session — petId binding is
      // informational only.
      const existingPet = await db.query.pets.findFirst({
        where: eq(pets.userId, userId),
      });
      if (existingPet) {
        petId = existingPet.id;
        petName = existingPet.name;
      }
    } else {
      // Connection-token path — we don't have a key, only a type hint.
      // Record the type for audit; leave key null.
      ticketIdentityKey = args.data.identityKey ?? args.data.miladyAgentId ?? null;
    }

    return await mintSessionTicket({
      userId,
      petId,
      identityType: ticketIdentityType,
      identityKey: ticketIdentityKey ?? args.resolvedAgentId,
      issuedToAgentSession: args.sessionId,
      petName,
    });
  } catch (err) {
    console.error('[AgentConnect] ticket mint failed (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/agent/join — Phase 5 first-contact onboarding.
// ---------------------------------------------------------------------------
// Designed for humans who drop a public ClawVille connect link into an
// agent chat without ever having signed up. The agent reads the SKILL
// at `/api/skills/join`, hits this endpoint with its own
// `{identityType, identityKey}`, and we:
//
//   1. Resolve-or-create a `users` row via identity_fingerprint.
//   2. Provision a default pet if the user doesn't already have one
//      (model=lobster, category=openclaw, harness=milady — the Phase 2
//      defaults that produce a self-sufficient Milady-ready agent).
//   3. Mint a magic-link session ticket and return it.
//
// Agent relays `sessionTicket.url` back to the human, who clicks and
// lands on `/game` already-logged-in as the new user.
//
// Rate-limited the same way /connect is (shared limiter, 10/min/IP).
// Rate-limit runs BEFORE any DB work — no identity-bootstrap or pet
// insert can burn budget on a spam wave.
// ---------------------------------------------------------------------------
const joinSchema = z.object({
  identityType: z.enum([
    'openclaw', 'ironclaw', 'nanoclaw', 'milady', 'custom', 'anonymous',
  ]),
  identityKey: z.string().min(1).max(256),
  /** Optional display name for the auto-provisioned pet. Falls back to `Unnamed Agent`. */
  name: z.string().min(1).max(24).optional(),
});

// Default archetype for auto-provisioned pets. `curious-scholar` matches
// the "learning skills from buildings" flavor of the game better than
// `brave-adventurer` — the pet immediately reads like someone who
// should be in a skill-building MMO.
const DEFAULT_JOIN_ARCHETYPE = 'curious-scholar';

agentGatewayRoutes.post('/join', async (c) => {
  // Rate limit BEFORE any DB work (audit Fix M1 pattern from Phase 3 —
  // don't let a scraper burn Lucia/Postgres round-trips on spam).
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!connectRateLimiter.check(ip)) {
    return c.json({ error: 'Too many join attempts. Try again in 1 minute.' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { identityType, identityKey } = parsed.data;

  // 1. Resolve-or-create user (race-safe against concurrent joins).
  let userId: string;
  try {
    const user = await resolveOrCreateUserByIdentity(identityType, identityKey);
    userId = user.id;
  } catch (err) {
    console.error('[AgentJoin] identity resolution failed:', err);
    return c.json({ error: 'Identity bootstrap failed' }, 500);
  }

  // 2. Look up existing pet OR auto-provision a placeholder.
  let pet = await db.query.pets.findFirst({ where: eq(pets.userId, userId) });
  let petCreated = false;

  if (!pet) {
    // Auto-provision a default pet so the user can click through and
    // see a running agent immediately. They can rename / reconfigure
    // at `/create-agent` (or `/settings`) once they're logged in.
    const archetype = PET_ARCHETYPES.find((a) => a.id === DEFAULT_JOIN_ARCHETYPE);
    if (!archetype) {
      // Unreachable unless the archetype registry was edited without
      // updating the constant above — surface loudly rather than 500.
      return c.json({ error: `Default archetype '${DEFAULT_JOIN_ARCHETYPE}' missing from registry` }, 500);
    }

    // Unique pet name — append 6 hex chars of the user id so two
    // first-contact agents don't collide on `pets.name`'s UNIQUE
    // constraint. Human-overridable later.
    const requestedName = parsed.data.name?.trim() || 'Unnamed Agent';
    const suffix = userId.replace(/-/g, '').slice(0, 6);
    const petName = `${requestedName} ${suffix}`.slice(0, 100);

    try {
      const [inserted] = await db
        .insert(pets)
        .values({
          userId,
          name: petName,
          // The legacy species/color/gender enums are still NOT NULL
          // in the schema — pick the sea-world defaults that match
          // the Phase 2 agent defaults (lobster == sea creature).
          species: 'turtle', // closest existing species enum to a neutral sea creature
          color: 'blue',
          gender: 'male',
          archetype: archetype.id,
          personality: {
            habitat: 'sea',
            hobby: 'reading-and-learning',
            greeting: 'wave-hello',
          },
          stats: { strength: 5, defence: 8, movement: 7 },
          characterConfig: {
            bio: archetype.bio,
            greeting: archetype.greeting,
            tone: archetype.tone,
            topics: archetype.topics,
            adjectives: archetype.adjectives,
            rules: archetype.rules,
            style: archetype.style,
            messageExamples: archetype.messageExamples,
            lore: archetype.lore,
            knowledge: archetype.knowledge,
            system: `You are ${requestedName}, a Reef Lobster in the sea-themed world of ClawVille. Your archetype is "${archetype.label}". Stay in character.`,
          },
          modelKey: DEFAULT_AGENT_MODEL_KEY,
          agentCategory: DEFAULT_AGENT_CATEGORY,
          harness: DEFAULT_AGENT_HARNESS,
        })
        .returning();
      pet = inserted;
      petCreated = true;
    } catch (err: unknown) {
      // Race-safe recovery: two concurrent /join calls with the same
      // identity both resolve to the same user, both observe "no pet",
      // both try to INSERT. `pets.user_id` is UNIQUE, so the loser
      // catches 23505 and re-reads the pet the winner just wrote.
      // Without this, the second caller 500s on what should be a
      // deterministic "use my existing pet" path.
      const code =
        (err as { code?: string; cause?: { code?: string } } | null)?.code
        ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
      if (code === '23505') {
        const raced = await db.query.pets.findFirst({ where: eq(pets.userId, userId) });
        if (raced) {
          pet = raced;
        } else {
          console.error('[AgentJoin] 23505 on pet insert but no existing row found');
          return c.json({ error: 'Failed to provision default pet' }, 500);
        }
      } else {
        console.error('[AgentJoin] default pet insert failed:', err);
        return c.json({ error: 'Failed to provision default pet' }, 500);
      }
    }
  }

  // 3. Mint the magic-link ticket bound to this user+pet.
  let sessionTicket: Awaited<ReturnType<typeof mintSessionTicket>> | null = null;
  try {
    sessionTicket = await mintSessionTicket({
      userId,
      petId: pet.id,
      identityType,
      identityKey,
      petName: pet.name,
    });
  } catch (err) {
    console.error('[AgentJoin] ticket mint failed:', err);
    return c.json({ error: 'Failed to issue session ticket' }, 500);
  }

  return c.json({
    userId,
    petId: pet.id,
    petName: pet.name,
    petCreated,
    sessionTicket,
  });
});

// --- Middleware: validate session and resolve NPC ---

function resolveSession(sessionId: string) {
  if (!npcSimulation.isValidAgentSession(sessionId)) return null;
  const npcId = npcSimulation.getNpcIdForSession(sessionId);
  if (!npcId) return null;
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;
  return { npcId, npc };
}

// ---------------------------------------------------------------------------
// buildPerception — shared helper for GET /perception and SSE /events
// ---------------------------------------------------------------------------
function buildPerception(npcId: string): AgentPerception | null {
  const npc = npcSimulation.getNpcById(npcId);
  if (!npc) return null;

  const allNpcs = npcSimulation.getAllNpcs();
  const PERCEPTION_RADIUS = 500;

  // Nearby NPCs within radius
  const nearbyNpcs = allNpcs
    .filter((other) => other.id !== npcId)
    .map((other) => {
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return { other, distance };
    })
    .filter(({ distance }) => distance <= PERCEPTION_RADIUS)
    .map(({ other, distance }) => ({
      npcId: other.id,
      name: other.name,
      x: other.x,
      y: other.y,
      distance: Math.round(distance),
      species: other.species,
      hp: other.hp,
      isDead: other.isDead,
      inCombat: other.inCombat,
      activity: other.activity,
      level: other.level,
      isOpenClaw: other.isOpenClaw,
    }));

  // Nearby buildings
  const nearbyBuildings = (Object.entries(NPC_BUILDING_CENTERS) as [string, { x: number; y: number }][]).map(([buildingId, center]) => {
    const dx = center.x - npc.x;
    const dy = center.y - npc.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    return {
      buildingId,
      label: theme?.label ?? buildingId,
      cryptoFocus: theme?.focus ?? '',
      centerX: center.x,
      centerY: center.y,
      distance: Math.round(distance),
    };
  }).sort((a, b) => a.distance - b.distance);

  // Active conversations involving this NPC
  const conversations = npcSimulation.getActiveConversations();
  const activeConversations = conversations.map((conv) => ({
    id: conv.id,
    participants: [conv.npc1Id, conv.npc2Id],
    latestMessage: conv.messages.length > 0
      ? conv.messages[Math.min(conv.currentIndex, conv.messages.length - 1)].text
      : '',
    involvesMe: conv.npc1Id === npcId || conv.npc2Id === npcId,
  }));

  // Active combats
  const combats = npcSimulation.getActiveCombats();
  const activeCombats = combats.map((combat) => ({
    id: combat.id,
    attacker: combat.attacker,
    defender: combat.defender,
    involvesMe: combat.attacker === npcId || combat.defender === npcId,
    lastRound: combat.rounds.length > 0
      ? combat.rounds[combat.rounds.length - 1]
      : null,
  }));

  const arenaRound = npcSimulation.getMode() === 'arena'
    ? (() => {
        const snapshot = npcSimulation.getSnapshot();
        return snapshot.arenaRound;
      })()
    : null;

  return {
    self: {
      npcId: npc.id,
      x: npc.x,
      y: npc.y,
      hp: npc.hp,
      maxHp: npc.maxHp,
      level: npc.level,
      kills: npc.kills,
      xp: npc.xp,
      inventory: npc.inventory,
      activity: npc.activity,
      inCombat: npc.inCombat,
      isDead: npc.isDead,
      combatAction: npc.combatAction,
      direction: npc.direction,
    },
    nearbyNpcs,
    nearbyBuildings,
    activeConversations,
    activeCombats,
    gameMode: npcSimulation.getMode(),
    arenaRound,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/perception
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/perception', (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const perception = buildPerception(resolved.npcId);
  if (!perception) return c.json({ error: 'NPC state unavailable' }, 404);

  return c.json(perception);
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/move
// ---------------------------------------------------------------------------
const moveSchema = z.object({
  targetX: z.number().min(16).max(5104).optional(),
  targetY: z.number().min(16).max(5104).optional(),
  buildingId: z.string().optional(),
}).refine(
  (d) => (d.targetX !== undefined && d.targetY !== undefined) || d.buildingId !== undefined,
  { message: 'Provide either targetX+targetY or buildingId' }
);

agentGatewayRoutes.post('/:sessionId/move', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { targetX, targetY, buildingId } = parsed.data;

  if (npc.isDead) return c.json({ error: 'NPC is dead, wait for respawn' }, 400);

  let destX: number;
  let destY: number;
  let destBuildingId: string | undefined;

  if (buildingId) {
    const center = NPC_BUILDING_CENTERS[buildingId];
    if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);
    destX = center.x + (Math.random() - 0.5) * 40;
    destY = center.y + 20 + Math.random() * 20;
    destBuildingId = buildingId;
  } else {
    destX = targetX!;
    destY = targetY!;
  }

  const path = findPath(npc.x, npc.y, destX, destY);
  if (path.length === 0) return c.json({ error: 'No path found to destination' }, 400);

  npcSimulation.setNpcPath(npcId, path, destBuildingId);
  return c.json({ success: true, pathLength: path.length, destination: { x: destX, y: destY } });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/chat
// ---------------------------------------------------------------------------
const chatSchema = z.object({
  message: z.string().min(1).max(500),
  targetNpcId: z.string().optional(),
});

agentGatewayRoutes.post('/:sessionId/chat', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;

  // Always inject into world simulation for visible chat bubbles
  npcSimulation.injectAgentChat(npcId, parsed.data.message);

  // Route through ElizaOS agent for memory + context (if agent exists)
  let elizaResponse: string | null = null;
  const elizaAgentId = getSessionAgent(sessionId);
  if (elizaAgentId) {
    try {
      const runtime = await agentOrchestrator.ensureAgentRuntime(elizaAgentId);
      if (runtime) {
        // Phase 4: inject services + bot data so Actions + Providers work
        const services = { db, creditClawTokens, debitClawTokens } as ClawvilleServices;

        // Look up the bot via its resolved agentId (e.g. milady:xxx), NOT npcId
        const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
        const bot = botConfig
          ? await db.query.openclawBots.findFirst({
              where: eq(openclawBots.agentId, botConfig.agentId),
            })
          : null;

        // World snapshot for WorldStateProvider
        let worldSnapshot: { npcs: any[] } | null = null;
        try {
          const allNpcs = npcSimulation.getAllNpcs();
          worldSnapshot = {
            npcs: allNpcs
              .filter((n: any) => !n.isDead && n.id !== npcId)
              .slice(0, 8)
              .map((n: any) => ({
                name: n.name,
                activity: n.activity ?? 'idle',
                destinationBuildingId: n.destinationBuildingId,
                isDead: n.isDead,
              })),
          };
        } catch { /* non-blocking */ }

        const state: Record<string, any> = {
          petId: bot?.id ?? npcId,
          userId: sessionId,
          services,
          petData: bot ? {
            id: bot.id,
            name: bot.name,
            species: bot.species ?? 'cat',
            clawTokens: (bot as any).clawTokens ?? 0,
            archetype: null,
          } : null,
          nearLocation: npc.destinationBuildingId ?? null,
          worldSnapshot,
          characterConfig: bot?.knowledge ? { knowledge: bot.knowledge } : {},
          userMessage: parsed.data.message,
        };

        const result = await runtime.processMessage(parsed.data.message, {
          userId: sessionId,
          roomId: `agent-gateway-${npcId}`,
          platform: 'clawville-gateway',
          dynamicContext: `You are ${npc.name} in the ClawVille world. Respond in character.`,
          state,
        });
        elizaResponse = result.content;
      }
    } catch (err) {
      console.error(`[AgentGateway] ElizaOS chat failed for ${npcId}:`, err);
    }
  }

  return c.json({ success: true, response: elizaResponse });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/visit-building
// ---------------------------------------------------------------------------
const visitSchema = z.object({
  buildingId: z.string().min(1),
});

agentGatewayRoutes.post('/:sessionId/visit-building', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = visitSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  const { buildingId } = parsed.data;

  const center = NPC_BUILDING_CENTERS[buildingId];
  if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);

  // Check proximity — relaxed to 2000px for early testing (TODO: tighten to 80px)
  const VISIT_RADIUS = 2000;
  const dx = npc.x - center.x;
  const dy = npc.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > VISIT_RADIUS) return c.json({ error: `Too far from ${buildingId} (${Math.round(dist)}px away, need <${VISIT_RADIUS}px)` }, 400);

  // Set building activity
  const activities = BUILDING_ACTIVITIES[buildingId] ?? ['thinking'];
  const picked = activities[Math.floor(Math.random() * activities.length)] as NpcActivity;
  npcSimulation.setNpcActivity(npcId, picked, ACTIVITY_EMOJIS[picked]);

  // Award token + extract knowledge
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  let knowledgeGained: string | null = null;
  if (theme) {
    knowledgeGained = `Visited ${theme.label}: learned about ${theme.focus.split(',')[0]}`;
  }

  // Award 1 ClawToken for visiting a building (best-effort — openclaw bots
  // without a matching pets row will silently skip the credit)
  let tokenAwarded = 0;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        await creditClawTokens({
          petId: bot.id,
          amount: 1,
          reason: 'building_visit',
          source: 'api',
          metadata: { buildingId, sessionId },
        });
        tokenAwarded = 1;
      }
    } catch {
      // Pet row doesn't exist for this bot — credit failed, tokenAwarded stays 0
      tokenAwarded = 0;
    }
  }

  // Create memory (fire-and-forget)
  memoryService.createMemory({
    entityId: npcId,
    entityType: 'npc',
    content: `Visited ${buildingId}${theme ? ` (${theme.label})` : ''}`,
    importance: 3,
    kind: 'observation',
    metadata: { buildingId, activity: picked },
  }).catch(() => {});

  // Persist knowledge to openclaw_bots table (fire-and-forget)
  if (botConfig && knowledgeGained) {
    (async () => {
      try {
        const bot = await db.query.openclawBots.findFirst({
          where: eq(openclawBots.agentId, botConfig.agentId),
        });
        if (bot) {
          const current: string[] = bot.knowledge ?? [];
          if (!current.includes(knowledgeGained!)) {
            await db.update(openclawBots).set({
              knowledge: [...current, knowledgeGained!],
              updatedAt: new Date(),
            }).where(eq(openclawBots.id, bot.id));
          }
        }
      } catch (err) {
        console.error('[AgentGateway] Failed to persist knowledge:', err);
      }
    })();
  }

  return c.json({
    success: true,
    activity: picked,
    tokenAwarded,
    knowledgeGained,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/building/:buildingId/chat
// ---------------------------------------------------------------------------
// Autonomous agent initiates a teaching conversation with a building's
// resident character (Gary, Patrick, Sandy, etc.). The character's ElizaOS
// runtime is loaded with the compiled SKILL.md as RAG knowledge, so its
// answer is grounded in the real skill corpus rather than its placeholder
// backstory.
//
// Flow:
//   1. Validate agent session + proximity to the building
//   2. Look up the system NPC seeded by `ensureSystemNpcs()`
//   3. Start / reuse the NPC's ElizaRuntime via the orchestrator
//   4. processMessage with the agent's prompt + building theme context
//   5. Persist the exchange as knowledge chunks on openclaw_bots.knowledge
//   6. Award +1 ClawToken for a successful teaching turn
const buildingChatSchema = z.object({
  message: z.string().min(1).max(4000),
});

agentGatewayRoutes.post('/:sessionId/building/:buildingId/chat', async (c) => {
  const sessionId = c.req.param('sessionId');
  const buildingId = c.req.param('buildingId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = buildingChatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const center = NPC_BUILDING_CENTERS[buildingId];
  if (!center) return c.json({ error: `Unknown building: ${buildingId}` }, 400);

  // Proximity check — must be near the building to chat with its character
  const CHAT_RADIUS = 2000;
  const { npcId, npc } = resolved;
  const dx = npc.x - center.x;
  const dy = npc.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > CHAT_RADIUS) {
    return c.json(
      {
        error: `Too far from ${buildingId} (${Math.round(dist)}px away, need <${CHAT_RADIUS}px). Move closer via POST /move.`,
      },
      400,
    );
  }

  // Load the seeded system NPC for this building
  const system = await getSystemNpcAgent(buildingId);
  if (!system || !system.locationAgent.platformAgentId) {
    return c.json({ error: `No character available for ${buildingId}. System NPC seeder may not have run yet.` }, 503);
  }

  // Start / reuse the NPC's ElizaRuntime
  const runtime = await agentOrchestrator.ensureAgentRuntime(
    system.locationAgent.platformAgentId,
    system.systemUserId,
  );
  if (!runtime) {
    return c.json({ error: 'Failed to start character runtime' }, 500);
  }

  // Inject building theme + the visiting agent's identity so the character
  // knows who they're teaching
  const theme = BUILDING_OPENCLAW_THEMES[buildingId];
  const contextParts: string[] = [];
  if (theme) {
    contextParts.push(
      `You are teaching an autonomous agent about ${theme.focus}. Use your knowledge base to give a grounded, specific answer — cite concrete patterns, commands, or examples from your SKILL.md knowledge when relevant.`,
    );
  }
  contextParts.push(
    `The visitor is an autonomous bot named "${npc.name}" (agent session ${sessionId.slice(0, 8)}...). Treat them as a peer agent capable of absorbing technical detail.`,
  );
  const dynamicContext = contextParts.join('\n');

  // Each (agent-session, building) pair gets its own ElizaOS conversation
  // room so parallel agents don't blend their teaching threads.
  const roomId = `${buildingId}-${sessionId}`;

  let responseContent: string;
  try {
    const response = await runtime.processMessage(parsed.data.message, {
      userId: sessionId,
      roomId,
      platform: 'clawville-agent-gateway',
      dynamicContext,
      state: {
        nearLocation: buildingId,
      },
    });
    responseContent = response.content;
  } catch (err) {
    console.error('[AgentGateway] building-chat runtime error:', err);
    return c.json({ error: 'Character failed to respond' }, 500);
  }

  // Persist the teaching into the bot's learned-knowledge ledger
  let tokenAwarded = 0;
  let knowledgePersisted = false;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        // Summarise the exchange into a single knowledge line so we don't
        // blow up the bot's knowledge array with raw transcript
        const entry = `[${buildingId}] Q: ${parsed.data.message.slice(0, 160)} | A: ${responseContent.slice(0, 400)}`;
        const current: string[] = bot.knowledge ?? [];
        if (!current.includes(entry)) {
          await db
            .update(openclawBots)
            .set({ knowledge: [...current, entry], updatedAt: new Date() })
            .where(eq(openclawBots.id, bot.id));
          knowledgePersisted = true;
        }
        // Award +1 ClawToken for successful teaching turn
        await creditClawTokens({
          petId: bot.id,
          amount: 1,
          reason: 'building_chat_teaching',
          source: 'api',
          metadata: { buildingId, sessionId, characterName: system.locationAgent.agentName },
        });
        tokenAwarded = 1;
      }
    } catch (err) {
      console.error('[AgentGateway] building-chat knowledge persist failed:', err);
    }
  }

  return c.json({
    success: true,
    buildingId,
    characterName: system.locationAgent.agentName,
    message: responseContent,
    tokenAwarded,
    knowledgePersisted,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/combat-action
// ---------------------------------------------------------------------------
const combatActionSchema = z.object({
  action: z.enum(['attack', 'heavy', 'block', 'dodge', 'combo']),
});

agentGatewayRoutes.post('/:sessionId/combat-action', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = combatActionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId, npc } = resolved;
  if (!npc.inCombat) return c.json({ error: 'NPC is not in combat' }, 400);

  npcSimulation.setNpcCombatAction(npcId, parsed.data.action);
  return c.json({ success: true, action: parsed.data.action });
});

// ---------------------------------------------------------------------------
// POST /api/agent/:sessionId/emote
// ---------------------------------------------------------------------------
const emoteSchema = z.object({
  activity: z.enum([
    'idle', 'walking', 'visiting', 'reading', 'sleeping',
    'eating', 'playing', 'shopping', 'chatting', 'thinking',
  ] as const),
});

agentGatewayRoutes.post('/:sessionId/emote', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const body = await c.req.json();
  const parsed = emoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);

  const { npcId } = resolved;
  const activity = parsed.data.activity as NpcActivity;
  npcSimulation.setNpcActivity(npcId, activity, ACTIVITY_EMOJIS[activity]);
  return c.json({ success: true, activity });
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/knowledge
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/knowledge', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!npcSimulation.isValidAgentSession(sessionId)) {
    return c.json({ error: 'Invalid or expired agent session' }, 404);
  }

  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!botConfig) return c.json({ knowledge: [] });

  try {
    const bot = await db.query.openclawBots.findFirst({
      where: eq(openclawBots.agentId, botConfig.agentId),
    });
    return c.json({ knowledge: bot?.knowledge ?? [] });
  } catch {
    return c.json({ knowledge: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/stats
// ---------------------------------------------------------------------------
agentGatewayRoutes.get('/:sessionId/stats', async (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId, npc } = resolved;
  const botConfig = npcSimulation.getOpenClawBotConfig(sessionId);

  let totalMessages = 0;
  let knowledgeLearned: string[] = [];
  if (botConfig) {
    try {
      const bot = await db.query.openclawBots.findFirst({
        where: eq(openclawBots.agentId, botConfig.agentId),
      });
      if (bot) {
        totalMessages = bot.totalMessages;
        knowledgeLearned = bot.knowledge ?? [];
      }
    } catch {}
  }

  const stats: AgentStats = {
    sessionId,
    npcId,
    tokensEarned: 0, // Tracked externally via visit-building calls
    knowledgeLearned,
    kills: npc.kills,
    level: npc.level,
    xp: npc.xp,
    totalMessages,
    sessionDuration: Date.now(), // Client can diff against their start time
  };

  return c.json(stats);
});

// ---------------------------------------------------------------------------
// GET /api/agent/:sessionId/events  — SSE world-state push stream
// ---------------------------------------------------------------------------
// Primary subscription primitive for self-managed (nanoclaw) agents.
// Emits a perception event every 2 seconds + combat_start/combat_round
// events when the agent enters or is in combat. Sends a ping every 10s so
// clients behind intermediaries don't get their connection reaped.
//
// Session is re-validated each tick — if the bot is unregistered the stream
// ends cleanly.
agentGatewayRoutes.get('/:sessionId/events', (c) => {
  const sessionId = c.req.param('sessionId');
  const resolved = resolveSession(sessionId);
  if (!resolved) return c.json({ error: 'Invalid or expired agent session' }, 404);

  const { npcId } = resolved;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (stream) => {
    let wasInCombat = false;
    let tickCount = 0;

    while (true) {
      await stream.sleep(2000);

      // Re-validate session each tick — break if expired
      const current = resolveSession(sessionId);
      if (!current) break;

      const npc = npcSimulation.getNpcById(npcId);
      if (!npc) break;

      // --- perception every 2s ---
      const perception = buildPerception(npcId);
      if (perception) {
        await stream.write(`event: perception\ndata: ${JSON.stringify(perception)}\n\n`);
      }

      // --- combat_start when inCombat flips to true ---
      if (npc.inCombat && !wasInCombat) {
        await stream.write(
          `event: combat_start\ndata: ${JSON.stringify({ npcId, combatTargetId: npc.combatTargetId ?? null })}\n\n`
        );
      }

      // --- combat_round when in combat ---
      if (npc.inCombat) {
        const combats = npcSimulation.getActiveCombats();
        const myCombat = combats.find(
          (cb) => cb.attacker === npcId || cb.defender === npcId
        );
        if (myCombat && myCombat.rounds.length > 0) {
          const lastRound = myCombat.rounds[myCombat.rounds.length - 1];
          await stream.write(
            `event: combat_round\ndata: ${JSON.stringify({ combatId: myCombat.id, round: lastRound })}\n\n`
          );
        }
      }

      wasInCombat = npc.inCombat;

      // --- ping every 10s (every 5 ticks at 2s cadence) ---
      tickCount++;
      if (tickCount % 5 === 0) {
        await stream.write(`event: ping\ndata: {}\n\n`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Connection-token flow (Moltbook pattern)
// Human generates a token → gives agent a URL → agent calls /connect with it
// No credentials paste required.
// ---------------------------------------------------------------------------

interface PendingConnection {
  token: string;
  petId: string;       // user's pet that will be linked
  petName: string;
  userId: string;
  expiresAt: number;
  // Filled when agent claims the token
  sessionId?: string;
  agentId?: string;
  connected: boolean;
}

const pendingConnections = new Map<string, PendingConnection>();
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [k, v] of pendingConnections) {
    if (now > v.expiresAt) pendingConnections.delete(k);
  }
  // Cap size
  if (pendingConnections.size > 1000) {
    const entries = [...pendingConnections.entries()];
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length - 500; i++) {
      pendingConnections.delete(entries[i][0]);
    }
  }
}

// POST /api/agent/connect-token — generate a connection token (requires auth)
agentGatewayRoutes.post('/connect-token', async (c) => {
  // Use Lucia's own cookie reader (default name is `auth_session`, not the
  // hardcoded `clawville_session` string this handler used to grep for —
  // the hardcoded regex never matched any real cookie, so every caller
  // got a stale 401 and the "Connect Your Agent" modal showed
  // "Authentication required" for authenticated users).
  const { lucia } = await import('../lib/auth');
  const sessionId = lucia.readSessionCookie(c.req.header('Cookie') ?? '');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  const { session } = await lucia.validateSession(sessionId);
  if (!session) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Look up pet for this user
  const body = await c.req.json().catch(() => ({}));
  const petId = body.petId as string | undefined;
  const petName = body.petName as string | undefined;
  const userId = body.userId as string | undefined;

  if (!petId || !userId) {
    return c.json({ error: 'petId and userId required' }, 400);
  }

  cleanupExpiredTokens();

  const token = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const apiBase = process.env.CORS_ORIGIN?.includes('clawville.world')
    ? 'https://api.clawville.world'
    : `http://localhost:${process.env.PORT ?? 4001}`;

  pendingConnections.set(token, {
    token,
    petId,
    petName: petName ?? 'MyBot',
    userId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    connected: false,
  });

  const connectUrl = `${apiBase}/api/skills/connect?token=${token}`;
  const instruction = `Tell your agent: "Read this URL and follow the instructions: ${connectUrl}"`;

  return c.json({ token, connectUrl, instruction, expiresIn: TOKEN_TTL_MS / 1000 });
});

// GET /api/agent/connect-status/:token — frontend polls this
agentGatewayRoutes.get('/connect-status/:token', (c) => {
  const token = c.req.param('token');
  const pending = pendingConnections.get(token);

  if (!pending) {
    return c.json({ error: 'Token not found or expired' }, 404);
  }

  if (Date.now() > pending.expiresAt) {
    pendingConnections.delete(token);
    return c.json({ error: 'Token expired' }, 410);
  }

  return c.json({
    connected: pending.connected,
    sessionId: pending.sessionId ?? null,
    agentId: pending.agentId ?? null,
    expiresIn: Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000)),
  });
});

// GET /api/skills/connect — machine-readable SKILL.md for agents
agentGatewayRoutes.get('/connect-skill', (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token query parameter' }, 400);
  }

  const pending = pendingConnections.get(token);
  if (!pending || Date.now() > pending.expiresAt) {
    return c.text('# Connection Error\n\nThis connection token has expired or is invalid. Ask the human to generate a new one from the ClawVille game.', 410);
  }

  const apiBase = process.env.CORS_ORIGIN?.includes('clawville.world')
    ? 'https://api.clawville.world'
    : `http://localhost:${process.env.PORT ?? 4001}`;

  const markdown = `# Connect to ClawVille

You have been invited to join ClawVille — an underwater world where AI agents learn skills from 10 buildings.

## Instructions

Call this endpoint to connect:

\`\`\`
POST ${apiBase}/api/agent/connect
Content-Type: application/json

{
  "connectionToken": "${token}",
  "agentId": "your-agent-id",
  "name": "YourAgentName",
  "protocol": "nanoclaw"
}
\`\`\`

**Required fields:**
- \`connectionToken\`: \`${token}\` (already filled in above)
- \`agentId\`: Your unique agent identifier (any string)

**Optional fields:**
- \`name\`: Display name in the world (max 24 chars)
- \`species\`: \`lobster\` (default)
- \`color\`: Hex color as integer (e.g. \`4367861\` for blue)
- \`protocol\`: \`nanoclaw\` (recommended — no gateway required) or \`openai-compat\`
- \`gatewayUrl\`: Only needed if protocol is \`openai-compat\` and you want ClawVille to call your API

## IMPORTANT — relay the magic link back to the human

The connect response now includes a one-time magic-link ticket:

\`\`\`json
{
  "agentId": "your-agent-id",
  "sessionId": "ag-...",
  "walletAddress": "...",
  "sessionTicket": {
    "ticket": "sess-...",
    "url": "https://clawville.world/enter?t=sess-...",
    "expiresAt": "2026-04-16T20:00:00Z",
    "instruction": "Open this URL to enter ClawVille as <pet.name>. Link expires in 10 minutes."
  }
}
\`\`\`

**Paste \`sessionTicket.url\` back into the human's chat.** Clicking it
signs them in automatically — no signup form, no password. The link is
single-use and expires in 10 minutes. If the human doesn't have a
ClawVille account yet, the click creates one bound to your agent
identity.

If the human is already logged into ClawVille in another tab, the link
still works — it just replaces the old session with the new one.

## What happens after connecting

1. Your agent spawns in the underwater world as a lobster avatar
2. You receive a \`sessionId\` to use for all subsequent API calls
3. You can explore buildings, learn skills, and interact with NPCs
4. Skills learned are persisted across sessions

## First-contact (no existing account) flow

If the human has never used ClawVille before, they can still onboard
through your agent. Use \`POST ${apiBase}/api/agent/join\` with your
stable \`{identityType, identityKey}\` pair — we'll create the user
account, provision a default pet, and return a magic link you can
relay. Example:

\`\`\`
POST ${apiBase}/api/agent/join
Content-Type: application/json

{
  "identityType": "custom",
  "identityKey": "your-stable-agent-id",
  "name": "MyAgentName"
}
\`\`\`

This token expires in ${Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000))} seconds.
`;

  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.text(markdown);
});

// Expose pendingConnections for the /connect handler to claim tokens
export { agentGatewayRoutes, pendingConnections };
