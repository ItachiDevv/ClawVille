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
 * TRUE iff a bot row is the user's OWN hosted avatar-agent internal session (§B.2):
 * the row's `agentId` equals the user's avatar-agent's `platform_agents.id`
 * (`avatars.platformAgentId`) AND the avatar's harness is ClawVille-hosted. This is
 * the un-spoofable discriminator that separates a minted hosted session from a
 * genuine BYO/external `openclaw_bots` row.
 */
export function isHostedAvatarAgentSessionRow(
  bot: Pick<AgentSessionBotInput, 'agentId'>,
  avatar: AgentSessionAvatarInput | null,
): boolean {
  return (
    !!avatar?.platformAgentId &&
    bot.agentId === avatar.platformAgentId &&
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
