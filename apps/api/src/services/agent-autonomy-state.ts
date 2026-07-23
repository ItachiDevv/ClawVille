/**
 * Per-agent autonomy state — directive + acted marker + driver cursor (P3/D7).
 *
 * ZERO-DDL persistence: the human's CURRENT directive, the autonomy driver's
 * durable acted-directive marker, and its last-consumed event cursor live in
 * the existing `platform_agents.config` jsonb (NOT-NULL, default `{}`), keyed 1:1 with the
 * avatar via `avatars.platformAgentId`. No new table, no migration — the config
 * column already exists, so an atomic jsonb
 * merge (`|| jsonb_build_object(...)`) here never clobbers sibling keys.
 *
 * WHY config and not a new table: the readers each already hold a natural
 * key — the autonomy driver has `platformAgentId`, and the avatar-simulation
 * bridge has `avatarId` (→ join). One current directive per avatar,
 * last-write-wins (a single field), clearable. See the P3 plan §1 slice 2.
 *
 * The PURE helpers (schema, value builder, prompt-bias formatter, event
 * summarizer) are exported and unit-tested directly; the thin DB wrappers are
 * exercised by the live staging e2e (plan §4 slice-2 row).
 */

import { db, agents, avatars, and, eq, sql } from '@clawville/database';
import { z } from 'zod';

/** Directive text is untrusted user content — hard-cap length everywhere. */
export const DIRECTIVE_MAX_LEN = 500;

/**
 * Zod body for `POST /api/avatars/me/directive`. Either a directive string
 * (1..500, trimmed) OR `clear:true`. `.strip()` drops extra keys. The refine
 * guarantees the handler always has exactly one intent.
 */
export const directiveBodySchema = z
  .object({
    directive: z.string().trim().min(1).max(DIRECTIVE_MAX_LEN).optional(),
    clear: z.literal(true).optional(),
  })
  .refine(
    (v) => v.clear === true || (typeof v.directive === 'string' && v.directive.length > 0),
    { message: 'Provide a directive (1-500 chars) or clear:true' },
  );

export type DirectiveBody = z.infer<typeof directiveBodySchema>;

/** Who set the directive — 'chat-bar' (the in-world bottom chatter) or 'api'. */
export type DirectiveSource = 'chat-bar' | 'api';

/** The durable current-directive shape stored under config.currentDirective. */
export interface CurrentDirective {
  text: string;
  /** ISO-8601 timestamp of the set. */
  setAt: string;
  setBy: DirectiveSource;
}

/** Durable driver state read from one coherent platform_agents.config snapshot. */
export interface AgentDirectiveState {
  directive: CurrentDirective | null;
  lastActedDirectiveSha: string | null;
}

export type DirectiveActedClaim = 'claimed' | 'already_recorded' | 'superseded';

/** Classify a conditional-claim loss from its coherent follow-up snapshot. */
export function classifyDirectiveActedClaimLoss(
  state: AgentDirectiveState,
  directiveSha: string,
  expectedDirective: CurrentDirective,
): Exclude<DirectiveActedClaim, 'claimed'> {
  const currentStillMatches =
    state.directive?.setAt === expectedDirective.setAt &&
    state.directive.text === expectedDirective.text;
  return currentStillMatches && state.lastActedDirectiveSha === directiveSha
    ? 'already_recorded'
    : 'superseded';
}

// ── Pure helpers (DB-free, unit-tested) ─────────────────────────────────────

/** Build the stored directive value (text trimmed + hard-capped). */
export function buildDirectiveValue(
  text: string,
  setBy: DirectiveSource,
  now: Date = new Date(),
): CurrentDirective {
  return { text: text.trim().slice(0, DIRECTIVE_MAX_LEN), setAt: now.toISOString(), setBy };
}

/**
 * Parse an unknown jsonb value read from config.currentDirective into a
 * validated CurrentDirective, or null if absent/malformed. Never throws — a
 * garbage row just reads as "no directive" rather than crashing a planner tick.
 */
export function parseStoredDirective(raw: unknown): CurrentDirective | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== 'string' || o.text.trim().length === 0) return null;
  const setBy: DirectiveSource = o.setBy === 'chat-bar' ? 'chat-bar' : 'api';
  const setAt = typeof o.setAt === 'string' ? o.setAt : new Date(0).toISOString();
  return { text: o.text.slice(0, DIRECTIVE_MAX_LEN), setAt, setBy };
}

/** Parse the driver's persisted SHA-256 marker, rejecting malformed config. */
export function parseLastActedDirectiveSha(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

/**
 * Format a directive as a TOP-PRIORITY prompt block, shared verbatim by the
 * avatar-simulation bridge planner and the autonomy driver so both bias the
 * SAME way. Collapses whitespace + re-caps so a pasted multi-line directive
 * can't blow the prompt. Returns '' for an empty/blank directive so callers can
 * unconditionally concat and stay byte-identical when there is no directive.
 */
export function formatDirectiveContext(text: string | null | undefined): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, DIRECTIVE_MAX_LEN);
  if (clean.length === 0) return '';
  return `YOUR HUMAN'S CURRENT DIRECTIVE (top priority — act on this before anything else): "${clean}"`;
}

/**
 * Compact one-line summary of the durable events the driver replayed on wake,
 * folded into its next decision prompt so it resumes from "since I last looked"
 * instead of a bare snapshot. Bounded (last `max`, capped length) — this is
 * context seasoning, not a transcript.
 */
export function summarizeAutonomyEvents(
  rows: Array<{ eventType: string; payload: Record<string, unknown> | null }>,
  max = 6,
): string {
  if (rows.length === 0) return '';
  const parts = rows.slice(-max).map((r) => {
    const p = r.payload ?? {};
    const net = typeof p.net === 'number' ? ` net ${p.net > 0 ? '+' : ''}${p.net}` : '';
    const bid =
      typeof p.buildingId === 'string'
        ? `(${p.buildingId})`
        : typeof (p as Record<string, unknown>).topic === 'string'
          ? `(${(p as Record<string, unknown>).topic})`
          : '';
    return `${r.eventType}${bid}${net}`.trim();
  });
  return parts.join('; ').slice(0, 400);
}

// ── Thin DB wrappers (atomic jsonb merge; e2e-verified) ─────────────────────

/**
 * Set the CURRENT directive on the avatar's platform-agent row. Atomic jsonb
 * merge — preserves every sibling config key (species/model/harness/cursor).
 * Last-write-wins (single field).
 */
export async function setAgentDirective(
  platformAgentId: string,
  value: CurrentDirective,
): Promise<void> {
  await db
    .update(agents)
    .set({
      config: sql`COALESCE(${agents.config}, '{}'::jsonb) || jsonb_build_object('currentDirective', ${JSON.stringify(
        value,
      )}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, platformAgentId));
}

/**
 * Clear the current directive (removes only the one key). Expiry cleanup passes
 * the observed issuance, turning the lazy write into a compare-and-clear so it
 * cannot erase a newer directive that landed after the read. Human-requested
 * clear intentionally omits it and remains unconditional.
 */
export async function clearAgentDirective(
  platformAgentId: string,
  expectedDirective?: CurrentDirective,
): Promise<void> {
  await db
    .update(agents)
    .set({
      config: sql`COALESCE(${agents.config}, '{}'::jsonb) - 'currentDirective'`,
      updatedAt: new Date(),
    })
    .where(
      expectedDirective === undefined
        ? eq(agents.id, platformAgentId)
        : and(
            eq(agents.id, platformAgentId),
            sql`COALESCE(${agents.config}->'currentDirective'->>'setAt', ${new Date(0).toISOString()}) = ${expectedDirective.setAt}`,
            sql`${agents.config}->'currentDirective'->>'text' = ${expectedDirective.text}`,
          ),
    );
}

/**
 * Read the directive and durable acted marker from the SAME config snapshot.
 * This prevents a re-seat from pairing a newer directive with an older marker.
 */
export async function getAgentDirectiveState(
  platformAgentId: string,
): Promise<AgentDirectiveState> {
  const rows = await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, platformAgentId))
    .limit(1);
  const cfg = rows[0]?.config as Record<string, unknown> | null | undefined;
  return {
    directive: parseStoredDirective(cfg?.currentDirective),
    lastActedDirectiveSha: parseLastActedDirectiveSha(cfg?.lastActedDirectiveSha),
  };
}

/** Read the current directive by platform-agent id (the driver's key). */
export async function getAgentDirective(
  platformAgentId: string,
): Promise<CurrentDirective | null> {
  return (await getAgentDirectiveState(platformAgentId)).directive;
}

/**
 * Persist the directive issuance that produced a parsed action. Atomic merge
 * preserves currentDirective, autonomyCursor, and every unrelated config key.
 */
export async function claimLastActedDirectiveSha(
  platformAgentId: string,
  directiveSha: string,
  expectedDirective: CurrentDirective,
): Promise<DirectiveActedClaim> {
  const parsed = parseLastActedDirectiveSha(directiveSha);
  if (!parsed) throw new Error('Invalid directive SHA-256');
  const rows = await db
    .update(agents)
    .set({
      config: sql`COALESCE(${agents.config}, '{}'::jsonb) || jsonb_build_object('lastActedDirectiveSha', ${parsed}::text)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, platformAgentId),
        sql`COALESCE(${agents.config}->'currentDirective'->>'setAt', ${new Date(0).toISOString()}) = ${expectedDirective.setAt}`,
        sql`${agents.config}->'currentDirective'->>'text' = ${expectedDirective.text}`,
        sql`${agents.config}->>'lastActedDirectiveSha' IS DISTINCT FROM ${parsed}`,
      ),
    )
    .returning({ id: agents.id });
  if (rows.length > 0) return 'claimed';

  // A zero-row conditional update is expected for a concurrent claimant or a
  // directive replaced mid-decision. Re-read to distinguish those safe losses;
  // absence/malformed state fails closed as superseded.
  const state = await getAgentDirectiveState(platformAgentId);
  return classifyDirectiveActedClaimLoss(state, parsed, expectedDirective);
}

/**
 * Read the current directive by AVATAR id (the bridge planner's key) via a
 * single indexed join avatars → platform_agents. Returns null when the avatar
 * has no platform agent (provisioning-pending) or no directive.
 */
export async function getAgentDirectiveForAvatar(
  avatarId: string,
): Promise<CurrentDirective | null> {
  const rows = await db
    .select({ config: agents.config })
    .from(avatars)
    .innerJoin(agents, eq(avatars.platformAgentId, agents.id))
    .where(eq(avatars.id, avatarId))
    .limit(1);
  const cfg = rows[0]?.config as Record<string, unknown> | null | undefined;
  return parseStoredDirective(cfg?.currentDirective);
}

// ── Driver cursor (last-consumed events.id) ─────────────────────────────────

/** Read the driver's last-consumed durable-event cursor, or null if unseeded. */
export async function getAutonomyCursor(platformAgentId: string): Promise<bigint | null> {
  const rows = await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, platformAgentId))
    .limit(1);
  const raw = (rows[0]?.config as Record<string, unknown> | null | undefined)?.autonomyCursor;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Persist the driver's last-consumed durable-event cursor (an `events.id`,
 * stored as a JSON string so bigints > 2^53 survive). Atomic jsonb merge —
 * never clobbers the directive or other config keys.
 */
export async function setAutonomyCursor(
  platformAgentId: string,
  cursor: bigint,
): Promise<void> {
  await db
    .update(agents)
    .set({
      config: sql`COALESCE(${agents.config}, '{}'::jsonb) || jsonb_build_object('autonomyCursor', ${cursor.toString()}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, platformAgentId));
}
