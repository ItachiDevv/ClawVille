import { afterEach, describe, expect, it } from "bun:test";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  bountyGasDailyCapLamports,
  bountySettleGasFloorLamports,
  ensureSettleGas,
  type GasSponsorDeps,
} from "../sap-gas-sponsor";

const BOUNTY_ID = "550e8400-e29b-41d4-a716-446655440000";
const context = { bountyId: BOUNTY_ID, leg: "settle" as const };
const originalFloor = process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL;
const originalCap = process.env.BOUNTY_GAS_DAILY_CAP_SOL;

afterEach(() => {
  if (originalFloor === undefined)
    delete process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL;
  else process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL = originalFloor;
  if (originalCap === undefined) delete process.env.BOUNTY_GAS_DAILY_CAP_SOL;
  else process.env.BOUNTY_GAS_DAILY_CAP_SOL = originalCap;
});

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
    let reserved = false;
    const result = await ensureSettleGas(worker.toBase58(), context, {
      dryRun: false,
      getBalance: async () => Number(bountySettleGasFloorLamports()),
      reserve: async () => {
        reserved = true;
        return { kind: "reserved" };
      },
    });
    expect(result).toEqual({
      ok: true,
      sponsored: false,
      lamports: 0,
      reason: "balance_sufficient",
    });
    expect(reserved).toBe(false);
  });

  it("transfers and confirms exactly the shortfall to the configured floor", async () => {
    process.env.BOUNTY_SETTLE_GAS_FLOOR_SOL = "0.006";
    const worker = Keypair.generate().publicKey;
    const gas = Keypair.generate();
    const calls: string[] = [];
    let transferredLamports = 0;
    let completedLamports = 0n;
    const deps: GasSponsorDeps = {
      dryRun: false,
      getBalance: async (wallet) =>
        wallet.equals(worker) ? 2_000_000 : LAMPORTS_PER_SOL,
      loadGasKeypair: async () => gas,
      reserve: async () => ({ kind: "reserved" }),
      broadcastTransfer: async ({ lamports }) => {
        calls.push("broadcast");
        transferredLamports = lamports;
        return {
          signature: "gas-sig",
          blockhash: "blockhash",
          lastValidBlockHeight: 1,
        };
      },
      markBroadcast: async () => {
        calls.push("marked");
      },
      confirmTransfer: async () => {
        calls.push("confirmed");
      },
      complete: async ({ lamports }) => {
        calls.push("completed");
        completedLamports = lamports;
      },
      alert: async () => undefined,
    };
    const result = await ensureSettleGas(worker.toBase58(), context, deps);
    expect(result).toEqual({
      ok: true,
      sponsored: true,
      lamports: 4_000_000,
      signature: "gas-sig",
      replay: false,
    });
    expect(transferredLamports).toBe(4_000_000);
    expect(completedLamports).toBe(4_000_000n);
    expect(calls).toEqual(["broadcast", "marked", "confirmed", "completed"]);
  });

  it("fails closed and emits a critical alert when the UTC-day cap is exceeded", async () => {
    const worker = Keypair.generate().publicKey;
    const alerts: any[] = [];
    const result = await ensureSettleGas(worker.toBase58(), context, {
      dryRun: false,
      getBalance: async () => 0,
      reserve: async () => ({
        kind: "cap_exceeded",
        usedLamports: 149_000_000n,
        capLamports: 150_000_000n,
      }),
      alert: async (alert) => {
        alerts.push(alert);
      },
    });
    expect(result).toEqual({
      ok: false,
      code: "gas_cap_exceeded",
      message: "bounty gas daily cap exceeded",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      source: "bounty-gas-sponsor",
    });
  });

  it("warns after a confirmed transfer when the gas wallet is below ten floors", async () => {
    const worker = Keypair.generate().publicKey;
    const gas = Keypair.generate();
    const alerts: any[] = [];
    const result = await ensureSettleGas(worker.toBase58(), context, {
      dryRun: false,
      getBalance: async (wallet) => (wallet.equals(worker) ? 0 : 59_999_999),
      loadGasKeypair: async () => gas,
      reserve: async () => ({ kind: "reserved" }),
      broadcastTransfer: async () => ({
        signature: "gas-sig",
        blockhash: "blockhash",
        lastValidBlockHeight: 1,
      }),
      markBroadcast: async () => undefined,
      confirmTransfer: async () => undefined,
      complete: async () => undefined,
      alert: async (alert) => {
        alerts.push(alert);
      },
    });
    expect(result.ok).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      source: "bounty-gas-sponsor",
    });
  });
});
