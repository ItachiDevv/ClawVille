import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  and,
  bountyGasCapPolicies,
  bountyGasSponsorships,
  db,
  desc,
  eq,
  inArray,
  sql,
  treasuryWallets,
} from "@clawville/database";
import { decryptSecretKey } from "../keypair-vault";
import { alertError, type AlertErrorParams } from "../alert-error";
import { recordCovenantAction } from "../covenant-action-recorder";
import { loadSapConfig } from "./sap-config";

const GAS_FLOOR_SOL_DEFAULT = 0.006;
const GAS_FLOOR_SOL_MIN = 0.003;
const DAILY_CAP_SOL_DEFAULT = 0.15;
const DAILY_CAP_SOL_MIN = 0.01;
const GAS_CAP_LOCK_KEY = "bounty:sap-gas-sponsorship:daily-cap";
const GAS_CLAIM_STALE_MS = 2 * 60 * 1000;
const GAS_ALERT_WINDOW_MS = 60 * 60 * 1000;
const GAS_ALERT_THROTTLE_MAX = 1_024;
const gasAlertLastSentAt = new Map<string, number>();
let gasAlertCapacitySuppressed = 0;

export function _resetGasSponsorAlertThrottle(): void {
  gasAlertLastSentAt.clear();
  gasAlertCapacitySuppressed = 0;
}

export function _gasSponsorAlertThrottleSizeForTest(): number {
  return gasAlertLastSentAt.size;
}

async function emitConditionAlert(
  key: string,
  alert: (params: AlertErrorParams) => Promise<void>,
  params: AlertErrorParams,
): Promise<void> {
  const now = Date.now();
  for (const [condition, sentAt] of gasAlertLastSentAt) {
    if (now - sentAt >= GAS_ALERT_WINDOW_MS) gasAlertLastSentAt.delete(condition);
  }
  const last = gasAlertLastSentAt.get(key);
  if (last != null && now - last < GAS_ALERT_WINDOW_MS) return;
  if (!gasAlertLastSentAt.has(key) && gasAlertLastSentAt.size >= GAS_ALERT_THROTTLE_MAX) {
    gasAlertCapacitySuppressed += 1;
    console.warn(
      `[bounty-gas-sponsor] alert throttle at capacity; suppressed=${gasAlertCapacitySuppressed} key=${key}`,
    );
    return;
  }
  try {
    await alert(params);
    gasAlertLastSentAt.delete(key);
    gasAlertLastSentAt.set(key, now);
  } catch {
    // Failed delivery retries on the next worker pass.
  }
}

export interface GasSponsorContext {
  bountyId: string;
  leg: "settle" | "finalize";
}

export type GasSponsorFailureCode =
  | "gas_cap_exceeded"
  | "gas_cap_configuration_mismatch"
  | "gas_sponsor_failed"
  | "gas_sponsorship_in_progress";

export type GasSponsorResult =
  | {
      ok: true;
      sponsored: false;
      lamports: 0;
      reason: "balance_sufficient" | "dry_run";
    }
  | {
      ok: true;
      sponsored: true;
      lamports: number;
      signature: string;
      replay: boolean;
    }
  | { ok: false; code: GasSponsorFailureCode; message: string };

export interface SignedGasTransfer {
  signature: string;
  serializedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

type Reservation =
  | { kind: "not_found" }
  | {
      kind: "pending";
      transfer: SignedGasTransfer;
      lamports: bigint;
      claimId: string;
      replay: boolean;
    }
  | { kind: "confirmed"; signature: string; lamports: bigint }
  | { kind: "quarantined"; signature: string }
  | { kind: "in_progress" }
  | { kind: "corrupt"; message: string }
  | { kind: "cap_mismatch"; recordedCapLamports: bigint; callCapLamports: bigint }
  | { kind: "cap_exceeded"; capDay: string; usedLamports: bigint; capLamports: bigint };

type BroadcastAuthorization =
  | { kind: "authorized" }
  | { kind: "claim_lost" }
  | { kind: "corrupt"; message: string }
  | { kind: "cap_mismatch"; recordedCapLamports: bigint; callCapLamports: bigint }
  | { kind: "cap_exceeded"; capDay: string; usedLamports: bigint; capLamports: bigint };

type DayCapPolicy = { capDay: string; capLamports: bigint };

export type TransferInspection =
  | "confirmed"
  | "pending"
  | "missing_valid"
  | "expired_missing"
  | "confirmed_reverted";

export interface GasSponsorDeps {
  dryRun?: boolean;
  getBalance?: (wallet: PublicKey) => Promise<number>;
  loadGasKeypair?: () => Promise<Keypair>;
  prepareTransfer?: (input: {
    gasKeypair: Keypair;
    workerWallet: PublicKey;
    lamports: number;
  }) => Promise<SignedGasTransfer>;
  reserve?: (input: {
    context: GasSponsorContext;
    workerWallet: string;
    lamports: bigint;
    capLamports: bigint;
    transfer: SignedGasTransfer | null;
    claimId: string;
  }) => Promise<Reservation>;
  inspectTransfer?: (transfer: SignedGasTransfer) => Promise<TransferInspection>;
  authorizeBroadcast?: (input: {
    dedupeKey: string;
    claimId: string;
    capLamports: bigint;
  }) => Promise<BroadcastAuthorization>;
  sendTransfer?: (transfer: SignedGasTransfer) => Promise<string>;
  confirmTransfer?: (transfer: SignedGasTransfer) => Promise<"confirmed" | "failed" | "unknown">;
  complete?: (input: {
    context: GasSponsorContext;
    workerWallet: string;
    lamports: bigint;
    signature: string;
    claimId: string;
  }) => Promise<void>;
  releaseClaim?: (dedupeKey: string, claimId: string) => Promise<void>;
  markExpiredQuarantined?: (dedupeKey: string, claimId: string) => Promise<void>;
  markConfirmedRevertedFailed?: (dedupeKey: string, claimId: string) => Promise<void>;
  alert?: (params: AlertErrorParams) => Promise<void>;
}

let gasKeypairCache: Keypair | null = null;
let connectionCache: Connection | null = null;

/**
 * Claim/read the one database-owned policy for the current DB-UTC day. This is
 * always called while holding GAS_CAP_LOCK_KEY, so the first cap-consuming
 * admission owns the day's value and every later pod must agree with it.
 */
async function claimCurrentDayCapPolicy(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  callCapLamports: bigint,
): Promise<DayCapPolicy> {
  await tx
    .insert(bountyGasCapPolicies)
    .values({
      capDay: sql`(now() AT TIME ZONE 'utc')::date`,
      capLamports: callCapLamports,
      updatedAt: sql`now()`,
    })
    .onConflictDoNothing({ target: bountyGasCapPolicies.capDay });
  const [policy] = await tx
    .select({
      capDay: bountyGasCapPolicies.capDay,
      capLamports: bountyGasCapPolicies.capLamports,
    })
    .from(bountyGasCapPolicies)
    .where(eq(bountyGasCapPolicies.capDay, sql`(now() AT TIME ZONE 'utc')::date`))
    .limit(1);
  if (!policy) throw new Error("daily gas cap policy was not readable after claim");
  return policy;
}

async function readDayCapPolicy(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  capDay: string,
): Promise<DayCapPolicy | null> {
  const [policy] = await tx
    .select({
      capDay: bountyGasCapPolicies.capDay,
      capLamports: bountyGasCapPolicies.capLamports,
    })
    .from(bountyGasCapPolicies)
    .where(eq(bountyGasCapPolicies.capDay, capDay))
    .limit(1);
  return policy ?? null;
}

function configuredSol(name: string, fallback: number, floor: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.max(parsed, floor) : fallback;
}

export function bountySettleGasFloorLamports(): bigint {
  return BigInt(
    Math.ceil(
      configuredSol(
        "BOUNTY_SETTLE_GAS_FLOOR_SOL",
        GAS_FLOOR_SOL_DEFAULT,
        GAS_FLOOR_SOL_MIN,
      ) * LAMPORTS_PER_SOL,
    ),
  );
}

export function bountyGasDailyCapLamports(): bigint {
  return BigInt(
    Math.ceil(
      configuredSol(
        "BOUNTY_GAS_DAILY_CAP_SOL",
        DAILY_CAP_SOL_DEFAULT,
        DAILY_CAP_SOL_MIN,
      ) * LAMPORTS_PER_SOL,
    ),
  );
}

function dedupeKey(context: GasSponsorContext): string {
  return `bounty:${context.bountyId}:gas:${context.leg}`;
}

function getConnection(): Connection {
  if (!connectionCache) {
    connectionCache = new Connection(loadSapConfig().rpcUrl, "confirmed");
  }
  return connectionCache;
}

async function loadGasKeypair(): Promise<Keypair> {
  if (gasKeypairCache) return gasKeypairCache;
  const [row] = await db
    .select({
      publicKey: treasuryWallets.publicKey,
      encryptedSecretKey: treasuryWallets.encryptedSecretKey,
      encryptionIv: treasuryWallets.encryptionIv,
      encryptionTag: treasuryWallets.encryptionTag,
    })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.purpose, "sap-gas-sponsor"))
    .orderBy(desc(treasuryWallets.createdAt))
    .limit(1);
  if (!row) {
    throw new Error(
      "treasury_wallets purpose='sap-gas-sponsor' is missing; run scripts/sap/provision-gas-wallet.ts",
    );
  }
  const keypair = decryptSecretKey(
    row.encryptedSecretKey,
    row.encryptionIv,
    row.encryptionTag,
  );
  const actual = keypair.publicKey.toBase58();
  if (actual !== row.publicKey) {
    throw new Error(
      `sap-gas-sponsor pubkey mismatch: decrypted ${actual} != row public_key ${row.publicKey}; refusing to sign`,
    );
  }
  gasKeypairCache = keypair;
  return keypair;
}

async function prepareTransfer(input: {
  gasKeypair: Keypair;
  workerWallet: PublicKey;
  lamports: number;
}): Promise<SignedGasTransfer> {
  const latest = await getConnection().getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: input.gasKeypair.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: input.gasKeypair.publicKey,
      toPubkey: input.workerWallet,
      lamports: input.lamports,
    }),
  );
  tx.sign(input.gasKeypair);
  if (!tx.signature) throw new Error("gas sponsorship signing produced no signature");
  return {
    signature: bs58.encode(tx.signature),
    serializedTransaction: Buffer.from(tx.serialize()).toString("base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

function transferFromRow(row: {
  signature: string | null;
  serializedTransaction: string | null;
  blockhash: string | null;
  lastValidBlockHeight: bigint | null;
}): SignedGasTransfer | null {
  if (
    !row.signature ||
    !row.serializedTransaction ||
    !row.blockhash ||
    row.lastValidBlockHeight == null
  ) {
    return null;
  }
  return {
    signature: row.signature,
    serializedTransaction: row.serializedTransaction,
    blockhash: row.blockhash,
    lastValidBlockHeight: Number(row.lastValidBlockHeight),
  };
}

async function reserveSponsorship(input: {
  context: GasSponsorContext;
  workerWallet: string;
  lamports: bigint;
  capLamports: bigint;
  transfer: SignedGasTransfer | null;
  claimId: string;
}): Promise<Reservation> {
  const key = dedupeKey(input.context);
  return db.transaction(async (tx): Promise<Reservation> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${GAS_CAP_LOCK_KEY}, 0))`,
    );
    const [existing] = await tx
      .select({
        status: bountyGasSponsorships.status,
        signature: bountyGasSponsorships.signature,
        serializedTransaction: bountyGasSponsorships.serializedTransaction,
        blockhash: bountyGasSponsorships.blockhash,
        lastValidBlockHeight: bountyGasSponsorships.lastValidBlockHeight,
        lamports: bountyGasSponsorships.lamports,
        capDay: bountyGasSponsorships.capDay,
        capLamports: bountyGasSponsorships.capLamports,
        workerWallet: bountyGasSponsorships.workerWallet,
      })
      .from(bountyGasSponsorships)
      .where(eq(bountyGasSponsorships.dedupeKey, key))
      .limit(1);

    if (existing && existing.workerWallet !== input.workerWallet) {
      throw new Error(
        "gas sponsorship dedupe key is already bound to a different worker wallet",
      );
    }
    if (existing && existing.status !== "failed") {
      const policy = await readDayCapPolicy(tx, existing.capDay);
      if (!policy) {
        return {
          kind: "corrupt",
          message: "gas sponsorship references a missing daily cap policy",
        };
      }
      // M2 — historical integrity is checked against the row that was admitted
      // that day. The caller's current env cap is only relevant when the pending
      // row is re-homed for today's broadcast admission below.
      if (policy.capLamports !== existing.capLamports) {
        return {
          kind: "corrupt",
          message: "gas sponsorship cap does not match its stored daily policy",
        };
      }
      if (existing.status === "confirmed") {
        return {
          kind: "confirmed",
          signature: existing.signature,
          lamports: existing.lamports,
        };
      }
      if (existing.status === "quarantined") {
        return { kind: "quarantined", signature: existing.signature };
      }
      const transfer = transferFromRow(existing);
      if (!transfer) {
        return {
          kind: "corrupt",
          message:
            "pending gas sponsorship is missing captured signature or blockhash proof material",
        };
      }
      const claimed = await tx
        .update(bountyGasSponsorships)
        .set({
          status: "pending",
          claimId: input.claimId,
          claimedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bountyGasSponsorships.dedupeKey, key),
            inArray(bountyGasSponsorships.status, ["pending", "unconfirmed"]),
            sql`(
              ${bountyGasSponsorships.claimedAt} IS NULL
              OR ${bountyGasSponsorships.claimedAt} <
                now() - (${GAS_CLAIM_STALE_MS} * interval '1 millisecond')
            )`,
          ),
        )
        .returning({ id: bountyGasSponsorships.id });
      if (claimed.length !== 1) return { kind: "in_progress" };
      return {
        kind: "pending",
        transfer,
        lamports: existing.lamports,
        claimId: input.claimId,
        replay: true,
      };
    }

    if (!input.transfer) return { kind: "not_found" };

    const policy = await claimCurrentDayCapPolicy(tx, input.capLamports);
    if (policy.capLamports !== input.capLamports) {
      return {
        kind: "cap_mismatch",
        recordedCapLamports: policy.capLamports,
        callCapLamports: input.capLamports,
      };
    }

    const [usage] = await tx.execute<{
      used_lamports: string;
      exceeds_cap: boolean;
    }>(sql`
      SELECT
        COALESCE(SUM(lamports), 0)::text AS used_lamports,
        COALESCE(SUM(lamports), 0) + ${input.lamports} > ${policy.capLamports}
          AS exceeds_cap
      FROM bounty_gas_sponsorships
      WHERE cap_day = ${policy.capDay}::date
        AND status IN ('pending', 'unconfirmed', 'quarantined', 'confirmed')
        AND dedupe_key <> ${key}
    `);
    const usedLamports = BigInt(usage?.used_lamports ?? "0");
    if (usage?.exceeds_cap) {
      return {
        kind: "cap_exceeded",
        capDay: policy.capDay,
        usedLamports,
        capLamports: policy.capLamports,
      };
    }

    const values = {
      bountyId: input.context.bountyId,
      leg: input.context.leg,
      workerWallet: input.workerWallet,
      lamports: input.lamports,
      capDay: policy.capDay,
      capLamports: policy.capLamports,
      status: "pending",
      signature: input.transfer.signature,
      serializedTransaction: input.transfer.serializedTransaction,
      blockhash: input.transfer.blockhash,
      lastValidBlockHeight: BigInt(input.transfer.lastValidBlockHeight),
      claimId: input.claimId,
      claimedAt: sql`now()`,
      dedupeKey: key,
      updatedAt: sql`now()`,
    } as const;

    if (existing?.status === "failed") {
      await tx
        .update(bountyGasSponsorships)
        .set({ ...values, createdAt: sql`now()` })
        .where(eq(bountyGasSponsorships.dedupeKey, key));
    } else {
      await tx.insert(bountyGasSponsorships).values(values);
    }
    return {
      kind: "pending",
      transfer: input.transfer,
      lamports: input.lamports,
      claimId: input.claimId,
      replay: false,
    };
  });
}

/** Test-only entry to exercise the real transaction/advisory-lock admission path. */
export async function _reserveSponsorshipForTest(input: {
  context: GasSponsorContext;
  workerWallet: string;
  lamports: bigint;
  capLamports: bigint;
  transfer: SignedGasTransfer | null;
  claimId: string;
}): Promise<Reservation> {
  return reserveSponsorship(input);
}

async function authorizeBroadcast(input: {
  dedupeKey: string;
  claimId: string;
  capLamports: bigint;
}): Promise<BroadcastAuthorization> {
  return db.transaction(async (tx): Promise<BroadcastAuthorization> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${GAS_CAP_LOCK_KEY}, 0))`,
    );
    const [row] = await tx
      .select({
        status: bountyGasSponsorships.status,
        claimId: bountyGasSponsorships.claimId,
        lamports: bountyGasSponsorships.lamports,
        capDay: bountyGasSponsorships.capDay,
        capLamports: bountyGasSponsorships.capLamports,
      })
      .from(bountyGasSponsorships)
      .where(eq(bountyGasSponsorships.dedupeKey, input.dedupeKey))
      .limit(1);
    if (!row || row.status !== "pending" || row.claimId !== input.claimId) {
      return { kind: "claim_lost" };
    }
    const historicalPolicy = await readDayCapPolicy(tx, row.capDay);
    if (!historicalPolicy || historicalPolicy.capLamports !== row.capLamports) {
      return {
        kind: "corrupt",
        message: "gas sponsorship cap does not match its stored historical policy",
      };
    }
    const policy = await claimCurrentDayCapPolicy(tx, input.capLamports);
    if (policy.capLamports !== input.capLamports) {
      return {
        kind: "cap_mismatch",
        recordedCapLamports: policy.capLamports,
        callCapLamports: input.capLamports,
      };
    }
    const [usage] = await tx.execute<{
      used_lamports: string;
      exceeds_cap: boolean;
    }>(sql`
      SELECT
        COALESCE(SUM(lamports), 0)::text AS used_lamports,
        COALESCE(SUM(lamports), 0) + ${row.lamports} > ${policy.capLamports}
          AS exceeds_cap
      FROM bounty_gas_sponsorships
      WHERE cap_day = ${policy.capDay}::date
        AND status IN ('pending', 'unconfirmed', 'quarantined', 'confirmed')
        AND dedupe_key <> ${input.dedupeKey}
    `);
    const usedLamports = BigInt(usage?.used_lamports ?? "0");
    if (usage?.exceeds_cap) {
      return {
        kind: "cap_exceeded",
        capDay: policy.capDay,
        usedLamports,
        capLamports: policy.capLamports,
      };
    }
    const updated = await tx
      .update(bountyGasSponsorships)
      .set({
        capDay: policy.capDay,
        capLamports: policy.capLamports,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bountyGasSponsorships.dedupeKey, input.dedupeKey),
          eq(bountyGasSponsorships.status, "pending"),
          eq(bountyGasSponsorships.claimId, input.claimId),
        ),
      )
      .returning({ id: bountyGasSponsorships.id });
    return updated.length === 1 ? { kind: "authorized" } : { kind: "claim_lost" };
  });
}

/** Test-only entry for current-day re-admission of a historical pending row. */
export async function _authorizeBroadcastForTest(input: {
  dedupeKey: string;
  claimId: string;
  capLamports: bigint;
}): Promise<BroadcastAuthorization> {
  return authorizeBroadcast(input);
}

async function inspectTransfer(transfer: SignedGasTransfer): Promise<TransferInspection> {
  const connection = getConnection();
  const status = (
    await connection.getSignatureStatuses([transfer.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (status?.err) return "confirmed_reverted";
  if (
    status &&
    ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
  ) {
    return "confirmed";
  }
  if (status) return "pending";
  const blockHeight = await connection.getBlockHeight("confirmed");
  return blockHeight > transfer.lastValidBlockHeight
    ? "expired_missing"
    : "missing_valid";
}

async function sendTransfer(transfer: SignedGasTransfer): Promise<string> {
  return getConnection().sendRawTransaction(
    Buffer.from(transfer.serializedTransaction, "base64"),
  );
}

async function confirmTransfer(
  transfer: SignedGasTransfer,
): Promise<"confirmed" | "failed" | "unknown"> {
  try {
    const confirmed = await getConnection().confirmTransaction(
      {
        signature: transfer.signature,
        blockhash: transfer.blockhash,
        lastValidBlockHeight: transfer.lastValidBlockHeight,
      },
      "confirmed",
    );
    return confirmed.value.err ? "failed" : "confirmed";
  } catch {
    return "unknown";
  }
}

async function completeSponsorship(input: {
  context: GasSponsorContext;
  workerWallet: string;
  lamports: bigint;
  signature: string;
  claimId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const confirmed = await tx
      .update(bountyGasSponsorships)
      .set({
        status: "confirmed",
        claimId: null,
        claimedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(bountyGasSponsorships.dedupeKey, dedupeKey(input.context)),
          eq(bountyGasSponsorships.status, "pending"),
          eq(bountyGasSponsorships.claimId, input.claimId),
          eq(bountyGasSponsorships.signature, input.signature),
        ),
      )
      .returning({ id: bountyGasSponsorships.id });
    if (confirmed.length !== 1) {
      throw new Error("gas sponsorship claim disappeared before confirmation bookkeeping");
    }
    await recordCovenantAction(
      {
        action: "bounty.gas_sponsored",
        subjectType: "system",
        subjectId: "sap-gas-sponsor",
        actorKind: "system",
        dedupeKey: dedupeKey(input.context),
        payload: {
          bountyId: input.context.bountyId,
          leg: input.context.leg,
          lamports: Number(input.lamports),
          workerWallet: input.workerWallet,
          signature: input.signature,
        },
      },
      tx,
    );
  });
}

async function releaseClaim(key: string, claimId: string): Promise<void> {
  await db
    .update(bountyGasSponsorships)
    .set({ claimId: null, claimedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(bountyGasSponsorships.dedupeKey, key),
        eq(bountyGasSponsorships.status, "pending"),
        eq(bountyGasSponsorships.claimId, claimId),
      ),
    );
}

async function markExpiredQuarantined(key: string, claimId: string): Promise<void> {
  await db
    .update(bountyGasSponsorships)
    .set({
      status: "quarantined",
      claimId: null,
      claimedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(bountyGasSponsorships.dedupeKey, key),
        eq(bountyGasSponsorships.status, "pending"),
        eq(bountyGasSponsorships.claimId, claimId),
      ),
    );
}

async function markConfirmedRevertedFailed(key: string, claimId: string): Promise<void> {
  await db
    .update(bountyGasSponsorships)
    .set({
      status: "failed",
      claimId: null,
      claimedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(bountyGasSponsorships.dedupeKey, key),
        eq(bountyGasSponsorships.status, "pending"),
        eq(bountyGasSponsorships.claimId, claimId),
      ),
    );
}

async function emitCapAlert(
  alert: (params: AlertErrorParams) => Promise<void>,
  context: GasSponsorContext,
  capDay: string,
  requestedLamports: bigint,
  usedLamports: bigint,
  capLamports: bigint,
): Promise<void> {
  // M1 — cap exhaustion is one global condition per DB-UTC day. The triggering
  // bounty remains diagnostic context but must not multiply pages.
  await emitConditionAlert(`cap:${capDay}`, alert, {
    severity: "critical",
    source: "bounty-gas-sponsor",
    message: `Bounty gas daily cap exceeded for ${context.bountyId} (${context.leg}); refusing sponsorship.`,
    context: {
      bountyId: context.bountyId,
      leg: context.leg,
      capDay,
      requestedLamports: requestedLamports.toString(),
      usedLamports: usedLamports.toString(),
      capLamports: capLamports.toString(),
    },
  });
}

/**
 * Ensure a composed-bounty settle/finalize signer has enough SOL. A transaction
 * is signed and its exact bytes are durably captured before any RPC send. Every
 * ambiguous attempt stays cap-counted and retries only those captured bytes.
 */
export async function ensureSettleGas(
  workerWalletPubkey: string,
  context: GasSponsorContext,
  deps: GasSponsorDeps = {},
): Promise<GasSponsorResult> {
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(workerWalletPubkey);
  } catch {
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: "worker wallet pubkey is invalid",
    };
  }

  if (deps.dryRun ?? loadSapConfig().dryRun) {
    return { ok: true, sponsored: false, lamports: 0, reason: "dry_run" };
  }

  const getBalance =
    deps.getBalance ??
    ((wallet: PublicKey) => getConnection().getBalance(wallet, "confirmed"));
  const floorLamports = bountySettleGasFloorLamports();
  let workerBalance: bigint;
  try {
    workerBalance = BigInt(await getBalance(workerWallet));
  } catch (err) {
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `could not read worker SOL balance: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const shortfall = workerBalance >= floorLamports ? 0n : floorLamports - workerBalance;
  const capLamports = bountyGasDailyCapLamports();
  const alert = deps.alert ?? alertError;
  const key = dedupeKey(context);
  const claimId = randomUUID();
  const reserve = deps.reserve ?? reserveSponsorship;
  let reservation: Reservation;
  try {
    reservation = await reserve({
      context,
      workerWallet: workerWalletPubkey,
      lamports: shortfall,
      capLamports,
      transfer: null,
      claimId,
    });
  } catch (err) {
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `could not inspect gas sponsorship reservation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (reservation.kind === "not_found") {
    if (workerBalance >= floorLamports) {
      return {
        ok: true,
        sponsored: false,
        lamports: 0,
        reason: "balance_sufficient",
      };
    }
    let prepared: SignedGasTransfer;
    try {
      const gasKeypair = await (deps.loadGasKeypair ?? loadGasKeypair)();
      prepared = await (deps.prepareTransfer ?? prepareTransfer)({
        gasKeypair,
        workerWallet,
        lamports: Number(shortfall),
      });
    } catch (err) {
      return {
        ok: false,
        code: "gas_sponsor_failed",
        message: `could not sign gas sponsorship: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      reservation = await reserve({
        context,
        workerWallet: workerWalletPubkey,
        lamports: shortfall,
        capLamports,
        transfer: prepared,
        claimId,
      });
    } catch (err) {
      return {
        ok: false,
        code: "gas_sponsor_failed",
        message: `could not reserve gas sponsorship: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (reservation.kind === "not_found") {
      return {
        ok: false,
        code: "gas_sponsor_failed",
        message: "gas sponsorship reservation was not persisted",
      };
    }
  }

  if (reservation.kind === "cap_exceeded") {
    await emitCapAlert(
      alert,
      context,
      reservation.capDay,
      shortfall,
      reservation.usedLamports,
      reservation.capLamports,
    );
    return {
      ok: false,
      code: "gas_cap_exceeded",
      message: "bounty gas daily cap exceeded",
    };
  }
  if (reservation.kind === "cap_mismatch") {
    return {
      ok: false,
      code: "gas_cap_configuration_mismatch",
      message:
        "gas sponsorship reservation cap differs from this instance configuration",
    };
  }
  if (reservation.kind === "corrupt") {
    return { ok: false, code: "gas_sponsor_failed", message: reservation.message };
  }
  if (reservation.kind === "in_progress") {
    return {
      ok: false,
      code: "gas_sponsorship_in_progress",
      message: "a gas sponsorship for this bounty leg is already in progress",
    };
  }
  if (reservation.kind === "quarantined") {
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `gas sponsorship ${reservation.signature} is quarantined for operator reconciliation`,
    };
  }
  if (reservation.kind === "confirmed") {
    return {
      ok: true,
      sponsored: true,
      lamports: Number(reservation.lamports),
      signature: reservation.signature,
      replay: true,
    };
  }

  const transfer = reservation.transfer;
  const inspect = deps.inspectTransfer ?? inspectTransfer;
  const release = deps.releaseClaim ?? releaseClaim;
  const quarantineExpired = deps.markExpiredQuarantined ?? markExpiredQuarantined;
  const failConfirmedRevert =
    deps.markConfirmedRevertedFailed ?? markConfirmedRevertedFailed;
  const complete = deps.complete ?? completeSponsorship;
  let inspection: TransferInspection;
  try {
    inspection = await inspect(transfer);
  } catch (err) {
    await release(key, reservation.claimId).catch(() => undefined);
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `could not reconcile captured gas sponsorship: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (inspection === "expired_missing") {
    await quarantineExpired(key, reservation.claimId).catch(() => undefined);
    await emitConditionAlert(`expired-missing:${transfer.signature}`, alert, {
      severity: "critical",
      source: "bounty-gas-sponsor",
      message: `Captured gas sponsorship ${transfer.signature} expired with no signature history and is quarantined for reconciliation.`,
      context: { bountyId: context.bountyId, leg: context.leg, signature: transfer.signature },
    });
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message:
        "captured gas sponsorship expired with no signature history; captured bytes remain quarantined and cap-counted for reconciliation",
    };
  }
  if (inspection === "confirmed_reverted") {
    await failConfirmedRevert(key, reservation.claimId).catch(() => undefined);
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: "captured gas sponsorship was confirmed reverted; a later attempt may reserve new bytes",
    };
  }

  try {
    if (inspection !== "confirmed") {
      const authorization = await (deps.authorizeBroadcast ?? authorizeBroadcast)({
        dedupeKey: key,
        claimId: reservation.claimId,
        capLamports,
      });
      if (authorization.kind === "cap_mismatch") {
        await release(key, reservation.claimId).catch(() => undefined);
        return {
          ok: false,
          code: "gas_cap_configuration_mismatch",
          message:
            "gas sponsorship reservation cap differs from this instance configuration",
        };
      }
      if (authorization.kind === "corrupt") {
        await release(key, reservation.claimId).catch(() => undefined);
        return {
          ok: false,
          code: "gas_sponsor_failed",
          message: authorization.message,
        };
      }
      if (authorization.kind === "cap_exceeded") {
        await release(key, reservation.claimId).catch(() => undefined);
        await emitCapAlert(
          alert,
          context,
          authorization.capDay,
          reservation.lamports,
          authorization.usedLamports,
          authorization.capLamports,
        );
        return {
          ok: false,
          code: "gas_cap_exceeded",
          message: "bounty gas daily cap exceeded before broadcast",
        };
      }
      if (authorization.kind === "claim_lost") {
        return {
          ok: false,
          code: "gas_sponsorship_in_progress",
          message: "gas sponsorship claim changed before broadcast",
        };
      }

      const sentSignature = await (deps.sendTransfer ?? sendTransfer)(transfer);
      if (sentSignature !== transfer.signature) {
        throw new Error("RPC returned a signature different from the captured transaction signature");
      }
      const confirmation = await (deps.confirmTransfer ?? confirmTransfer)(transfer);
      if (confirmation !== "confirmed") {
        const after = await inspect(transfer);
        if (after === "expired_missing") {
          await quarantineExpired(key, reservation.claimId);
          await emitConditionAlert(`expired-missing:${transfer.signature}`, alert, {
            severity: "critical",
            source: "bounty-gas-sponsor",
            message: `Captured gas sponsorship ${transfer.signature} expired with no signature history and is quarantined for reconciliation.`,
            context: { bountyId: context.bountyId, leg: context.leg, signature: transfer.signature },
          });
          return {
            ok: false,
            code: "gas_sponsor_failed",
            message:
              "gas sponsorship expired after broadcast with no signature history; captured bytes remain quarantined and cap-counted",
          };
        } else if (after === "confirmed_reverted") {
          await failConfirmedRevert(key, reservation.claimId);
          return {
            ok: false,
            code: "gas_sponsor_failed",
            message:
              "gas sponsorship was confirmed reverted; a later attempt may reserve new bytes",
          };
        } else if (after === "confirmed") {
          inspection = "confirmed";
        } else {
          await release(key, reservation.claimId);
          return {
            ok: false,
            code: "gas_sponsor_failed",
            message:
              "gas sponsorship confirmation is ambiguous; the captured bytes remain pending and cap-counted",
          };
        }
      }
    }

    await complete({
      context,
      workerWallet: workerWalletPubkey,
      lamports: reservation.lamports,
      signature: transfer.signature,
      claimId: reservation.claimId,
    });
  } catch (err) {
    await release(key, reservation.claimId).catch(() => undefined);
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `gas sponsorship did not confirm: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const gasKeypair = await (deps.loadGasKeypair ?? loadGasKeypair)();
    const gasBalance = await getBalance(gasKeypair.publicKey);
    if (BigInt(gasBalance) < floorLamports * 10n) {
      const lowBalanceKey = `low-balance:${gasKeypair.publicKey.toBase58()}`;
      await emitConditionAlert(lowBalanceKey, alert, {
        severity: "warning",
        source: "bounty-gas-sponsor",
        message:
          "SAP bounty gas sponsor wallet is below ten settles of configured headroom.",
        context: {
          gasWallet: gasKeypair.publicKey.toBase58(),
          balanceLamports: String(gasBalance),
          warningThresholdLamports: (floorLamports * 10n).toString(),
        },
      });
    } else {
      gasAlertLastSentAt.delete(`low-balance:${gasKeypair.publicKey.toBase58()}`);
    }
  } catch {
    // A warning read cannot convert a confirmed transfer into a failure.
  }

  return {
    ok: true,
    sponsored: true,
    lamports: Number(reservation.lamports),
    signature: transfer.signature,
    replay: reservation.replay,
  };
}
