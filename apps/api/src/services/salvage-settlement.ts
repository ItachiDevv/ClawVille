/**
 * Seabed salvage — qualification, admission and settlement (Land gamification P7a).
 *
 * WHY THIS IS A SERVICE AND NOT ROUTE CODE
 * ----------------------------------------
 * A salvage claim is reachable from THREE subject paths — a logged-in human, a
 * connected agent bearing `X-Clawville-Agent-Session`, and a user-hosted agent
 * acting autonomously through the `[ACTION:]` executor. The executor is not a
 * Hono context (`dispatchHatcherActions` has no request), so it cannot reuse a
 * route body. Putting the caps, the cooldown, the yield and the credit HERE is
 * what makes the three paths provably one implementation. Same reasoning as
 * `tutorial-quest-settlement.ts` and `land-tenure-settlement.ts`.
 *
 * The service is CONTEXT-FREE: it returns a result and never touches caches,
 * analytics or broadcasts. Each adapter fires its own post-commit effects, and
 * only on a fresh settlement.
 *
 * ── THE YIELD IS AN HMAC, NOT A PUBLIC HASH ─────────────────────────────────
 * `HMAC(serverSecret, avatarId | nodeId | claimOrdinal) mod 3 + 1`.
 *
 * A public `sha256` over the same fields would be FARMABLE: every input is
 * known to the client, so a player could compute the yield of every pending
 * claim and only ever spend cooldowns on 3-material nodes. The server secret is
 * what makes the outcome unpredictable while keeping it deterministic and
 * auditable server-side. `claimOrdinal` is what makes it non-replayable: it is
 * monotonic per `(avatar, node)`, so the same node never pays the same amount
 * twice in a row by construction.
 *
 * ── LOCK ORDER AND DEADLOCK FREEDOM ─────────────────────────────────────────
 * OWNER key, then AVATAR key, both as in-process mutex OUTER and
 * `pg_advisory_xact_lock` INNER (the repo's canonical per-subject stack).
 *
 * Only salvage takes an owner key, and it always takes it BEFORE the avatar
 * key. Every other land writer takes the avatar key alone. No path anywhere
 * takes avatar-then-owner, so no cycle is constructible and the ordering is
 * deadlock-free by inspection rather than by hope. The owner key is namespaced
 * (`salvage-owner:<userId>`) so it can never alias a bare avatar-UUID key.
 *
 * ── EVERY REFUSAL ROLLS BACK ────────────────────────────────────────────────
 * Admission is a WRITE. If the owner counter increments and the avatar counter
 * then refuses, that owner increment MUST NOT stick — otherwise a capped-out
 * avatar silently burns its whole fleet's budget. Refusals inside the
 * transaction are therefore thrown as a sentinel and translated outside it, so
 * Postgres rolls the partial admission back for us.
 */

import { createHash, createHmac } from 'node:crypto';
import { db, sql } from '@clawville/database';
import {
  SALVAGE_AVATAR_DAILY_CLAIM_CAP,
  SALVAGE_LAYOUT_VERSION,
  SALVAGE_CT_BOUNTY_DAILY_CLAIMS,
  SALVAGE_CT_BOUNTY_VCLAW,
  SALVAGE_NODES,
  SALVAGE_NODE_COOLDOWN_MS,
  SALVAGE_OWNER_DAILY_CLAIM_CAP,
  SALVAGE_YIELD_MAX,
  SALVAGE_YIELD_MIN,
  getSalvageNode,
  salvageFlavourForYield,
  type SalvageFlavour,
} from '@clawville/shared';
import { withKeyedMutex } from './keyed-mutex';
import { creditMaterials, readMaterialBalance } from './material-ledger';
import { isHouseAgentId } from './autonomous-cove-agent-binding';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * WHO is claiming. Resolved by the caller — `requireAuthOrAgentSession` on the
 * REST path, the live agent-session resolver on the executor path. Both land on
 * ONE bound avatar, which is the settlement subject.
 */
export interface SalvageClaimActor {
  readonly kind: 'user' | 'agent';
  readonly userId: string;
  readonly avatarId: string;
  /** Present only for agents. Used for the house-actor barrier and telemetry. */
  readonly agentId: string | null;
  readonly sessionId: string | null;
}

/**
 * The binding captured BEFORE the locks were taken. Re-asserted under them, so
 * a session that was rotated, expired or re-bound mid-flight cannot settle
 * against a stale principal. Copied from `settleAutonomousCoveGame`.
 */
export interface SalvageClaimBindings {
  readonly expectedAvatarId: string;
  readonly expectedAgentId: string | null;
  readonly expectedUserId: string;
}

export type SalvageRefusalCode =
  | 'node_unknown'
  | 'house_excluded'
  | 'owner_unresolved'
  | 'binding_drift'
  | 'owner_daily_cap'
  | 'avatar_daily_cap'
  | 'node_on_cooldown'
  | 'idempotency_key_conflict'
  | 'concurrent_retry';

/** The exact payload a client receives, and the exact jsonb stored on the receipt. */
export interface SalvageClaimPayload {
  readonly nodeId: string;
  readonly layoutVersion: number;
  readonly materialsGranted: number;
  readonly flavour: SalvageFlavour;
  /** Pooled material balance AFTER the credit. */
  readonly balanceAfter: number;
  /** ISO8601. When this node becomes claimable again for this avatar. */
  readonly nextClaimAt: string;
  readonly claimsRemainingToday: number;
  readonly ownerClaimsRemainingToday: number;
  /**
   * vCLAW paid by the §2.10 bounty. ALWAYS 0 unless that dark rail is lit
   * (founder ruling Q1 keeps it dark), and it is a TRANSFER from the treasury
   * either way — never a mint.
   */
  readonly bountyVclaw: number;
}

export type SalvageClaimOutcome =
  | { readonly kind: 'settled'; readonly fresh: true; readonly payload: SalvageClaimPayload }
  /** A replayed idempotency key whose fingerprint matched. Nothing was consumed. */
  | { readonly kind: 'replay'; readonly fresh: false; readonly payload: SalvageClaimPayload }
  | {
      readonly kind: 'refused';
      readonly code: SalvageRefusalCode;
      /** Present on cooldown refusals so the client can show a countdown. */
      readonly nextClaimAt?: string;
    };

export interface SalvageClaimInput {
  readonly actor: SalvageClaimActor;
  readonly bindings: SalvageClaimBindings;
  readonly nodeId: string;
  readonly idempotencyKey: string;
  /**
   * Re-resolve the live session UNDER the locks. Optional because a Lucia human
   * has no session that can drift out from under a request — the cookie was
   * already validated and there is no bearer to rotate. Agent adapters MUST
   * pass one. Returning `null` (or a mismatching binding) refuses with
   * `binding_drift`.
   */
  readonly revalidateBinding?: () => Promise<{
    readonly userId: string | null;
    readonly avatarId: string | null;
    readonly agentId: string;
    readonly ledgerCapable: boolean;
  } | null>;
}

// ---------------------------------------------------------------------------
// Yield + fingerprint
// ---------------------------------------------------------------------------

const HMAC_DOMAIN = 'clawville:salvage-yield:v1';

function hmacKey(secret: string): Buffer {
  return createHash('sha256').update(`${secret}${HMAC_DOMAIN}`).digest();
}

/**
 * `FINGERPRINT_SECRET` is hard-required at API boot (`middleware/fingerprint.ts`
 * throws at module load without it), so in a running process this is always
 * present. It is re-checked here rather than assumed because the alternative
 * failure mode — quietly falling back to an unkeyed hash — would turn the yield
 * into a client-computable value and hand every player a perfect node oracle.
 * Fail closed, loudly.
 */
function requireYieldSecret(): string {
  const secret = process.env.FINGERPRINT_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      'salvage: FINGERPRINT_SECRET is required to derive claim yields — refusing to fall back to an unkeyed hash',
    );
  }
  return secret;
}

/**
 * Deterministic 1-3 yield.
 *
 * The digest is reduced as a single 256-bit integer rather than a truncated
 * 32-bit read, so the modulo bias against a uniform 1-3 is ~2^-254 instead of
 * ~2^-32. Both are irrelevant to a player; the wide reduction just removes the
 * question from review permanently.
 */
export function deriveSalvageYield(
  avatarId: string,
  nodeId: string,
  claimOrdinal: number,
  secret = requireYieldSecret(),
): number {
  const digest = createHmac('sha256', hmacKey(secret))
    .update(`${avatarId}|${nodeId}|${claimOrdinal}`)
    .digest('hex');
  const span = BigInt(SALVAGE_YIELD_MAX - SALVAGE_YIELD_MIN + 1);
  return Number((BigInt(`0x${digest}`) % span) + BigInt(SALVAGE_YIELD_MIN));
}

/**
 * The STABLE canonical request. `claimOrdinal` is deliberately absent: it is
 * server-derived after the cooldown check, is unavailable at the receipt-lookup
 * step, and changes after any later claim on the same node. Including it would
 * make a legitimate replay look like a conflict.
 */
export function salvageFingerprint(
  avatarId: string,
  nodeId: string,
  layoutVersion: number,
): string {
  return createHash('sha256')
    .update(`${avatarId}|${nodeId}|${layoutVersion}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Thrown to roll the transaction back on a refusal. Never escapes this module. */
class SalvageRefusal extends Error {
  constructor(
    readonly code: SalvageRefusalCode,
    readonly nextClaimAt?: string,
  ) {
    super(`salvage_refused:${code}`);
    this.name = 'SalvageRefusal';
  }
}

function pgErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return null;
}

function isPayload(value: unknown): value is SalvageClaimPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nodeId === 'string' &&
    typeof v.materialsGranted === 'number' &&
    typeof v.balanceAfter === 'number'
  );
}

type ReceiptRow = { fingerprint: string; response: unknown };

/** Read a stored receipt and decide replay-vs-conflict. Used inside and outside the tx. */
function classifyReceipt(
  row: ReceiptRow | undefined,
  expectedFingerprint: string,
): SalvageClaimOutcome | null {
  if (!row) return null;
  if (row.fingerprint !== expectedFingerprint) {
    return { kind: 'refused', code: 'idempotency_key_conflict' };
  }
  if (!isPayload(row.response)) {
    // A receipt exists but its stored response is unreadable. Reporting it as a
    // conflict is the honest answer: we know the key was used and we cannot
    // reproduce what it paid, so re-settling it would be a double credit.
    return { kind: 'refused', code: 'idempotency_key_conflict' };
  }
  return { kind: 'replay', fresh: false, payload: row.response };
}

const MUTEX_OWNER_PREFIX = 'salvage:owner:';
const MUTEX_AVATAR_PREFIX = 'salvage:avatar:';


// ---------------------------------------------------------------------------
// The vCLAW bounty (design §2.10) — DARK
// ---------------------------------------------------------------------------

// FEATURE_GATE: salvage_ct_bounty
// Status: DARK. `SALVAGE_CT_BOUNTY_ENABLED` is unset everywhere, so
//   `bountyVclaw` is 0 on every path and not a single vCLAW moves. The code
//   exists so that lighting it is a reviewed config event with a specified
//   implementation, rather than an improvised one written under pressure.
// Metric to graduate: a founder decision to reverse ruling Q1 (2026-08-09),
//   which currently states "salvage pays materials only; the vCLAW rail stays
//   dark". There is no metric that graduates this on its own.
// Current reading: 0 vCLAW issued by salvage, by construction.
// Review deadline: whenever Q1 is revisited. Not date-bound — inventing a date
//   here is the exact thing the design's process note calls out.
// On deadline: if Q1 still stands, this stays dark. If it is reversed, the
//   funding source is the RECIRCULATING treasury (ruling Q6) and the global
//   supply delta must remain exactly zero.
// Reference: gamification-pass-2026-08-09.md §2.10 (P10), §3.5 ledger 1/3.

/**
 * Is the bounty lit? Exact-`'true'` only, so a typo, an empty string or a
 * stray `0` all read as OFF. Money rails do not get fuzzy booleans.
 */
export function isSalvageBountyEnabled(): boolean {
  return process.env.SALVAGE_CT_BOUNTY_ENABLED === 'true';
}

/**
 * Pay the bounty for one admitted claim, inside the caller's transaction and
 * under the locks it already holds. Returns the vCLAW actually paid.
 *
 * ── FAIL-CLOSED, AND WHAT THAT MEANS HERE ───────────────────────────────────
 * The design says to follow the kit-fee pattern ("a transfer, never a burn")
 * rather than the upgrade burn. The invariant that pattern protects is that
 * vCLAW is never credited without being debited from somewhere — global supply
 * delta zero. That is enforced absolutely below: an unresolvable or
 * insufficient treasury pays NOTHING.
 *
 * Where this deliberately differs from the kit fee: the kit fee 503s the whole
 * request, because a placement WITHOUT its fee would be a free piece. A salvage
 * bounty is a bonus ON TOP of the materials, so an empty treasury skips the
 * bonus and still settles the materials rather than taking the core earn loop
 * offline over a decoration. Both readings are "fail closed" on supply; this
 * one is also fail-closed on the player's time. Stated here because it is a
 * judgement call, not something to be discovered later in a diff.
 */
async function paySalvageBounty(
  tx: Parameters<typeof creditMaterials>[1] & object,
  avatarId: string,
  claimsAdmittedToday: number,
): Promise<number> {
  if (!isSalvageBountyEnabled()) return 0;
  if (claimsAdmittedToday > SALVAGE_CT_BOUNTY_DAILY_CLAIMS) return 0;

  const { getHouseTreasuryAvatarId } = await import('./house-treasury-seeder');
  const treasuryId = await getHouseTreasuryAvatarId();
  if (!treasuryId) return 0;

  const { creditClawTokens, debitClawTokens, InsufficientTokensError } = await import(
    './claw-token-ledger'
  );
  try {
    // DEBIT FIRST. If the treasury cannot cover it, the credit never runs and
    // supply is untouched.
    await debitClawTokens(
      {
        avatarId: treasuryId,
        amount: SALVAGE_CT_BOUNTY_VCLAW,
        reason: 'salvage_bounty_funding',
        source: 'system',
        metadata: { ownerAvatarId: avatarId, claimsAdmittedToday },
        actorKind: 'system',
      },
      tx,
    );
  } catch (err) {
    if (err instanceof InsufficientTokensError) return 0;
    throw err;
  }

  await creditClawTokens(
    {
      avatarId,
      amount: SALVAGE_CT_BOUNTY_VCLAW,
      reason: 'salvage_bounty',
      source: 'system',
      metadata: { claimsAdmittedToday },
      actorKind: 'system',
    },
    tx,
  );
  return SALVAGE_CT_BOUNTY_VCLAW;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Claim ONE salvage node as ONE avatar. Identical for every subject path.
 *
 * Transaction order (design §2.6), each step commented at its site:
 *   1 owner advisory lock          2 avatar advisory lock
 *   3 live binding revalidation    4 receipt lookup
 *   5 node cooldown (FOR UPDATE)   6 owner then avatar admission
 *   7 ordinal + HMAC yield         8 credit + materials_issued
 *   9 node claim upsert           10 receipt insert
 */
export async function settleSalvageClaim(
  input: SalvageClaimInput,
): Promise<SalvageClaimOutcome> {
  const { actor, bindings, nodeId, idempotencyKey } = input;

  // Cheap, lock-free pre-checks. A node outside the frozen layout can never
  // settle, so there is no reason to take a lock to find that out.
  const node = getSalvageNode(nodeId);
  if (!node) return { kind: 'refused', code: 'node_unknown' };

  // HOUSE ACTORS EARN NOTHING. Salvage is a pure faucet with no counterparty,
  // so a server-owned house actor claiming one would mint materials into house
  // balances and leak them into the player economy. This lives in the SERVICE
  // rather than being copied into each adapter (the arrangement the quest
  // ladder uses) precisely so a fourth caller cannot be added without it.
  if (actor.kind === 'agent' && actor.agentId && (await isHouseAgentId(actor.agentId))) {
    return { kind: 'refused', code: 'house_excluded' };
  }

  const fingerprint = salvageFingerprint(actor.avatarId, nodeId, SALVAGE_LAYOUT_VERSION);
  const ownerKey = `salvage-owner:${bindings.expectedUserId}`;

  const run = async (): Promise<SalvageClaimOutcome> =>
    db.transaction(async (tx) => {
      // (1) OWNER lock, then (2) AVATAR lock. This order is the whole deadlock
      // argument — see the module header. The avatar key matches the one every
      // other land writer uses, so salvage serializes against them correctly.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.avatarId}, 0))`,
      );

      // (3) LIVE BINDING REVALIDATION under both locks.
      //
      // First the OWNER axis, re-derived from the database rather than trusted
      // from the request: the avatar must still exist, still be active, and
      // still belong to the principal whose cap bucket we just locked. This is
      // what stops a claim from being charged to one owner's budget while
      // crediting another owner's avatar.
      const avatarRows = await tx.execute<{ user_id: string | null; is_active: boolean }>(
        sql`SELECT user_id, is_active FROM avatars WHERE id = ${actor.avatarId} FOR UPDATE`,
      );
      const avatarRow = avatarRows[0];
      if (!avatarRow || !avatarRow.is_active || !avatarRow.user_id) {
        throw new SalvageRefusal('owner_unresolved');
      }
      if (avatarRow.user_id !== bindings.expectedUserId) {
        throw new SalvageRefusal('binding_drift');
      }

      // Then the SESSION axis, for bearer-bound callers.
      if (input.revalidateBinding) {
        const live = await input.revalidateBinding();
        if (!live || !live.ledgerCapable) throw new SalvageRefusal('binding_drift');
        if (
          live.avatarId !== bindings.expectedAvatarId ||
          live.userId !== bindings.expectedUserId ||
          live.agentId !== bindings.expectedAgentId
        ) {
          throw new SalvageRefusal('binding_drift');
        }
      }

      // (4) RECEIPT LOOKUP. A matching fingerprint replays verbatim WITHOUT
      // consuming a cooldown or an admission — that is the whole point of an
      // idempotency key. A mismatch is a conflict: the same key was already
      // spent on a different node.
      const priorRows = await tx.execute<ReceiptRow>(
        sql`SELECT fingerprint, response FROM salvage_claim_receipts
            WHERE avatar_id = ${actor.avatarId} AND idempotency_key = ${idempotencyKey}
            LIMIT 1`,
      );
      const replay = classifyReceipt(priorRows[0], fingerprint);
      if (replay) return replay;

      // (5) NODE COOLDOWN. Locked so a concurrent claim on the same node cannot
      // read a stale ordinal. A missing row means "never claimed", which is
      // claimable with ordinal 0 as the predecessor.
      const claimRows = await tx.execute<{
        claim_ordinal: number | string;
        next_claim_at: string | Date;
        ready: boolean;
      }>(
        sql`SELECT claim_ordinal, next_claim_at,
                   next_claim_at <= transaction_timestamp() AS ready
            FROM salvage_node_claims
            WHERE avatar_id = ${actor.avatarId} AND node_id = ${nodeId}
            FOR UPDATE`,
      );
      const claimRow = claimRows[0];
      if (claimRow && !claimRow.ready) {
        throw new SalvageRefusal(
          'node_on_cooldown',
          new Date(claimRow.next_claim_at).toISOString(),
        );
      }

      // (6) ADMISSION — OWNER FIRST, then AVATAR.
      //
      // Both are ATOMIC CONDITIONAL UPSERTS, never read-then-write: the cap
      // lives in the `WHERE ... < cap` of the DO UPDATE, so concurrent claimers
      // serialize on the row and zero returned rows IS the refusal. This is the
      // only shape that holds under the design's 141-concurrent-claims-across-
      // two-processes acceptance test.
      const ownerAdmit = await tx.execute<{ claims_admitted: number | string }>(
        sql`INSERT INTO salvage_owner_admissions (owner_kind, owner_id, utc_day, claims_admitted)
            VALUES ('user', ${bindings.expectedUserId},
                    (transaction_timestamp() AT TIME ZONE 'UTC')::date, 1)
            ON CONFLICT (owner_kind, owner_id, utc_day) DO UPDATE
              SET claims_admitted = salvage_owner_admissions.claims_admitted + 1
              WHERE salvage_owner_admissions.claims_admitted < ${SALVAGE_OWNER_DAILY_CLAIM_CAP}
            RETURNING claims_admitted`,
      );
      const ownerUsed = ownerAdmit[0];
      if (!ownerUsed) throw new SalvageRefusal('owner_daily_cap');

      const avatarAdmit = await tx.execute<{ claims_admitted: number | string }>(
        sql`INSERT INTO salvage_daily_admissions (avatar_id, utc_day, claims_admitted, materials_issued)
            VALUES (${actor.avatarId}, (transaction_timestamp() AT TIME ZONE 'UTC')::date, 1, 0)
            ON CONFLICT (avatar_id, utc_day) DO UPDATE
              SET claims_admitted = salvage_daily_admissions.claims_admitted + 1
              WHERE salvage_daily_admissions.claims_admitted < ${SALVAGE_AVATAR_DAILY_CLAIM_CAP}
            RETURNING claims_admitted`,
      );
      const avatarUsed = avatarAdmit[0];
      // The owner counter incremented a statement ago. Throwing here rolls it
      // back with the rest of the transaction, so a capped avatar never spends
      // its fleet's budget.
      if (!avatarUsed) throw new SalvageRefusal('avatar_daily_cap');

      // (7) ORDINAL + YIELD. The ordinal is monotonic per (avatar, node) and is
      // never reset, so no two claims on a node ever share a yield input.
      const claimOrdinal = Number(claimRow?.claim_ordinal ?? 0) + 1;
      const materialsGranted = deriveSalvageYield(actor.avatarId, nodeId, claimOrdinal);
      const flavour = salvageFlavourForYield(materialsGranted);

      // (8) CREDIT, in this transaction. `creditMaterials` in COMPOSED mode does
      // not re-take the per-subject mutex — we already hold it — and its upsert
      // is a single atomic statement regardless.
      const credit = await creditMaterials(
        {
          avatarId: actor.avatarId,
          amount: materialsGranted,
          reason: 'salvage_claim',
          source: 'salvage',
        },
        tx,
      );

      // (8b) Material issuance counter. Bounded by construction: 20 claims x 3
      // materials = 60, which is exactly the column's CHECK.
      await tx.execute(
        sql`UPDATE salvage_daily_admissions
            SET materials_issued = materials_issued + ${materialsGranted}
            WHERE avatar_id = ${actor.avatarId}
              AND utc_day = (transaction_timestamp() AT TIME ZONE 'UTC')::date`,
      );

      // (9) NODE CLAIM UPSERT. The `WHERE next_claim_at <= transaction_timestamp()`
      // guard closes the first-claim race: two concurrent first claims both see
      // no row at step 5, and the loser's upsert conflicts onto a row that is
      // NOT yet ready, matches nothing, and rolls the whole transaction back
      // rather than paying twice.
      const cooldownSeconds = Math.floor(SALVAGE_NODE_COOLDOWN_MS / 1000);
      const upserted = await tx.execute<{ next_claim_at: string | Date }>(
        sql`INSERT INTO salvage_node_claims
              (avatar_id, node_id, layout_version, claim_ordinal, last_claimed_at, next_claim_at)
            VALUES (${actor.avatarId}, ${nodeId}, ${SALVAGE_LAYOUT_VERSION}, ${claimOrdinal},
                    transaction_timestamp(),
                    transaction_timestamp() + make_interval(secs => ${cooldownSeconds}))
            ON CONFLICT (avatar_id, node_id) DO UPDATE
              SET layout_version  = ${SALVAGE_LAYOUT_VERSION},
                  claim_ordinal   = ${claimOrdinal},
                  last_claimed_at = transaction_timestamp(),
                  next_claim_at   = transaction_timestamp() + make_interval(secs => ${cooldownSeconds})
              WHERE salvage_node_claims.next_claim_at <= transaction_timestamp()
            RETURNING next_claim_at`,
      );
      const upsertedRow = upserted[0];
      if (!upsertedRow) throw new SalvageRefusal('node_on_cooldown');

      // Dark by default (Q1). When unlit this is a synchronous `return 0` that
      // touches no table, so the money path below is provably a no-op.
      const bountyVclaw = await paySalvageBounty(
        tx,
        actor.avatarId,
        Number(avatarUsed.claims_admitted),
      );

      const payload: SalvageClaimPayload = {
        nodeId,
        layoutVersion: SALVAGE_LAYOUT_VERSION,
        materialsGranted,
        flavour,
        balanceAfter: credit.balanceAfter,
        nextClaimAt: new Date(upsertedRow.next_claim_at).toISOString(),
        claimsRemainingToday: Math.max(
          0,
          SALVAGE_AVATAR_DAILY_CLAIM_CAP - Number(avatarUsed.claims_admitted),
        ),
        ownerClaimsRemainingToday: Math.max(
          0,
          SALVAGE_OWNER_DAILY_CLAIM_CAP - Number(ownerUsed.claims_admitted),
        ),
        bountyVclaw,
      };

      // (10) RECEIPT. `salvage_receipt_uniq` is the durable barrier; a duplicate
      // key racing in this window trips it and we resolve outside the
      // transaction, where the winner's row is visible.
      await tx.execute(
        sql`INSERT INTO salvage_claim_receipts
              (avatar_id, idempotency_key, fingerprint, node_id, layout_version,
               claim_ordinal, materials_granted, flavour, response)
            VALUES (${actor.avatarId}, ${idempotencyKey}, ${fingerprint}, ${nodeId},
                    ${SALVAGE_LAYOUT_VERSION}, ${claimOrdinal}, ${materialsGranted},
                    ${flavour}, ${JSON.stringify(payload)}::jsonb)`,
      );

      return { kind: 'settled' as const, fresh: true as const, payload };
    });

  try {
    // Mutexes OUTER, in the same owner-then-avatar order as the advisory locks,
    // so the in-process ordering can never contradict the database ordering.
    return await withKeyedMutex(`${MUTEX_OWNER_PREFIX}${bindings.expectedUserId}`, () =>
      withKeyedMutex(`${MUTEX_AVATAR_PREFIX}${actor.avatarId}`, run),
    );
  } catch (err) {
    if (err instanceof SalvageRefusal) {
      return err.nextClaimAt
        ? { kind: 'refused', code: err.code, nextClaimAt: err.nextClaimAt }
        : { kind: 'refused', code: err.code };
    }
    // 23505 on the receipt index: a concurrent identical claim committed first.
    // Its row is visible now that our transaction is gone, so serve it as the
    // replay it is. Only if it is somehow unreadable do we report a retry.
    if (pgErrorCode(err) === '23505') {
      const winnerRows = await db.execute<ReceiptRow>(
        sql`SELECT fingerprint, response FROM salvage_claim_receipts
            WHERE avatar_id = ${actor.avatarId} AND idempotency_key = ${idempotencyKey}
            LIMIT 1`,
      );
      const winner = classifyReceipt(winnerRows[0], fingerprint);
      if (winner) return winner;
      return { kind: 'refused', code: 'concurrent_retry' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export interface SalvageNodeState {
  readonly nodeId: string;
  readonly band: string;
  readonly x: number;
  readonly z: number;
  /** null = never claimed by this avatar, i.e. ready now. */
  readonly nextClaimAt: string | null;
  readonly ready: boolean;
}

export interface SalvageState {
  readonly layoutVersion: number;
  readonly nodes: readonly SalvageNodeState[];
  readonly materialBalance: number;
  readonly claimsUsedToday: number;
  readonly claimsRemainingToday: number;
  readonly ownerClaimsUsedToday: number;
  readonly ownerClaimsRemainingToday: number;
  readonly lastClaim: SalvageClaimPayload | null;
}

/**
 * ONE closed-field payload feeds BOTH the human HUD and hosted perception, so a
 * player and an agent are never looking at different worlds. No player prose,
 * no database UUIDs, no other subject's state.
 */
export async function readSalvageState(input: {
  readonly avatarId: string;
  readonly userId: string;
}): Promise<SalvageState> {
  const { avatarId, userId } = input;
  const [claimRows, dailyRows, ownerRows, balance, lastRows] = await Promise.all([
    db.execute<{ node_id: string; next_claim_at: string | Date; ready: boolean }>(
      sql`SELECT node_id, next_claim_at, next_claim_at <= now() AS ready
          FROM salvage_node_claims WHERE avatar_id = ${avatarId}`,
    ),
    db.execute<{ claims_admitted: number | string }>(
      sql`SELECT claims_admitted FROM salvage_daily_admissions
          WHERE avatar_id = ${avatarId} AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
    ),
    db.execute<{ claims_admitted: number | string }>(
      sql`SELECT claims_admitted FROM salvage_owner_admissions
          WHERE owner_kind = 'user' AND owner_id = ${userId}
            AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
    ),
    readMaterialBalance(avatarId),
    db.execute<{ response: unknown }>(
      sql`SELECT response FROM salvage_claim_receipts
          WHERE avatar_id = ${avatarId} ORDER BY created_at DESC LIMIT 1`,
    ),
  ]);

  const byNode = new Map(
    Array.from(claimRows).map((row) => [row.node_id, row]),
  );
  const nodes = SALVAGE_NODES.map((node): SalvageNodeState => {
    const row = byNode.get(node.id);
    return {
      nodeId: node.id,
      band: node.band,
      x: node.x,
      z: node.z,
      nextClaimAt: row ? new Date(row.next_claim_at).toISOString() : null,
      ready: row ? row.ready === true : true,
    };
  });

  const claimsUsedToday = Number(dailyRows[0]?.claims_admitted ?? 0);
  const ownerClaimsUsedToday = Number(ownerRows[0]?.claims_admitted ?? 0);
  const lastResponse = lastRows[0]?.response;

  return {
    layoutVersion: SALVAGE_LAYOUT_VERSION,
    nodes,
    materialBalance: balance,
    claimsUsedToday,
    claimsRemainingToday: Math.max(0, SALVAGE_AVATAR_DAILY_CLAIM_CAP - claimsUsedToday),
    ownerClaimsUsedToday,
    ownerClaimsRemainingToday: Math.max(
      0,
      SALVAGE_OWNER_DAILY_CLAIM_CAP - ownerClaimsUsedToday,
    ),
    lastClaim: isPayload(lastResponse) ? lastResponse : null,
  };
}
