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
import { db, covenantActionRecords } from '@clawville/database';
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
  | 'bounty.claim'
  | 'bounty.submit'
  | 'bounty.approve'
  | 'bounty.reject'
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
): Promise<{ id: string }> {
  const canonicalStr = canonicalJson(input.payload);
  const canonical = JSON.parse(canonicalStr) as Record<string, unknown>;
  const payloadHash = createHash('sha256').update(canonicalStr, 'utf8').digest('hex');

  const executor = tx ?? db;
  const [row] = await executor
    .insert(covenantActionRecords)
    .values({
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      actorKind: input.actorKind ?? null,
      payload: canonical,
      payloadHash,
    })
    .returning({ id: covenantActionRecords.id });

  return { id: row.id };
}
