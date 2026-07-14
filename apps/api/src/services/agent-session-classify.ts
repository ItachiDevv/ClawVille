/**
 * PURE classification of `GET /api/auth/me/agent-session`'s HOT branches
 * (2026-07-08, §B.2 hosted-label fix). Extracted from `routes/auth.ts` so the
 * mode-label decision — the session-classification surface the frontend reads to
 * decide "hosted vs external/BYO vs pending" — is unit-testable WITHOUT a DB, a
 * Lucia session, or the route graph.
 *
 * Covers every branch that resolves BEFORE the cold provisioning-pending
 * fall-through. That final branch is deliberately NOT in here: it needs a lazy
 * `users.is_guest` DB read that the route only pays on the cold path (hot branches
 * pay nothing — see the note in auth.ts), so this classifier returns a
 * `cold-fallthrough` sentinel and the route does the guest read + pending/none.
 *
 * THE BUG THIS CLOSES: a hosted signup avatar-agent's OWN internal tool-surface
 * session (§B.2, `hosted-avatar-agent-session.ts`) writes an `openclaw_bots` row
 * keyed to the user. Without the hosted short-circuit below, that row matched the
 * external/BYO reporting and flipped the label from 'hosted' (pre-mint, correct)
 * to 'external-active' the moment the user went Autonomous — misrepresenting the
 * user's own hosted agent as a BYO/external connection. The row is un-spoofably
 * identifiable within the user's own account: its `agentId` IS the user's
 * avatar-agent's `platform_agents.id` (`avatars.platformAgentId` — a UUID we
 * generate, which a BYO/external connect never carries), and the avatar's harness
 * is ClawVille-hosted. GENUINE BYO rows are byte-identical to before.
 */

import { HOSTED_AVATAR_IDENTITY_TYPE } from './hosted-avatar-agent-session-plan';

/** ClawVille-hosted signup harnesses. 'custom' stays OUT — not signup-selectable;
 *  a custom row without a live bot must not read "hosted". */
export const HOSTED_HARNESSES = new Set(['milady', 'hermes', 'openclaw']);

/**
 * The canonical "hosted" response body. A hosted avatar-agent reports this at ALL
 * times — its cognition runtime is always alive server-side — whether or not it
 * currently holds a §B.2 tool-surface bearer session. Shared by BOTH the bot-row
 * short-circuit (a minted hosted session) AND the no-bot hosted-harness branch so
 * the two hosted returns can NEVER drift (fix 30352e60's shape is preserved).
 */
export function hostedAgentSessionResponse(
  platformAgentId: string,
  harness: string | null,
) {
  return {
    connected: true,
    mode: 'hosted',
    agentId: platformAgentId,
    harness,
    expiresAt: null,
    lastSeenAt: null,
  } as const;
}

export interface AgentSessionBotInput {
  agentId: string;
  lastSeenAt: Date;
  sessionExpiresAt: Date | null;
  identityType: string | null;
}

export interface AgentSessionAvatarInput {
  platformAgentId: string | null;
  harness: string | null;
  flags: { agentBannerDismissed?: boolean } | null;
}

export type AgentSessionClassification =
  | { kind: 'response'; body: Record<string, unknown> }
  /** No hot branch matched — the route does the lazy `is_guest` read then decides
   *  provisioning-pending vs none. */
  | { kind: 'cold-fallthrough' };

/**
 * TRUE iff a bot row is the user's OWN hosted avatar-agent internal session (§B.2).
 * THREE conjuncts, all required (the founder's stated marker):
 *   1. the row's `agentId` equals the user's avatar-agent's `platform_agents.id`
 *      (`avatars.platformAgentId` — a UUID WE generate);
 *   2. the row's `identityType` is exactly what the §B.2 mint writes
 *      (`HOSTED_AVATAR_IDENTITY_TYPE` = 'nanoclaw'); AND
 *   3. the avatar's harness is ClawVille-hosted (HOSTED_HARNESSES).
 *
 * Conjunct 2 was added after a Codex adversarial pass (2026-07-08): `agentId` is
 * caller-supplied at `POST /api/agent/connect` and `identityType` is a public enum
 * that INCLUDES 'nanoclaw', so a HARNESS-only + agentId-match discriminator could
 * mislabel a same-user BYO agent (one that deliberately connected with
 * `agentId == its owner's platformAgentId` and a non-nanoclaw identity) as
 * 'hosted' AND mask its dead/expired state. Requiring identityType 'nanoclaw'
 * closes the realistic gap: a BYO agent connecting as openclaw/hermes/milady/
 * custom/hatcher no longer matches. (Cross-user is already impossible — the
 * `/me/agent-session` bot query is keyed by the AUTHED user's own id; the sole
 * residual is a user maximally self-spoofing all three conjuncts of their OWN
 * account label, which carries zero security/economy impact and points at their
 * own hosted avatar-agent id anyway.)
 */
export function isHostedAvatarAgentSessionRow(
  bot: Pick<AgentSessionBotInput, 'agentId' | 'identityType'>,
  avatar: AgentSessionAvatarInput | null,
): boolean {
  return (
    !!avatar?.platformAgentId &&
    bot.agentId === avatar.platformAgentId &&
    bot.identityType === HOSTED_AVATAR_IDENTITY_TYPE &&
    HOSTED_HARNESSES.has(avatar.harness ?? '')
  );
}

/**
 * Classify the hot branches of `/me/agent-session`. Behavior-preserving extraction
 * of `routes/auth.ts` lines (bot-row → dismissed → hosted-harness), with the NEW
 * hosted short-circuit at the top of the bot branch. Returns `cold-fallthrough`
 * when no hot branch matches (route then does the guest read).
 */
export function classifyAgentSessionHot(input: {
  bot: AgentSessionBotInput | null;
  avatar: AgentSessionAvatarInput | null;
  now: number;
  externalActiveWindowMs: number;
}): AgentSessionClassification {
  const { bot, avatar, now, externalActiveWindowMs } = input;

  if (bot) {
    // §B.2 hosted short-circuit — a hosted avatar-agent's own minted session
    // reports 'hosted' regardless of the tool-surface session's TTL/idle/expiry
    // (that session is the tool credential, NOT the cognition runtime, which is
    // always alive server-side). Genuine BYO rows fall through to the byte-
    // identical external logic below.
    if (isHostedAvatarAgentSessionRow(bot, avatar)) {
      return {
        kind: 'response',
        body: hostedAgentSessionResponse(avatar!.platformAgentId!, avatar!.harness ?? null),
      };
    }

    const lastSeenMs = bot.lastSeenAt.getTime();
    const expired =
      bot.sessionExpiresAt !== null && bot.sessionExpiresAt.getTime() <= now;
    const idle = now - lastSeenMs > externalActiveWindowMs;

    if (expired) {
      // EXPIRED external row + HOSTED avatar ⇒ report 'hosted', not
      // 'external-expired' (2026-07-14, founder report). A hosted signup
      // avatar's cognition runtime is ALWAYS alive server-side; a long-dead
      // BYO/external credential (e.g. a prewarm/test connect from days ago)
      // is not the account's durable truth, and letting it shadow the hosted
      // classification made the UI demand "Connect Your Agent" from accounts
      // that are connected by definition. A LIVE or merely-idle external
      // session still wins below — the user deliberately connected it and
      // its state is actionable. Genuinely-external accounts (non-hosted
      // harness / no platformAgentId) keep the external-expired label.
      if (
        avatar?.platformAgentId &&
        HOSTED_HARNESSES.has(avatar.harness ?? '')
      ) {
        return {
          kind: 'response',
          body: hostedAgentSessionResponse(avatar.platformAgentId, avatar.harness ?? null),
        };
      }
      // Same principle for a NOT-YET-PROVISIONED avatar (platformAgentId null
      // — agent rows don't exist, e.g. a legacy pre-P2 account): the dead
      // credential must not shadow the provisioning-pending classification
      // either. Fall through to the route's cold path (lazy is_guest read →
      // 'provisioning-pending' for an authed non-guest, 'none' otherwise).
      // Avatars WITH agent rows but a non-hosted harness keep the
      // external-expired label below — the reconnect hint is their truth.
      if (avatar && !avatar.platformAgentId) {
        return { kind: 'cold-fallthrough' };
      }
      return {
        kind: 'response',
        body: {
          connected: false,
          reason: 'expired',
          mode: 'external-expired',
          agentId: bot.agentId,
          lastSeenAt: bot.lastSeenAt.toISOString(),
          expiresAt: bot.sessionExpiresAt!.toISOString(),
        },
      };
    }

    if (idle) {
      return {
        kind: 'response',
        body: {
          connected: false,
          reason: 'idle',
          mode: 'external-idle',
          agentId: bot.agentId,
          lastSeenAt: bot.lastSeenAt.toISOString(),
          idleSinceMs: now - lastSeenMs,
          canReconnect: true,
        },
      };
    }

    return {
      kind: 'response',
      body: {
        connected: true,
        mode: 'external-active',
        agentId: bot.agentId,
        harness: avatar?.harness ?? bot.identityType ?? null,
        expiresAt: bot.sessionExpiresAt?.toISOString() ?? null,
        lastSeenAt: bot.lastSeenAt.toISOString(),
      },
    };
  }

  // No external bot — dismissal flag suppresses the banner (server runtime is
  // always alive; purely a UI preference).
  const flags = avatar?.flags ?? {};
  if (flags.agentBannerDismissed === true) {
    return {
      kind: 'response',
      body: {
        connected: false,
        reason: 'dismissed',
        mode: 'dismissed',
        harness: avatar?.harness ?? null,
      },
    };
  }

  // No-bot hosted-harness carve-out (pre-mint hosted case; fix 30352e60).
  if (avatar && HOSTED_HARNESSES.has(avatar.harness ?? '') && avatar.platformAgentId) {
    return {
      kind: 'response',
      body: hostedAgentSessionResponse(avatar.platformAgentId, avatar.harness ?? null),
    };
  }

  return { kind: 'cold-fallthrough' };
}
