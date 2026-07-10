/**
 * House SAP identity provisioning — bounty-composition-rail SLICE 1 (money-path,
 * GATED OFF + dry-run-honored).
 * ─────────────────────────────────────────────────────────────────────────────
 * The bounty composition rail opens a SAP V2 USDC escrow at bounty-post with the
 * CLAWVILLE HOUSE avatar as the escrow WORKER counterparty (funds custodied
 * on-chain), then pays the hunter via a SEPARATE PayAI x402 leg from the house
 * wallet. For ANY of that on-chain, the house avatar must be:
 *   (1) given a Phase-5.1 custodial Solana wallet,
 *   (2) SAP-registered on devnet (an on-chain AgentAccount),
 *   (3) given a USDC pricing tier (V2 create_escrow_v2 reads the worker's
 *       pricing_menu — a missing tier fails PricingTierNotFound 6148), and
 *   (4) SOL-staked (create_escrow_v2 enforces an on-chain stake gate).
 *
 * Today NONE of that exists — the three house seeders (house-agent-seeder,
 * house-treasury-seeder, cash-house-seeder) create their avatar via a direct
 * `db.insert(avatars)` and never call `ensureWallet`, and no seeder/script calls
 * the SAP register / pricing / stake functions. This service is the idempotent,
 * re-runnable provisioner that closes that gap.
 *
 * ── WHY THE COVE/CORALIA "house-agent" AVATAR (not the treasury) ──────────────
 * The escrow WORKER is an ACTIVE economic participant: it custodies USDC in an
 * on-chain vault and (via the separate PayAI leg) pays hunters. The house-agent
 * seeder (`house-agent-seeder.ts`) provisions exactly such an identity — the
 * ClawVille-HOSTED autonomous house agent "Coralia" (`is_house=true`), backed by
 * a DEDICATED internal user (`coralia@clawville.internal`) + a dedicated
 * `avatars` row (matched idempotently on every API boot by
 * `ensureHouseUserAndAvatar()`). That is the right identity for a settlement
 * counterparty.
 *
 * The house TREASURY (`house-treasury-seeder.ts`) is the WRONG choice: its own
 * header says it is a "pure revenue SINK … never pays players (no faucet)",
 * `isActive:false`, only ever accumulates fee credits. A sink can't be a worker
 * that custodies and pays out. Likewise the cash-house bank is a bankroll faucet,
 * not a settlement identity. So: Coralia's dedicated avatar is the counterparty.
 *
 * ── EXACT LOOKUP (documented, mirrors ensureHouseUserAndAvatar) ───────────────
 *   internal email `coralia@clawville.internal`  →  `users` row (by email)
 *   →  `avatars` row (by `avatars.userId`, which is UNIQUE — one avatar per user).
 * `resolveHouseAvatarId()` returns null if either row is absent (i.e. the house
 * agent hasn't been seeded yet — run the API once, `ensureHouseAgent()` seeds it
 * on boot). The email is duplicated from `house-agent-seeder.ts`'s private
 * `HOUSE_AGENT_EMAIL` const on purpose: a drift here FAILS CLOSED (no user found
 * → no provisioning), it can NEVER resolve a different/wrong avatar and register
 * the wrong wallet on-chain.
 *
 * ── GATING / DRY-RUN (do NOT bypass) ─────────────────────────────────────────
 * The wallet step is a plain custodial-keypair DB write (identity, not money —
 * no funds, no chain tx) so it runs regardless of the SAP flags. The three
 * on-chain steps (register / pricing / stake) SELF-GATE inside the sap-client:
 * with the default flags OFF they return `sap_disabled` / `sap_escrow_disabled`
 * / `sap_usdc_escrow_disabled` before touching the chain, and with the flags ON
 * but `SAP_DRY_RUN=true` (the default) they build + `simulateTransaction` ONLY,
 * NEVER broadcasting. This service does NOT read or flip any flag to change that;
 * it only READS `sapConfigSnapshot().dryRun` to REPORT the posture. It calls the
 * exported sap-client functions and maps each `SapWriteResult` into a step.
 *
 * ── IDEMPOTENCY (safe to re-run) ─────────────────────────────────────────────
 *   wallet   — `ensureWallet` is idempotent (surfaced as `alreadyProvisioned`).
 *   register — pre-checked with `fetchAgentProfile` (a non-null profile ⇒ already
 *              registered ⇒ skip); and if a live `registerAgent` still races into
 *              an "already in use / already initialized" on-chain error, that is
 *              classified as success (`alreadyProvisioned`).
 *   pricing  — `update_agent(pricing=[tier])` REPLACES the whole menu (last-write
 *              wins), so re-publishing the same tier is naturally idempotent.
 *   stake    — `provisionAgentStake` returns `invalid_amount` "…nothing to
 *              provision" once the stake already ≥ target; classified as success.
 *
 * The custodial secret key is NEVER logged, echoed, or returned — `ensureWallet`
 * only ever exposes the PUBLIC key, and the sap-client decrypts in memory only.
 *
 * Consumes only EXPORTED sap-client functions (`registerAgent`,
 * `updateAgentPricingUsdc`, `provisionAgentStake`, `fetchAgentProfile`,
 * `sapConfigSnapshot`) + `ensureWallet` (wallet-service). It touches NONE of the
 * frozen SAP executor internals and changes NO flag default.
 */

import { db, users, avatars, eq } from '@clawville/database';
import { ensureWallet } from '../wallet-service';
import {
  registerAgent,
  updateAgentPricingUsdc,
  provisionAgentStake,
  fetchAgentProfile,
  sapConfigSnapshot,
  type SapWriteResult,
  type SapFailure,
} from './sap-client';

// ─── house identity constants ─────────────────────────────────────────────────

/**
 * SINGLE SOURCE OF TRUTH = `house-agent-seeder.ts` HOUSE_AGENT_EMAIL
 * ('coralia@clawville.internal'). That const is not exported, so it is mirrored
 * here deliberately. A drift is FAIL-CLOSED: `resolveHouseAvatarId()` simply
 * finds no user and returns null (no provisioning), never a wrong avatar.
 */
const HOUSE_AGENT_EMAIL = 'coralia@clawville.internal';

/**
 * On-chain SAP AgentAccount label for the bounty-settlement counterparty. Clear
 * to a bounty depositor that the escrow worker is the ClawVille house. `name`
 * cap is 64 chars (routes/sap-route-schemas registerSchema); this is well under.
 * The in-game token is "vCLAW" — NO "CT" / "ClawTokens" appears in any string
 * here (the escrow leg is USDC anyway).
 */
const HOUSE_SAP_NAME = 'ClawVille House';
/** description cap is 512 chars; trimmed, non-empty (registerSchema). */
const HOUSE_SAP_DESCRIPTION =
  'ClawVille house settlement counterparty for the bounty composition rail: the ' +
  'SAP V2 USDC escrow WORKER that custodies a bounty reward on-chain at post time ' +
  'and pays the winning hunter via a separate PayAI x402 leg from the house wallet.';
/**
 * On-chain protocol tags. `['clawville']` matches every existing ClawVille SAP
 * registration (light-devnet-smoke, dry-run-e2e, routes/sap registerSchema
 * default) — kept consistent so the house is discoverable the same way.
 */
const HOUSE_SAP_PROTOCOLS = ['clawville'];

/**
 * USDC pricing tier id (shared with the escrow-open slice). The provisioner
 * publishes ONE tier under this id at a NOMINAL 1-USDC price to move the worker out
 * of the "no pricing menu → PricingTierNotFound 6148" state at boot. Exported so
 * `openComposedBountyEscrow` (bounty-escrow-link.ts) re-publishes THE SAME tier id
 * at each bounty's exact reward price before opening its vault — one source of truth
 * for the id keeps the menu legible across the boot-time provision and the
 * per-bounty republish.
 *
 * PER-BOUNTY ARITHMETIC OWNERSHIP (was a TODO here in SLICE 1, now DONE): the
 * DEFINITIVE per-bounty escrow↔tier price is owned by the escrow-open slice.
 * `openComposedBountyEscrow` re-publishes this tier at `pricePerCall =
 * usdcRewardBaseUnits(reward)` under a per-house keyed mutex BEFORE every
 * `create_escrow_v2` — because `update_agent(pricing)` replaces the whole menu
 * (last-write-wins), the fixed nominal tier below is only the boot-time placeholder;
 * the live per-create price is set there, not here. rateLimit / maxCallsPerSession
 * are left at the sap-client defaults (100 / 1000).
 */
export const HOUSE_PRICING_TIER_ID = 'bounty-usdc';
const HOUSE_PRICING_PRICE_PER_CALL = 1_000_000n; // 1 USDC (6 dp), nominal boot placeholder

/**
 * Default target stake — 0.11 SOL (staging default; overridable via
 * `opts.targetStakeLamports` and the script's `HOUSE_STAKE_LAMPORTS` env).
 *
 * ── STAKE ↔ MAX SINGLE BOUNTY (the create_escrow_v2 coverage gate) ────────────
 * `create_escrow_v2` requires the WORKER (house) stake ≥ `max(0.1 SOL,
 * 50% × maxObligation)`, where `maxObligation = pricePerCall × maxCalls` = the
 * bounty reward in USDC BASE UNITS (6 dp). The DEPLOYED program compares that raw
 * base-unit number DIRECTLY against lamports with NO mint-decimal / oracle
 * conversion (unit-naive), so a reward of R whole USDC needs
 * `max(0.1 SOL, R × 500_000 lamports)` staked. Consequences:
 *   - 0.10 SOL covers every bounty ≤ $200 (the 0.1-SOL floor dominates there).
 *   - 0.11 SOL covers a single bounty up to ~$220.
 *   - a single bounty of $R (R > 200) needs ~`R × 500_000` lamports (≈ 0.0005 SOL/$).
 * 0.11 SOL is plenty for staging e2e (single bounties ≤ ~$200). The stake is a
 * one-time, REUSABLE standing coverage bond — it is NOT consumed per bounty — so
 * ops RAISES it once (script arg / env) before posting a larger single bounty.
 * Real, timelocked SOL — only spent when the flags are ON and `SAP_DRY_RUN=false`
 * (a deliberate, funded ops step; devnet SOL is sourced by the orchestrator).
 */
const DEFAULT_HOUSE_STAKE_LAMPORTS = 110_000_000n; // 0.11 SOL (staging default)

// ─── result shape ─────────────────────────────────────────────────────────────

export type HouseSapProvisionStep = 'wallet' | 'register' | 'pricing' | 'stake';

export interface HouseSapProvisionStepResult {
  step: HouseSapProvisionStep;
  ok: boolean;
  /** Failure code (SapErrorCode or a local pre-step code); omitted on success. */
  code?: string;
  message?: string;
  /** True when the step was a no-op because it was already provisioned. */
  alreadyProvisioned?: boolean;
}

export interface HouseSapProvisionSummary {
  /** True only when EVERY step is ok (succeeded, dry-ran, or already provisioned). */
  ok: boolean;
  houseAvatarId: string | null;
  /** The house avatar's custodial wallet PUBLIC key (never the secret). */
  walletPubkey: string | null;
  /** Whether the on-chain steps were dry-run (build + simulate) — from config. */
  dryRun: boolean;
  steps: HouseSapProvisionStepResult[];
}

// ─── house avatar resolution ──────────────────────────────────────────────────

/**
 * Resolve the CLAWVILLE HOUSE (Coralia) avatar id: internal email → users row →
 * avatars row (by userId). Returns null if the house agent hasn't been seeded
 * yet (`ensureHouseAgent()` seeds it on API boot). Read-only.
 */
export async function resolveHouseAvatarId(): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, HOUSE_AGENT_EMAIL),
    columns: { id: true },
  });
  if (!user) return null;
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
    columns: { id: true },
  });
  return avatar?.id ?? null;
}

// ─── result → step mapping helpers ────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a raw sap-client `SapWriteResult` into a step result (no idempotency layer). */
function mapWriteResult(
  step: HouseSapProvisionStep,
  res: SapWriteResult,
): HouseSapProvisionStepResult {
  if (res.ok) {
    if (res.dryRun) {
      return {
        step,
        ok: true,
        message: `dry-run rehearsal (programReached=${res.programReached}, accepted=${res.accepted})`,
      };
    }
    return { step, ok: true, message: `live tx confirmed: ${res.signature}` };
  }
  return { step, ok: false, code: res.code, message: res.message };
}

/**
 * Does this failure mean the agent is ALREADY registered on-chain (so a live
 * `registerAgent` re-run is a no-op success, not an error)? Anchor's
 * `#[account(init)]` on the already-existing AgentAccount surfaces as the System
 * program's "account already in use" (Custom(0)) which `classifyChainError`
 * leaves as the generic `on_chain_error` with the raw message attached.
 */
function isAlreadyRegisteredFailure(res: SapFailure): boolean {
  if (res.code !== 'on_chain_error') return false;
  const m = res.message.toLowerCase();
  return (
    m.includes('already in use') ||
    m.includes('already initialized') ||
    m.includes('already registered') ||
    m.includes('accountalreadyinitialized') ||
    m.includes('custom program error: 0x0')
  );
}

// ─── the four provisioning steps ──────────────────────────────────────────────

async function provisionWallet(
  houseAvatarId: string,
): Promise<{ result: HouseSapProvisionStepResult; walletPubkey: string | null }> {
  try {
    const w = await ensureWallet('avatar', houseAvatarId);
    return {
      walletPubkey: w.publicKey,
      result: {
        step: 'wallet',
        ok: true,
        alreadyProvisioned: w.alreadyExisted,
        message: `custodial wallet ${w.publicKey}${w.alreadyExisted ? ' (existing)' : ' (created)'}`,
      },
    };
  } catch (err) {
    return {
      walletPubkey: null,
      result: { step: 'wallet', ok: false, code: 'wallet_error', message: errMessage(err) },
    };
  }
}

async function provisionRegister(
  houseAvatarId: string,
  walletPubkey: string | null,
): Promise<HouseSapProvisionStepResult> {
  // Idempotency pre-check: a non-null on-chain profile ⇒ already registered.
  // Only meaningful once SAP is enabled + RPC reachable; a gate/RPC failure here
  // simply falls through to registerAgent, which reports the same gate/error.
  if (walletPubkey) {
    const profile = await fetchAgentProfile(walletPubkey);
    if (profile.ok && profile.data) {
      return {
        step: 'register',
        ok: true,
        alreadyProvisioned: true,
        message: `already registered on-chain (agentPda ${profile.data.agentPda})`,
      };
    }
  }

  const res = await registerAgent({
    avatarId: houseAvatarId,
    name: HOUSE_SAP_NAME,
    description: HOUSE_SAP_DESCRIPTION,
    capabilities: [],
    protocols: HOUSE_SAP_PROTOCOLS,
  });

  if (!res.ok && isAlreadyRegisteredFailure(res)) {
    return {
      step: 'register',
      ok: true,
      alreadyProvisioned: true,
      message: `already registered (idempotent — on-chain: ${res.message})`,
    };
  }
  return mapWriteResult('register', res);
}

async function provisionPricing(
  houseAvatarId: string,
): Promise<HouseSapProvisionStepResult> {
  const res = await updateAgentPricingUsdc({
    workerAvatarId: houseAvatarId,
    tierId: HOUSE_PRICING_TIER_ID,
    pricePerCall: HOUSE_PRICING_PRICE_PER_CALL,
  });
  // update_agent(pricing) REPLACES the menu (last-write-wins) — re-runs are
  // inherently idempotent, so there is no "already exists" case to reclassify.
  return mapWriteResult('pricing', res);
}

async function provisionStake(
  houseAvatarId: string,
  targetLamports: bigint,
): Promise<HouseSapProvisionStepResult> {
  const res = await provisionAgentStake({ avatarId: houseAvatarId, targetLamports });
  // `provisionAgentStake` returns invalid_amount "…nothing to provision" when the
  // stake already ≥ target — an idempotent no-op success, not a real failure.
  if (
    !res.ok &&
    res.code === 'invalid_amount' &&
    res.message.toLowerCase().includes('nothing to provision')
  ) {
    return {
      step: 'stake',
      ok: true,
      alreadyProvisioned: true,
      message: `stake already ≥ target (idempotent — ${res.message})`,
    };
  }
  return mapWriteResult('stake', res);
}

// ─── entrypoint ───────────────────────────────────────────────────────────────

/**
 * Idempotently provision the CLAWVILLE HOUSE (Coralia) avatar as a SAP V2 USDC
 * escrow worker: custodial wallet → on-chain register → USDC pricing tier → SOL
 * stake. Safe to re-run. GATED OFF + dry-run-honored by default (the on-chain
 * steps self-gate inside the sap-client; this never bypasses a flag). All four
 * steps run fail-soft and are recorded; `ok` is true only when every step is ok.
 *
 * @param opts.targetStakeLamports override the default 1-SOL stake target.
 */
export async function ensureHouseSapIdentity(
  opts?: { targetStakeLamports?: bigint },
): Promise<HouseSapProvisionSummary> {
  const dryRun = sapConfigSnapshot().dryRun;
  const targetLamports = opts?.targetStakeLamports ?? DEFAULT_HOUSE_STAKE_LAMPORTS;

  // 0. Resolve the house avatar (hard prerequisite for everything below).
  let houseAvatarId: string | null;
  try {
    houseAvatarId = await resolveHouseAvatarId();
  } catch (err) {
    return {
      ok: false,
      houseAvatarId: null,
      walletPubkey: null,
      dryRun,
      steps: [{ step: 'wallet', ok: false, code: 'house_avatar_lookup_failed', message: errMessage(err) }],
    };
  }
  if (!houseAvatarId) {
    return {
      ok: false,
      houseAvatarId: null,
      walletPubkey: null,
      dryRun,
      steps: [
        {
          step: 'wallet',
          ok: false,
          code: 'house_avatar_missing',
          message: `no house avatar for ${HOUSE_AGENT_EMAIL} — run the API once so ensureHouseAgent() seeds Coralia's user + avatar.`,
        },
      ],
    };
  }

  const steps: HouseSapProvisionStepResult[] = [];

  // 1. Custodial wallet (identity, not money — runs regardless of SAP flags).
  const wallet = await provisionWallet(houseAvatarId);
  steps.push(wallet.result);

  // 2–4. On-chain steps (self-gated + dry-run-honored inside the sap-client).
  steps.push(await provisionRegister(houseAvatarId, wallet.walletPubkey));
  steps.push(await provisionPricing(houseAvatarId));
  steps.push(await provisionStake(houseAvatarId, targetLamports));

  return {
    ok: steps.every((s) => s.ok),
    houseAvatarId,
    walletPubkey: wallet.walletPubkey,
    dryRun,
    steps,
  };
}
