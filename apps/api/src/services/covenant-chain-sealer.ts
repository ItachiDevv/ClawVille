/**
 * Covenant chain sealer (2026-07-13) — assigns the gapless hash chain over
 * `covenant_action_records`.
 *
 * Records are INSERTED unchained by `covenant-action-recorder.ts` (plain
 * parallel inserts, atomic with the business tx — chaining at write time would
 * put a global serialization point inside every money transaction). This sealer
 * is the ONLY writer of the seal columns: every SEAL_INTERVAL_MS it takes one
 * advisory lock (sealer-vs-sealer only — money paths never touch this lock),
 * scans unsealed rows older than the WATERMARK in `seq` order, and assigns
 * `chain_position` / `prev_hash` / `record_hash` serially.
 *
 * WHY THE WATERMARK: `seq` is a bigserial — values from still-open transactions
 * commit late, so a freshly-committed row can appear BELOW an already-visible
 * seq. Sealing only rows `created_at < now() - 30s` makes an in-flight tx
 * overtaking the scan practically impossible; a transaction that somehow lingers
 * longer simply seals in a LATER batch at a later chain position. `seq` is an
 * arrival HINT; `chain_position` (assigned strictly serially here, under the
 * lock) is the canonical total order — the chain is deterministic and complete
 * regardless of seq gaps or stragglers.
 *
 * CHAIN ENCODING (verifier contract — mirrors requesterApprovalAuditRoot's
 * NUL-separated style):
 *   record_hash = sha256(
 *     prev_hash ‖0‖ payload_hash ‖0‖ action ‖0‖ subject_type ‖0‖ subject_id
 *     ‖0‖ actor_kind('' when null) ‖0‖ chain_position(decimal)
 *     ‖0‖ created_at(ISO-8601 UTC ms)
 *   )   — genesis prev_hash = 64 zeros.
 * Every field is either stored on the row or recomputable from it
 * (payload_hash = sha256(canonical sorted-key JSON of payload)), so a verifier
 * holding the rows can recompute the entire chain from position 1.
 *
 * Each pass that seals ≥1 record appends one `covenant_seal_batches` row whose
 * `batch_root` is the new chain head — the value a future on-chain
 * `anchor_receipt_batch` anchors (audit roadmap #2).
 */

import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { db, covenantActionRecords, covenantSealBatches } from '@clawville/database';
import { covenantPayloadHash } from './covenant-action-recorder';
import { alertError } from './alert-error';

const SEAL_INTERVAL_MS = 60_000;
/** Don't seal rows younger than this — see the watermark rationale above. */
const SEAL_WATERMARK_MS = 30_000;
/** Max records chained per pass (multiple passes drain a backlog). */
const SEAL_BATCH_LIMIT = 500;
/**
 * App-wide advisory lock key for the sealer (xact-scoped). Arbitrary constant,
 * distinct from the per-avatar `hashtextextended(avatarId, 0)` locks money
 * paths use — the sealer NEVER contends with them.
 */
const SEALER_LOCK_KEY = 7_413_002_601;

const GENESIS_HASH = '0'.repeat(64);

/** Rows already paged for a payload-hash mismatch (once per process). */
const alertedMismatchIds = new Set<string>();

type UnsealedRow = {
  id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  actor_kind: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  created_at: Date | string;
};

type ChainHeadRow = {
  chain_position: string | number | bigint;
  record_hash: string;
};

/** The canonical seal encoding — exported for tests + future verifiers. */
export function computeRecordHash(parts: {
  prevHash: string;
  payloadHash: string;
  action: string;
  subjectType: string;
  subjectId: string;
  /** null (unattributed) encodes as the empty string - NUL separation keeps it unambiguous. */
  actorKind: string | null;
  chainPosition: bigint;
  createdAtIso: string;
}): string {
  const h = createHash('sha256');
  const push = (s: string, last = false) => {
    h.update(Buffer.from(s, 'utf8'));
    if (!last) h.update(Buffer.from([0]));
  };
  push(parts.prevHash);
  push(parts.payloadHash);
  push(parts.action);
  push(parts.subjectType);
  push(parts.subjectId);
  // Codex round 1 HIGH #4: attribution is partner-visible provenance, so it
  // MUST be hash-committed - a mutated actor_kind must invalidate the chain.
  push(parts.actorKind ?? '');
  push(parts.chainPosition.toString(10));
  push(parts.createdAtIso, true);
  return h.digest('hex');
}

/** Normalize a driver timestamp (Date or string) to ISO-8601 UTC ms. */
export function toCanonicalIso(createdAt: Date | string): string {
  return (createdAt instanceof Date ? createdAt : new Date(createdAt)).toISOString();
}

/**
 * One seal pass. Returns the number of records sealed (0 = nothing eligible).
 * Runs entirely inside one transaction: advisory lock → read head → chain →
 * write seals → append batch row. Safe to run concurrently across processes
 * (the lock serializes passes; a second process just waits or finds nothing).
 */
export async function sealCovenantChainOnce(): Promise<number> {
  return db.transaction(async (tx) => {
    // Sealer-vs-sealer serialization ONLY (money paths never take this key).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEALER_LOCK_KEY})`);

    const heads = await tx.execute<ChainHeadRow>(
      sql`SELECT chain_position, record_hash FROM covenant_action_records
          WHERE chain_position IS NOT NULL
          ORDER BY chain_position DESC LIMIT 1`,
    );
    const head = heads[0];
    let position = head ? BigInt(head.chain_position) : 0n;
    let prevHash = head ? head.record_hash : GENESIS_HASH;

    const rows = await tx.execute<UnsealedRow>(
      sql`SELECT id, action, subject_type, subject_id, actor_kind, payload, payload_hash, created_at
          FROM covenant_action_records
          WHERE chain_position IS NULL
            AND created_at < now() - make_interval(secs => ${SEAL_WATERMARK_MS / 1000})
          ORDER BY seq ASC
          LIMIT ${SEAL_BATCH_LIMIT}`,
    );
    if (rows.length === 0) return 0;

    const firstPosition = position + 1n;
    let sealedCount = 0;
    for (const row of rows) {
      // Codex round 1 HIGH #5 + round 3 HIGH #2: never trust the STORED
      // payload_hash - recompute from the stored payload before chaining. A
      // mismatch means an injected/corrupted row, and the chain FAILS CLOSED
      // AT it: rows before it seal normally, NOTHING after it seals until an
      // operator repairs the stream. Skipping-and-continuing would hide the
      // poison from partners behind a contiguous-looking chain; a stalled
      // sealer head is the loud, durable unhealthy signal (the growing
      // unsealed backlog is queryable, and ops is paged CRITICAL).
      const recomputed = covenantPayloadHash(row.payload);
      if (recomputed !== row.payload_hash) {
        // One CRITICAL page per row per process — the row is re-scanned every
        // pass (it never seals), so an unguarded alert would fire every 60s.
        if (!alertedMismatchIds.has(row.id)) {
          alertedMismatchIds.add(row.id);
          void alertError({
            severity: 'critical',
            source: 'covenant-chain-sealer',
            message:
              `covenant_action_records ${row.id}: stored payload_hash does not match ` +
              `the stored payload (recomputed ${recomputed.slice(0, 12)}..., stored ` +
              `${row.payload_hash.slice(0, 12)}...). CHAIN SEALING HALTED at this row ` +
              `(fail-closed) - repair/remove the poisoned row to resume sealing.`,
            context: { recordId: row.id, action: row.action, subjectId: row.subject_id },
          });
        }
        break;
      }
      position += 1n;
      const recordHash = computeRecordHash({
        prevHash,
        payloadHash: row.payload_hash,
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        actorKind: row.actor_kind,
        chainPosition: position,
        createdAtIso: toCanonicalIso(row.created_at),
      });
      await tx
        .update(covenantActionRecords)
        .set({
          chainPosition: position,
          prevHash,
          recordHash,
          sealedAt: new Date(),
        })
        .where(sql`${covenantActionRecords.id} = ${row.id}`);
      prevHash = recordHash;
      sealedCount += 1;
    }

    // Every eligible row may have been refused (hash mismatch) - no chain
    // movement, no batch row.
    if (sealedCount === 0) return 0;

    await tx.insert(covenantSealBatches).values({
      firstPosition,
      lastPosition: position,
      recordCount: BigInt(sealedCount),
      batchRoot: prevHash, // the new chain head
      prevBatchRoot: head ? head.record_hash : GENESIS_HASH,
    });

    return sealedCount;
  });
}

let sealerTimer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

/**
 * Boot entry (index.ts). Interval-driven; a pass that finds a full batch loops
 * immediately until the backlog drains. `passRunning` prevents overlapping
 * passes within THIS process; the advisory lock covers cross-process overlap.
 */
export function startCovenantChainSealer(): void {
  if (sealerTimer) return;
  const run = async () => {
    if (passRunning) return;
    passRunning = true;
    try {
      // Drain: keep sealing while full batches come back.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const sealed = await sealCovenantChainOnce();
        if (sealed < SEAL_BATCH_LIMIT) break;
      }
    } catch (err) {
      console.error('[CovenantSealer] pass failed:', err);
    } finally {
      passRunning = false;
    }
  };
  sealerTimer = setInterval(run, SEAL_INTERVAL_MS);
  // First pass shortly after boot (let the pool warm up).
  setTimeout(run, 5_000);
  console.log(
    `[CovenantSealer] started — interval ${SEAL_INTERVAL_MS / 1000}s, watermark ${SEAL_WATERMARK_MS / 1000}s, batch ${SEAL_BATCH_LIMIT}`,
  );
}

/** Graceful-shutdown stop (mirrors the other sweepers). */
export function stopCovenantChainSealer(): void {
  if (sealerTimer) {
    clearInterval(sealerTimer);
    sealerTimer = null;
  }
}
