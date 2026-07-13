/**
 * Covenant action recorder — the single write path into the covenant
 * action-record stream (`covenant_action_records`).
 *
 * Founder directive 2026-07-13: "the agents' actions should be managed with
 * covenants." Every economic agent-relevant action appends exactly one record
 * here, IN THE SAME TRANSACTION as the business write wherever one exists —
 * the record and the action commit or roll back TOGETHER. That atomicity is
 * the covenant guarantee: there is no action without a record and no record
 * without an action. (A recorder failure therefore fails the action — the
 * recorder is deliberately minimal, one parameterized insert, to keep that
 * failure surface near zero.)
 *
 * Records are inserted UNCHAINED (plain parallel inserts). The background
 * sealer (`covenant-chain-sealer.ts`) assigns the gapless hash chain
 * afterwards — chaining at write time would put a global serialization point
 * inside every money transaction (see the schema header for the full model).
 *
 * Producers (v1):
 *   - `claw-token-ledger.ts` credit/debit primitives → economy.credit/debit
 *   - quest lifecycle (routes + hosted native actions) → quest.*
 *   - bounty lifecycle (routes + composition worker + payai-release) → bounty.*
 *
 * Read surface: `routes/partner-covenant.ts` GET /actions (+ /actions/head).
 */

import { createHash } from 'crypto';
import { db, covenantActionRecords, eq } from '@clawville/database';
import type { LedgerTx } from './claw-token-ledger';

/** The namespaced action verbs the stream records (v1). */
export type CovenantAction =
  | 'economy.credit'
  | 'economy.debit'
  | 'quest.accept'
  | 'quest.submit'
  | 'quest.approve'
  | 'quest.reject'
  | 'bounty.create'
  | 'bounty.create_failed'
  | 'bounty.claim'
  | 'bounty.submit'
  | 'bounty.approve'
  | 'bounty.reject'
  | 'bounty.settle_requested'
  | 'bounty.settle'
  | 'bounty.refund';

/** Who performed the action, when the call site has a resolved identity. */
export type CovenantActorKind = 'human' | 'agent' | 'system' | 'admin';

export interface CovenantActionInput {
  action: CovenantAction;
  /** What the record is about. Almost always an avatar. */
  subjectType: 'avatar' | 'treasury' | 'system';
  subjectId: string;
  /** Pass ONLY when the call site resolved an identity — never guess. */
  actorKind?: CovenantActorKind | null;
  /** Action detail. Must be JSON-serializable; keys are canonicalized. */
  payload: Record<string, unknown>;
  /**
   * Business idempotency key for exactly-once actions whose external legs are
   * RETRYABLE (bounty settle/refund/create_failed — e.g. `bounty:<id>:settle`).
   * A retry's duplicate insert no-ops (partial unique index) instead of
   * appending a second immutable record (Codex round 1 HIGH #2). Omit for
   * ordinary records.
   */
  dedupeKey?: string;
}

/**
 * Canonical JSON: recursively sorted object keys, arrays in place, `undefined`
 * properties dropped (matching JSON.stringify semantics so the stored jsonb and
 * the hashed encoding can never disagree on content). Deterministic across
 * processes — the hash is reproducible from the stored payload by any verifier.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // JSON.stringify drops undefined props
      sorted[key] = sortValue(v);
    }
    return sorted;
  }
  return value;
}

/** sha256 hex of the canonical JSON encoding of `payload`. */
export function covenantPayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Append one record to the stream. Pass `tx` to make the record atomic with
 * the business write (REQUIRED on money paths); without `tx` the insert runs
 * standalone (acceptable only for call sites that have no transaction).
 *
 * The stored `payload` is the canonicalized (sorted-key, undefined-stripped)
 * object, so `payload_hash` is always recomputable from the row itself.
 */
export async function recordCovenantAction(
  input: CovenantActionInput,
  tx?: LedgerTx,
): Promise<{ id: string | null; deduped: boolean }> {
  const canonicalStr = canonicalJson(input.payload);
  const canonical = JSON.parse(canonicalStr) as Record<string, unknown>;
  const payloadHash = createHash('sha256').update(canonicalStr, 'utf8').digest('hex');

  const executor = tx ?? db;

  // Dedupe semantics (Codex round 2 HIGH #3): a collision may ONLY be treated
  // as a successful retry when the existing row is the SAME action — same
  // verb, subject, actor, payload hash. Anything else (a reused key with
  // different semantics, or any non-dedupe unique violation) must ABORT the
  // surrounding business transaction, never silently commit recordless.
  const verifyExistingMatches = async (): Promise<{ id: string; deduped: true }> => {
    const [existing] = await executor
      .select({
        id: covenantActionRecords.id,
        action: covenantActionRecords.action,
        subjectType: covenantActionRecords.subjectType,
        subjectId: covenantActionRecords.subjectId,
        actorKind: covenantActionRecords.actorKind,
        payloadHash: covenantActionRecords.payloadHash,
      })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.dedupeKey, input.dedupeKey!))
      .limit(1);
    if (
      !existing ||
      existing.action !== input.action ||
      existing.subjectType !== input.subjectType ||
      existing.subjectId !== input.subjectId ||
      (existing.actorKind ?? null) !== (input.actorKind ?? null) ||
      existing.payloadHash !== payloadHash
    ) {
      throw new Error(
        `covenant dedupe-key collision with DIFFERENT action identity (key=${input.dedupeKey}, ` +
          `action=${input.action}) — refusing to treat as a retry`,
      );
    }
    return { id: existing.id, deduped: true };
  };

  if (input.dedupeKey) {
    // Fast path: an earlier attempt already recorded this action.
    const [prior] = await executor
      .select({ id: covenantActionRecords.id })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.dedupeKey, input.dedupeKey))
      .limit(1);
    if (prior) return verifyExistingMatches();
  }

  try {
    const [row] = await executor
      .insert(covenantActionRecords)
      .values({
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        actorKind: input.actorKind ?? null,
        payload: canonical,
        payloadHash,
        dedupeKey: input.dedupeKey ?? null,
      })
      .returning({ id: covenantActionRecords.id });
    return { id: row.id, deduped: false };
  } catch (err) {
    // Only a dedupe-key race is retriable-as-success; every other unique
    // violation (seq skew after a restore, PK anomaly) bubbles and aborts.
    const pgErr = err as { code?: string; constraint_name?: string; cause?: any };
    const code = pgErr?.code ?? pgErr?.cause?.code;
    const constraint = pgErr?.constraint_name ?? pgErr?.cause?.constraint_name;
    if (
      input.dedupeKey &&
      code === '23505' &&
      (constraint == null || constraint === 'covenant_action_records_dedupe_key_unique')
    ) {
      // Inside a surrounding tx the 23505 has already ABORTED it (25P02 on any
      // further statement), so the verify-select can only run standalone. A
      // concurrent in-tx race therefore fails LOUD (whole tx rolls back — the
      // caller's next attempt lands on the committed row via the pre-check);
      // it can never silently commit recordless.
      if (tx) {
        throw new Error(
          `covenant dedupe-key race inside a transaction (key=${input.dedupeKey}) — ` +
            'business tx rolled back; retry will dedupe against the committed record',
        );
      }
      return verifyExistingMatches();
    }
    throw err;
  }
}
