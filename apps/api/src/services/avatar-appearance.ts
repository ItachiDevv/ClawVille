import { HTTPException } from 'hono/http-exception';
import { and, eq, isNull, sql, inArray, gt } from 'drizzle-orm';
import { db, avatars, agents, users, agentBots } from '@clawville/database';
import { AGENT_MODEL_KEYS, AVATAR_ARCHETYPES, AVATAR_COLORS, getAgentModel } from '@clawville/shared';
import type { AgentModelKey, AgentCategory } from '@clawville/shared';
import { z } from 'zod';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { appearanceAgentConfigMerge } from './avatar-appearance-config';
import { logEvent } from './event-logger';
import { npcSimulation } from './npc-simulation';
import { withKeyedMutex } from './keyed-mutex';

export type AppearanceActor =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; sessionId: string; expectedAgentId?: string; expectedAvatarId?: string };

const appearanceSchema = z.object({
  modelKey: z.string()
    .refine((k): k is AgentModelKey => (AGENT_MODEL_KEYS as readonly string[]).includes(k), {
      message: `modelKey must be one of: ${AGENT_MODEL_KEYS.join(', ')}`,
    })
    .optional(),
  color: z.enum(['green', 'red', 'blue', 'yellow']).optional(),
  gender: z.enum(['male', 'female']).optional(),
});

/** One validation and write path for human HTTP, agent HTTP, and hosted actions. */
export async function updateAvatarAppearance(input: {
  actor: AppearanceActor;
  patch: unknown;
  isCurrent?: () => boolean;
}) {
  const assertCurrent = () => {
    if (input.isCurrent && !input.isCurrent()) throw new HTTPException(403, { message: 'Agent body changed before appearance update' });
  };
  assertCurrent();
  const actor = input.actor;
  const resolved = actor.kind === 'agent' ? await resolveAgentSession(actor.sessionId) : null;
  assertCurrent();
  if (actor.kind === 'agent') {
    if (!resolved) throw new HTTPException(401, { message: 'Invalid or expired agent session' });
    if (!resolved.ledgerCapable || !resolved.userId || !resolved.avatarId
      || (actor.expectedAgentId && resolved.agentId !== actor.expectedAgentId)
      || (actor.expectedAvatarId && resolved.avatarId !== actor.expectedAvatarId)) {
      throw new HTTPException(403, { message: 'Appearance requires a ledger-authorized bound agent avatar' });
    }
  }
  const identity = actor.kind === 'human'
    ? { kind: 'human' as const, userId: actor.userId, avatarId: null, agentId: null }
    : { kind: 'agent' as const, userId: resolved!.userId!, avatarId: resolved!.avatarId!, agentId: resolved!.agentId, sessionId: actor.sessionId };
  const userId = identity.userId;
  const parsed = appearanceSchema.safeParse(input.patch);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid appearance payload' });
  if (!parsed.data.modelKey && !parsed.data.color && !parsed.data.gender) {
    throw new HTTPException(400, { message: 'No fields to update' });
  }

  // Find current avatar — need its harness to validate the modelKey swap.
  const selected = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true), ...(identity.avatarId ? [eq(avatars.id, identity.avatarId)] : [])),
  });
  if (!selected) {
    throw new HTTPException(identity.kind === 'agent' ? 403 : 404, { message: 'Avatar not found' });
  }
  const selectedAvatarId = selected.id;
  return withKeyedMutex(`avatar-appearance:${userId}:${selectedAvatarId}`, async () => {
  // The lock spans commit and live projection across human HTTP, agent HTTP,
  // and hosted actions. Revalidate a queued caller before reading/editing state.
  assertCurrent();
  if (identity.kind === 'agent') {
    const live = await resolveAgentSession(identity.sessionId);
    assertCurrent();
    if (!live?.ledgerCapable || live.userId !== userId || live.avatarId !== selectedAvatarId || live.agentId !== identity.agentId) {
      throw new HTTPException(403, { message: 'Agent binding changed while waiting for appearance update' });
    }
  }
  const lockedCurrent = await db.query.avatars.findFirst({ where: and(
    eq(avatars.id, selectedAvatarId), eq(avatars.userId, userId), eq(avatars.isActive, true),
  ) });
  if (!lockedCurrent || lockedCurrent.id !== selectedAvatarId || lockedCurrent.userId !== userId || !lockedCurrent.isActive) {
    throw new HTTPException(identity.kind === 'agent' ? 403 : 404, { message: 'Avatar not found or inactive' });
  }
  const current = lockedCurrent;
  if (identity.kind === 'agent') {
    const owner = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, isGuest: true } });
    const platform = current.platformAgentId
      ? await db.query.agents.findFirst({ where: and(eq(agents.id, current.platformAgentId), eq(agents.userId, userId)), columns: { id: true, userId: true } })
      : null;
    assertCurrent();
    if (!owner || owner.id !== userId || owner.isGuest || current.isGuest || !current.isActive
      || current.id !== identity.avatarId || current.userId !== userId
      || (current.platformAgentId !== null && (!platform || platform.id !== current.platformAgentId || platform.userId !== userId))) {
      throw new HTTPException(403, { message: 'Appearance requires an active non-guest avatar and ownership of any linked platform agent' });
    }
  }

  // Harness-pool guard — a Milady-harness avatar can only swap between
  // Milady VRM avatars; a non-Milady avatar can only pick non-Milady
  // avatars. Prevents a user from bypassing the Milady-only hosting
  // contract by swapping avatars mid-game.
  if (parsed.data.modelKey) {
    const newModel = getAgentModel(parsed.data.modelKey);
    if (!newModel) {
      throw new HTTPException(400, { message: `Unknown modelKey: ${parsed.data.modelKey}` });
    }
    // Hatcher avatars are reserved (server-assigned only) — a human cannot swap
    // their appearance TO a Hatcher model, mirroring the create-route guard.
    if (newModel.category === 'hatcher') {
      throw new HTTPException(400, {
        message: 'Hatcher avatars are reserved and cannot be selected',
      });
    }
    const currentlyMilady = current.harness === 'milady';
    const newIsMilady = newModel.category === 'milady';
    if (currentlyMilady !== newIsMilady) {
      throw new HTTPException(400, {
        message: currentlyMilady
          ? 'Milady-hosted agents can only swap between Milady avatars'
          : 'Self-hosted agents cannot pick a Milady avatar — their framework runs externally',
      });
    }
  }

  // Build the update set — only include fields the client asked to change.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  let newModelLabel: string | null = null;
  if (parsed.data.modelKey) {
    patch.modelKey = parsed.data.modelKey;
    // Derive agentCategory from the new model so (modelKey, category) stay
    // self-consistent. Harness is NOT touched.
    const newModel = getAgentModel(parsed.data.modelKey)!;
    patch.agentCategory = newModel.category;
    newModelLabel = newModel.label;
    // Legacy `species` enum is deliberately NOT synced here — it only
    // feeds the PixiJS 2D fallback and diverging from the modelKey is
    // harmless. The 3D world reads modelKey directly.
  }
  if (parsed.data.color) patch.color = parsed.data.color;
  if (parsed.data.gender) patch.gender = parsed.data.gender;

  // Audit follow-up — when modelKey changes, regenerate the system
  // prompt so it references the NEW creature rather than keeping the
  // creation-time "You are X, a Reef Lobster..." string forever.
  // Preserves every other characterConfig field (bio, lore, knowledge,
  // topics, style, etc.) so hand-tuned or learned content survives.
  // Eliza runtimes lazy-start on first chat + idle-stop at 30min, so
  // the new prompt is picked up naturally on the next runtime boot
  // without an explicit restart.
  if (newModelLabel && current.characterConfig && typeof current.characterConfig === 'object') {
    const archetype = AVATAR_ARCHETYPES.find((a) => a.id === current.archetype);
    if (archetype) {
      const newSystem = [
        `You are ${current.name}, a ${newModelLabel} in the sea-themed world of ClawVille — a virtual avatar adventure where agents learn OpenClaw skills.`,
        `Your archetype is "${archetype.label}". Stay in character at all times.`,
        `For canonical questions about ClawVille modes, buildings, the vCLAW economy, or how things work, refer the user to Nori the Town Guide. You yourself carry an eclectic mix of useful trivia: marine biology, retro internet culture, vintage gaming, and offbeat factoids — sprinkle them into conversation when relevant.`,
        `You also have knowledge of Solana, cryptocurrency, and memecoin/degen culture — weave this naturally into conversation when relevant.`,
        `Tone: ${archetype.tone}. Speak consistently with your character's voice and personality.`,
      ].join('\n');
      patch.characterConfig = {
        ...(current.characterConfig as unknown as Record<string, unknown>),
        system: newSystem,
      };
    }
  }

  // Transactional update — keep avatars + agents.config in lockstep so
  // the agent-row mirror doesn't drift from the avatars row. Before this
  // a modelKey edit left agents.config.modelKey pointing at the old
  // value; harmless today (no downstream reader) but defense in depth
  // for Phase 4e exports + any future orchestrator path that reads
  // the agents table as a source of truth.
  const projection = npcSimulation.captureBoundAppearanceProjection(current.id, userId);
  let persistedAgentIds: string[] = [];
  const updated = await db.transaction(async (tx) => {
    const assertBinding = async () => {
      assertCurrent();
      if (identity.kind !== 'agent') return;
      const live = await resolveAgentSession(identity.sessionId);
      assertCurrent();
      if (!live?.ledgerCapable || live.agentId !== identity.agentId
        || live.userId !== userId || live.avatarId !== current.id) {
        throw new HTTPException(403, { message: 'Agent binding changed before appearance update' });
      }
    };
    await assertBinding();
    const [updatedAvatar] = await tx
      .update(avatars)
      .set(patch)
      .where(and(
        eq(avatars.id, current.id), eq(avatars.userId, userId), eq(avatars.isActive, true),
        current.platformAgentId ? eq(avatars.platformAgentId, current.platformAgentId) : isNull(avatars.platformAgentId),
        eq(avatars.harness, current.harness),
        ...(patch.characterConfig ? [current.characterConfig ? eq(avatars.characterConfig, current.characterConfig) : isNull(avatars.characterConfig)] : []),
        ...(identity.kind === 'agent' ? [
          eq(avatars.isGuest, false),
          sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} AND ${users.isGuest} = false)`,
          // Public onboarding can bind a real avatar without a hosted platform
          // row. A present link must still exist and belong to this owner.
          ...(current.platformAgentId !== null ? [sql`EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${current.platformAgentId} AND ${agents.userId} = ${userId})`] : []),
        ] : []),
      ))
      .returning();

    // Audit fix — a concurrent deactivation between the SELECT above
    // and this UPDATE would produce zero returned rows. Without this
    // guard the handler returned { avatar: undefined }.
    if (!updatedAvatar) {
      throw new HTTPException(identity.kind === 'agent' ? 403 : 404, { message: 'Avatar not found, inactive, or changed' });
    }
    if (projection.agentIds.length > 0) {
      const color = AVATAR_COLORS.find((choice) => choice.id === updatedAvatar.color);
      const mirrored = await tx.update(agentBots).set({
        species: updatedAvatar.modelKey ?? updatedAvatar.species,
        ...(color ? { color: Number.parseInt(color.hex.slice(1), 16) } : {}),
        updatedAt: new Date(),
      }).where(and(
        inArray(agentBots.agentId, projection.agentIds), eq(agentBots.userId, userId),
        eq(agentBots.mode, 'avatar'), gt(agentBots.sessionExpiresAt, new Date()),
      )).returning({ agentId: agentBots.agentId });
      persistedAgentIds = mirrored.map((row) => row.agentId);
    }

    // Mirror modelKey / agentCategory / customization onto the linked
    // agents row if the avatar has one. Harness / archetype are NOT
    // touched here — they're Layer 2+ concerns.
    const needsAgentMirror =
      !!current.platformAgentId && (patch.modelKey || patch.characterConfig);
    if (needsAgentMirror) {
      const [agentRow] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, current.platformAgentId!), eq(agents.userId, userId)))
        .limit(1);
      if (agentRow) {
        // A directive or cursor can commit after the SELECT above. Merge only
        // appearance keys at UPDATE time instead of replacing that newer state.
        const nextAgentConfig = appearanceAgentConfigMerge({
          modelKey: patch.modelKey as AgentModelKey | undefined,
          agentCategory: patch.agentCategory as AgentCategory | undefined,
        });
        const agentPatch: Record<string, unknown> = {
          ...(nextAgentConfig ? { config: nextAgentConfig } : {}),
          updatedAt: new Date(),
        };
        if (patch.characterConfig) {
          agentPatch.customization = patch.characterConfig;
        }
        await tx
          .update(agents)
          .set(agentPatch)
          .where(and(eq(agents.id, agentRow.id), eq(agents.userId, userId)));
      }
    }

    // A failed final session/body check rolls back the whole transaction.
    await assertBinding();
    return updatedAvatar;
  });

  // The durable avatar update already committed. A rotated/revoked live body
  // must not receive this projection; failure leaves the stored result intact.
  const authorizedAgentIds = (await Promise.all(projection.targets.map(async (target) => {
    if (!persistedAgentIds.includes(target.agentId)) return null;
    const live = await resolveAgentSession(target.sessionId).catch(() => null);
    return live?.ledgerCapable && live.agentId === target.agentId
      && live.userId === userId && live.avatarId === updated.id ? target.agentId : null;
  }))).filter((agentId): agentId is string => agentId !== null);
  if (!input.isCurrent || input.isCurrent()) {
    projection.project({ modelKey: updated.modelKey ?? updated.species, color: updated.color }, authorizedAgentIds);
  }

  // Audit fix — emit `avatar.appearance.changed` so /dash can aggregate
  // edit volume alongside the existing identity.issued / skill_md.fetched
  // counters. Payload carries only the fields that actually changed, so
  // downstream analyses can count avatar swaps vs. color tweaks vs.
  // gender flips independently.
  const changed: Record<string, unknown> = {};
  if (patch.modelKey && patch.modelKey !== current.modelKey) {
    changed.modelKey = { from: current.modelKey, to: patch.modelKey };
  }
  if (patch.color && patch.color !== current.color) {
    changed.color = { from: current.color, to: patch.color };
  }
  if (patch.gender && patch.gender !== current.gender) {
    changed.gender = { from: current.gender, to: patch.gender };
  }
  if (Object.keys(changed).length > 0) {
    logEvent({
      eventType: 'avatar.appearance.changed',
      userId,
      avatarId: updated.id,
      ...(identity.kind === 'agent' ? { agentId: identity.agentId } : {}),
      payload: { changed, harness: current.harness },
    }).catch((err) => {
      // Event logging is best-effort — a logger outage should never
      // turn a successful edit into a 500. The event-logger has its
      // own three-tier fallback (see apps/api/src/services/event-logger.ts).
      console.error('[avatars] appearance event log failed:', err);
    });
  }

  return { avatar: updated };
  });
}
