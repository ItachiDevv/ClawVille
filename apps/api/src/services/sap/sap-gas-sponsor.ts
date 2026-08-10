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
  bountyGasSponsorships,
  db,
  desc,
  eq,
  gte,
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

export interface GasSponsorContext {
  bountyId: string;
  leg: "settle" | "finalize";
}

export type GasSponsorFailureCode =
  | "gas_cap_exceeded"
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

interface BroadcastTransfer {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

type Reservation =
  | { kind: "reserved" }
  | { kind: "confirmed"; signature: string; lamports: bigint }
  | { kind: "unconfirmed"; signature: string; lamports: bigint }
  | { kind: "in_progress" }
  | { kind: "cap_exceeded"; usedLamports: bigint; capLamports: bigint };

export interface GasSponsorDeps {
  dryRun?: boolean;
  getBalance?: (wallet: PublicKey) => Promise<number>;
  loadGasKeypair?: () => Promise<Keypair>;
  reserve?: (input: {
    context: GasSponsorContext;
    workerWallet: string;
    lamports: bigint;
    capLamports: bigint;
  }) => Promise<Reservation>;
  broadcastTransfer?: (input: {
    gasKeypair: Keypair;
    workerWallet: PublicKey;
    lamports: number;
  }) => Promise<BroadcastTransfer>;
  markBroadcast?: (dedupeKey: string, signature: string) => Promise<void>;
  confirmTransfer?: (transfer: BroadcastTransfer) => Promise<void>;
  complete?: (input: {
    context: GasSponsorContext;
    workerWallet: string;
    lamports: bigint;
    signature: string;
  }) => Promise<void>;
  markFailed?: (dedupeKey: string) => Promise<void>;
  alert?: (params: AlertErrorParams) => Promise<void>;
}

let gasKeypairCache: Keypair | null = null;
let connectionCache: Connection | null = null;

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

function utcDayStart(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

async function reserveSponsorship(input: {
  context: GasSponsorContext;
  workerWallet: string;
  lamports: bigint;
  capLamports: bigint;
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
        lamports: bountyGasSponsorships.lamports,
        workerWallet: bountyGasSponsorships.workerWallet,
      })
      .from(bountyGasSponsorships)
      .where(eq(bountyGasSponsorships.dedupeKey, key))
      .limit(1);
    if (
      existing &&
      existing.status !== "failed" &&
      existing.workerWallet !== input.workerWallet
    ) {
      throw new Error(
        "gas sponsorship dedupe key is already bound to a different worker wallet",
      );
    }
    if (existing?.status === "confirmed" && existing.signature) {
      return {
        kind: "confirmed",
        signature: existing.signature,
        lamports: existing.lamports,
      };
    }
    if (existing?.status === "unconfirmed" && existing.signature) {
      return {
        kind: "unconfirmed",
        signature: existing.signature,
        lamports: existing.lamports,
      };
    }
    if (existing?.status === "pending") return { kind: "in_progress" };

    const [total] = await tx
      .select({
        lamports: sql<string>`COALESCE(SUM(${bountyGasSponsorships.lamports}), 0)`,
      })
      .from(bountyGasSponsorships)
      .where(
        and(
          gte(bountyGasSponsorships.createdAt, utcDayStart()),
          inArray(bountyGasSponsorships.status, [
            "pending",
            "unconfirmed",
            "confirmed",
          ]),
        ),
      );
    const usedLamports = BigInt(total?.lamports ?? "0");
    if (usedLamports + input.lamports > input.capLamports) {
      return {
        kind: "cap_exceeded",
        usedLamports,
        capLamports: input.capLamports,
      };
    }

    if (existing?.status === "failed") {
      await tx
        .update(bountyGasSponsorships)
        .set({
          status: "pending",
          signature: null,
          workerWallet: input.workerWallet,
          lamports: input.lamports,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bountyGasSponsorships.dedupeKey, key));
    } else {
      await tx.insert(bountyGasSponsorships).values({
        bountyId: input.context.bountyId,
        leg: input.context.leg,
        workerWallet: input.workerWallet,
        lamports: input.lamports,
        status: "pending",
        dedupeKey: key,
      });
    }
    return { kind: "reserved" };
  });
}

async function broadcastTransfer(input: {
  gasKeypair: Keypair;
  workerWallet: PublicKey;
  lamports: number;
}): Promise<BroadcastTransfer> {
  const connection = getConnection();
  const latest = await connection.getLatestBlockhash("confirmed");
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
  const signature = await connection.sendRawTransaction(tx.serialize());
  return { signature, ...latest };
}

async function markBroadcast(key: string, signature: string): Promise<void> {
  const marked = await db
    .update(bountyGasSponsorships)
    .set({ status: "unconfirmed", signature, updatedAt: new Date() })
    .where(
      and(
        eq(bountyGasSponsorships.dedupeKey, key),
        eq(bountyGasSponsorships.status, "pending"),
      ),
    )
    .returning({ id: bountyGasSponsorships.id });
  if (marked.length !== 1)
    throw new Error(
      "gas sponsorship reservation disappeared before broadcast bookkeeping",
    );
}

async function confirmTransfer(transfer: BroadcastTransfer): Promise<void> {
  if (!transfer.blockhash) {
    const status = (
      await getConnection().getSignatureStatuses([transfer.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (
      !status ||
      status.err ||
      !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
    ) {
      throw new Error(
        "previous gas sponsorship broadcast is not confirmed yet",
      );
    }
    return;
  }
  const confirmed = await getConnection().confirmTransaction(
    {
      signature: transfer.signature,
      blockhash: transfer.blockhash,
      lastValidBlockHeight: transfer.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmed.value.err) {
    throw new Error(
      `gas sponsorship transfer rejected: ${JSON.stringify(confirmed.value.err)}`,
    );
  }
}

async function completeSponsorship(input: {
  context: GasSponsorContext;
  workerWallet: string;
  lamports: bigint;
  signature: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const confirmed = await tx
      .update(bountyGasSponsorships)
      .set({
        status: "confirmed",
        signature: input.signature,
        updatedAt: new Date(),
      })
      .where(eq(bountyGasSponsorships.dedupeKey, dedupeKey(input.context)))
      .returning({ id: bountyGasSponsorships.id });
    if (confirmed.length !== 1)
      throw new Error("gas sponsorship reservation missing at confirmation");
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
        },
      },
      tx,
    );
  });
}

async function markFailed(key: string): Promise<void> {
  await db
    .update(bountyGasSponsorships)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(bountyGasSponsorships.dedupeKey, key),
        eq(bountyGasSponsorships.status, "pending"),
      ),
    );
}

/**
 * Ensure a composed-bounty settle/finalize signer has enough SOL for fees and
 * pending-account rent. The transfer is confirmed before success is returned.
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
  if (workerBalance >= floorLamports) {
    return {
      ok: true,
      sponsored: false,
      lamports: 0,
      reason: "balance_sufficient",
    };
  }

  const shortfall = floorLamports - workerBalance;
  const reserve = deps.reserve ?? reserveSponsorship;
  const alert = deps.alert ?? alertError;
  const key = dedupeKey(context);
  let reservation: Reservation;
  try {
    reservation = await reserve({
      context,
      workerWallet: workerWalletPubkey,
      lamports: shortfall,
      capLamports: bountyGasDailyCapLamports(),
    });
  } catch (err) {
    return {
      ok: false,
      code: "gas_sponsor_failed",
      message: `could not reserve gas sponsorship: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (reservation.kind === "cap_exceeded") {
    await alert({
      severity: "critical",
      source: "bounty-gas-sponsor",
      message: `Bounty gas daily cap exceeded for ${context.bountyId} (${context.leg}); refusing sponsorship.`,
      context: {
        bountyId: context.bountyId,
        leg: context.leg,
        requestedLamports: shortfall.toString(),
        usedLamports: reservation.usedLamports.toString(),
        capLamports: reservation.capLamports.toString(),
      },
    }).catch(() => undefined);
    return {
      ok: false,
      code: "gas_cap_exceeded",
      message: "bounty gas daily cap exceeded",
    };
  }
  if (reservation.kind === "in_progress") {
    return {
      ok: false,
      code: "gas_sponsorship_in_progress",
      message: "a gas sponsorship for this bounty leg is already in progress",
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

  const confirm = deps.confirmTransfer ?? confirmTransfer;
  const complete = deps.complete ?? completeSponsorship;
  const sponsoredLamports =
    reservation.kind === "unconfirmed" ? reservation.lamports : shortfall;
  let transfer: BroadcastTransfer;
  let broadcasted = reservation.kind === "unconfirmed";
  try {
    if (reservation.kind === "unconfirmed") {
      transfer = {
        signature: reservation.signature,
        blockhash: "",
        lastValidBlockHeight: 0,
      };
    } else {
      const gasKeypair = await (deps.loadGasKeypair ?? loadGasKeypair)();
      transfer = await (deps.broadcastTransfer ?? broadcastTransfer)({
        gasKeypair,
        workerWallet,
        lamports: Number(sponsoredLamports),
      });
      broadcasted = true;
      await (deps.markBroadcast ?? markBroadcast)(key, transfer.signature);
    }
    await confirm(transfer);
    await complete({
      context,
      workerWallet: workerWalletPubkey,
      lamports: sponsoredLamports,
      signature: transfer.signature,
    });
  } catch (err) {
    if (reservation.kind === "reserved" && !broadcasted) {
      await (deps.markFailed ?? markFailed)(key).catch(() => undefined);
    }
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
      await alert({
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
    }
  } catch {
    // Sponsorship is already confirmed. A warning read must not convert success to failure.
  }

  return {
    ok: true,
    sponsored: true,
    lamports: Number(sponsoredLamports),
    signature: transfer.signature,
    replay: reservation.kind === "unconfirmed",
  };
}
