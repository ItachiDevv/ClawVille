/**
 * Provision the CLAWVILLE HOUSE (Coralia) avatar as a SAP V2 USDC escrow worker
 * — bounty-composition-rail SLICE 1.
 *
 * Drives `ensureHouseSapIdentity()`: custodial wallet → on-chain register → USDC
 * pricing tier → SOL stake, for the dedicated house-agent avatar
 * (`coralia@clawville.internal`). Prints the summary as pretty JSON and exits
 * 0 when every step is ok (succeeded / dry-ran / already-provisioned), else 1.
 *
 * ── IDEMPOTENT / RE-RUNNABLE ─────────────────────────────────────────────────
 * Safe to run repeatedly. The wallet is ensured once (idempotent), the register
 * is skipped if already on-chain, the pricing menu is republished (last-write
 * wins), and the stake is a no-op once it already ≥ target.
 *
 * ── FUND THE HOUSE WALLET FIRST (for the LIVE path) ──────────────────────────
 * `register` and `stake` SPEND REAL (devnet) SOL — the house's custodial wallet
 * must be FUNDED with devnet SOL BEFORE the live path can succeed. Run this ONCE
 * in dry-run first to MINT + PRINT the wallet pubkey (step "wallet" in the JSON),
 * airdrop it devnet SOL (≥ ~1.2 SOL: ~1 SOL stake + register rent + fees) via
 * https://faucet.solana.com, THEN run the live path. An unfunded wallet makes the
 * live register/stake fail with an on-chain (insufficient-funds) error — that is
 * the operator's cue to fund it.
 *
 * ── DRY-RUN BY DEFAULT (safe) ────────────────────────────────────────────────
 * With no env set, SAP is DISABLED (the on-chain steps return `sap_disabled` /
 * `sap_escrow_disabled` and nothing hits the chain; the wallet is still ensured).
 * With the gates ON but `SAP_DRY_RUN` unset/≠'false', the on-chain steps build +
 * `simulateTransaction` ONLY — never broadcast.
 *
 * ── ENV ──────────────────────────────────────────────────────────────────────
 *   REQUIRED (always):
 *     DATABASE_URL           the Supabase Postgres (house avatar + wallet rows).
 *     VANITY_ENCRYPTION_KEY  64-hex — encrypts the new custodial secret AND is
 *                            used by the sap-client to DECRYPT it in memory to
 *                            sign. Must match the box that owns the wallet row.
 *   DRY-RUN REHEARSAL (build + simulate, no broadcast):
 *     SAP_ENABLED=true SAP_ESCROW_ENABLED=true SAP_USDC_ESCROW_ENABLED=true
 *     SAP_CLUSTER=devnet   (SAP_DRY_RUN left unset ⇒ dry-run is the default)
 *   ACTUALLY EXECUTE ON DEVNET (real SOL — fund the wallet first!):
 *     SAP_ENABLED=true SAP_ESCROW_ENABLED=true SAP_USDC_ESCROW_ENABLED=true \
 *     SAP_DRY_RUN=false SAP_CLUSTER=devnet
 *     (optional: SAP_RPC_URL=<devnet RPC>, SAP_ARBITER_PUBKEY=<pubkey> — the
 *      arbiter is required later by create_escrow_v2, not by this provisioner.)
 *
 * ── FOUNDER / OPS PREREQUISITE ───────────────────────────────────────────────
 * Writing + dry-running this needs NO founder action. Going LIVE needs one ops
 * step: fund the printed house wallet with devnet SOL (a separate, deliberate
 * action). Mainnet is NEVER reachable from here — SAP_CLUSTER=mainnet is a
 * code-gated crash (see sap-config.ts SAP_ALLOW_MAINNET).
 *
 * Run:  cd apps/api && bun run scripts/sap/provision-house-sap.ts
 */

import { ensureHouseSapIdentity } from '../../src/services/sap/house-sap-provisioning';

/** JSON replacer so any bigint in the summary serializes as a decimal string. */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function main(): Promise<void> {
  const summary = await ensureHouseSapIdentity();
  console.log(JSON.stringify(summary, jsonSafe, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(
    'provision-house-sap crashed:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
