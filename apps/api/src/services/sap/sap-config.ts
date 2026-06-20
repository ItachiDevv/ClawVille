/**
 * SAP (Synapse Agent Protocol) — on-chain config + gate loader.
 *
 * Mirrors the preset/gate shape of `x402-config.ts`: a single
 * `loadSapConfig()` that reads env + applies safe defaults and never throws
 * for a normal (disabled) deployment, plus a HARD code-level mainnet gate that
 * DOES throw (mirrors the wager-program devnet-only doctrine).
 *
 * ── Default-safe posture (CLAUDE.md hard constraint) ──────────────────────────
 *   SAP_ENABLED        default false  — the WHOLE layer (identity/feedback/tool)
 *   SAP_ESCROW_ENABLED default false  — the MONEY/STAKE rail, gated SEPARATELY
 *   SAP_DRY_RUN        default true    — build + simulate ONLY, NEVER broadcast
 *   SAP_CLUSTER        default devnet  — same program id devnet+mainnet; only the
 *                                        cluster/RPC + the code gate differ
 *
 * With `SAP_DRY_RUN=true` NO transaction is ever sent to the chain — the client
 * builds the tx and runs `connection.simulateTransaction` only. The in-game
 * economy stays ClawTokens; SAP is an additive, flip-to-live, on-chain layer.
 *
 * ── Mainnet code gate (NOT just an env flip) ──────────────────────────────────
 * `SAP_ALLOW_MAINNET` is a CODE CONSTANT in this file, NOT read from env. To run
 * SAP against mainnet a human must edit this file (flip the constant to true) AND
 * set `SAP_CLUSTER=mainnet` — a config-review event, not an ops toggle. Setting
 * `SAP_CLUSTER=mainnet` while the constant is false makes `loadSapConfig()` throw
 * at call time (crash-loud, like `FINGERPRINT_SECRET`), so a mainnet env on a box
 * whose code wasn't reviewed for mainnet refuses to operate. This deliberately
 * mirrors `wager-program` (devnet-only; mainnet is a code change, not an env).
 */

import { PublicKey } from '@solana/web3.js';

// ─── the mainnet code gate (edit-to-enable, NOT env) ──────────────────────────
//
// DO NOT change this to `true` without a deliberate code review of the whole SAP
// money/custody path (solana-auditor + Codex adversarial on the escrow rail).
// Flipping this alone does nothing — `SAP_CLUSTER=mainnet` must ALSO be set. But
// without this constant true, `SAP_CLUSTER=mainnet` throws. Two locks, one code.
export const SAP_ALLOW_MAINNET = false as boolean;

export type SapCluster = 'devnet' | 'mainnet';

export const SAP_DEFAULT_PROGRAM_ID = 'SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ';

// Default RPC endpoints per cluster. Operators SHOULD override `SAP_RPC_URL`
// with a paid endpoint (Helius/Triton) before any real traffic — the public
// endpoints are rate-limited and unsuitable for production.
const DEFAULT_RPC_BY_CLUSTER: Record<SapCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

// USDC mints — the ONLY SPL token the SAP escrow program accepts besides native
// SOL (program error 6091 InvalidPaymentToken = "payment token not accepted
// (USDC only)"). Pinned by cluster so a devnet escrow can't reference the
// mainnet mint and vice-versa.
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// Solana cluster genesis hashes — the immutable fingerprint of a cluster, used by
// the live-send path to REFUSE broadcasting to mainnet unless the mainnet code
// gate is on (FIX-D: close the SAP_RPC_URL=<mainnet> + SAP_CLUSTER=devnet bypass —
// the program id is identical on every cluster, so the RPC's genesis hash is the
// only ground truth for which chain a tx would actually hit).
export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// Known mainnet RPC hostnames — a cheap static pre-check (the genesis-hash probe
// on the live path is the strong, authoritative guard). A devnet-config box must
// never point SAP_RPC_URL at one of these. Substring match (covers paths/keys).
const KNOWN_MAINNET_RPC_HOST_FRAGMENTS = [
  'api.mainnet-beta.solana.com',
  'mainnet.helius-rpc.com',
  'rpc.ankr.com/solana', // ankr mainnet (their devnet path differs)
  'solana-mainnet.g.alchemy.com',
  'solana-mainnet.core.chainstack.com',
];

/**
 * Does this RPC URL look like a Solana MAINNET endpoint by hostname? A static,
 * cheap pre-check used by `loadSapConfig` to refuse a devnet-config box that is
 * pointed at a known mainnet RPC. NOT authoritative (an unknown/custom mainnet
 * RPC won't be caught here) — the genesis-hash probe on the live-send path is the
 * real guard. Best-effort substring match against the host + path.
 */
export function rpcUrlLooksLikeMainnet(rpcUrl: string): boolean {
  const lower = rpcUrl.toLowerCase();
  return KNOWN_MAINNET_RPC_HOST_FRAGMENTS.some((frag) => lower.includes(frag));
}

// Minimum self-stake required by the program before an agent can create escrows
// (mirrors `AgentStake::MIN_STAKE` on-chain = 0.1 SOL). Real, timelocked SOL —
// surfaced as an explicit, separate step, never auto-staked.
export const SAP_MIN_STAKE_LAMPORTS = 100_000_000n; // 0.1 SOL

export interface SapConfig {
  /** Master gate — the whole SAP layer (identity/feedback/tool/discovery). */
  enabled: boolean;
  /** Money/stake rail gate — escrow + staking. Independent of `enabled`. */
  escrowEnabled: boolean;
  /** When true, build + simulate ONLY; NEVER broadcast. */
  dryRun: boolean;
  cluster: SapCluster;
  programId: PublicKey;
  rpcUrl: string;
  /** The cluster-correct USDC mint (the only SPL the escrow rail honors). */
  usdcMint: PublicKey;
  minStakeLamports: bigint;
}

/**
 * Read + validate the SAP env config. Always returns a config object for a
 * normal (devnet, disabled, dry-run) deployment. THROWS only on the mainnet
 * code-gate violation — a config error an operator must fix, never a silent
 * fallback to an unsafe cluster.
 */
export function loadSapConfig(): SapConfig {
  const enabled = process.env.SAP_ENABLED === 'true';
  const escrowEnabled = process.env.SAP_ESCROW_ENABLED === 'true';
  // Dry-run defaults ON (safe). It is OFF only when EXPLICITLY set to 'false'.
  const dryRun = process.env.SAP_DRY_RUN !== 'false';

  const rawCluster = (process.env.SAP_CLUSTER ?? 'devnet').trim().toLowerCase();
  if (rawCluster !== 'devnet' && rawCluster !== 'mainnet') {
    throw new Error(
      `[sap] SAP_CLUSTER must be 'devnet' or 'mainnet' (got '${rawCluster}').`,
    );
  }
  const cluster = rawCluster as SapCluster;

  // ── MAINNET CODE GATE (crash-loud) ──────────────────────────────────────────
  // Mirrors the wager-program devnet-only rule + the FINGERPRINT_SECRET fail-fast
  // posture: a mainnet env on a box whose code wasn't reviewed for mainnet must
  // refuse to operate rather than quietly move real funds on the wrong cluster.
  if (cluster === 'mainnet' && !SAP_ALLOW_MAINNET) {
    throw new Error(
      '[sap] SAP_CLUSTER=mainnet but the SAP_ALLOW_MAINNET code constant is false. ' +
        'Mainnet SAP is a deliberate CODE change (review the full money/custody path), ' +
        'NOT an env toggle. Flip SAP_ALLOW_MAINNET in sap-config.ts only after a ' +
        'solana-auditor + Codex adversarial pass on the escrow rail.',
    );
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(
      (process.env.SAP_PROGRAM_ID ?? SAP_DEFAULT_PROGRAM_ID).trim(),
    );
  } catch {
    throw new Error(
      `[sap] SAP_PROGRAM_ID is not a valid base58 pubkey: '${process.env.SAP_PROGRAM_ID}'.`,
    );
  }

  const rpcUrl = (process.env.SAP_RPC_URL ?? DEFAULT_RPC_BY_CLUSTER[cluster]).trim();

  // ── RPC-vs-cluster mainnet bypass guard (FIX-D, static pre-check) ────────────
  // The program id is identical on every cluster, so a box configured for devnet
  // (cluster=devnet, no mainnet code gate) but pointed at a MAINNET RPC would,
  // with SAP_DRY_RUN=false, broadcast a real-funds tx to mainnet. The genesis-hash
  // probe on the live-send path is the authoritative guard, but we ALSO refuse a
  // known mainnet RPC hostname here at config load (crash-loud) unless the mainnet
  // code gate is fully on. This catches the obvious misconfig before any tx.
  const mainnetCodeGateOn = cluster === 'mainnet' && SAP_ALLOW_MAINNET;
  if (!mainnetCodeGateOn && rpcUrlLooksLikeMainnet(rpcUrl)) {
    throw new Error(
      `[sap] SAP_RPC_URL looks like a Solana MAINNET endpoint ('${rpcUrl}') but the ` +
        `mainnet code gate is not fully enabled (SAP_CLUSTER=${cluster}, ` +
        `SAP_ALLOW_MAINNET=${SAP_ALLOW_MAINNET}). The program id is the same on every ` +
        `cluster, so a devnet-configured box on a mainnet RPC would broadcast real ` +
        `funds to mainnet. Point SAP_RPC_URL at devnet, or enable the mainnet code ` +
        `gate (flip SAP_ALLOW_MAINNET + set SAP_CLUSTER=mainnet) deliberately.`,
    );
  }

  const usdcMint = new PublicKey(
    cluster === 'mainnet' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET,
  );

  return {
    enabled,
    escrowEnabled,
    dryRun,
    cluster,
    programId,
    rpcUrl,
    usdcMint,
    minStakeLamports: SAP_MIN_STAKE_LAMPORTS,
  };
}

/**
 * Is the given mint string an honored escrow payment token for THIS config?
 *
 * SOL-ONLY FOR NOW (FIX-E). SOL is represented by `null` (the program's
 * `token_mint: None`). The USDC/SPL path is NOT wired yet: `create_escrow_v2` for
 * an SPL token requires the SPL `remaining_accounts` (the token program + the
 * escrow/depositor token accounts) to be appended, which the client does NOT do —
 * so a USDC escrow would hit the on-chain `SplTokenRequired` error. Until that
 * ATA/token-program remaining-accounts wiring lands we refuse ANY non-null mint
 * (incl. the cluster USDC mint) client-side with a clean `sol_only_for_now` code.
 *
 * TODO(escrow-usdc): wire SPL remaining_accounts (token program + escrow ATA +
 * depositor ATA) into createEscrow/deposit/settle/withdraw/close, then restore
 * the `mint === cfg.usdcMint` acceptance below. See docs/sap-integration.md §9.
 */
export function isHonoredEscrowMint(
  cfg: SapConfig,
  mint: string | null,
): boolean {
  if (mint === null) return true; // native SOL — the ONLY honored path today
  // USDC/SPL intentionally refused until remaining_accounts are wired (see above).
  return false;
}
