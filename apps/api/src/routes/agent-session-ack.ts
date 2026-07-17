import { Hono } from 'hono';
import { z } from 'zod';
import {
  db,
  agentBots,
  buildingSkills,
  eq,
  type AgentBotAck,
} from '@clawville/database';
import { SHOP_BUILDINGS } from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  PROTOCOL_VERSION,
  normalizeContentHash,
  protocolContentHash,
  resolveApiBase,
} from '../services/skill-protocol';
import type { AppContext } from '../types';

const contentHashSchema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/i);

export const agentSkillAckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('protocol-manual'),
    buildingId: z.string().optional(),
    version: z.number().int().positive().optional(),
    contentHash: contentHashSchema,
  }).strict(),
  z.object({
    kind: z.literal('building-skill'),
    buildingId: z.string().min(1).max(64),
    version: z.number().int().positive().optional(),
    contentHash: contentHashSchema,
  }).strict(),
]);

export type AgentSkillAckInput = z.infer<typeof agentSkillAckSchema>;
export type AgentSkillAckLatest = { version: number; contentHash: string };
export type AgentSkillAckMutation =
  | { kind: 'protocol-manual'; latest: AgentSkillAckLatest; at: string }
  | { kind: 'building-skill'; buildingId: string; latest: AgentSkillAckLatest; at: string };

export class AgentSkillAckRevalidationError extends Error {
  constructor(public readonly latest: AgentSkillAckLatest | null) {
    super('stale_or_unknown_hash');
    this.name = 'AgentSkillAckRevalidationError';
  }
}

const agentSkillAckRateLimit = createRateLimiter({
  maxPerWindow: 30,
  windowMs: 60_000,
});

/** Test seam only; production never clears a connected agent's ACK budget. */
export function resetAgentSkillAckRateLimit(): void {
  agentSkillAckRateLimit.reset();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge one valid ACK without clobbering the manual or sibling skills. Unknown
 * skill keys are dropped and the result is bounded by the ten canonical shops.
 */
export function mergeAgentBotAck(
  existing: AgentBotAck | null | undefined,
  mutation: AgentSkillAckMutation,
): AgentBotAck {
  const source = isRecord(existing) ? existing : {};
  const sourceSkills = isRecord(source.skills) ? source.skills : {};
  const skills: NonNullable<AgentBotAck['skills']> = {};
  for (const buildingId of SHOP_BUILDINGS) {
    const entry = sourceSkills[buildingId];
    if (
      isRecord(entry) &&
      typeof entry.contentHash === 'string' &&
      typeof entry.at === 'string'
    ) {
      skills[buildingId] = {
        contentHash: entry.contentHash,
        at: entry.at,
      };
    }
  }

  const next: AgentBotAck = { skills };
  if (
    isRecord(source.manual) &&
    typeof source.manual.version === 'number' &&
    typeof source.manual.contentHash === 'string' &&
    typeof source.manual.at === 'string'
  ) {
    next.manual = {
      version: source.manual.version,
      contentHash: source.manual.contentHash,
      at: source.manual.at,
    };
  }

  if (mutation.kind === 'protocol-manual') {
    next.manual = { ...mutation.latest, at: mutation.at };
  } else {
    next.skills![mutation.buildingId] = {
      contentHash: mutation.latest.contentHash,
      at: mutation.at,
    };
  }
  return next;
}

async function persistAgentSkillAck(
  agentId: string,
  mutation: AgentSkillAckMutation,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock + revalidate the building row in the SAME transaction as the bot ACK
    // merge. A concurrent skill regeneration can otherwise change content_hash
    // after the preflight read and make a stale digest look current.
    if (mutation.kind === 'building-skill') {
      const [skill] = await tx
        .select({
          generatorVersion: buildingSkills.generatorVersion,
          contentHash: buildingSkills.contentHash,
        })
        .from(buildingSkills)
        .where(eq(buildingSkills.buildingId, mutation.buildingId))
        .for('update')
        .limit(1);
      const lockedHash = skill
        ? normalizeContentHash(skill.contentHash ?? '')
        : null;
      const lockedLatest = skill && lockedHash
        ? { version: skill.generatorVersion, contentHash: lockedHash }
        : null;
      if (
        !lockedLatest ||
        lockedLatest.version !== mutation.latest.version ||
        lockedLatest.contentHash !== mutation.latest.contentHash
      ) {
        throw new AgentSkillAckRevalidationError(lockedLatest);
      }
    }

    const [locked] = await tx
      .select({ ack: agentBots.ack })
      .from(agentBots)
      .where(eq(agentBots.agentId, agentId))
      .for('update')
      .limit(1);
    if (!locked) throw new Error('live_agent_row_missing');

    await tx
      .update(agentBots)
      .set({
        ack: mergeAgentBotAck(locked.ack, mutation),
        updatedAt: new Date(),
      })
      .where(eq(agentBots.agentId, agentId));
  });
}

type AgentSkillAckDependencies = {
  allowSubject?: (subjectKey: string) => boolean;
  loadBuildingSkill?: (buildingId: string) => Promise<{
    generatorVersion: number;
    contentHash: string | null;
  } | null>;
  persist?: (agentId: string, mutation: AgentSkillAckMutation) => Promise<void>;
  apiBase?: string;
  now?: () => Date;
};

export async function executeAgentSkillAck(
  identity: ActivityIdentity,
  input: AgentSkillAckInput,
  dependencies: AgentSkillAckDependencies = {},
): Promise<{
  status: 200 | 400 | 403 | 429;
  body: Record<string, unknown>;
}> {
  if (identity.kind !== 'agent') {
    return {
      status: 403,
      body: { error: 'agent_session_required' },
    };
  }
  // Ownership-proven sessions only (2026-06-03 model): a bare-agentId reconnect
  // proves liveness, not ownership (`ledgerCapable: false`), and could otherwise
  // ack VALID current hashes on a victim agent's behalf — spoofing that agent's
  // ackState to "current" and hiding real ingestion drift. ACK v1 is
  // informational, but the drift data must stay trustworthy and v2 enforcement
  // must not inherit a spoofable input. IdentityKey connects are ledgerCapable,
  // so every legitimately self-connecting BYO agent passes this gate.
  if (!identity.ledgerCapable) {
    return {
      status: 403,
      body: { error: 'proven_agent_session_required' },
    };
  }

  const allowSubject = dependencies.allowSubject ??
    ((key: string) => agentSkillAckRateLimit.check(key));
  if (!allowSubject(`agent-skill-ack:${identity.agentId}`)) {
    return {
      status: 429,
      body: { error: 'rate_limited' },
    };
  }

  const suppliedHash = normalizeContentHash(input.contentHash);
  let latest: AgentSkillAckLatest | null = null;
  if (input.kind === 'protocol-manual') {
    latest = {
      version: PROTOCOL_VERSION,
      contentHash: protocolContentHash(dependencies.apiBase ?? resolveApiBase()),
    };
    if (
      suppliedHash !== latest.contentHash ||
      (input.version !== undefined && input.version !== latest.version)
    ) {
      return {
        status: 400,
        body: { error: 'stale_or_unknown_hash', latest },
      };
    }
  } else {
    if (!SHOP_BUILDINGS.includes(input.buildingId as (typeof SHOP_BUILDINGS)[number])) {
      return {
        status: 400,
        body: { error: 'stale_or_unknown_hash', latest: null },
      };
    }
    const row = await (dependencies.loadBuildingSkill ?? (async (buildingId) =>
      (await db.query.buildingSkills.findFirst({
        where: eq(buildingSkills.buildingId, buildingId),
        columns: {
          generatorVersion: true,
          contentHash: true,
        },
      })) ?? null))(input.buildingId);
    const currentContentHash = row ? normalizeContentHash(row.contentHash ?? '') : null;
    if (row && currentContentHash) {
      latest = {
        version: row.generatorVersion,
        contentHash: currentContentHash,
      };
    }
    if (!latest || suppliedHash !== latest.contentHash) {
      return {
        status: 400,
        body: { error: 'stale_or_unknown_hash', latest },
      };
    }
  }

  const mutation: AgentSkillAckMutation = input.kind === 'protocol-manual'
    ? {
        kind: 'protocol-manual',
        latest,
        at: (dependencies.now?.() ?? new Date()).toISOString(),
      }
    : {
        kind: 'building-skill',
        buildingId: input.buildingId,
        latest,
        at: (dependencies.now?.() ?? new Date()).toISOString(),
      };
  try {
    await (dependencies.persist ?? persistAgentSkillAck)(identity.agentId, mutation);
  } catch (error) {
    if (error instanceof AgentSkillAckRevalidationError) {
      return {
        status: 400,
        body: { error: 'stale_or_unknown_hash', latest: error.latest },
      };
    }
    throw error;
  }
  return { status: 200, body: { current: true, latest } };
}

export const agentSessionAckRoutes = new Hono<AppContext>();

agentSessionAckRoutes.post(
  '/ack',
  sessionMiddleware,
  requireAuthOrAgentSession,
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = agentSkillAckSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const result = await executeAgentSkillAck(c.get('identity'), parsed.data);
    return c.json(result.body, result.status);
  },
);
