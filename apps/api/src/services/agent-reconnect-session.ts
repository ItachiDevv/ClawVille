/**
 * /reconnect agent-session mint planner (P0 gate fix, 2026-07-03).
 *
 * THE BUG THIS CLOSES (found live by scripts/agent-connect/restart-survival-proof.ts):
 * the protocol manual + the P0 design promise that a NON-restorable agent
 * (real-gateway identity types openclaw/ironclaw/custom, whose outbound
 * `auth_token` is never persisted) recovers after an API restart via
 * GET /api/agent/challenge → POST /api/agent/reconnect, receiving a FRESH
 * `sessionId` and its body back. The actual handler verified the ed25519
 * signature and refreshed the row TTL but minted ONLY the human magic-link
 * `sessionTicket` — no agent bearer, no body. Real-gateway agents had no
 * self-recovery path at all.
 *
 * THIS MODULE is the PURE decision half of the fix: given the surviving
 * `openclaw_bots` row, the proven userId (the ed25519 signature was already
 * verified by the route), the freshly-drawn sessionId, and the OPTIONAL
 * re-supplied gateway credentials, it decides
 *   (a) whether a session may be minted at all,
 *   (b) the exact in-world `AgentSubstrateRegistration` config (via the SHARED
 *       mint/restore builders in agent-session-config.ts — the D1 anti-drift
 *       pattern), and
 *   (c) what must be persisted back onto the row (the new bearer's
 *       `session_key_hash` — rebinding it INVALIDATES the old bearer, both for
 *       lazy restore (hash no longer matches) and for a still-in-RAM stale
 *       session (validateLiveAgentSession tears down a present-and-mismatched
 *       hash) — plus the caller-supplied gatewayUrl/protocol like /connect).
 *
 * DELIBERATELY DEPENDENCY-LIGHT (no DB, no sim, no route imports — importing
 * `routes/agent-gateway.ts` at module load throws without FINGERPRINT_SECRET),
 * so the ledger/dormancy/credential rules are unit-testable without the route
 * graph's env requirements (same pattern as agent-owner-binding.ts).
 *
 * THE THREE RULES (docs/agent-metaverse-p0-v2-refound.md + agent-metaverse-model.md):
 *   1. PROOF-CARRYING LEDGER: reconnect IS a proof-carrying flow (unlike lazy
 *      restore, which is always non-ledger). `ledgerCapable` is true IFF the
 *      row is BOUND to the proven user (`bot.userId === provenUserId`), the
 *      exact rule /connect uses via boundUserId.
 *   2. PREFER DORMANT OVER BROKEN (L1): a real-gateway type reconnecting
 *      WITHOUT credentials gets a DORMANT-INERT session — the fail-soft
 *      'nanoclaw' wire (its `.chat()` returns '' with no network call), so the
 *      agent can perceive/move/act/play but has no outbound chat until it
 *      reconnects WITH credentials. NEVER a broken `http://localhost:0` client.
 *   3. PARTNER ROWS ARE OFF-LIMITS: a reserved partner identity type (hatcher)
 *      is never minted here — hatcher sessions are partner-signed AND fully
 *      restorable from the row, so they never need this path. Refusing keeps
 *      /reconnect off the protected partner surface (no hatcher wire change).
 *
 * ONE-BODY ASSERTION (why re-register can never duplicate): an avatar body's
 * in-world id is the DETERMINISTIC `ocb-<base64url(agentId)>` (npc-simulation
 * `avatarBodyId`), and `registerAgentBot` does `npcs.set(bodyId, …)` +
 * `npcOverrides.set(bodyId, sessionId)` — a Map SET, which REPLACES. The route
 * additionally evicts every prior in-RAM session for the agentId before
 * registering (their bearers are invalidated by the hash rebind anyway), which
 * also releases an override-mode NPC seat so the re-register can't throw
 * OverrideTargetUnavailable against our own stale session.
 */

import { z } from 'zod';
import type { AgentWireProtocol, AgentSubstrateRegistration } from '@clawville/shared';
import {
  buildAvatarSessionConfig,
  buildOverrideSessionConfig,
  isRowRestorableFromIdentity,
} from './agent-session-config';
import { isReservedPartnerIdentityType } from './reserved-agent-namespaces';
import { sha256Hex } from './session-digest';

/**
 * The dummy gateway placeholder the mint paths persist for no-gateway agents.
 * A row carrying this (or null) has NO real outbound gateway to rebuild.
 */
const DUMMY_GATEWAY_URL = 'http://localhost:0';

/**
 * Gateway-credential zod field trio — the EXACT shapes `connectSchema`
 * (agent-gateway.ts) uses for the same three fields. Exported so BOTH
 * `connectSchema` and `reconnectSchema` spread this one object and can never
 * drift ("validated exactly like /connect" is structural, not a mirror).
 */
export const gatewayCredentialZodFields = {
  gatewayUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  protocol: z
    .enum(['openai-compat', 'anthropic', 'custom-webhook', 'nanoclaw'])
    .optional(),
} as const;

/** The optional re-supplied credentials, post-zod. */
export interface ReconnectGatewayCredentials {
  gatewayUrl?: string;
  authToken?: string;
  protocol?: 'openai-compat' | 'anthropic' | 'custom-webhook' | 'nanoclaw';
}

/**
 * Structural projection of the `openclaw_bots` row fields the planner needs.
 * Structural (not `$inferSelect`) so tests stay DB-free; the drizzle row
 * satisfies it as-is.
 */
export interface ReconnectBotRow {
  agentId: string;
  identityType: string;
  protocol: string | null;
  gatewayUrl: string | null;
  userId: string | null;
  mode: string | null;
  name: string | null;
  species: string | null;
  color: number | null;
  targetNpcId: string | null;
  metadata: {
    personality?: string;
    homeX?: number;
    homeY?: number;
    patrolRadius?: number;
    stats?: { hp: number; attack: number; defense: number; speed: number };
    lastX?: number;
    lastY?: number;
  } | null;
}

export type ReconnectSessionPlan =
  | {
      mint: false;
      /**
       * - `reserved_partner_type`: partner-owned row (hatcher) — never minted
       *   through the public reconnect (rule 3 above). The route falls back to
       *   today's ticket-only response (TTL still refreshed, hash untouched).
       * - `override_missing_target`: an override-mode row with no targetNpcId
       *   can't be re-seated (same degrade as restore).
       */
      reason: 'reserved_partner_type' | 'override_missing_target';
    }
  | {
      mint: true;
      /** The in-world registration for `npcSimulation.registerAgentBot`. */
      config: AgentSubstrateRegistration;
      /**
       * True when a real-gateway type was minted WITHOUT credentials — the
       * session is inert-dormant (fail-soft 'nanoclaw' wire, no outbound chat)
       * until the agent reconnects with `{gatewayUrl, authToken, protocol}`.
       */
      dormant: boolean;
      /** Proof-carrying rule: `bot.userId === provenUserId` (both non-null). */
      ledgerCapable: boolean;
      /** Last in-world position (row metadata) so the body respawns in place. */
      restoredState?: { lastX: number; lastY: number };
      /** Fields the route persists on the row in the SAME update as the TTL. */
      persist: {
        /**
         * sha256 of the NEW bearer. Writing it is what invalidates the old
         * bearer: lazy restore matches rows by this hash, and a still-in-RAM
         * stale session is torn down by validateLiveAgentSession's
         * present-and-mismatched-hash check.
         */
        sessionKeyHash: string;
        /** Persisted only when the caller re-supplied it (mirrors /connect). */
        gatewayUrl?: string;
        /** Persisted only when the caller re-supplied it (mirrors /connect). */
        protocol?: AgentWireProtocol;
      };
    };

const DEFAULT_STATS = { hp: 100, attack: 10, defense: 8, speed: 6 } as const;

/** True when the row carries a REAL (non-null, non-dummy) outbound gateway. */
function rowHasRealGateway(bot: ReconnectBotRow): boolean {
  return !!bot.gatewayUrl && bot.gatewayUrl !== DUMMY_GATEWAY_URL;
}

/**
 * Decide the session-mint for a signed-challenge /reconnect. PURE — the caller
 * (the route) already verified the signature, consumed the nonce, and located
 * the row; it executes the returned plan (DB persist → stale-session evict →
 * registerAgentBot) and surfaces `sessionId`/`expiresAt`/`dormant` on the
 * response.
 */
export function planReconnectSession(input: {
  bot: ReconnectBotRow;
  /** The userId whose ed25519 identity signature the route verified. */
  provenUserId: string;
  /** The freshly-drawn `ag-…` bearer this plan is keyed to. */
  sessionId: string;
  /** Bound active avatar already resolved by the authenticated route. */
  avatarId?: string;
  credentials?: ReconnectGatewayCredentials;
}): ReconnectSessionPlan {
  const { bot, provenUserId, sessionId } = input;
  const credentials = input.credentials ?? {};

  // Rule 3 — partner-owned rows are never minted through the public reconnect.
  if (isReservedPartnerIdentityType(bot.identityType)) {
    return { mint: false, reason: 'reserved_partner_type' };
  }

  const mode = bot.mode === 'override' ? 'override' : 'avatar';
  if (mode === 'override' && !bot.targetNpcId) {
    return { mint: false, reason: 'override_missing_target' };
  }

  // Rule 1 — proof-carrying ledger: this flow proved control of the identity
  // key for `provenUserId`; the session is ledger-capable IFF the row is bound
  // to exactly that user. (The route looks the row up BY userId, so this holds
  // by construction — asserted here so the rule survives a future lookup change.)
  const ledgerCapable = bot.userId !== null && bot.userId === provenUserId;
  const boundUserId = bot.userId ?? null;

  // Credential resolution. A real-gateway identity type (openclaw/ironclaw/
  // custom — NOT isRowRestorableFromIdentity) can only get a WORKING outbound
  // client when we have a REAL gateway URL to point it at: either re-supplied
  // now, or persisted on the row (in which case a re-supplied authToken alone
  // is enough to re-arm it). Anything less → rule 2, DORMANT-INERT.
  const isRealGatewayType = !isRowRestorableFromIdentity(bot.identityType);
  const effectiveGatewayUrl = credentials.gatewayUrl
    ?? (rowHasRealGateway(bot) ? bot.gatewayUrl! : null);
  const credentialsSupplied = !!(
    credentials.gatewayUrl || credentials.authToken || credentials.protocol
  );
  const canRebuildOutbound = credentialsSupplied && effectiveGatewayUrl !== null;
  const dormant = isRealGatewayType && !canRebuildOutbound;

  const meta = bot.metadata ?? {};
  const stats = meta.stats ?? { ...DEFAULT_STATS };
  const storedProtocol = credentials.protocol ?? bot.protocol;

  const base = {
    agentId: bot.agentId,
    sessionId,
    identityType: bot.identityType,
    storedProtocol,
    // Dormant bodies carry the row's gatewayUrl for fidelity but NEVER POST to
    // it (the 'nanoclaw' override below is fail-soft, no network). No-gateway
    // identity types ignore it entirely (builder derives their protocol from
    // identityType — the D1 rule).
    gatewayUrl: effectiveGatewayUrl ?? bot.gatewayUrl,
    // The outbound bearer to the agent's OWN gateway — request-scoped only,
    // NEVER persisted (that non-persistence is exactly why real-gateway types
    // are non-restorable and need this proof-carrying path).
    authToken: dormant ? '' : credentials.authToken ?? '',
    // autonomyMode deliberately OMITTED — same derivation as restore's
    // non-hatcher branch: resolveAutonomyMode handles nanoclaw/hermes →
    // self-managed; everything else server-managed.
    ledgerCapable,
    boundUserId,
    avatarId: input.avatarId,
    // Rule 2 — the dormant-inert wire. 'nanoclaw' `.chat()` returns '' with no
    // network call, so a credential-less real-gateway body is mute-but-alive
    // (never a broken localhost:0 POST). Non-dormant configs derive normally.
    ...(dormant ? { protocolOverride: 'nanoclaw' as AgentWireProtocol } : {}),
  };

  const config: AgentSubstrateRegistration =
    mode === 'override'
      ? buildOverrideSessionConfig({
          ...base,
          mode: 'override',
          targetNpcId: bot.targetNpcId!,
        })
      : buildAvatarSessionConfig({
          ...base,
          mode: 'avatar',
          name: bot.name ?? bot.agentId.slice(0, 24),
          species: bot.species,
          color: bot.color,
          stats,
          // Non-hatcher agents live in the legacy space — same 2560 default as
          // /connect + restore's non-hatcher branch.
          homeX: meta.homeX ?? 2560,
          homeY: meta.homeY ?? 2560,
          patrolRadius: meta.patrolRadius ?? 100,
          personality: meta.personality ?? '',
        });

  return {
    mint: true,
    config,
    dormant,
    ledgerCapable,
    restoredState:
      meta.lastX != null && meta.lastY != null
        ? { lastX: meta.lastX, lastY: meta.lastY }
        : undefined,
    persist: {
      sessionKeyHash: sha256Hex(sessionId),
      // Mirror /connect's returning-row persistence: gatewayUrl only when the
      // caller supplied one; protocol only when the caller supplied one.
      ...(credentials.gatewayUrl ? { gatewayUrl: credentials.gatewayUrl } : {}),
      ...(credentials.protocol ? { protocol: credentials.protocol } : {}),
    },
  };
}
