/**
 * Per-agent autonomy state — directive + acted marker + driver cursor (P3/D7).
 *
 * ZERO-DDL persistence: the human's CURRENT directive, the autonomy driver's
 * durable acted-directive marker, its last-consumed event cursor, and the
 * agent's last questions per teacher (`priorTalkQuestions`, owner-scoped) live in
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

// -- Prior teacher questions (founder 2026-10-22: survive a restart) ----------
//
// Stored under config.priorTalkQuestions as
//   { "ownerUserId": string | null, "ownerSetAt": <epoch ms>,
//     "byBuilding": { "<buildingId>": string[] } }
// The driver keeps the in-memory copy authoritative; this store only lets the
// list survive an API restart / deploy. The owner tag scopes the list to the
// owner period: a row that moved to another owner reads as empty, and the first
// write under the new owner replaces the whole object. `ownerSetAt` is the
// driver's owner generation stamp (when it bound the agent to that owner): a
// delayed write from an OLDER owner generation never replaces a newer owner's
// object (see decidePriorTalkQuestionsWrite).

/** Prior questions kept per (agent, teacher) for the talk prompt. */
export const PRIOR_TALK_QUESTIONS_MAX = 4;
/** Per-question length cap. */
export const PRIOR_TALK_QUESTION_MAX_CHARS = 160;
/** Cap on stored teacher keys read back from one row. */
export const PRIOR_TALK_QUESTION_BUILDINGS_MAX = 16;
const PRIOR_TALK_BUILDING_ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Normalize a prior-question list (oldest first): each item has all whitespace
 * collapsed to single spaces, is trimmed and capped at
 * PRIOR_TALK_QUESTION_MAX_CHARS; empty items are dropped; a repeated item keeps
 * only its NEWEST position; the result keeps the last PRIOR_TALK_QUESTIONS_MAX.
 * Shared by the driver's in-memory recorder and the stored-value parser.
 */
export function normalizePriorTalkQuestions(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const question = raw.replace(/\s+/g, ' ').trim().slice(0, PRIOR_TALK_QUESTION_MAX_CHARS);
    if (!question) continue;
    const at = out.indexOf(question);
    if (at !== -1) out.splice(at, 1);
    out.push(question);
  }
  return out.slice(-PRIOR_TALK_QUESTIONS_MAX);
}

// Loose top-level shape: entries are validated one by one below so a single
// malformed list never discards the valid ones.
// ownerSetAt is accepted but not used for the read decision (owner match is the
// read rule); a missing or malformed stamp never discards an older object.
const storedPriorTalkQuestionsSchema = z.object({
  ownerUserId: z.string().nullable().optional(),
  ownerSetAt: z.number().finite().optional().catch(undefined),
  byBuilding: z.record(z.string(), z.unknown()),
});

/**
 * Parse config.priorTalkQuestions into buildingId -> normalized list. Never
 * throws. The WHOLE value is discarded (empty map) when it is malformed or its
 * ownerUserId differs from `expectedOwnerUserId` (a missing ownerUserId reads as
 * null, the same as `->>'ownerUserId'` in SQL; null equals null). Bad building
 * ids and non-string-array lists are dropped; at most
 * PRIOR_TALK_QUESTION_BUILDINGS_MAX keys are kept; empty lists are omitted.
 */
export function parseStoredPriorTalkQuestions(
  raw: unknown,
  expectedOwnerUserId: string | null,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const parsed = storedPriorTalkQuestionsSchema.safeParse(raw);
  if (!parsed.success) return result;
  if ((parsed.data.ownerUserId ?? null) !== expectedOwnerUserId) return result;
  for (const [buildingId, list] of Object.entries(parsed.data.byBuilding)) {
    if (result.size >= PRIOR_TALK_QUESTION_BUILDINGS_MAX) break;
    if (!PRIOR_TALK_BUILDING_ID_RE.test(buildingId)) continue;
    if (!Array.isArray(list) || !list.every((q) => typeof q === 'string')) continue;
    const questions = normalizePriorTalkQuestions(list as string[]);
    if (questions.length > 0) result.set(buildingId, questions);
  }
  return result;
}

/**
 * The stored value's owner as SQL `->>'ownerUserId'` sees it: NULL for a
 * missing or JSON-null value, the string itself, else its JSON text form
 * (owner ids are strings; the text form only matters for corrupt rows).
 */
function storedOwnerText(rawOwner: unknown): string | null {
  if (rawOwner === undefined || rawOwner === null) return null;
  return typeof rawOwner === 'string' ? rawOwner : JSON.stringify(rawOwner);
}

/** Stored owner tag + generation stamp, whoever owns the stored object. */
export interface StoredPriorTalkQuestionsOwnerStamp {
  /** False when the stored value is missing or not an object (no stamp to honor). */
  present: boolean;
  storedOwnerUserId: string | null;
  /** The stored ownerSetAt when it is a finite number, else null. */
  storedOwnerSetAt: number | null;
}

/**
 * PURE: read the stored owner and ownerSetAt even when the owner differs from
 * the reader (Codex r2 P2: the driver must never hold a smaller stamp than the
 * stored one, or the write CASE would skip its writes). Never throws.
 */
export function parseStoredPriorTalkQuestionsOwnerStamp(raw: unknown): StoredPriorTalkQuestionsOwnerStamp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { present: false, storedOwnerUserId: null, storedOwnerSetAt: null };
  }
  const o = raw as Record<string, unknown>;
  return {
    present: true,
    storedOwnerUserId: storedOwnerText(o.ownerUserId),
    storedOwnerSetAt:
      typeof o.ownerSetAt === 'number' && Number.isFinite(o.ownerSetAt) ? o.ownerSetAt : null,
  };
}

/** What the driver's restart hydrate reads in one row snapshot. */
export interface PriorTalkQuestionsSnapshot extends StoredPriorTalkQuestionsOwnerStamp {
  /** Questions for the READER's owner only (empty on an owner mismatch). */
  questions: Map<string, string[]>;
}

/**
 * Read the stored prior questions for this agent row under `ownerUserId`
 * (owner match is the read rule for questions), plus the stored owner tag and
 * stamp from the same snapshot, whoever owns it.
 */
export async function getPriorTalkQuestions(
  platformAgentId: string,
  ownerUserId: string | null,
): Promise<PriorTalkQuestionsSnapshot> {
  const rows = await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, platformAgentId))
    .limit(1);
  const cfg = rows[0]?.config as Record<string, unknown> | null | undefined;
  const raw = cfg?.priorTalkQuestions;
  return {
    questions: parseStoredPriorTalkQuestions(raw, ownerUserId),
    ...parseStoredPriorTalkQuestionsOwnerStamp(raw),
  };
}

export type PriorTalkQuestionsWriteDecision = 'merge' | 'replace' | 'skip';

/**
 * PURE mirror of the CASE in setPriorTalkQuestionsForBuilding (keep the two in
 * sync; the SQL is authoritative, this exists so the decision is unit-tested):
 *   1. stored is an object AND stored ownerUserId IS NOT DISTINCT FROM mine
 *      -> 'merge' (only this building's list changes; ownerSetAt becomes
 *      GREATEST(stored, mine) when the stored stamp is a number, else mine);
 *   2. stored is missing / not an object -> 'replace';
 *   3. stored ownerSetAt is missing / not a number -> 'replace';
 *   4. stored ownerSetAt < mine -> 'replace' (an older owner generation);
 *   5. else (another owner with a newer-or-equal stamp) -> 'skip' (no change).
 * `->>'ownerUserId'` yields NULL for a missing or JSON-null value and the text
 * form for any other value; this mirror follows that (owner ids are strings).
 */
export function decidePriorTalkQuestionsWrite(
  stored: unknown,
  ownerUserId: string | null,
  ownerSetAt: number,
): PriorTalkQuestionsWriteDecision {
  const isObject = typeof stored === 'object' && stored !== null && !Array.isArray(stored);
  if (!isObject) return 'replace';
  const o = stored as Record<string, unknown>;
  if (storedOwnerText(o.ownerUserId) === ownerUserId) return 'merge';
  if (typeof o.ownerSetAt !== 'number') return 'replace';
  if (o.ownerSetAt < ownerSetAt) return 'replace';
  return 'skip';
}

/**
 * Store one teacher's prior-question list. ONE atomic UPDATE (no app-side
 * read-modify-write), decided by the CASE mirrored in
 * decidePriorTalkQuestionsWrite: 'merge' changes only that building's list in
 * byBuilding (a non-object byBuilding is reset); 'replace' writes
 * `{ownerUserId, ownerSetAt, byBuilding: {buildingId: questions}}`; 'skip'
 * writes the stored value back unchanged, so a delayed write from an older
 * owner generation never replaces a newer owner's object. Sibling config keys
 * are preserved by the outer `||` in every branch. The list is normalized here
 * as well, so one write never stores more than PRIOR_TALK_QUESTIONS_MAX.
 * `ownerSetAt` is the driver's owner generation stamp (epoch ms, a safe
 * non-negative integer; anything else writes nothing). All values are bound
 * parameters.
 */
export async function setPriorTalkQuestionsForBuilding(
  platformAgentId: string,
  ownerUserId: string | null,
  buildingId: string,
  questions: readonly string[],
  ownerSetAt: number,
): Promise<void> {
  if (!PRIOR_TALK_BUILDING_ID_RE.test(buildingId)) return;
  if (!Number.isSafeInteger(ownerSetAt) || ownerSetAt < 0) return;
  const list = JSON.stringify(normalizePriorTalkQuestions(questions));
  const current = sql`COALESCE(${agents.config}, '{}'::jsonb)->'priorTalkQuestions'`;
  const replaced = sql`jsonb_build_object(
          'ownerUserId', ${ownerUserId}::text,
          'ownerSetAt', ${ownerSetAt}::bigint,
          'byBuilding', jsonb_build_object(${buildingId}::text, ${list}::jsonb)
        )`;
  // CASE order matters (PostgreSQL evaluates WHEN arms in order), so the
  // numeric cast in the 4th arm only runs on a JSON number. Keep in sync with
  // decidePriorTalkQuestionsWrite.
  await db
    .update(agents)
    .set({
      config: sql`COALESCE(${agents.config}, '{}'::jsonb) || jsonb_build_object('priorTalkQuestions', CASE
        WHEN jsonb_typeof(${current}) = 'object'
          AND (${current}->>'ownerUserId') IS NOT DISTINCT FROM ${ownerUserId}::text
        THEN jsonb_build_object(
          'ownerUserId', ${ownerUserId}::text,
          'ownerSetAt', CASE
            WHEN jsonb_typeof(${current}->'ownerSetAt') = 'number'
            THEN GREATEST((${current}->>'ownerSetAt')::numeric, ${ownerSetAt}::numeric)
            ELSE ${ownerSetAt}::numeric
          END,
          'byBuilding', COALESCE(
            CASE WHEN jsonb_typeof(${current}->'byBuilding') = 'object' THEN ${current}->'byBuilding' END,
            '{}'::jsonb
          ) || jsonb_build_object(${buildingId}::text, ${list}::jsonb)
        )
        WHEN jsonb_typeof(${current}) IS DISTINCT FROM 'object' THEN ${replaced}
        WHEN jsonb_typeof(${current}->'ownerSetAt') IS DISTINCT FROM 'number' THEN ${replaced}
        WHEN (${current}->>'ownerSetAt')::numeric < ${ownerSetAt}::numeric THEN ${replaced}
        ELSE ${current}
      END)`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, platformAgentId));
}
