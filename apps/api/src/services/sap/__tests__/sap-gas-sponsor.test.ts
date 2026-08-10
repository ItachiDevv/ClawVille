import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  bountyGasDailyCapLamports,
  bountySettleGasFloorLamports,
  ensureSettleGas,
  _gasSponsorAlertThrottleSizeForTest,
  _resetGasSponsorAlertThrottle,
  type GasSponsorDeps,
  type SignedGasTransfer,
} from "../sap-gas-sponsor";

const BOUNTY_ID = "550e8400-e29b-41d4-a716-446655440000";
const context = { bountyId: BOUNTY_ID, leg: "settle" as const };
const originalFloor = process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL;
const originalCap = process.env.BOUNTY_GAS_DAILY_CAP_SOL;

const captured = (suffix = "a"): SignedGasTransfer => ({
  signature: `gas-sig-${suffix}`,
  serializedTransaction: Buffer.from(`signed-transaction-${suffix}`).toString("base64"),
  blockhash: `blockhash-${suffix}`,
  lastValidBlockHeight: 123,
});

afterEach(() => {
  _resetGasSponsorAlertThrottle();
  if (originalFloor === undefined)
    delete process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL;
  else process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL = originalFloor;
  if (originalCap === undefined) delete process.env.BOUNTY_GAS_DAILY_CAP_SOL;
  else process.env.BOUNTY_GAS_DAILY_CAP_SOL = originalCap;
});

function liveDeps(overrides: GasSponsorDeps = {}): GasSponsorDeps {
  const gas = Keypair.generate();
  return {
    dryRun: false,
    getBalance: async () => 0,
    loadGasKeypair: async () => gas,
    prepareTransfer: async () => captured(),
    reserve: async ({ transfer, lamports, claimId }) =>
      transfer
        ? {
            kind: "pending",
            transfer,
            lamports,
            claimId,
            replay: false,
          }
        : { kind: "not_found" },
    inspectTransfer: async () => "missing_valid",
    authorizeBroadcast: async () => ({ kind: "authorized" }),
    sendTransfer: async (transfer) => transfer.signature,
    confirmTransfer: async () => "confirmed",
    complete: async () => undefined,
    releaseClaim: async () => undefined,
    markExpiredQuarantined: async () => undefined,
    markConfirmedRevertedFailed: async () => undefined,
    alert: async () => undefined,
    ...overrides,
  };
}

describe("ensureSettleGas", () => {
  it("clamps a configured floor below 0.003 SOL", () => {
    process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL = "0.001";
    expect(bountySettleGasFloorLamports()).toBe(3_000_000n);
  });

  it("clamps a configured daily cap below 0.01 SOL", () => {
    process.env.BOUNTY_GAS_DAILY_CAP_SOL = "0";
    expect(bountyGasDailyCapLamports()).toBe(10_000_000n);
  });

  it("is a no-op when the worker already meets the gas floor", async () => {
    const worker = Keypair.generate().publicKey;
    let prepared = false;
    const result = await ensureSettleGas(worker.toBase58(), context, {
      dryRun: false,
      getBalance: async () => Number(bountySettleGasFloorLamports()),
      reserve: async () => ({ kind: "not_found" }),
      prepareTransfer: async () => {
        prepared = true;
        return captured();
      },
    });
    expect(result).toEqual({
      ok: true,
      sponsored: false,
      lamports: 0,
      reason: "balance_sufficient",
    });
    expect(prepared).toBe(false);
  });

  it("reconciles a captured pending row even when its ambiguous send already raised the balance", async () => {
    const worker = Keypair.generate().publicKey;
    const original = captured("landed-before-restart");
    let prepared = false;
    let completed = false;
    const result = await ensureSettleGas(worker.toBase58(), context, liveDeps({
      getBalance: async (wallet) =>
        wallet.equals(worker)
          ? Number(bountySettleGasFloorLamports())
          : LAMPORTS_PER_SOL,
      prepareTransfer: async () => {
        prepared = true;
        return captured("replacement-forbidden");
      },
      reserve: async ({ claimId }) => ({
        kind: "pending",
        transfer: original,
        lamports: bountySettleGasFloorLamports(),
        claimId,
        replay: true,
      }),
      inspectTransfer: async () => "confirmed",
      complete: async () => {
        completed = true;
      },
    }));
    expect(result).toMatchObject({
      ok: true,
      sponsored: true,
      signature: original.signature,
      replay: true,
    });
    expect(prepared).toBe(false);
    expect(completed).toBe(true);
  });

  it("captures signed bytes and expiry proof before the exact bytes are sent", async () => {
    process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL = "0.006";
    const worker = Keypair.generate().publicKey;
    const transfer = captured("capture-first");
    const calls: string[] = [];
    let reservedTransfer: SignedGasTransfer | null = null;
    let sentTransfer: SignedGasTransfer | null = null;
    const result = await ensureSettleGas(worker.toBase58(), context, liveDeps({
      getBalance: async (wallet) =>
        wallet.equals(worker) ? 2_000_000 : LAMPORTS_PER_SOL,
      prepareTransfer: async () => {
        calls.push("signed");
        return transfer;
      },
      reserve: async ({ transfer: persisted, lamports, claimId }) => {
        if (!persisted) return { kind: "not_found" };
        calls.push("captured");
        reservedTransfer = persisted;
        return {
          kind: "pending",
          transfer: persisted,
          lamports,
          claimId,
          replay: false,
        };
      },
      inspectTransfer: async () => {
        calls.push("inspected");
        return "missing_valid";
      },
      authorizeBroadcast: async () => {
        calls.push("cap-revalidated");
        return { kind: "authorized" };
      },
      sendTransfer: async (persisted) => {
        calls.push("sent");
        sentTransfer = persisted;
        return persisted.signature;
      },
      confirmTransfer: async () => {
        calls.push("confirmed");
        return "confirmed";
      },
      complete: async () => {
        calls.push("completed");
      },
    }));
    expect(result).toEqual({
      ok: true,
      sponsored: true,
      lamports: 4_000_000,
      signature: transfer.signature,
      replay: false,
    });
    expect(JSON.stringify(reservedTransfer)).toBe(JSON.stringify(transfer));
    expect(JSON.stringify(sentTransfer)).toBe(JSON.stringify(transfer));
    expect(calls).toEqual([
      "signed",
      "captured",
      "inspected",
      "cap-revalidated",
      "sent",
      "confirmed",
      "completed",
    ]);
  });

  it("an ambiguous send remains pending and a takeover retries identical captured bytes", async () => {
    const worker = Keypair.generate().publicKey;
    const original = captured("original");
    const newlyPrepared = captured("must-not-replace-original");
    const sentBytes: string[] = [];
    let pass = 0;
    let releases = 0;
    let completed = 0;
    const deps = liveDeps({
      prepareTransfer: async () => (pass === 0 ? original : newlyPrepared),
      reserve: async ({ transfer, lamports, claimId }) => {
        if (pass === 0 && !transfer) return { kind: "not_found" };
        return {
          kind: "pending",
          transfer: pass === 0 ? transfer! : original,
          lamports: pass === 0 ? lamports : bountySettleGasFloorLamports(),
          claimId,
          replay: pass > 0,
        };
      },
      sendTransfer: async (transfer) => {
        sentBytes.push(transfer.serializedTransaction);
        if (pass === 0) throw new Error("RPC response lost after send");
        return transfer.signature;
      },
      releaseClaim: async () => {
        releases += 1;
      },
      complete: async () => {
        completed += 1;
      },
    });

    const first = await ensureSettleGas(worker.toBase58(), context, deps);
    pass = 1;
    const second = await ensureSettleGas(worker.toBase58(), context, deps);

    expect(first).toMatchObject({ ok: false, code: "gas_sponsor_failed" });
    expect(second).toEqual({
      ok: true,
      sponsored: true,
      lamports: Number(bountySettleGasFloorLamports()),
      signature: original.signature,
      replay: true,
    });
    expect(sentBytes).toEqual([
      original.serializedTransaction,
      original.serializedTransaction,
    ]);
    expect(releases).toBe(1);
    expect(completed).toBe(1);
  });

  it("quarantines expired-missing capture, keeps it cap-counted, and alerts once", async () => {
    const worker = Keypair.generate().publicKey;
    let quarantined = 0;
    let markedFailed = 0;
    let sent = 0;
    const alerts: AlertErrorParamsLike[] = [];
    const deps = liveDeps({
      inspectTransfer: async () => "expired_missing",
      sendTransfer: async (transfer) => {
        sent += 1;
        return transfer.signature;
      },
      markExpiredQuarantined: async () => {
        quarantined += 1;
      },
      markConfirmedRevertedFailed: async () => {
        markedFailed += 1;
      },
      alert: async (alert) => { alerts.push(alert); },
    });
    const result = await ensureSettleGas(worker.toBase58(), context, deps);
    await ensureSettleGas(worker.toBase58(), context, deps);
    expect(result).toMatchObject({ ok: false, code: "gas_sponsor_failed" });
    if (!result.ok) expect(result.message).toContain("quarantined and cap-counted");
    expect(quarantined).toBe(2);
    expect(markedFailed).toBe(0);
    expect(sent).toBe(0);
    expect(alerts).toHaveLength(1);
  });

  it("an ambiguous confirmation stays cap-counted and is never marked failed", async () => {
    const worker = Keypair.generate().publicKey;
    let inspections = 0;
    let released = 0;
    let markedFailed = 0;
    const result = await ensureSettleGas(worker.toBase58(), context, liveDeps({
      inspectTransfer: async () => {
        inspections += 1;
        return inspections === 1 ? "missing_valid" : "pending";
      },
      confirmTransfer: async () => "unknown",
      releaseClaim: async () => {
        released += 1;
      },
      markExpiredQuarantined: async () => {
        markedFailed += 1;
      },
    }));
    expect(result).toMatchObject({ ok: false, code: "gas_sponsor_failed" });
    expect(released).toBe(1);
    expect(markedFailed).toBe(0);
  });

  it("a confirmed revert is the only inspection that releases the row to failed", async () => {
    const worker = Keypair.generate().publicKey;
    let failed = 0;
    let quarantined = 0;
    const result = await ensureSettleGas(worker.toBase58(), context, liveDeps({
      inspectTransfer: async () => "confirmed_reverted",
      markConfirmedRevertedFailed: async () => { failed += 1; },
      markExpiredQuarantined: async () => { quarantined += 1; },
    }));

    expect(result).toMatchObject({ ok: false, code: "gas_sponsor_failed" });
    if (!result.ok) expect(result.message).toContain("confirmed reverted");
    expect(failed).toBe(1);
    expect(quarantined).toBe(0);
  });

  it("M1 — a DB-UTC cap exhaustion alerts globally once across bounties", async () => {
    const worker = Keypair.generate().publicKey;
    const alerts: AlertErrorParamsLike[] = [];
    let sent = false;
    const deps = liveDeps({
      authorizeBroadcast: async () => ({
        kind: "cap_exceeded",
        capDay: "2026-08-10",
        usedLamports: 149_000_000n,
        capLamports: 150_000_000n,
      }),
      sendTransfer: async (transfer) => {
        sent = true;
        return transfer.signature;
      },
      alert: async (alert) => {
        alerts.push(alert);
      },
    });
    const result = await ensureSettleGas(worker.toBase58(), context, deps);
    const repeated = await ensureSettleGas(worker.toBase58(), {
      bountyId: "660f9500-f30c-42e5-b827-557766551111",
      leg: "finalize",
    }, deps);
    expect(result).toEqual({
      ok: false,
      code: "gas_cap_exceeded",
      message: "bounty gas daily cap exceeded before broadcast",
    });
    expect(sent).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.context).toMatchObject({ capDay: "2026-08-10" });
    expect(repeated).toEqual(result);
  });

  it("M1 — the condition throttle preserves live entries and suppresses new alerts at capacity", async () => {
    const worker = Keypair.generate().publicKey.toBase58();
    let capIndex = 0;
    let alerts = 0;
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message) => {
      warnings.push(String(message));
    });
    const deps = liveDeps({
      reserve: async () => ({
        kind: "cap_exceeded",
        capDay: `day-${capIndex++}`,
        usedLamports: 150_000_000n,
        capLamports: 150_000_000n,
      }),
      alert: async () => { alerts += 1; },
    });

    try {
      for (let i = 0; i < 1_050; i += 1) {
        await ensureSettleGas(worker, context, deps);
      }
      capIndex = 0;
      await ensureSettleGas(worker, context, deps);
    } finally {
      warn.mockRestore();
    }

    expect(_gasSponsorAlertThrottleSizeForTest()).toBe(1_024);
    expect(alerts).toBe(1_024);
    expect(warnings).toHaveLength(26);
    expect(warnings.at(-1)).toContain("suppressed=26");
  });

  it("fails closed on cross-instance cap disagreement", async () => {
    const worker = Keypair.generate().publicKey;
    const result = await ensureSettleGas(worker.toBase58(), context, liveDeps({
      reserve: async () => ({
        kind: "cap_mismatch",
        recordedCapLamports: 150_000_000n,
        callCapLamports: 200_000_000n,
      }),
    }));
    expect(result).toEqual({
      ok: false,
      code: "gas_cap_configuration_mismatch",
      message:
        "gas sponsorship reservation cap differs from this instance configuration",
    });
  });

  it("warns after a confirmed transfer when the gas wallet is below ten floors", async () => {
    const worker = Keypair.generate().publicKey;
    const gas = Keypair.generate();
    const alerts: AlertErrorParamsLike[] = [];
    const deps = liveDeps({
      getBalance: async (wallet) => (wallet.equals(worker) ? 0 : 59_999_999),
      loadGasKeypair: async () => gas,
      alert: async (alert) => {
        alerts.push(alert);
      },
    });
    const result = await ensureSettleGas(worker.toBase58(), context, deps);
    await ensureSettleGas(worker.toBase58(), context, deps);
    expect(result.ok).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      source: "bounty-gas-sponsor",
    });
  });
});

type AlertErrorParamsLike = {
  severity: string;
  source: string;
  message: string;
  context?: Record<string, unknown>;
};
