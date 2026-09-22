import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db, avatars, avatarInventory } from '@clawville/database';
import { characterRoomId } from '@clawville/agent-runtime';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { isGuestUser } from '../middleware/require-non-guest';
import { agentOrchestrator } from './agent-orchestrator';
import { getSystemAgent } from './system-npc-seeder';
import { systemAgentRewardLimiter } from './system-agent-reward-limiter';
import { creditClawTokens } from './claw-token-ledger';
import { awardXp } from './xp-service';
import { logEvent } from './event-logger';
import { recordEarnedSkillLesson } from './earned-skill-memory';
import { moderateText, CONTENT_BLOCKED_MESSAGE, OUTPUT_REFUSAL_MESSAGE } from './moderation-service';

export type SystemChatActor =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; sessionId: string; expectedAgentId?: string; expectedAvatarId?: string };

/** Shared by the HTTP chat and the hosted action. Never interprets reply actions. */
export async function conductSystemAgentChat(input: {
  actor: SystemChatActor;
  slug: string;
  content: string;
  fpHash?: string | null;
  ipPrefixHash?: string | null;
  /** Hosted actions fence a replaced/despawned body across cognition awaits. */
  isCurrent?: () => boolean;
}) {
  const resolveActor = async () => {
    if (input.isCurrent && !input.isCurrent()) throw new HTTPException(403, { message: 'Agent body changed during Nori chat' });
    if (input.actor.kind === 'human') {
      return { userId: input.actor.userId, avatarId: null, agentId: null };
    }
    const resolved = await resolveAgentSession(input.actor.sessionId);
    if (input.isCurrent && !input.isCurrent()) throw new HTTPException(403, { message: 'Agent body changed during Nori chat' });
    if (!resolved) throw new HTTPException(401, { message: 'Invalid or expired agent session' });
    if (!resolved.ledgerCapable || !resolved.userId || !resolved.avatarId ||
        (input.actor.expectedAgentId && resolved.agentId !== input.actor.expectedAgentId) ||
        (input.actor.expectedAvatarId && resolved.avatarId !== input.actor.expectedAvatarId)) {
      throw new HTTPException(403, { message: 'Nori chat requires a ledger-authorized bound agent avatar' });
    }
    return { userId: resolved.userId, avatarId: resolved.avatarId, agentId: resolved.agentId };
  };
  const subject = await resolveActor();
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, subject.userId), eq(avatars.isActive, true),
      ...(subject.avatarId ? [eq(avatars.id, subject.avatarId)] : [])),
  });
  const canonicalGuest = await isGuestUser(subject.userId);
  if (input.actor.kind === 'agent' && (!avatar || avatar.id !== subject.avatarId || canonicalGuest)) {
    throw new HTTPException(403, { message: 'Nori chat requires a non-guest bound active avatar' });
  }
  if (!input.content.trim() || input.content.length > 4000) {
    throw new HTTPException(400, { message: 'Message must be 1-4000 characters' });
  }
  const inMod = await moderateText(input.content, { surface: 'system-chat', direction: 'input' });
  if (!inMod.allowed) throw new HTTPException(400, { message: CONTENT_BLOCKED_MESSAGE });
  const agent = await getSystemAgent(input.slug);
  if (!agent) throw new HTTPException(503, { message: `System agent '${input.slug}' not seeded yet — try again in a moment` });
  const runtime = await agentOrchestrator.ensureAgentRuntime(agent.platformAgent.id, agent.systemUserId);
  if (!runtime) throw new HTTPException(500, { message: 'Failed to start system agent runtime' });
  const state: Record<string, unknown> = {
    avatarId: avatar?.id,
    platformAgentId: agent.platformAgent.id,
    userId: subject.userId,
    // Nori is orientation-only for humans and agents. Eliza executes reply
    // actions only when services exists; never grant her DB/ledger capability.
    avatarData: avatar ?? null,
    nearLocation: input.slug,
    characterConfig: avatar?.characterConfig ?? {},
  };
  if (avatar) {
    try { state.inventory = await db.query.avatarInventory.findMany({ where: eq(avatarInventory.avatarId, avatar.id) }); }
    catch { /* Inventory is optional context. */ }
  }
  const response = await runtime.processMessage(input.content, {
    userId: subject.userId,
    roomId: characterRoomId(input.slug, subject.userId),
    platform: 'clawville', state, conversational: true,
  });
  // Cognition can outlive a bearer or a rebind. Re-resolve before rewards,
  // memory, or attribution; never attach the old turn to a replacement owner.
  const outMod = await moderateText(response.content, { surface: 'system-chat', direction: 'output' });
  const current = await resolveActor();
  if (current.userId !== subject.userId || current.avatarId !== subject.avatarId || current.agentId !== subject.agentId) {
    throw new HTTPException(403, { message: 'Agent binding changed during Nori chat' });
  }
  const content = outMod.allowed
    ? response.content.replace(/\[ACTION:[^\]]*\]/gi, '').trim()
    : OUTPUT_REFUSAL_MESSAGE;
  let tokenAwarded: 0 | 1 = 0;
  // Humans may lose an active avatar while cognition runs too. Keep their
  // chat response, but never reward a removed/deactivated avatar or new guest.
  const rewardAvatar = avatar ? await db.query.avatars.findFirst({
    where: and(eq(avatars.id, avatar.id), eq(avatars.userId, subject.userId), eq(avatars.isActive, true)),
  }) : null;
  const rewardGuest = await isGuestUser(subject.userId);
  const beforeReward = await resolveActor();
  if (beforeReward.userId !== subject.userId || beforeReward.avatarId !== subject.avatarId || beforeReward.agentId !== subject.agentId ||
      (input.actor.kind === 'agent' && (!rewardAvatar || rewardAvatar.id !== subject.avatarId || rewardGuest))) {
    throw new HTTPException(403, { message: 'Agent binding changed before Nori reward' });
  }
  if (rewardAvatar && !rewardGuest && systemAgentRewardLimiter.tryConsume(subject.userId, input.slug)) {
    try {
      await creditClawTokens({ avatarId: rewardAvatar.id, amount: 1, reason: 'system_agent_chat',
        source: 'api', metadata: { slug: input.slug }, actorKind: input.actor.kind });
      tokenAwarded = 1;
      void awardXp(rewardAvatar.id, 5, 'npc-chat').catch(() => console.error('[chat/system] XP award failed'));
    } catch { console.error('[chat/system] credit failed'); }
  }
  void logEvent({ eventType: 'agent.chat.turn', userId: subject.userId,
    avatarId: avatar?.id ?? null, agentId: subject.agentId, buildingId: null,
    fpHash: input.fpHash, ipPrefixHash: input.ipPrefixHash,
    payload: { chatType: 'system-agent', agentSlug: input.slug,
      messageLength: input.content.length, tokenAwarded },
  });
  if (input.actor.kind === 'agent' && rewardAvatar && outMod.allowed) {
    // A durable reward already belongs to the original subject. Revocation
    // can suppress later memory, but must not erase that event or replay credit.
    const beforeMemory = await resolveActor().catch(() => null);
    if (beforeMemory?.userId === subject.userId && beforeMemory.avatarId === subject.avatarId && beforeMemory.agentId === subject.agentId) {
      await recordEarnedSkillLesson({
        platformAgentId: rewardAvatar.platformAgentId ?? '', avatarId: rewardAvatar.id,
        agentId: subject.agentId!, buildingId: input.slug, teacherName: 'Nori',
        lesson: `Nori told me: ${content}`,
      });
    }
  }
  return { message: { role: 'assistant' as const, content, timestamp: response.timestamp.toISOString() } };
}
