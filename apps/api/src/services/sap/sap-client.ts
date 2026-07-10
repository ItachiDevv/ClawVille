/**
 * SAP on-chain client — load the official SDK 1.0.0 IDL + `Program`, a CUSTODIAL
 * signer wrapping `keypair-vault`, and the Phase-1 (identity/reputation/tool/
 * discovery) + Phase-2 (stake/escrow money rail) instruction builders.
 *
 * ── Default-safe execution model ──────────────────────────────────────────────
 *   DRY-RUN (default, `SAP_DRY_RUN` !== 'false'):
 *     build the tx → `connection.simulateTransaction` → return
 *     `{ dryRun: true, simulation, instruction, accounts }`. NO `sendTransaction`,
 *     NO signature, NEVER broadcast. A sim "insufficient funds"/"account not
 *     found" is a SUCCESSFUL dry-run (it proves the encoding reached the program).
 *   LIVE (`SAP_DRY_RUN=false` AND the relevant gate on):
 *     sign with the custodial keypair → `sendAndConfirmTransaction` → return
 *     `{ dryRun: false, signature, accounts }`.
 *
 * ── Custodial key handling (CLAUDE.md hard constraint) ────────────────────────
 * The agent's Phase-5.1 Solana avatar keypair is decrypted IN MEMORY ONLY via
 * `decryptWalletRow` (CF-KEK / VANITY_ENCRYPTION_KEY pipeline), used to sign, and
 * then DROPPED. It is NEVER logged, echoed, returned, or persisted. We sign by
 * partial-signing the built `Transaction` with the `Keypair` and never construct
 * a long-lived custodial NodeWallet around a real agent key (a throwaway
 * read-only placeholder wallet drives the AnchorProvider for tx assembly only).
 *
 * The acting agent is ALWAYS ITS OWN wallet — every builder takes an `avatarId`
 * (resolved upstream from `requireAuthOrAgentSession` → identity.avatarId) and
 * loads THAT avatar's wallet. No body-supplied pubkey ever becomes a signer.
 *
 * ── Gates ─────────────────────────────────────────────────────────────────────
 * Every write builder hard-checks `cfg.enabled` (and, for stake/escrow,
 * `cfg.escrowEnabled`) and returns a structured `{ ok:false, code:'sap_disabled' }`
 * BEFORE touching the chain. The route layer maps that to 503. Read-only
 * discovery requires only `cfg.enabled`.
 *
 * Errors are NEVER thrown raw to the route layer — every chain/RPC failure is
 * caught and returned as a structured `SapResult` with a stable `code`, so the
 * route returns a clean 4xx/503, never a 5xx stack leak.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { db, eq, and, wallets } from '@clawville/database';
import { decryptWalletRow } from '../keypair-vault';
import {
  loadSapConfig,
  isHonoredEscrowMint,
  SAP_ALLOW_MAINNET,
  SOLANA_MAINNET_GENESIS_HASH,
  type SapConfig,
} from './sap-config';
import {
  deriveAgentPdaSet,
  findAgentPda,
  findStatsPda,
  findGlobalPda,
  findStakePda,
  findPricingPda,
  findToolPda,
  findFeedbackPda,
  findAttestationPda,
  findEscrowPda,
  findPendingPda,
  toolNameHash,
  sha256Bytes,
  serviceHash as deriveServiceHash,
} from './sap-pdas';
import {
  deriveUsdcEscrowAddresses,
  buildCreateEscrowUsdcIx,
  buildDepositEscrowUsdcIx,
  buildSettleCallsUsdcIx,
  buildWithdrawEscrowUsdcIx,
  type UsdcEscrowAddresses,
} from './sap-escrow-usdc';
import {
  buildCreateEscrowV2Ix,
  buildDepositEscrowV2Ix,
  buildSettleCallsV2Ix,
  buildFinalizeSettlementIx,
  buildWithdrawEscrowV2Ix,
  assembleV2SplRemaining,
  SETTLEMENT_SECURITY,
  type SettlementSecurityMode,
} from './sap-escrow-v2';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
} from './sap-spl';
import {
  computeV2EscrowCoverageLimit,
  preflightV2CreateCoverage,
  preflightV2DepositCoverage,
  type V2EscrowCoverageTerms,
} from './sap-coverage';
export {
  checkV2EscrowCoverage,
  checkV2EscrowDepositCoverage,
  computeV2EscrowCoverageLimit,
  preflightV2CreateCoverage,
  preflightV2DepositCoverage,
  V2_MIN_STAKE_LAMPORTS,
  V2_STAKE_COVERAGE_BPS,
  type V2EscrowCoverageTerms,
} from './sap-coverage';
// OFFICIAL SDK IDL — @oobe-protocol-labs/synapse-sap-sdk@1.0.0. OOBE published the SDK
// + a refreshed on-chain IDL whose account/arg layouts MATCH the deployed 0.25-family
// program (and match what we had empirically devnet-verified). We load THAT IDL into
// the Anchor `Program` and let Anchor assemble every escrow-V2 money instruction (see
// sap-escrow-v2.ts) — NO more hand-rolled discriminators / borsh / account lists. A
// wire-parity test asserts the Anchor-built instructions are byte-identical to the
// devnet-verified shapes, so the on-chain wire is provably unchanged.
//
// The refreshed IDL is correct where the two old vendored IDLs were each wrong:
// settle_calls_v2 = 5 accounts (NO settlement_receipt), create_escrow_v2 = 7 accounts
// (agent_stake + agent_stats + pricing_menu), and it drops the deprecated
// create_pending_settlement (settle inits the pending itself). register / update_agent
// / init_stake / deposit_stake / request_unstake / complete_unstake / feedback /
// attestation contexts were verified IDENTICAL to the prior vendored IDL, so their
// accountsStrict calls below are unchanged.
//
// NOTE: the legacy SOL-only escrow rail (`createEscrow`/`settleCalls`/`closeEscrow`
// Anchor calls below) is 0.18-shaped and NOT migrated — under this IDL its
// `accountsStrict` calls fail-closed (throw "Account … not provided", caught →
// structured error). It is gated OFF (SAP_ESCROW_ENABLED default false) + dry-run, so
// this is safe; a separate SOL-rail migration is out of this diff's scope.
import idlJson from '@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json' with { type: 'json' };

const COMMITMENT: Commitment = 'confirmed';
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// settlement_security discriminant — SelfReport (0) only, per the plan.
// CoSigned/DisputeWindow are deferred (the DisputeWindow settlement_index
// footgun is out of scope). The route layer pins this; we never accept it from
// a request body.
export const SETTLEMENT_SELF_REPORT = 0;

// ─── structured result types (NEVER throw raw to the route) ───────────────────

export type SapErrorCode =
  | 'sap_disabled'
  | 'sap_escrow_disabled'
  | 'sap_usdc_escrow_disabled'
  | 'avatar_wallet_missing'
  | 'invalid_pubkey'
  | 'invalid_mint'
  | 'sol_only_for_now'
  | 'invalid_amount'
  | 'mainnet_broadcast_refused'
  | 'rpc_unreachable'
  | 'on_chain_error'
  // Distinct, caller-actionable deployed-program custom errors (0.25, devnet-confirmed 2026-07-09).
  | 'insufficient_escrow_balance' // 6062 — deposit too small for the protocol fee
  | 'stake_below_minimum' // 6107 — agent must stake >= 0.1 SOL first
  | 'pricing_tier_not_found' // 6148 — provision a pricing tier matching price_per_call first
  | 'pending_settlement_deprecated' // 6161 — create_pending_settlement removed; use settle_calls_v2
  | 'stake_below_coverage'
  | 'escrow_coverage_exceeded'
  | 'internal';

export interface SapDryRunResult {
  ok: true;
  dryRun: true;
  /** The raw simulation response (logs + err + unitsConsumed). */
  simulation: SimulatedTransactionResponse;
  /**
   * Whether the simulation showed the instruction reached + was DECODED by the
   * program (a positive `Program <id> invoke` log with no malformed-encoding
   * signature). FIX-B: this is now HONEST — `false` when the program was never
   * invoked (e.g. `AccountNotFound`/empty logs on an unfunded custodial wallet),
   * which is INCONCLUSIVE, not proof of a correct account set. A program runtime/
   * custom error AFTER invoke still counts as `accepted:true` (it proves the
   * account context reached the program).
   */
  accepted: boolean;
  /**
   * Was the SAP program actually INVOKED in the sim? `'yes'` = a real invoke log;
   * `'no'` = a malformed-instruction signature (encoding/account mismatch);
   * `'inconclusive'` = the program never ran (under-funded payer / pre-program
   * abort) — the encoding could not be exercised. Callers/operators must read
   * `'inconclusive'` as "fund the wallet and retry", NOT as success.
   */
  programReached: 'yes' | 'no' | 'inconclusive';
  accounts: Record<string, string>;
}

export interface SapLiveResult {
  ok: true;
  dryRun: false;
  signature: string;
  accounts: Record<string, string>;
}

export interface SapReadResult<T> {
  ok: true;
  data: T;
}

export interface SapFailure {
  ok: false;
  code: SapErrorCode;
  message: string;
  /**
   * BLOCKING #5 fix — TRUE only when a LIVE transaction was actually broadcast to
   * the network (`sendRawTransaction` returned a signature) but its CONFIRMATION
   * was never observed (timeout / RPC drop). The escrow gate uses this to decide
   * whether deleting/retrying is safe: a failure WITHOUT `broadcast` never touched
   * the wire (clean delete OK); a failure WITH `broadcast` may have LANDED, so the
   * gate must persist a recoverable `funding_unknown`/`failed` state + the
   * `signature` and NEVER auto-delete or auto-retry (that would double-fund /
   * double-pay). Always falsy on a dry-run (the simulator never broadcasts).
   */
  broadcast?: boolean;
  /** The broadcast tx signature when `broadcast===true` (for reconciliation). */
  signature?: string;
}

export type SapWriteResult = SapDryRunResult | SapLiveResult | SapFailure;

// ─── module-scope singletons ──────────────────────────────────────────────────

let cachedCfg: SapConfig | null = null;
let cachedConnection: Connection | null = null;
let cachedProgram: Program | null = null;

function getConfig(): SapConfig {
  if (!cachedCfg) cachedCfg = loadSapConfig();
  return cachedCfg;
}

function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(getConfig().rpcUrl, COMMITMENT);
  }
  return cachedConnection;
}

/**
 * A read-only placeholder wallet for the AnchorProvider. Anchor's provider
 * requires a wallet to assemble txns, but we NEVER let it auto-sign with a real
 * custodial key — we build the tx, then partial-sign with the per-call decrypted
 * agent `Keypair` ourselves. This placeholder's `signTransaction` is a no-op
 * (returns the tx unchanged) so the provider can never silently sign with the
 * wrong key. Its keypair is a throwaway generated at module load.
 */
function makePlaceholderWallet() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: async (tx: any) => tx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signAllTransactions: async (txs: any) => txs,
    payer: kp,
  };
}

function getProgram(): Program {
  if (cachedProgram) return cachedProgram;
  const provider = new AnchorProvider(
    getConnection(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makePlaceholderWallet() as any,
    { commitment: COMMITMENT, preflightCommitment: COMMITMENT },
  );
  // Anchor 0.31 — 2-arg `new Program(idl, provider)`; idl.address carries the
  // program id (the SDK 1.0.0 IDL pins SAPpU…FETZ).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cachedProgram = new Program(idlJson as any, provider);
  return cachedProgram;
}

/** Public, side-effect-free config read for the route layer's gate checks. */
export function sapConfigSnapshot(): {
  enabled: boolean;
  escrowEnabled: boolean;
  usdcEscrowEnabled: boolean;
  /** PayAI x402 settlement rail gate (SAP_PAYAI_SETTLEMENT_ENABLED). */
  payaiSettlementEnabled: boolean;
  dryRun: boolean;
  cluster: string;
  programId: string;
  rpcUrl: string;
} {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    escrowEnabled: cfg.escrowEnabled,
    usdcEscrowEnabled: cfg.usdcEscrowEnabled,
    payaiSettlementEnabled: cfg.payaiSettlementEnabled,
    dryRun: cfg.dryRun,
    cluster: cfg.cluster,
    programId: cfg.programId.toBase58(),
    rpcUrl: cfg.rpcUrl,
  };
}

// ─── custodial wallet loading (decrypt-in-memory-only) ────────────────────────

interface AvatarWalletHandle {
  keypair: Keypair;
  publicKey: PublicKey;
}

/**
 * Load + decrypt the avatar's custodial Solana keypair. The returned `Keypair`
 * lives only as long as the caller holds it — sign, then let it fall out of
 * scope. NEVER log/echo/return the secret. Returns a structured failure (not a
 * throw) when the wallet row is missing.
 */
async function loadAvatarWallet(
  avatarId: string,
): Promise<AvatarWalletHandle | SapFailure> {
  // FIX-F: wrap the DB lookup + decrypt in try/catch so a decrypt/DB failure
  // returns a structured `internal` failure (mapped to a clean 5xx by the route)
  // instead of throwing an unhandled rejection. CRITICAL: the underlying error is
  // NEVER echoed — a decrypt error can carry key-pipeline detail; we return a
  // fixed, non-revealing message and let the secret/error stay internal.
  try {
    const row = await db.query.wallets.findFirst({
      where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    });
    if (!row) {
      return {
        ok: false,
        code: 'avatar_wallet_missing',
        message: `Avatar ${avatarId} has no custodial Solana wallet row.`,
      };
    }
    const keypair = await decryptWalletRow(row);
    return { keypair, publicKey: keypair.publicKey };
  } catch {
    // Do NOT include the caught error — it may reference the KEK/secret pipeline.
    return {
      ok: false,
      code: 'internal',
      message: 'wallet decrypt failed',
    };
  }
}

/**
 * SIGN-SCOPED export of the custodial wallet loader for sibling SAP money
 * modules (today: `payai-release.ts`, which must sign an x402 payment payload AS
 * the depositor). Same contract as the private loader: decrypt IN MEMORY ONLY,
 * sign, let the `Keypair` fall out of scope; NEVER log/echo/persist the secret;
 * a missing row / decrypt failure returns a structured `SapFailure`, never a
 * throw. Do NOT widen the callers of this beyond in-process signing legs.
 */
export async function loadAvatarWalletForSigning(
  avatarId: string,
): Promise<{ keypair: Keypair; publicKey: PublicKey } | SapFailure> {
  return loadAvatarWallet(avatarId);
}

// ─── error classification ─────────────────────────────────────────────────────

/**
 * Map a deployed-program custom error NUMBER (Anchor error code) to a stable,
 * caller-actionable `code`. Lets a route react ("provision your pricing tier /
 * stake first") instead of parsing a raw Anchor message. The numbers are the
 * deployed 0.25 program's (devnet-confirmed 2026-07-09); extend as new ones surface.
 */
const SAP_ONCHAIN_ERROR_CODES: Record<number, SapErrorCode> = {
  6145: 'stake_below_coverage',
  6153: 'escrow_coverage_exceeded',
  6062: 'insufficient_escrow_balance', // 0x17ae — deposit too small for the fee (raise initialDeposit)
  6107: 'stake_below_minimum', // 0x17db — agent must stake >= 0.1 SOL first
  6148: 'pricing_tier_not_found', // 0x1804 — provision a pricing tier matching price_per_call first
  6161: 'pending_settlement_deprecated', // 0x1811 — create_pending_settlement removed; use settle_calls_v2
};

/** Extract the Anchor custom error number from a message string OR a tx `err` object. */
function extractCustomErrorNumber(input: unknown): number | null {
  // tx confirmation `value.err` shape: { InstructionError: [i, { Custom: <n> }] }
  if (input && typeof input === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ie = (input as any).InstructionError;
    if (Array.isArray(ie) && ie[1] && typeof ie[1] === 'object' && typeof ie[1].Custom === 'number') {
      return ie[1].Custom as number;
    }
  }
  const msg = typeof input === 'string' ? input : input instanceof Error ? input.message : JSON.stringify(input ?? '');
  // "custom program error: 0x1804" (hex) or "Error Number: 6148" (dec)
  const hex = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = msg.match(/Error Number:\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  return null;
}

function classifyChainError(label: string, err: unknown): SapFailure {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to send') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('getaddrinfo')
  ) {
    return {
      ok: false,
      code: 'rpc_unreachable',
      message: `SAP RPC unreachable during ${label}.`,
    };
  }
  // Map a known deployed-program custom error to a distinct, caller-actionable code.
  const errNo = extractCustomErrorNumber(err);
  const mapped = errNo !== null ? SAP_ONCHAIN_ERROR_CODES[errNo] : undefined;
  if (mapped) {
    return {
      ok: false,
      code: mapped,
      message: `SAP ${label} rejected on-chain (error ${errNo}): ${msg}`,
    };
  }
  return {
    ok: false,
    code: 'on_chain_error',
    message: `SAP ${label} failed on-chain: ${msg}`,
  };
}

/**
 * The single execution tail shared by every WRITE builder. Takes a fully-built
 * `Transaction` + the decrypted agent `Keypair` (the fee payer + only signer)
 * and either simulates (dry-run) or signs+sends (live). The keypair is used
 * here and never escapes.
 */
async function executeTx(
  cfg: SapConfig,
  label: string,
  tx: Transaction,
  signer: Keypair,
  accounts: Record<string, string>,
): Promise<SapWriteResult> {
  const connection = getConnection();
  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(COMMITMENT);
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;

    if (cfg.dryRun) {
      // DRY-RUN: simulate ONLY. We sign the tx so the simulator validates the
      // signer set, but we run `simulateTransaction`, which NEVER broadcasts.
      tx.sign(signer);
      const sim = await connection.simulateTransaction(tx);
      // FIX-B: classify HONESTLY from the program-invoke log, not the absence of
      // a malformed signature. An unfunded custodial wallet aborts the sim BEFORE
      // the program runs (AccountNotFound / empty logs) — that is INCONCLUSIVE,
      // NOT proof the account set is correct. Only a real `Program <id> invoke`
      // with no malformed-encoding signature is `accepted:true`.
      const programReached = classifyProgramReached(cfg.programId.toBase58(), sim.value);
      const accepted = programReached === 'yes';
      return {
        ok: true,
        dryRun: true,
        simulation: sim.value,
        accepted,
        programReached,
        accounts,
      };
    }

    // ── LIVE-SEND MAINNET GUARD (FIX-D, authoritative) ──────────────────────────
    // Before ANY broadcast, fetch the connection's genesis hash and REFUSE if it
    // is the Solana MAINNET genesis, UNLESS the full mainnet code gate is on
    // (SAP_CLUSTER=mainnet AND SAP_ALLOW_MAINNET). The program id is identical on
    // every cluster, so SAP_RPC_URL=<mainnet> + SAP_CLUSTER=devnet (which the
    // static hostname pre-check in sap-config can miss for an unknown RPC) would
    // otherwise broadcast real funds to mainnet. This is the ground-truth guard:
    // it checks the chain the RPC is ACTUALLY on, not what env claims.
    const mainnetGateOn = cfg.cluster === 'mainnet' && SAP_ALLOW_MAINNET;
    if (!mainnetGateOn) {
      const genesisGuard = await assertNotMainnetGenesis(connection, label);
      if (genesisGuard) return genesisGuard;
    }

    // LIVE: sign + send + confirm. Reached only when SAP_DRY_RUN=false AND the
    // route already passed the enabled/escrow gate.
    tx.sign(signer);
    // BLOCKING #5 fix — split BROADCAST from CONFIRM so a confirmation failure
    // AFTER a successful broadcast is reported with `broadcast:true` + the
    // signature (the tx may have LANDED). A pre-broadcast failure (build /
    // blockhash / sendRawTransaction reject) falls through to the outer catch with
    // NO `broadcast` flag (nothing hit the wire — a clean retry/delete is safe).
    const signature = await connection.sendRawTransaction(tx.serialize());
    let confirmed;
    try {
      confirmed = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        COMMITMENT,
      );
    } catch (confirmErr) {
      // The send LANDED on the wire; we just never observed confirmation. Tag the
      // failure so the caller persists a recoverable state + signature and NEVER
      // auto-deletes/retries.
      const failure = classifyChainError(`${label}:confirm`, confirmErr);
      return { ...failure, broadcast: true, signature };
    }
    // N1 fix — confirmTransaction RESOLVES even when the tx CONFIRMED WITH A PROGRAM
    // ERROR (it only rejects on non-landing). If `value.err` is non-null the tx landed
    // but REVERTED on-chain: returning ok:true here would let a ledger mark a bounty
    // "settled" when the chain reverted (e.g. 6062/6148). Surface it as a structured
    // failure carrying `broadcast:true` + the signature (the reverted tx did hit the
    // wire — the caller must NOT blindly retry without checking on-chain state).
    if (confirmed.value?.err) {
      const failure = classifyChainError(
        `${label}:reverted`,
        confirmed.value.err as unknown,
      );
      return { ...failure, broadcast: true, signature };
    }
    return { ok: true, dryRun: false, signature, accounts };
  } catch (err) {
    return classifyChainError(label, err);
  }
}

/**
 * Live-send mainnet guard (FIX-D, hardened FIX-H). Fetch the connection's genesis
 * hash and return a structured refusal if it is the Solana MAINNET genesis. Caller
 * invokes this ONLY when the mainnet code gate is OFF — so a mainnet match here
 * means a misconfigured devnet box pointed at a mainnet RPC, which must NEVER
 * broadcast. On an RPC error we FAIL CLOSED (refuse the send).
 *
 * FIX-H: the genesis hash is probed FRESH on EVERY live send — NOT cached. A
 * per-URL cache could be poisoned: an endpoint that first resolves to non-mainnet
 * and is later re-pointed at mainnet (same URL) would skip the check on a stale
 * cache hit. Live sends only occur when SAP_ENABLED + !SAP_DRY_RUN (rare,
 * flip-to-live), so the extra RPC round-trip is immaterial; correctness wins.
 */
async function assertNotMainnetGenesis(
  connection: Connection,
  label: string,
): Promise<SapFailure | null> {
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    // Fail closed: cannot prove the cluster — refuse to broadcast.
    return {
      ok: false,
      code: 'mainnet_broadcast_refused',
      message:
        `SAP ${label}: could not verify the RPC's cluster genesis hash ` +
        `(${err instanceof Error ? err.message : String(err)}); refusing to broadcast ` +
        `(fail-closed — cannot prove the endpoint is not mainnet).`,
    };
  }
  if (genesis === SOLANA_MAINNET_GENESIS_HASH) {
    return {
      ok: false,
      code: 'mainnet_broadcast_refused',
      message:
        `SAP ${label}: the RPC endpoint resolves to the Solana MAINNET cluster ` +
        `(genesis ${genesis}) but the mainnet code gate is OFF. Refusing to broadcast ` +
        `real funds. Point SAP_RPC_URL at devnet, or enable the mainnet code gate ` +
        `(flip SAP_ALLOW_MAINNET + set SAP_CLUSTER=mainnet) deliberately.`,
    };
  }
  return null;
}

// Log signatures that mean the program REJECTED the instruction SHAPE (wrong
// discriminator / account mismatch / deserialization) — a real malformed-encoding
// signal, distinct from a post-invoke business/runtime error.
const MALFORMED_LOG_SIGNATURES = [
  'Fallback functions are not supported',
  'InstructionFallbackNotFound',
  'Could not deserialize',
  'AccountDiscriminatorMismatch',
  'DeclaredProgramIdMismatch',
  'invalid instruction data',
];

/**
 * FIX-B: classify what a dry-run simulation actually PROVED, from the program
 * invoke log — NOT from the absence of an error.
 *
 *   'yes'          → a `Program <id> invoke` log is present and NO malformed
 *                    signature appears: the program ran + decoded the instruction.
 *                    A post-invoke runtime/custom error is fine (the account
 *                    context still reached the program). This is the only "accepted".
 *   'no'           → a malformed-encoding signature appears: the program rejected
 *                    the instruction SHAPE (wrong account set / discriminator).
 *   'inconclusive' → neither: the program was NEVER invoked (e.g. AccountNotFound
 *                    or empty logs on an under-funded fee-payer). The encoding
 *                    could not be exercised — this is NOT a pass.
 */
function classifyProgramReached(
  programId: string,
  sim: SimulatedTransactionResponse,
): 'yes' | 'no' | 'inconclusive' {
  const logs = sim.logs ?? [];
  const joined = logs.join('\n');
  if (MALFORMED_LOG_SIGNATURES.some((s) => joined.includes(s))) return 'no';
  if (logs.some((l) => l.includes(`Program ${programId} invoke`))) return 'yes';
  return 'inconclusive';
}

// ─── Phase 1 — identity / reputation / tool / discovery ───────────────────────

export interface RegisterAgentInput {
  avatarId: string;
  name: string;
  description: string;
  capabilities: { id: string; description?: string | null; protocolId?: string | null; version?: string | null }[];
  protocols: string[];
  agentId?: string | null;
  agentUri?: string | null;
  x402Endpoint?: string | null;
}

/**
 * register_agent — map the agent's custodial wallet → SAP AgentAccount.
 * Pricing is EMPTY for the MVP (`pricing: []`) — identity/reputation only, no
 * priced services declared on-chain yet. The treasury account is OMITTED
 * (not in the IDL account list) → protocol fee = 0.
 */
export async function registerAgent(input: RegisterAgentInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  // 0.25-family register_agent accounts = [wallet, agent, agent_stats, pricing_menu,
  // global_registry, system_program] — the deployed binary carries a `pricing_menu`
  // account (empirically confirmed 2026-07-09; the stale 0.18 onchain IDL lacked it).
  // The `pricing` ARG (empty for the MVP) is unchanged. pricing_menu PDA = deriveAgentPdaSet(...).pricing.
  const { agent, stats, pricing, global } = deriveAgentPdaSet(cfg.programId, wallet);

  const capabilities = input.capabilities.map((c) => ({
    id: c.id,
    description: c.description ?? null,
    protocolId: c.protocolId ?? null,
    version: c.version ?? null,
  }));

  try {
    const tx: Transaction = await program.methods
      .registerAgent(
        input.name,
        input.description,
        capabilities,
        [], // pricing — empty for MVP (no priced services declared on-chain)
        input.protocols,
        input.agentId ?? null,
        input.agentUri ?? null,
        input.x402Endpoint ?? null,
      )
      .accountsStrict({
        wallet,
        agent,
        agentStats: stats,
        pricingMenu: pricing,
        globalRegistry: global,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'registerAgent', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      agentStats: stats.toBase58(),
      pricingMenu: pricing.toBase58(),
      globalRegistry: global.toBase58(),
    });
  } catch (err) {
    return classifyChainError('registerAgent:build', err);
  }
}

export interface PublishToolInput {
  avatarId: string;
  toolName: string;
  /** Canonical JSON schema string for the tool (we store its SHA-256, not it). */
  schemaJson?: string;
  description?: string;
  httpMethod?: number; // u8, default 0
  category?: number; // u8, default 0
  paramsCount?: number; // u8, default 0
  requiredParams?: number; // u8, default 0
  isCompound?: boolean; // default false
}

/**
 * publish_tool — publish a ClawVille capability as an on-chain ToolDescriptor.
 * We store SHA-256 hashes of the name / protocol / description / input+output
 * schema (the program is content-addressed, not a blob store). Tool PDA =
 * ["sap_tool", agent, sha256(toolName)].
 */
export async function publishTool(input: PublishToolInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const nameHash = toolNameHash(input.toolName);
  const [tool] = findToolPda(cfg.programId, agent, nameHash);
  const [global] = findGlobalPda(cfg.programId);

  const schemaHash = input.schemaJson
    ? toolNameHash(input.schemaJson)
    : Buffer.alloc(32);
  const protocolHash = toolNameHash('clawville');
  const descriptionHash = input.description
    ? toolNameHash(input.description)
    : Buffer.alloc(32);

  try {
    const tx: Transaction = await program.methods
      .publishTool(
        input.toolName,
        Array.from(nameHash),
        Array.from(protocolHash),
        Array.from(descriptionHash),
        Array.from(schemaHash), // input_schema_hash
        Array.from(schemaHash), // output_schema_hash (same canonical schema)
        input.httpMethod ?? 0,
        input.category ?? 0,
        input.paramsCount ?? 0,
        input.requiredParams ?? 0,
        input.isCompound ?? false,
      )
      .accountsStrict({
        wallet,
        agent,
        tool,
        globalRegistry: global,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'publishTool', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      tool: tool.toBase58(),
      globalRegistry: global.toBase58(),
    });
  } catch (err) {
    return classifyChainError('publishTool:build', err);
  }
}

export interface GiveFeedbackInput {
  /** The REVIEWER (signer) — the agent giving feedback, as ITS own wallet. */
  reviewerAvatarId: string;
  /** The on-chain AgentAccount PDA of the agent being reviewed (base58). */
  targetAgentPda: string;
  /** 0..1000 reputation score. */
  score: number;
  tag: string;
  /** Optional 32-byte comment hash (sha256 of an off-chain comment). */
  comment?: string;
}

/**
 * give_feedback — the reviewer agent scores a counterpart 0..1000 after an
 * Agent↔Agent interaction. Feedback PDA = ["sap_feedback", targetAgent,
 * reviewerWallet]. The signer is the reviewer's OWN custodial wallet.
 */
export async function giveFeedback(input: GiveFeedbackInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 1000) {
    return { ok: false, code: 'invalid_amount', message: 'score must be an integer 0..1000.' };
  }
  let targetAgent: PublicKey;
  try {
    targetAgent = new PublicKey(input.targetAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'targetAgentPda is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.reviewerAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: reviewer } = handle as AvatarWalletHandle;

  const program = getProgram();
  const { global } = deriveAgentPdaSet(cfg.programId, reviewer);
  const [feedback] = findFeedbackPda(cfg.programId, targetAgent, reviewer);
  const commentHash = input.comment
    ? Array.from(toolNameHash(input.comment))
    : null;

  try {
    const tx: Transaction = await program.methods
      .giveFeedback(input.score, input.tag, commentHash)
      .accountsStrict({
        reviewer,
        feedback,
        agent: targetAgent,
        globalRegistry: global,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'giveFeedback', tx, keypair, {
      reviewer: reviewer.toBase58(),
      feedback: feedback.toBase58(),
      agent: targetAgent.toBase58(),
      globalRegistry: global.toBase58(),
    });
  } catch (err) {
    return classifyChainError('giveFeedback:build', err);
  }
}

export interface CreateAttestationInput {
  /** The ATTESTER (signer) — the agent making the attestation, as ITS own wallet. */
  attesterAvatarId: string;
  /**
   * The on-chain AgentAccount PDA of the SUBJECT agent being attested (base58).
   * Used ONLY as a NON-SIGNER account. The program enforces "attester must NOT be
   * the agent owner" on-chain. This is a body-supplied pubkey and NEVER a signer.
   */
  subjectAgentPda: string;
  /** Attestation type/label — max 32 chars (e.g. 'verified', 'collaborated'). */
  attestationType: string;
  /**
   * Optional off-chain metadata (URI / note). sha256'd → the 32-byte
   * `metadata_hash` arg. Absent ⇒ 32 zero bytes (the "no metadata" sentinel).
   */
  metadata?: string;
  /** Unix-seconds expiry (i64). 0 = never expires (per the on-chain docs). */
  expiresAt?: bigint;
}

/**
 * create_attestation — the attester agent attests to a counterpart (cross-agent
 * web-of-trust; the "reputation = feedback + cross-agent attestations" Light rung).
 *
 * Attestation PDA = ["sap_attest", subjectAgent, attesterWallet]. The signer is
 * the attester's OWN custodial wallet. The subject agent is a NON-SIGNER account.
 *
 * On-chain 0.18.0 account context (ORDER matters — verbatim from the IDL):
 *   [attester(signer,writable), agent(subject,ro), attestation(pda,writable),
 *    global_registry(pda,writable), system_program]
 *
 * Args: attestation_type:string(≤32), metadata_hash:[u8;32], expires_at:i64.
 *
 * REPUTATION (not money): gated on `cfg.enabled` ONLY — same as give_feedback,
 * NOT the escrow gate. The route layer applies `requireLedgerCapable` (a custodial
 * sign still occurs) before the handler reaches here.
 */
export async function createAttestation(
  input: CreateAttestationInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  // attestation_type: program caps it at 32 chars — reject early + clean.
  if (
    typeof input.attestationType !== 'string' ||
    input.attestationType.length < 1 ||
    input.attestationType.length > 32
  ) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'attestationType must be a 1..32 char string.',
    };
  }
  const expiresAt = input.expiresAt ?? 0n;
  if (expiresAt < 0n) {
    return { ok: false, code: 'invalid_amount', message: 'expiresAt must be ≥ 0 (0 = never).' };
  }
  let subjectAgent: PublicKey;
  try {
    subjectAgent = new PublicKey(input.subjectAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'subjectAgentPda is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.attesterAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: attester } = handle as AvatarWalletHandle;

  const program = getProgram();
  const { global } = deriveAgentPdaSet(cfg.programId, attester);
  const [attestation] = findAttestationPda(cfg.programId, subjectAgent, attester);
  // metadata_hash is a REQUIRED [u8;32] (not an Option like feedback's
  // comment_hash) — sha256 the metadata, or 32 zero bytes when none is supplied.
  const metadataHash = input.metadata
    ? Array.from(sha256Bytes(input.metadata))
    : Array.from(Buffer.alloc(32));

  try {
    const tx: Transaction = await program.methods
      .createAttestation(input.attestationType, metadataHash, new BN(expiresAt.toString()))
      .accountsStrict({
        attester,
        agent: subjectAgent,
        attestation,
        globalRegistry: global,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'createAttestation', tx, keypair, {
      attester: attester.toBase58(),
      agent: subjectAgent.toBase58(),
      attestation: attestation.toBase58(),
      globalRegistry: global.toBase58(),
    });
  } catch (err) {
    return classifyChainError('createAttestation:build', err);
  }
}

export interface RevokeAttestationInput {
  /** The original ATTESTER (signer) — only it may revoke, as ITS own wallet. */
  attesterAvatarId: string;
  /** The on-chain AgentAccount PDA of the SUBJECT agent (base58) — non-signer. */
  subjectAgentPda: string;
}

/**
 * revoke_attestation — the ORIGINAL attester revokes its own attestation of a
 * subject. On-chain rule: "Original attester only." The PDA is the same
 * ["sap_attest", subjectAgent, attesterWallet]; the program resolves the stored
 * `agent`/`attester` relations from it.
 *
 * On-chain 0.18.0 account context (ORDER matters — verbatim from the IDL; note
 * revoke does NOT touch global_registry):
 *   [attester(signer,ro), agent(subject,ro), attestation(pda,writable)]
 *
 * Args: none. REPUTATION (not money): gated on `cfg.enabled` only.
 */
export async function revokeAttestation(
  input: RevokeAttestationInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  let subjectAgent: PublicKey;
  try {
    subjectAgent = new PublicKey(input.subjectAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'subjectAgentPda is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.attesterAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: attester } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [attestation] = findAttestationPda(cfg.programId, subjectAgent, attester);

  try {
    const tx: Transaction = await program.methods
      .revokeAttestation()
      .accountsStrict({
        attester,
        agent: subjectAgent,
        attestation,
      })
      .transaction();

    return executeTx(cfg, 'revokeAttestation', tx, keypair, {
      attester: attester.toBase58(),
      agent: subjectAgent.toBase58(),
      attestation: attestation.toBase58(),
    });
  } catch (err) {
    return classifyChainError('revokeAttestation:build', err);
  }
}

// ─── discovery (read-only — NO signing) ───────────────────────────────────────

export interface AgentProfile {
  agentPda: string;
  wallet: string;
  name: string;
  description: string;
  isActive: boolean;
  reputationScore: number;
  totalFeedbacks: number;
  agentUri: string | null;
  x402Endpoint: string | null;
}

/** Decode a raw AgentAccount into the trimmed profile DTO. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProfile(pda: PublicKey, acc: any): AgentProfile {
  return {
    agentPda: pda.toBase58(),
    wallet: (acc.wallet as PublicKey).toBase58(),
    name: acc.name,
    description: acc.description,
    isActive: acc.isActive,
    reputationScore: Number(acc.reputationScore ?? 0),
    totalFeedbacks: Number(acc.totalFeedbacks ?? 0),
    agentUri: acc.agentUri ?? null,
    x402Endpoint: acc.x402Endpoint ?? null,
  };
}

/** Fetch one agent profile by its wallet pubkey (derives the agent PDA). */
export async function fetchAgentProfile(
  walletPubkey: string,
): Promise<SapReadResult<AgentProfile | null> | SapFailure> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(walletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'wallet is not a valid pubkey.' };
  }
  const program = getProgram();
  const [agentPda] = findAgentPda(cfg.programId, wallet);
  try {
    // fetchNullable returns null when the account doesn't exist (not registered).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (program.account as any).agentAccount.fetchNullable(agentPda);
    return { ok: true, data: acc ? toProfile(agentPda, acc) : null };
  } catch (err) {
    return classifyChainError('fetchAgentProfile', err);
  }
}

/**
 * discoverAgents — list registered AgentAccounts (the anchor coder applies the
 * AgentAccount discriminator memcmp automatically via `.all()`). Read-only;
 * never signs. `limit` trims client-side after fetch.
 */
export async function discoverAgents(
  limit = 100,
): Promise<SapReadResult<AgentProfile[]> | SapFailure> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  const program = getProgram();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await (program.account as any).agentAccount.all();
    const profiles = all
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => toProfile(r.publicKey, r.account))
      .sort((a: AgentProfile, b: AgentProfile) => b.reputationScore - a.reputationScore)
      .slice(0, Math.max(0, Math.min(limit, 1000)));
    return { ok: true, data: profiles };
  } catch (err) {
    return classifyChainError('discoverAgents', err);
  }
}

// ─── Phase 2 — stake + escrow money rail (separately gated) ───────────────────

function escrowGate(cfg: SapConfig): SapFailure | null {
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  if (!cfg.escrowEnabled) {
    return { ok: false, code: 'sap_escrow_disabled', message: 'SAP escrow/stake rail is disabled.' };
  }
  return null;
}

export interface StakeInput {
  avatarId: string;
  /** Lamports to stake. Must be ≥ SAP_MIN_STAKE_LAMPORTS for init. */
  lamports: bigint;
}

/**
 * init_stake — create the agent's AgentStake PDA with an initial deposit. Real,
 * timelocked SOL. The route surfaces this as an EXPLICIT separate step (never
 * auto-staked). Enforces the ≥0.1 SOL minimum client-side for a clean error.
 */
export async function initStake(input: StakeInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.lamports < cfg.minStakeLamports) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: `init stake must be ≥ ${cfg.minStakeLamports} lamports (0.1 SOL).`,
    };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [stake] = findStakePda(cfg.programId, agent);

  try {
    const tx: Transaction = await program.methods
      .initStake(new BN(input.lamports.toString()))
      .accountsStrict({ wallet, agent, stake, systemProgram: SYSTEM_PROGRAM_ID })
      .transaction();
    return executeTx(cfg, 'initStake', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      stake: stake.toBase58(),
    });
  } catch (err) {
    return classifyChainError('initStake:build', err);
  }
}

/** deposit_stake — top up an existing AgentStake PDA. */
export async function depositStake(input: StakeInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.lamports <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'deposit must be > 0.' };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [stake] = findStakePda(cfg.programId, agent);

  try {
    const tx: Transaction = await program.methods
      .depositStake(new BN(input.lamports.toString()))
      .accountsStrict({ wallet, agent, stake, systemProgram: SYSTEM_PROGRAM_ID })
      .transaction();
    return executeTx(cfg, 'depositStake', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      stake: stake.toBase58(),
    });
  } catch (err) {
    return classifyChainError('depositStake:build', err);
  }
}

/**
 * Stake-coverage preflight — a FAIL-FAST client mirror of the on-chain gate, NOT the
 * source of truth. The deployed create_escrow_v2 requires the WORKER agent to hold an
 * AgentStake PDA with staked_amount ≥ the coverage requirement (StakeBelowMinimum 6107
 * / insufficient coverage otherwise). Reading it here BEFORE building lets a create
 * against an unstaked / under-staked worker fail with an actionable code instead of a
 * raw on-chain revert.
 *
 * `computeV2EscrowCoverageLimit` below is the exact raw-unit source mirror. For a
 * USDC escrow, raw token base units are compared directly to lamports with a 0.1 SOL
 * minimum; there is no mint-decimal or price-oracle conversion.
 *
 * DRY-RUN rehearsal: when the stake account is simply MISSING on a dry-run (the agent
 * hasn't been provisioned on this cluster yet) we SKIP the preflight so the encoding is
 * still exercised — mirroring settleCallsV2Usdc's missing-escrow handling. A LIVE send
 * with a missing/under stake fails fast (never broadcasts a doomed create).
 */
/** Narrow read seam for deterministic preflight tests; production omits it. */
export interface V2CoveragePreflightReaders {
  readStakeLamports?: (stakePda: PublicKey) => Promise<bigint | null>;
  readEscrow?: (
    escrowPda: PublicKey,
  ) => Promise<{ balance: bigint; maxObligation: bigint } | null>;
}

async function checkAgentStakeCoverage(
  cfg: SapConfig,
  agentPda: PublicKey,
  terms: V2EscrowCoverageTerms,
  readStakeLamports?: V2CoveragePreflightReaders['readStakeLamports'],
): Promise<SapFailure | null> {
  const [stakePda] = findStakePda(cfg.programId, agentPda);
  const evaluated = await preflightV2CreateCoverage(terms, async () => {
    if (readStakeLamports) return readStakeLamports(stakePda);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (getProgram().account as any).agentStake.fetchNullable(stakePda);
    if (!acc) return null;
    const decodedStake = acc.stakedAmount ?? acc.staked_amount;
    if (decodedStake == null) throw new Error('unexpected AgentStake decode shape');
    return BigInt(decodedStake.toString());
  });
  if (!evaluated) return null;
  if (evaluated.state === 'missing_stake') {
    const coverage = computeV2EscrowCoverageLimit(terms);
    if (cfg.dryRun) return null; // rehearsal — encoding still exercised; chain enforces.
    return {
      ok: false,
      code: 'stake_below_minimum',
      message:
        `worker agent ${agentPda.toBase58()} has no AgentStake — provision ≥ ` +
        `${coverage.requiredStakeLamports} lamports (provisionAgentStake / init_stake) before opening an escrow.`,
    };
  }
  const coverage = evaluated.verdict;
  const staked = evaluated.stakeLamports;
  if (!coverage.ok) {
    return {
      ok: false,
      code: 'stake_below_coverage',
      message:
        `worker stake ${staked} lamports cannot cover max_obligation ` +
        `${coverage.maxObligation} base units; required stake is ` +
        `${coverage.requiredStakeLamports} lamports. Top up ` +
        `${coverage.additionalStakeLamports} more lamports before opening.`,
    };
  }
  return null;
}

async function checkEscrowDepositCoverage(
  escrowPda: PublicKey,
  amount: bigint,
  readEscrow?: V2CoveragePreflightReaders['readEscrow'],
): Promise<SapFailure | null> {
  const verdict = await preflightV2DepositCoverage(amount, async () => {
    if (readEscrow) {
      return readEscrow(escrowPda);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await (getProgram().account as any).escrowAccountV2.fetchNullable(escrowPda);
    return account
      ? {
          balance: BigInt(account.balance.toString()),
          maxObligation: BigInt((account.maxObligation ?? account.max_obligation).toString()),
        }
      : null;
  });
  if (!verdict || verdict.ok) return null;
  return {
    ok: false,
    code: 'escrow_coverage_exceeded',
    message:
      `deposit would raise the V2 escrow balance to ${verdict.projectedBalance} base units, ` +
      `above max_obligation ${verdict.maxObligation}; maximum additional deposit is ` +
      `${verdict.maximumAdditionalDeposit} base units. Open a new nonce-scoped escrow ` +
      `with a larger call obligation instead.`,
  };
}

/** Read-only, fail-open coverage preflight usable before a ledger claim. */
export async function preflightCreateEscrowV2Coverage(input: {
  workerWalletPubkey: string;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
}, readers: V2CoveragePreflightReaders = {}): Promise<SapFailure | null> {
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }
  const cfg = getConfig();
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  return checkAgentStakeCoverage(cfg, agentPda, input, readers.readStakeLamports);
}

/** Read-only, fail-open deposit-cap preflight usable before a ledger claim. */
export async function preflightDepositEscrowV2Coverage(input: {
  workerWalletPubkey: string;
  depositorWalletPubkey: string;
  escrowNonce: bigint;
  amount: bigint;
}, readers: V2CoveragePreflightReaders = {}): Promise<SapFailure | null> {
  let workerWallet: PublicKey;
  let depositorWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'invalid worker/depositor wallet pubkey.' };
  }
  const cfg = getConfig();
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositorWallet, input.escrowNonce);
  return checkEscrowDepositCoverage(escrowPda, input.amount, readers.readEscrow);
}

export interface ProvisionAgentStakeInput {
  /** The agent OWNER avatar — stakes its OWN SOL as its own custodial wallet. */
  avatarId: string;
  /** Target TOTAL staked_amount (lamports). Must be ≥ the 0.1 SOL minimum. */
  targetLamports: bigint;
}

/**
 * provisionAgentStake — bring the agent's AgentStake up to `targetLamports`, choosing
 * init_stake (no stake yet) vs deposit_stake (top up the delta) by READING the current
 * on-chain stake. EXPLICIT + operator-driven: flag-gated (escrowGate) and dry-run-
 * honored, and NEVER auto-called from a create path — the 0.1+ SOL is a real spend that
 * must be a deliberate step. Signer = the agent owner's OWN custodial wallet. Composes
 * the existing initStake / depositStake executors (same gates + executeTx tail).
 */
export async function provisionAgentStake(
  input: ProvisionAgentStakeInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.targetLamports < cfg.minStakeLamports) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: `target stake must be ≥ ${cfg.minStakeLamports} lamports (0.1 SOL).`,
    };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { publicKey: wallet } = handle as AvatarWalletHandle;
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [stakePda] = findStakePda(cfg.programId, agent);

  // Read current stake to pick init vs deposit + compute the top-up delta. A MISSING
  // account (incl. on a dry-run rehearsal) ⇒ the init path; an existing account ⇒ deposit.
  let current: bigint;
  let accMissing: boolean;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (getProgram().account as any).agentStake.fetchNullable(stakePda);
    accMissing = !acc;
    current = acc && acc.stakedAmount != null ? BigInt(acc.stakedAmount.toString()) : 0n;
  } catch (err) {
    return classifyChainError('provisionAgentStake:read', err);
  }

  if (accMissing) {
    // No stake account yet → init_stake with the full target (init requires ≥ MIN).
    return initStake({ avatarId: input.avatarId, lamports: input.targetLamports });
  }
  if (current >= input.targetLamports) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: `agent stake ${current} already ≥ target ${input.targetLamports}; nothing to provision.`,
    };
  }
  // Top up the delta to reach the target.
  return depositStake({ avatarId: input.avatarId, lamports: input.targetLamports - current });
}

/**
 * request_unstake — begin the timelocked withdrawal of `lamports` from the agent's
 * AgentStake PDA (starts the cooldown; funds are NOT released yet). 0.25-family
 * 3-acct context [wallet(S), agent, stake(W)] (NO system_program). Signer = the
 * agent OWNER's own custodial wallet. Retrieves (does NOT spend) SOL; gated behind
 * the escrow rail + dry-run like the other stake ops.
 */
export async function requestUnstake(input: StakeInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.lamports <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'unstake amount must be > 0.' };
  }
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [stake] = findStakePda(cfg.programId, agent);

  try {
    const tx: Transaction = await program.methods
      .requestUnstake(new BN(input.lamports.toString()))
      .accountsStrict({ wallet, agent, stake })
      .transaction();
    return executeTx(cfg, 'requestUnstake', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      stake: stake.toBase58(),
    });
  } catch (err) {
    return classifyChainError('requestUnstake:build', err);
  }
}

/**
 * complete_unstake — finalize a matured unstake request, releasing the cooled-down
 * lamports from the AgentStake PDA back to the owner wallet. No args. 0.25-family
 * 3-acct context [wallet(S,W), agent, stake(W)] (NO system_program). Signer = the
 * agent OWNER's own custodial wallet.
 */
export async function completeUnstake(input: { avatarId: string }): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [stake] = findStakePda(cfg.programId, agent);

  try {
    const tx: Transaction = await program.methods
      .completeUnstake()
      .accountsStrict({ wallet, agent, stake })
      .transaction();
    return executeTx(cfg, 'completeUnstake', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      stake: stake.toBase58(),
    });
  } catch (err) {
    return classifyChainError('completeUnstake:build', err);
  }
}

export interface UpdateAgentPricingInput {
  /** The agent OWNER (worker) avatar — provisions its OWN pricing tier as ITS wallet. */
  avatarId: string;
  /** Escrow price per call (base units) the "standard" tier advertises. */
  pricePerCall: bigint;
  /** Max calls/sec (u32). Default 100. */
  rateLimit?: number;
  /** Max calls/session (u32; 0=unlimited on-chain). Default 1000. */
  maxCallsPerSession?: number;
}

/**
 * update_agent(pricing) — provision the agent's on-chain AgentPricingMenu with ONE
 * Escrow-mode USDC tier ("standard"). This is the pricing-provisioning PREREQUISITE
 * a worker MUST run before any create_escrow_v2 against it, or create fails
 * PricingTierNotFound 6148 (see the createEscrowV2Usdc FEATURE_GATE note — pricing
 * is NOT auto-provisioned in the create path: update_agent is owner-signed while
 * create is depositor-signed, so it cannot be bundled). Signer = the agent OWNER's
 * own custodial wallet (update_agent is owner-gated on-chain).
 *
 * 0.25-family 4-acct context [wallet(S), agent(W), pricing_menu(W), system_program].
 * Only the `pricing` arg is Some([tier]); every other update_agent option is None,
 * so name/description/capabilities/etc. are left untouched. The tier binds the
 * cluster USDC mint (6 dp), Escrow settlement mode — the shape create_escrow_v2
 * requires. (devnet-confirmed 2026-07-09 tx 5SWRTNhjb82uSGcJvHDb3QShdMrN4CdpRYV2TSvwbXTNrz3yAareNY7jTvpYWniVywdQ8gpK8Rs8RUiTbVz6Y6y)
 */
export async function updateAgentPricing(
  input: UpdateAgentPricingInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.pricePerCall <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'pricePerCall must be > 0.' };
  }
  const rateLimit = input.rateLimit ?? 100;
  const maxCallsPerSession = input.maxCallsPerSession ?? 1000;
  if (!Number.isInteger(rateLimit) || rateLimit < 0 || rateLimit > 0xffff_ffff) {
    return { ok: false, code: 'invalid_amount', message: 'rateLimit must be a u32 (0..4294967295).' };
  }
  if (
    !Number.isInteger(maxCallsPerSession) ||
    maxCallsPerSession < 0 ||
    maxCallsPerSession > 0xffff_ffff
  ) {
    return { ok: false, code: 'invalid_amount', message: 'maxCallsPerSession must be a u32 (0..4294967295).' };
  }

  const handle = await loadAvatarWallet(input.avatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [pricingMenu] = findPricingPda(cfg.programId, agent);

  // ONE Escrow-mode USDC tier "standard" bound to the cluster USDC mint (6 dp).
  // Anchor field names are camelCase; fieldless enums are `{ variantName: {} }`
  // (verified: PascalCase `{ Usdc: {} }` throws "unable to infer src variant").
  const tier = {
    tierId: 'standard',
    pricePerCall: new BN(input.pricePerCall.toString()),
    minPricePerCall: null,
    maxPricePerCall: null,
    rateLimit,
    maxCallsPerSession,
    burstLimit: null,
    tokenType: { usdc: {} },
    tokenMint: cfg.usdcMint,
    tokenDecimals: USDC_DECIMALS,
    settlementMode: { escrow: {} },
    minEscrowDeposit: null,
    batchIntervalSec: null,
    volumeCurve: null,
  };

  try {
    const tx: Transaction = await program.methods
      .updateAgent(
        null, // name
        null, // description
        null, // capabilities
        [tier], // pricing = Some([tier])
        null, // protocols
        null, // agent_id
        null, // agent_uri
        null, // x402_endpoint
      )
      .accountsStrict({ wallet, agent, pricingMenu, systemProgram: SYSTEM_PROGRAM_ID })
      .transaction();
    return executeTx(cfg, 'updateAgentPricing', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      pricingMenu: pricingMenu.toBase58(),
    });
  } catch (err) {
    return classifyChainError('updateAgentPricing:build', err);
  }
}

export interface UpdateAgentPricingUsdcInput {
  /** The worker avatar whose OWN custodial wallet owns and updates the agent. */
  workerAvatarId: string;
  /** Caller-selected pricing tier identifier (1..32 trimmed characters). */
  tierId: string;
  /** Escrow price per call in USDC base units. */
  pricePerCall: bigint;
  /** Max calls/sec (positive i32). Default 100. */
  rateLimit?: number;
  /** Max calls/session (positive i32). Default 1000. */
  maxCallsPerSession?: number;
}

const MAX_POSITIVE_I32 = 0x7fff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

/** Pure service-boundary validation, exported for deterministic contract tests. */
export function validateUpdateAgentPricingUsdcInput(
  input: UpdateAgentPricingUsdcInput,
): SapFailure | null {
  const tierId = input.tierId.trim();
  if (tierId.length < 1 || tierId.length > 32) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'tierId must contain 1..32 characters after trimming.',
    };
  }
  if (input.pricePerCall <= 0n || input.pricePerCall > MAX_U64) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'pricePerCall must be within 1..u64::MAX.',
    };
  }
  const rateLimit = input.rateLimit ?? 100;
  if (!Number.isInteger(rateLimit) || rateLimit <= 0 || rateLimit > MAX_POSITIVE_I32) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'rateLimit must be a positive i32 (1..2147483647).',
    };
  }
  const maxCallsPerSession = input.maxCallsPerSession ?? 1000;
  if (
    !Number.isInteger(maxCallsPerSession) ||
    maxCallsPerSession <= 0 ||
    maxCallsPerSession > MAX_POSITIVE_I32
  ) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'maxCallsPerSession must be a positive i32 (1..2147483647).',
    };
  }
  return null;
}

/**
 * update_agent(pricing) — publish the worker's on-chain AgentPricingMenu with ONE
 * Escrow-mode USDC tier. This is the pricing-provisioning PREREQUISITE
 * a worker MUST run before any create_escrow_v2 against it, or create fails
 * PricingTierNotFound 6148 (see the createEscrowV2Usdc FEATURE_GATE note — pricing
 * is NOT auto-provisioned in the create path: update_agent is owner-signed while
 * create is depositor-signed, so it cannot be bundled). Signer = the agent OWNER's
 * own custodial wallet (update_agent is owner-gated on-chain).
 *
 * IMPORTANT: on-chain `update_agent(pricing = [tier])` REPLACES the worker's whole
 * pricing menu; it does not append or merge. Last write wins, so this API publishes
 * one caller-named tier per worker for now. A later multi-tier API must replace the
 * complete intended menu atomically rather than assuming additive semantics.
 *
 * 0.25-family 4-acct context [wallet(S), agent(W), pricing_menu(W), system_program].
 * Only the `pricing` arg is Some([tier]); every other update_agent option is None,
 * so name/description/capabilities/etc. are left untouched. The tier binds the
 * cluster USDC mint (6 dp), Escrow settlement mode — the shape create_escrow_v2
 * requires. (devnet-confirmed 2026-07-09 tx 5SWRTNhjb82uSGcJvHDb3QShdMrN4CdpRYV2TSvwbXTNrz3yAareNY7jTvpYWniVywdQ8gpK8Rs8RUiTbVz6Y6y)
 */
export async function updateAgentPricingUsdc(
  input: UpdateAgentPricingUsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  const invalid = validateUpdateAgentPricingUsdcInput(input);
  if (invalid) return invalid;

  const tierId = input.tierId.trim();
  const rateLimit = input.rateLimit ?? 100;
  const maxCallsPerSession = input.maxCallsPerSession ?? 1000;

  const handle = await loadAvatarWallet(input.workerAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [pricingMenu] = findPricingPda(cfg.programId, agent);

  // ONE Escrow-mode USDC tier bound to the cluster USDC mint (6 dp).
  // Anchor field names are camelCase; fieldless enums are `{ variantName: {} }`
  // (verified: PascalCase `{ Usdc: {} }` throws "unable to infer src variant").
  const tier = {
    tierId,
    pricePerCall: new BN(input.pricePerCall.toString()),
    minPricePerCall: null,
    maxPricePerCall: null,
    rateLimit,
    maxCallsPerSession,
    burstLimit: null,
    tokenType: { usdc: {} },
    tokenMint: usdcMintForEscrow(cfg),
    tokenDecimals: USDC_DECIMALS,
    settlementMode: { escrow: {} },
    minEscrowDeposit: null,
    batchIntervalSec: null,
    volumeCurve: null,
  };

  try {
    const tx: Transaction = await program.methods
      .updateAgent(
        null, // name
        null, // description
        null, // capabilities
        [tier], // pricing = Some([tier])
        null, // protocols
        null, // agent_id
        null, // agent_uri
        null, // x402_endpoint
      )
      .accountsStrict({ wallet, agent, pricingMenu, systemProgram: SYSTEM_PROGRAM_ID })
      .transaction();
    return executeTx(cfg, 'updateAgentPricingUsdc', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      pricingMenu: pricingMenu.toBase58(),
    });
  } catch (err) {
    return classifyChainError('updateAgentPricingUsdc:build', err);
  }
}

export interface CreateEscrowInput {
  /** The DEPOSITOR (signer + payer) — the consuming agent, as ITS own wallet. */
  depositorAvatarId: string;
  /** The on-chain AgentAccount PDA of the SERVICE agent being prepaid (base58). */
  serviceAgentPda: string;
  /** Per-call escrow nonce (u64) — distinguishes multiple escrows depositor↔agent. */
  nonce: bigint;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** Unix seconds expiry (i64). */
  expiresAt: bigint;
  /** null = native SOL; else the cluster USDC mint (base58). Arbitrary SPL refused. */
  tokenMint?: string | null;
}

/**
 * create_escrow_v2 — depositor opens a prepaid per-call escrow against a service
 * agent. SelfReport settlement only. token_mint None=SOL or the cluster USDC
 * mint ONLY — any other mint is refused CLIENT-SIDE (the program would reject it
 * with 6091 InvalidPaymentToken anyway, but we fail fast + clean).
 */
export async function createEscrow(input: CreateEscrowInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;

  const mint = input.tokenMint ?? null;
  // SOL-only for now (FIX-E). The SPL `remaining_accounts` (token program +
  // escrow/depositor ATAs) are NOT wired, so a non-null mint would hit on-chain
  // `SplTokenRequired`. Refuse ANY non-null mint with a clear, distinct code
  // (NOT `invalid_mint`, which would imply "wrong USDC mint, try the right one").
  if (mint !== null) {
    return {
      ok: false,
      code: 'sol_only_for_now',
      message:
        'SAP escrow is SOL-only for now — the USDC/SPL token path (remaining_accounts ' +
        'wiring) is not implemented yet. Omit tokenMint (or pass null) to escrow in SOL.',
    };
  }
  // Defense-in-depth: even native SOL must pass the honored-mint check (null=SOL).
  if (!isHonoredEscrowMint(cfg, mint)) {
    return {
      ok: false,
      code: 'invalid_mint',
      message: 'Only native SOL (null) escrow is accepted right now.',
    };
  }
  if (input.initialDeposit <= 0n || input.pricePerCall <= 0n || input.maxCalls <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'deposit, pricePerCall, maxCalls must be > 0.' };
  }
  let serviceAgent: PublicKey;
  try {
    serviceAgent = new PublicKey(input.serviceAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'serviceAgentPda is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const program = getProgram();
  // 0.18.0 create_escrow_v2 accounts = [depositor, agent, escrow, system_program].
  // The deployed program has NO agent_stake / agent_stats / pricing_menu accounts
  // here (the 0.25.0 IDL added them). CONSEQUENCE: the 0.18.0 program does NOT
  // enforce the self-stake precondition on-chain at escrow creation. The escrow
  // rail stays hard-gated (SAP_ESCROW_ENABLED) until either 0.25.0 is deployed or
  // a backend stake check is added (see docs/sap-integration.md §9 + FEATURE_GATE).
  const [escrow] = findEscrowPda(cfg.programId, serviceAgent, depositor, input.nonce);

  const tokenMintArg = mint ? new PublicKey(mint) : null;
  // SOL = 9 decimals, USDC = 6. Only used by the program for display math.
  const tokenDecimals = mint ? 6 : 9;

  try {
    const tx: Transaction = await program.methods
      .createEscrowV2(
        new BN(input.nonce.toString()),
        new BN(input.pricePerCall.toString()),
        new BN(input.maxCalls.toString()),
        new BN(input.initialDeposit.toString()),
        new BN(input.expiresAt.toString()),
        [], // volume_curve — none for MVP
        tokenMintArg,
        tokenDecimals,
        SETTLEMENT_SELF_REPORT,
        new BN(0), // dispute_window_slots — SelfReport ignores it
        null, // co_signer — SelfReport
        null, // arbiter — SelfReport
      )
      .accountsStrict({
        depositor,
        agent: serviceAgent,
        escrow,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'createEscrow', tx, keypair, {
      depositor: depositor.toBase58(),
      agent: serviceAgent.toBase58(),
      escrow: escrow.toBase58(),
    });
  } catch (err) {
    return classifyChainError('createEscrow:build', err);
  }
}

export interface DepositEscrowInput {
  depositorAvatarId: string;
  serviceAgentPda: string;
  nonce: bigint;
  amount: bigint;
}

/** deposit_escrow_v2 — top up an existing escrow. */
export async function depositEscrow(input: DepositEscrowInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let serviceAgent: PublicKey;
  try {
    serviceAgent = new PublicKey(input.serviceAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'serviceAgentPda is not a valid pubkey.' };
  }
  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [escrow] = findEscrowPda(cfg.programId, serviceAgent, depositor, input.nonce);

  try {
    const tx: Transaction = await program.methods
      .depositEscrowV2(new BN(input.nonce.toString()), new BN(input.amount.toString()))
      .accountsStrict({ depositor, escrow, systemProgram: SYSTEM_PROGRAM_ID })
      .transaction();
    return executeTx(cfg, 'depositEscrow', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: escrow.toBase58(),
    });
  } catch (err) {
    return classifyChainError('depositEscrow:build', err);
  }
}

export interface SettleCallsInput {
  /** The SERVICE agent (signer, receives lamports) — as ITS own wallet. */
  serviceAvatarId: string;
  /** The depositor's wallet (escrow PDA seed component), base58. */
  depositorWallet: string;
  nonce: bigint;
  callsToSettle: bigint;
  /** Anti-replay service hash parts (joined → sha256) OR a 32-byte hex hash. */
  serviceHashParts: string[];
}

/**
 * settle_calls_v2 — the service agent settles N completed calls, receiving
 * lamports. SelfReport (custodial-trusted). Receipt PDA = ["sap_recv", escrow,
 * service_hash] is the anti-replay key (a repeat with the same hash fails).
 * Signer = the service agent's OWN wallet.
 */
export async function settleCalls(input: SettleCallsInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.callsToSettle <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'callsToSettle must be > 0.' };
  }
  let depositor: PublicKey;
  try {
    depositor = new PublicKey(input.depositorWallet);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'depositorWallet is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.serviceAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: wallet } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [agent] = findAgentPda(cfg.programId, wallet);
  const [agentStats] = findStatsPda(cfg.programId, agent);
  const [escrow] = findEscrowPda(cfg.programId, agent, depositor, input.nonce);
  // 0.18.0 settle_calls_v2 accounts = [wallet, agent, agent_stats, escrow,
  // system_program] — NO settlement_receipt account. The deployed program does
  // NOT have the per-(escrow, service_hash) receipt PDA, so there is NO on-chain
  // anti-replay receipt in 0.18.0 (the 0.25.0 IDL added it). The `service_hash`
  // ARG is still passed (the instruction still takes it), but it is NOT used as a
  // unique receipt key on-chain today. SECURITY: this is exactly why the escrow
  // rail is hard-gated + service_hash MUST be backend-derived/idempotent before
  // real money — see docs/sap-integration.md §9 + the settle FEATURE_GATE note.
  const svcHash = deriveServiceHash(...input.serviceHashParts);

  try {
    const tx: Transaction = await program.methods
      .settleCallsV2(
        new BN(input.nonce.toString()),
        new BN(input.callsToSettle.toString()),
        Array.from(svcHash),
      )
      .accountsStrict({
        wallet,
        agent,
        agentStats,
        escrow,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'settleCalls', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      agentStats: agentStats.toBase58(),
      escrow: escrow.toBase58(),
    });
  } catch (err) {
    return classifyChainError('settleCalls:build', err);
  }
}

export interface WithdrawEscrowInput {
  depositorAvatarId: string;
  serviceAgentPda: string;
  nonce: bigint;
  amount: bigint;
}

/** withdraw_escrow_v2 — depositor reclaims unspent lamports. */
export async function withdrawEscrow(input: WithdrawEscrowInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let serviceAgent: PublicKey;
  try {
    serviceAgent = new PublicKey(input.serviceAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'serviceAgentPda is not a valid pubkey.' };
  }
  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const program = getProgram();
  const [escrow] = findEscrowPda(cfg.programId, serviceAgent, depositor, input.nonce);

  try {
    const tx: Transaction = await program.methods
      .withdrawEscrowV2(new BN(input.amount.toString()))
      .accountsStrict({ depositor, escrow })
      .transaction();
    return executeTx(cfg, 'withdrawEscrow', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: escrow.toBase58(),
    });
  } catch (err) {
    return classifyChainError('withdrawEscrow:build', err);
  }
}

export interface CloseEscrowInput {
  depositorAvatarId: string;
  serviceAgentPda: string;
  nonce: bigint;
}

/** close_escrow_v2 — depositor closes the escrow, reclaiming rent. */
export async function closeEscrow(input: CloseEscrowInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = escrowGate(cfg);
  if (gate) return gate;
  let serviceAgent: PublicKey;
  try {
    serviceAgent = new PublicKey(input.serviceAgentPda);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'serviceAgentPda is not a valid pubkey.' };
  }
  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const program = getProgram();
  // 0.18.0 close_escrow_v2 accounts = [depositor, escrow] — NO agent_stats (the
  // 0.25.0 IDL added it). The deployed program closes the escrow with just the
  // depositor + the escrow PDA.
  const [escrow] = findEscrowPda(cfg.programId, serviceAgent, depositor, input.nonce);

  try {
    const tx: Transaction = await program.methods
      .closeEscrowV2()
      .accountsStrict({ depositor, escrow })
      .transaction();
    return executeTx(cfg, 'closeEscrow', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: escrow.toBase58(),
    });
  } catch (err) {
    return classifyChainError('closeEscrow:build', err);
  }
}

// ─── Option C — OOBE USDC SelfReport escrow (V1 RAW instructions) ─────────────
//
// The USDC path uses the V1 (non-versioned) instructions with HAND-ASSEMBLED
// account lists (the IDL is wrong — see sap-escrow-usdc.ts). These builders are
// the low-level chain leg of the Option C escrow GATE (escrow-gate.ts); they do
// NOT contain the verify/idempotency logic — that lives in the gate. Each one
// hard-checks the Option C sub-gate (escrowEnabled AND usdcEscrowEnabled) BEFORE
// touching the chain, resolves the acting avatar's custodial wallet, and runs
// through the SAME `executeTx` dry-run/live + genesis-guard tail as the SOL rail.

/** Option C USDC sub-gate: requires the master gate, SOL escrow gate, AND usdcEscrowEnabled. */
function usdcEscrowGate(cfg: SapConfig): SapFailure | null {
  if (!cfg.enabled) {
    return { ok: false, code: 'sap_disabled', message: 'SAP layer is disabled.' };
  }
  if (!cfg.escrowEnabled) {
    return { ok: false, code: 'sap_escrow_disabled', message: 'SAP escrow rail is disabled.' };
  }
  if (!cfg.usdcEscrowEnabled) {
    return {
      ok: false,
      code: 'sap_usdc_escrow_disabled',
      message: 'SAP Option C USDC escrow gate is disabled.',
    };
  }
  return null;
}

/**
 * The USDC mint the escrow uses, CLUSTER-PINNED (FIX 4). `cfg.usdcMint` is
 * `USDC_MINT_MAINNET` on mainnet and `USDC_MINT_DEVNET` on devnet
 * (`sap-config.ts`), so a devnet smoke derives every ATA against the devnet test
 * mint and a mainnet flip uses real USDC — NOT a hardcoded mainnet mint that
 * would make the devnet rehearsal derive unusable mainnet-mint ATAs. The
 * genesis-hash live-send guard still refuses a real mainnet broadcast unless the
 * mainnet code gate is on, so cluster-pinning the mint is purely about deriving
 * the CORRECT ATAs for whichever cluster is configured.
 */
function usdcMintForEscrow(cfg: SapConfig): PublicKey {
  return cfg.usdcMint;
}

/**
 * DisputeWindow-only guard (Codex money-path fix). The settle / pending / dispute /
 * resolve executors below are hard-coded for the DisputeWindow flow (settle bumps
 * pending → finalize releases; depositor disputes → arbiter resolves). If the config
 * is CoSigned (a misconfig, since createEscrowV2Usdc refuses to CREATE a CoSigned
 * escrow today), those executors would build a wrong-shaped tx. Refuse up front so a
 * mode mismatch can never assemble a guaranteed-to-fail (or, once CoSigned ships,
 * mis-shaped) transaction.
 */
function disputeWindowModeGate(cfg: SapConfig): SapFailure | null {
  if (cfg.settlementMode !== 'DisputeWindow') {
    return {
      ok: false,
      code: 'internal',
      message:
        `SAP_SETTLEMENT_MODE is '${cfg.settlementMode}' but this executor is DisputeWindow-only. ` +
        'The CoSigned settle path is not implemented yet.',
    };
  }
  return null;
}

export interface UsdcEscrowResolvedAddresses extends UsdcEscrowAddresses {
  /** Acting avatar's wallet pubkey (base58) — for the gate's record. */
  actingWallet: string;
}

/**
 * Resolve every deterministic USDC-escrow address for a (worker, depositor) pair
 * WITHOUT signing or sending. Read-only — used by the gate to compute the
 * `escrowPda` (the idempotency key) before deciding to act. Gated identically to
 * the write builders so a disabled rail leaks nothing.
 */
export function resolveUsdcEscrowAddresses(input: {
  workerWalletPubkey: string;
  depositorWalletPubkey: string;
}): { ok: true; addrs: UsdcEscrowAddresses; mint: PublicKey } | SapFailure {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  let workerWallet: PublicKey;
  let depositorWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'invalid worker/depositor wallet pubkey.' };
  }
  const mint = usdcMintForEscrow(cfg);
  const addrs = deriveUsdcEscrowAddresses({
    programId: cfg.programId,
    workerWallet,
    depositorWallet,
    mint,
  });
  return { ok: true, addrs, mint };
}

/**
 * Resolve the nonce-scoped V2 escrow PDA without signing or sending. The gate
 * needs this deterministic key before its claim-first/fund-second insert.
 */
export function resolveV2UsdcEscrowAddress(input: {
  workerWalletPubkey: string;
  depositorWalletPubkey: string;
  escrowNonce: bigint;
}): { ok: true; escrowPda: PublicKey; mint: PublicKey } | SapFailure {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  let workerWallet: PublicKey;
  let depositorWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'invalid worker/depositor wallet pubkey.' };
  }
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [escrowPda] = findEscrowPda(
    cfg.programId,
    agentPda,
    depositorWallet,
    input.escrowNonce,
  );
  return { ok: true, escrowPda, mint: usdcMintForEscrow(cfg) };
}

/**
 * The DECODED on-chain PendingSettlement fields the gate books on a replay-
 * reconcile (flip-gate fix, docs/sap-integration.md line 624). ALL values come
 * from the chain account, NEVER the caller's request — the reconcile must record
 * what the program actually reserved.
 */
export interface DecodedPendingSettlement {
  /** `PendingSettlement.calls_to_settle` (u64) — the calls this pending covers. */
  callsToSettle: bigint;
  /**
   * `PendingSettlement.amount` (u64) — the GROSS principal reserved for release
   * (= calls × price; devnet-proven `amount=100000` for 10 × 10000, doc line 592),
   * i.e. exactly what the gate books as `reservedPrincipalAmount`. The protocol
   * fee is a SEPARATE leg the caller re-derives via `computeV2ProtocolFee(amount)`.
   */
  amount: bigint;
  isFinalized: boolean;
  isDisputed: boolean;
}

/**
 * Read the authoritative V2 settlement index and — when its PendingSettlement PDA
 * already exists — DECODE that account so the gate books the on-chain principal /
 * calls on a replay-reconcile instead of the caller's requested numbers (doc line
 * 624). The gate calls this before claiming so a replay is routed to finalize
 * without ever rebuilding/re-sending settle_calls_v2.
 *
 * `pending` is populated ONLY when `pendingExists` is true and the Anchor decode
 * succeeded. A decode/RPC failure returns a structured `SapFailure` (retryable) so
 * the caller books NOTHING — never a fabricated amount.
 */
export async function inspectV2SettlementState(input: {
  workerWalletPubkey: string;
  depositorWalletPubkey: string;
  escrowNonce: bigint;
  /** When supplied, inspect this persisted pre-send index, not the escrow's incremented current index. */
  settlementIndex?: bigint;
}): Promise<
  | {
      ok: true;
      escrowPda: string;
      settlementIndex: bigint;
      pendingExists: boolean;
      /** The decoded pending account — present iff `pendingExists`. */
      pending?: DecodedPendingSettlement;
    }
  | SapFailure
> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  const resolved = resolveV2UsdcEscrowAddress(input);
  if (resolved.ok === false) return resolved;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const escrow = await (getProgram().account as any).escrowAccountV2.fetchNullable(
      resolved.escrowPda,
    );
    if (!escrow) {
      if (!cfg.dryRun) {
        return {
          ok: false,
          code: 'on_chain_error',
          message: 'V2 escrow account not found on-chain.',
        };
      }
      return {
        ok: true,
        escrowPda: resolved.escrowPda.toBase58(),
        settlementIndex: 0n,
        pendingExists: false,
      };
    }
    const settlementIndex = input.settlementIndex ?? BigInt(escrow.settlementIndex.toString());
    const [pendingPda] = findPendingPda(cfg.programId, resolved.escrowPda, settlementIndex);
    // Anchor-DECODE the pending account (not a raw getAccountInfo existence probe):
    // a non-null fetch both proves existence AND yields the authoritative reserved
    // principal + calls for the reconcile. `fetchNullable` returns null when the
    // PDA is absent (never settled at this index, or already finalized+closed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingAcc = await (getProgram().account as any).pendingSettlement.fetchNullable(
      pendingPda,
    );
    if (!pendingAcc) {
      return {
        ok: true,
        escrowPda: resolved.escrowPda.toBase58(),
        settlementIndex,
        pendingExists: false,
      };
    }
    const callsRaw = pendingAcc.callsToSettle ?? pendingAcc.calls_to_settle;
    const amountRaw = pendingAcc.amount;
    if (callsRaw == null || amountRaw == null) {
      // Decode succeeded structurally but the money fields are missing — refuse to
      // guess. Surface a retryable failure so the caller books nothing.
      throw new Error('PendingSettlement decode missing calls_to_settle/amount');
    }
    return {
      ok: true,
      escrowPda: resolved.escrowPda.toBase58(),
      settlementIndex,
      pendingExists: true,
      pending: {
        callsToSettle: BigInt(callsRaw.toString()),
        amount: BigInt(amountRaw.toString()),
        isFinalized: Boolean(pendingAcc.isFinalized ?? pendingAcc.is_finalized),
        isDisputed: Boolean(pendingAcc.isDisputed ?? pendingAcc.is_disputed),
      },
    };
  } catch (err) {
    return classifyChainError('inspectV2SettlementState', err);
  }
}

/**
 * The LIVE on-chain physical state of a V2 escrow: the vault ATA token balance AND
 * the escrow account's aggregate `pending_amount` (R4-A, docs line 623/624). Both
 * feed the settle claim:
 *   - `physicalFree = vaultBalance − escrowPendingAmount` clamps the release ceiling
 *     (fail-OPEN — null → ledger fallback; the chain stays the 6062 fail-closed guard).
 *   - `escrowPendingAmount` is the AUTHORITATIVE reserved term and the ONLY source of
 *     the unowned-pending guard (fail-CLOSED). Unlike the DB's reserved sum, it
 *     includes out-of-band settles AND settle_unknown-landed pendings the gate cannot
 *     see (verified field: EscrowAccountV2.pending_amount u64, accessor `pendingAmount`).
 */
export interface V2VaultPhysicalState {
  /** Vault ATA USDC base units, or null on read failure. */
  vaultBalance: bigint | null;
  /**
   * The escrow's on-chain aggregate `pending_amount` (sum of all settled-but-not-
   * finalized principal reserved in the vault), or null on read/decode failure OR
   * when the escrow account is ABSENT (both → the unowned guard fails CLOSED).
   */
  escrowPendingAmount: bigint | null;
}

export async function readV2VaultPhysicalState(input: {
  workerWalletPubkey: string;
  depositorWalletPubkey: string;
  escrowNonce: bigint;
}): Promise<V2VaultPhysicalState> {
  const empty: V2VaultPhysicalState = { vaultBalance: null, escrowPendingAmount: null };
  try {
    const cfg = getConfig();
    if (usdcEscrowGate(cfg)) return empty;
    let workerWallet: PublicKey;
    let depositorWallet: PublicKey;
    try {
      workerWallet = new PublicKey(input.workerWalletPubkey);
      depositorWallet = new PublicKey(input.depositorWalletPubkey);
    } catch {
      return empty;
    }
    const mint = usdcMintForEscrow(cfg);
    const [agentPda] = findAgentPda(cfg.programId, workerWallet);
    const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositorWallet, input.escrowNonce);
    const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
    // A3 — bound the lock-hold. The settle claim calls this WHILE holding the per-escrow
    // advisory lock (+ a pooled DB connection), so a hung RPC could pin both. Both reads
    // race a shared ~4s timeout; each independently resolves to null on timeout/failure.
    // R3-2 — each read carries its own .catch so a slow-then-reject can't unhandled-reject.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 4000);
    });
    const balP: Promise<bigint | null> = getConnection()
      .getTokenAccountBalance(vaultAta, COMMITMENT)
      .then((r) => (r?.value?.amount ? BigInt(r.value.amount) : null))
      .catch(() => null);
    const pendingP: Promise<bigint | null> = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getProgram().account as any).escrowAccountV2
        .fetchNullable(escrowPda)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((acc: any) => {
          if (!acc) return null; // ABSENT escrow ⇒ unverifiable (fail-closed at caller)
          const pa = acc.pendingAmount ?? acc.pending_amount;
          return pa != null ? BigInt(pa.toString()) : 0n;
        })
        .catch(() => null);
    try {
      const [vaultBalance, escrowPendingAmount] = await Promise.all([
        Promise.race([balP, timeout]),
        Promise.race([pendingP, timeout]),
      ]);
      return { vaultBalance: vaultBalance ?? null, escrowPendingAmount: escrowPendingAmount ?? null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return empty;
  }
}

export interface CreateEscrowUsdcInput {
  /** The DEPOSITOR (signer + payer) avatar — funds the escrow as ITS own wallet. */
  depositorAvatarId: string;
  /** The worker/service agent's registered wallet pubkey (base58) — escrow seed. */
  workerWalletPubkey: string;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** Absolute unix-seconds expiry (i64). 0 = no expiry. */
  expiresAt: bigint;
}

/**
 * create_escrow (V1 USDC) — depositor opens + funds the escrow. Prepends an
 * idempotent vault-ATA create (the program does NOT init the vault). Signer =
 * the depositor's OWN custodial wallet.
 */
export async function createEscrowUsdc(input: CreateEscrowUsdcInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.pricePerCall <= 0n || input.maxCalls <= 0n || input.initialDeposit <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'pricePerCall, maxCalls, initialDeposit must be > 0.' };
  }
  if (input.expiresAt < 0n) {
    return { ok: false, code: 'invalid_amount', message: 'expiresAt must be ≥ 0 (0 = no expiry).' };
  }
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const addrs = deriveUsdcEscrowAddresses({
    programId: cfg.programId,
    workerWallet,
    depositorWallet: depositor,
    mint,
  });

  try {
    const tx = new Transaction();
    // (1) Idempotent vault ATA create — payer = depositor, owner = escrow PDA.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: depositor,
        ata: addrs.vaultAta,
        owner: addrs.escrowPda,
        mint,
      }),
    );
    // (2) create_escrow (V1) + initial deposit (one tx).
    tx.add(
      buildCreateEscrowUsdcIx({
        depositor,
        addrs,
        programId: cfg.programId,
        mint,
        pricePerCall: input.pricePerCall,
        maxCalls: input.maxCalls,
        initialDeposit: input.initialDeposit,
        expiresAt: input.expiresAt,
      }),
    );
    return executeTx(cfg, 'createEscrowUsdc', tx, keypair, {
      depositor: depositor.toBase58(),
      worker: workerWallet.toBase58(),
      agent: addrs.agentPda.toBase58(),
      escrow: addrs.escrowPda.toBase58(),
      vaultAta: addrs.vaultAta.toBase58(),
      depositorAta: addrs.depositorAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('createEscrowUsdc:build', err);
  }
}

export interface DepositEscrowUsdcInput {
  depositorAvatarId: string;
  workerWalletPubkey: string;
  amount: bigint;
}

/** deposit_escrow (V1 USDC) — top up the standing per-(agent,depositor) escrow. */
export async function depositEscrowUsdc(input: DepositEscrowUsdcInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const addrs = deriveUsdcEscrowAddresses({
    programId: cfg.programId,
    workerWallet,
    depositorWallet: depositor,
    mint,
  });

  try {
    const tx = new Transaction();
    // Idempotent vault ATA create is safe to prepend (no-op if it exists), so a
    // deposit can never fail on a missing vault if create raced.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: depositor,
        ata: addrs.vaultAta,
        owner: addrs.escrowPda,
        mint,
      }),
    );
    tx.add(
      buildDepositEscrowUsdcIx({ depositor, addrs, programId: cfg.programId, amount: input.amount }),
    );
    return executeTx(cfg, 'depositEscrowUsdc', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: addrs.escrowPda.toBase58(),
      vaultAta: addrs.vaultAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('depositEscrowUsdc:build', err);
  }
}

export interface SettleCallsUsdcInput {
  /** The WORKER agent (signer, receives USDC) — settles as ITS own wallet. */
  workerAvatarId: string;
  /** The depositor's wallet pubkey (escrow PDA seed component), base58. */
  depositorWalletPubkey: string;
  callsToSettle: bigint;
  /** The verification provider's 32-byte audit root → on-chain service_hash. */
  auditRoot: Uint8Array;
}

/**
 * settle_calls (V1 USDC) — release vault → worker's USDC ATA. Signer = the
 * worker's OWN custodial wallet (= the agent PDA seed + the only settle
 * authority). The 32-byte `auditRoot` is bound into `service_hash` for on-chain
 * provenance. CALLED ONLY BY THE GATE after a passing verification + an atomic
 * idempotency claim — never directly from a route.
 */
export async function settleCallsUsdc(input: SettleCallsUsdcInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.callsToSettle <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'callsToSettle must be > 0.' };
  }
  if (input.auditRoot.length !== 32) {
    return { ok: false, code: 'invalid_amount', message: 'auditRoot must be 32 bytes.' };
  }
  // Refuse a zero (sentinel) audit root — that is the verification-failed marker,
  // and a settle must NEVER fire on it. Defense-in-depth: the gate already only
  // calls settle on `passed===true`, but a non-zero root is a hard invariant of a
  // legitimate release, so we reject it here too.
  if (input.auditRoot.every((b) => b === 0)) {
    return { ok: false, code: 'invalid_amount', message: 'auditRoot is all-zero (verification did not pass).' };
  }
  let depositorWallet: PublicKey;
  try {
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'depositorWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.workerAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: workerWallet } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const addrs = deriveUsdcEscrowAddresses({
    programId: cfg.programId,
    workerWallet,
    depositorWallet,
    mint,
  });

  try {
    const tx = new Transaction();
    // Idempotent worker-ATA create (the settle DESTINATION). Payer = the worker.
    // The program releases into agentAta; if it does not exist yet the settle
    // would fail — create it idempotently first.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: workerWallet,
        ata: addrs.agentAta,
        owner: workerWallet,
        mint,
      }),
    );
    tx.add(
      buildSettleCallsUsdcIx({
        workerWallet,
        addrs,
        programId: cfg.programId,
        mint,
        callsToSettle: input.callsToSettle,
        serviceHash: Buffer.from(input.auditRoot),
      }),
    );
    return executeTx(cfg, 'settleCallsUsdc', tx, keypair, {
      worker: workerWallet.toBase58(),
      agent: addrs.agentPda.toBase58(),
      agentStats: addrs.agentStatsPda.toBase58(),
      escrow: addrs.escrowPda.toBase58(),
      vaultAta: addrs.vaultAta.toBase58(),
      agentAta: addrs.agentAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('settleCallsUsdc:build', err);
  }
}

export interface WithdrawEscrowUsdcInput {
  /** The DEPOSITOR (signer) avatar — reclaims unspent USDC as ITS own wallet. */
  depositorAvatarId: string;
  workerWalletPubkey: string;
  amount: bigint;
}

/** withdraw_escrow (V1 USDC) — refund unspent USDC → depositor (cancel/expiry). */
export async function withdrawEscrowUsdc(input: WithdrawEscrowUsdcInput): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const addrs = deriveUsdcEscrowAddresses({
    programId: cfg.programId,
    workerWallet,
    depositorWallet: depositor,
    mint,
  });

  try {
    const tx = new Transaction();
    tx.add(
      buildWithdrawEscrowUsdcIx({ depositor, addrs, programId: cfg.programId, amount: input.amount }),
    );
    return executeTx(cfg, 'withdrawEscrowUsdc', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: addrs.escrowPda.toBase58(),
      vaultAta: addrs.vaultAta.toBase58(),
      depositorAta: addrs.depositorAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('withdrawEscrowUsdc:build', err);
  }
}

// ─── SAP Escrow V2 (DisputeWindow default / CoSigned pluggable) ────────────────
//
// The founder-locked BOUNTY settlement flow, on the deployed 0.25-family V2 escrow rail:
//   post → fund (create_escrow_v2) → accept → complete →
//   settle_calls_v2 (charges fee + INITS pending) → (dispute window elapses) →
//   finalize_settlement (releases principal)  |  file_dispute (depositor).
//   Dispute RESOLUTION in 1.0.0 is auto_resolve_dispute (merkle/slash) — NOT wired here.
//
// Every instruction these executors emit is now BUILT BY ANCHOR off the OFFICIAL SDK
// 1.0.0 IDL (sap-escrow-v2.ts), and the escrow-v2 wire-parity test asserts it is
// byte-identical to the devnet-verified shapes. These executors only assemble the V2
// accounts, read the on-chain settlement_index, ensure the destination ATAs exist, and
// reuse the SAME rails as the V1 USDC path: the usdcEscrowGate (enabled AND escrowEnabled
// AND usdcEscrowEnabled), the custodial loadAvatarWallet (decrypt-in-memory-only; the
// acting agent is ALWAYS its own wallet — no body pubkey is ever a signer), and the
// executeTx dry-run/live + genesis-guard tail. SAP_DRY_RUN defaults true ⇒ NOTHING
// broadcasts; a dry-run only simulates.
//
// SPL-ORDER DISCIPLINE — `assembleV2SplRemaining()` (co-located with the builders in
// sap-escrow-v2.ts, imported above) is the SINGLE source of truth for the token
// `remaining_accounts` wire order (byte-identical to the official SDK's settle assembly):
//   - create / deposit : [depositorAta(W), vaultAta(W), tokenProgram(ro)]  (NO mint)
//   - settle_calls_v2  : [vaultAta(W), workerAta(W), tokenProgram(ro), treasuryAta(W),
//                         pendingPda(W)] — settle CHARGES the fee to treasury + INITS the
//                         pending settlement (create_pending_settlement is DEPRECATED 6161).
//   - finalize         : [vaultAta(W), workerAta(W), tokenProgram(ro)]     (NO mint)
//   - withdraw         : [vaultAta(W), depositorAta(W), tokenProgram(ro)]  (NO mint)
// Vault ATA is ALWAYS getAssociatedTokenAddress(mint, escrowPda, /*allowOwnerOffCurve*/ true).

export interface CreateEscrowV2UsdcInput {
  /** DEPOSITOR (bounty creator) avatar — funds + signs as ITS own custodial wallet. */
  depositorAvatarId: string;
  /** Worker/service agent's registered wallet pubkey (base58) — the agent PDA seed. */
  workerWalletPubkey: string;
  /** Per-(agent,depositor) escrow nonce (u64) — the V2 escrow PDA seed. */
  escrowNonce: bigint;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** Absolute unix-seconds work-deadline (i64). REQUIRED (> 0) for a bounty. */
  expiresAt: bigint;
}

/**
 * create_escrow_v2 (USDC, fund-at-create) — the DEPOSITOR opens + funds the escrow.
 * settlement_security is taken from cfg.settlementMode:
 *   - DisputeWindow (default) ⇒ security=2, arbiter=cfg.arbiterPubkey (REQUIRED — fail
 *     if unset; the program cannot open a DisputeWindow escrow without an arbiter).
 *   - CoSigned ⇒ security=1, co_signer=cfg.coSignerPubkey (REQUIRED — Covenant's key).
 * Prepends an idempotent vault-ATA create (the program does NOT init the vault).
 * Signer = the depositor's OWN custodial wallet.
 */
export async function createEscrowV2Usdc(
  input: CreateEscrowV2UsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.pricePerCall <= 0n || input.maxCalls <= 0n || input.initialDeposit <= 0n) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'pricePerCall, maxCalls, initialDeposit must be > 0.',
    };
  }
  if (input.expiresAt <= 0n) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'expiresAt (absolute unix-seconds work-deadline) must be > 0 for a bounty.',
    };
  }

  // ── MONEY RULE: initial_deposit MUST EXCEED the call obligation (fee headroom) ──
  // The deployed settle_calls_v2 charges a protocol fee FROM THE VAULT to treasury.
  // The live devnet lifecycle measured the fee at EXACTLY 0.5% (4,500 on a 900,000
  // obligation) — matching `sap-config.ts`'s "0.5% fee sink". If initial_deposit ==
  // price_per_call × max_calls (the bare obligation), the vault has no room for the
  // fee and settle fails InsufficientEscrowBalance 6062.
  //
  // We require headroom = ceil(obligation × feeBps / 10000), floored at 1 base unit.
  // feeBps = 100 (1%) is deliberately DOUBLE the observed 0.5% on-chain fee — NOT a
  // tight match — so that (a) per-batch integer ceil rounding across a MULTI-settle
  // escrow (K partial settles can each round the fee up, summing above a single
  // ceil(0.5%) headroom) and (b) a future fee-schedule wobble both still settle.
  // feeBps is a client-side PRE-FLIGHT guard, NOT the on-chain fee (see
  // docs/sap-integration.md); revisit if the protocol fee schedule changes.
  const obligation = input.pricePerCall * input.maxCalls;
  const FEE_HEADROOM_BPS = 100n; // 1% — 2× the measured 0.5% on-chain fee, for multi-settle + drift margin
  const feeCeil = (obligation * FEE_HEADROOM_BPS + 9999n) / 10000n; // ceil division
  const headroom = feeCeil > 1n ? feeCeil : 1n; // max(1, ceil)
  const requiredMinDeposit = obligation + headroom;
  if (input.initialDeposit < requiredMinDeposit) {
    return {
      ok: false,
      code: 'invalid_amount',
      message:
        `initialDeposit (${input.initialDeposit}) must EXCEED the call obligation ` +
        `(price_per_call × max_calls = ${obligation}) by a protocol-fee headroom of ` +
        `${headroom} base units; required ≥ ${requiredMinDeposit}. A bare-obligation deposit ` +
        `fails at settle (InsufficientEscrowBalance 6062).`,
    };
  }

  // Resolve the mode's SettlementSecurity tag + the required authority pubkey.
  let settlementSecurity: SettlementSecurityMode;
  let coSigner: PublicKey | null = null;
  let arbiter: PublicKey | null = null;
  if (cfg.settlementMode === 'DisputeWindow') {
    settlementSecurity = SETTLEMENT_SECURITY.DisputeWindow;
    if (!cfg.arbiterPubkey) {
      return {
        ok: false,
        code: 'internal',
        message: 'DisputeWindow escrow requires SAP_ARBITER_PUBKEY (no arbiter configured).',
      };
    }
    arbiter = cfg.arbiterPubkey;
  } else {
    // CoSigned (settlementSecurity=1) is pluggable-LATER (needs Covenant's live
    // co-signature, which we do not hold — a joint op). There is NO CoSigned settle
    // executor yet, so CREATING a CoSigned escrow now would strand the deposit
    // (fundable but un-settleable). Refuse create until the CoSigned settle path
    // (co_signer signer + treasury + dev-confirmed SPL remaining) ships. The
    // co_signer config check is retained for that future path.
    if (!cfg.coSignerPubkey) {
      return {
        ok: false,
        code: 'internal',
        message: 'CoSigned escrow requires SAP_COSIGNER_PUBKEY (no co-signer configured).',
      };
    }
    return {
      ok: false,
      code: 'internal',
      message:
        'CoSigned settlement mode is not yet settle-able (no CoSigned settle executor — ' +
        'it needs Covenant\'s live co-signature). Use SAP_SETTLEMENT_MODE=DisputeWindow. ' +
        'Refusing to create a CoSigned escrow that could not be released.',
    };
    // (unreachable until the CoSigned settle path ships) coSigner = cfg.coSignerPubkey;
  }

  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  // 0.25-family create_escrow_v2 is 7-acct: the deployed program enforces the on-chain
  // stake gate (agent_stake) + writes agent_stats + reads the pricing_menu tier. Derive
  // all three from the WORKER's agent PDA.
  const [agentStakePda] = findStakePda(cfg.programId, agentPda);
  const [agentStatsPda] = findStatsPda(cfg.programId, agentPda);
  const [pricingMenuPda] = findPricingPda(cfg.programId, agentPda);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositor, input.escrowNonce);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositor, false);

  // Stake-coverage preflight (fail-fast mirror of the on-chain create_escrow_v2 gate).
  // Required stake is max(0.1 SOL, floor(max_obligation * 50%));
  // the program enforces the full rule. Missing stake on a dry-run rehearsal is skipped.
  const stakeGate = await checkAgentStakeCoverage(cfg, agentPda, {
    pricePerCall: input.pricePerCall,
    maxCalls: input.maxCalls,
    initialDeposit: input.initialDeposit,
  });
  if (stakeGate) return stakeGate;

  // FEATURE_GATE: sap_agent_stake_provisioning
  // Status: create_escrow_v2 is wired for the 0.25-family 7-acct shape (stake+stats+
  //   pricing_menu), but the worker's ON-CHAIN PREREQUISITES are NOT auto-provisioned
  //   here — every worker agent must, as ITS OWN owner-signed steps, FIRST:
  //     (a) register_agent (~0.055 SOL rent), (b) init_stake ≥ 0.1 SOL (hard-enforced
  //     on-chain, StakeBelowMinimum 6107), (c) updateAgentPricing() to seed a matching
  //     Escrow-mode USDC tier (else create fails PricingTierNotFound 6148).
  //   We do NOT bundle those into this depositor-signed create: update_agent/init_stake
  //   are OWNER(worker)-signed while create is DEPOSITOR-signed (a single tx can't carry
  //   both), AND the 0.1-SOL stake is a real SOL spend that must never be auto-run. So
  //   provisioning stays an explicit, separate, worker-driven flow.
  // Metric to graduate: SAP escrow rail enabled (SAP_ESCROW_ENABLED + SAP_USDC_ESCROW_ENABLED
  //   true, SAP_DRY_RUN=false) with a funded stake-provisioning flow that stakes each
  //   worker agent ≥ 0.1 SOL + seeds its pricing tier before its first escrow.
  // Current reading: rail OFF (all SAP_* gates default false, SAP_DRY_RUN default true).
  // Review deadline: 2026-10-01
  // On deadline: re-evaluate — keep gated if no funded provisioning flow exists, else graduate.
  // Reference: docs/sap-integration.md §9; CLAUDE.md "no scaffolding theater".

  try {
    const tx = new Transaction();
    // (1) Idempotent vault-ATA create — payer = depositor, owner = escrow PDA.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: depositor,
        ata: vaultAta,
        owner: escrowPda,
        mint,
      }),
    );
    // (2) create_escrow_v2 (fund-at-create) — 7 named accts + SPL remaining pays depositor → vault.
    tx.add(
      await buildCreateEscrowV2Ix(getProgram(), {
        depositor,
        agentPda,
        agentStakePda,
        agentStatsPda,
        pricingMenuPda,
        escrowPda,
        escrowNonce: input.escrowNonce,
        pricePerCall: input.pricePerCall,
        maxCalls: input.maxCalls,
        initialDeposit: input.initialDeposit,
        expiresAt: input.expiresAt,
        tokenMint: mint,
        tokenDecimals: USDC_DECIMALS,
        settlementSecurity,
        disputeWindowSlots: cfg.disputeWindowSlots,
        coSigner,
        arbiter,
        remaining: assembleV2SplRemaining('create', { vaultAta, depositorAta, tokenMint: mint }),
      }),
    );
    return executeTx(cfg, 'createEscrowV2Usdc', tx, keypair, {
      depositor: depositor.toBase58(),
      worker: workerWallet.toBase58(),
      agent: agentPda.toBase58(),
      agentStake: agentStakePda.toBase58(),
      agentStats: agentStatsPda.toBase58(),
      pricingMenu: pricingMenuPda.toBase58(),
      escrow: escrowPda.toBase58(),
      vaultAta: vaultAta.toBase58(),
      depositorAta: depositorAta.toBase58(),
      settlementMode: cfg.settlementMode,
    });
  } catch (err) {
    return classifyChainError('createEscrowV2Usdc:build', err);
  }
}

export interface DepositEscrowV2UsdcInput {
  depositorAvatarId: string;
  workerWalletPubkey: string;
  escrowNonce: bigint;
  amount: bigint;
}

/** deposit_escrow_v2 (USDC) — top up an existing V2 escrow. Signer = the depositor. */
export async function depositEscrowV2Usdc(
  input: DepositEscrowV2UsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositor, input.escrowNonce);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositor, false);

  const coverageGate = await checkEscrowDepositCoverage(escrowPda, input.amount);
  if (coverageGate) return coverageGate;

  try {
    const tx = new Transaction();
    // Idempotent vault-ATA create (no-op if it exists) so a deposit never fails on a
    // missing vault if create raced.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: depositor,
        ata: vaultAta,
        owner: escrowPda,
        mint,
      }),
    );
    tx.add(
      await buildDepositEscrowV2Ix(getProgram(), {
        depositor,
        escrowPda,
        escrowNonce: input.escrowNonce,
        amount: input.amount,
        remaining: assembleV2SplRemaining('deposit', { vaultAta, depositorAta, tokenMint: mint }),
      }),
    );
    return executeTx(cfg, 'depositEscrowV2Usdc', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: escrowPda.toBase58(),
      vaultAta: vaultAta.toBase58(),
      depositorAta: depositorAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('depositEscrowV2Usdc:build', err);
  }
}

export interface SettleCallsV2UsdcInput {
  /** WORKER agent (signer) — settles as ITS own custodial wallet (the agent PDA seed). */
  workerAvatarId: string;
  /** Depositor's wallet pubkey (base58) — the escrow PDA seed component. */
  depositorWalletPubkey: string;
  escrowNonce: bigint;
  callsToSettle: bigint;
  /** Verification provider's 32-byte audit root → on-chain service_hash. */
  auditRoot: Uint8Array;
  /**
   * The pending release amount (base units) the CALLER records off-chain for its own
   * ledger/reconciliation. NOTE: the deployed settle computes the on-chain pending
   * amount itself (calls × price − fee); this value is NOT sent to the program.
   */
  amount: bigint;
}

/**
 * DisputeWindow release STEP 1 — settle_calls_v2 (0.25-family).
 *
 * ONE instruction now does the whole settle: the deployed settle_calls_v2 CHARGES the
 * protocol fee from the vault → treasury AND INITS the pending settlement itself. The
 * separate `create_pending_settlement` call is DEPRECATED on-chain (6161) and is NO
 * longer bundled. It does NOT release principal — finalize_settlement does, after the
 * dispute window. The SPL remaining carries the vault + worker + treasury ATAs and the
 * pending PDA (order LOAD-BEARING — see assembleV2SplRemaining('settle')).
 *
 * The pending PDA is seeded by the escrow's CURRENT (pre-increment) settlement_index,
 * READ from chain here (Anchor decodes the on-chain `settlement_index` u64 as a BN under
 * the camelCase `settlementIndex` accessor). Signer = the worker's OWN custodial wallet.
 *
 * FEATURE_GATE: sap_v2_release_path
 * Status: ROUTED THROUGH THE ESCROW GATE, GATED OFF. The nonce-scoped V2 open,
 *   worker settle, and permissionless finalize routes all use the durable money ledger;
 *   the existing SAP/SAP_ESCROW/SAP_USDC triple gate remains default-OFF and
 *   SAP_DRY_RUN remains default-true. Staging end-to-end sign-off is still required.
 * Metric to graduate: the escrow-gate ledger drives the V2 TWO-PHASE DisputeWindow
 *   settle→window→finalize with the V1 gate's authorization ported — depositor approval,
 *   per-job release ceiling, self-dealing block, at-most-once claim — AND the T5 idempotency
 *   contract below, verified by an adversarial + codex money-lens pass on staging.
 * Review deadline: 2026-10-01.
 * On deadline: if the gated path has not passed the staging open→settle→window→finalize
 *   smoke, keep it OFF and re-evaluate or delete it; do not silently extend the deadline.
 * Reference: docs/sap-integration.md §"FLIP-TO-LIVE CHECKLIST" B1 (gate→V2 two-phase retrofit).
 *
 * ── T5 idempotency (on-chain anti-replay is authoritative in 1.0.0) ────────────
 * The deployed program enforces at-most-once settlement ITSELF: settle inits a per-index
 * `PendingSettlement` PDA, and a duplicate settle for a reused/finalized index FAILS LOUD
 * (SettlementReplay 6138 / EscrowNonceReused 6097 / SettlementAlreadyFinalized 6099). So the
 * old "no on-chain anti-replay" concern is RESOLVED — the chain is the replay guard. The
 * gate integration (metric above) is still required for AUTHORIZATION (approval/ceiling), not
 * for replay. The retrofit MUST treat "pending PDA already exists for the current index" as
 * ALREADY-SETTLED → route to FINALIZE, NEVER re-settle (re-init aborts), and honor the
 * executeTx `broadcast:true` NEVER-auto-retry contract.
 */
export async function settleCallsV2Usdc(
  input: SettleCallsV2UsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  const modeGate = disputeWindowModeGate(cfg);
  if (modeGate) return modeGate;
  if (input.callsToSettle <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'callsToSettle must be > 0.' };
  }
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  if (input.auditRoot.length !== 32) {
    return { ok: false, code: 'invalid_amount', message: 'auditRoot must be 32 bytes.' };
  }
  // Refuse the all-zero sentinel (the verification-failed marker) — a settle must NEVER
  // fire on it (defense-in-depth; the gate already only calls settle on passed===true).
  if (input.auditRoot.every((b) => b === 0)) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'auditRoot is all-zero (verification did not pass).',
    };
  }
  let depositorWallet: PublicKey;
  try {
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'depositorWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.workerAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: workerWallet } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [agentStatsPda] = findStatsPda(cfg.programId, agentPda);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositorWallet, input.escrowNonce);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const workerAta = getAssociatedTokenAddress(mint, workerWallet, false);
  // Treasury may be a PDA/off-curve — derive with allowOwnerOffCurve=true (per the
  // devnet-verified settle; treasury = cfg.treasuryPubkey, the protocol fee sink).
  const treasuryAta = getAssociatedTokenAddress(mint, cfg.treasuryPubkey, true);

  // READ the escrow's CURRENT settlement_index (pre-increment) — the value the pending
  // PDA seed uses. On a dry-run rehearsal the escrow may not exist yet (fetchNullable ⇒
  // null) → default 0n so the encoding can still be exercised; a real RPC failure is
  // surfaced as rpc_unreachable (never a silent wrong index).
  let settlementIndex: bigint;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const escrowAcc = await (getProgram().account as any).escrowAccountV2.fetchNullable(escrowPda);
    if (escrowAcc && escrowAcc.settlementIndex != null) {
      settlementIndex = BigInt(escrowAcc.settlementIndex.toString());
    } else {
      // Escrow account not found. On a DRY-RUN rehearsal the escrow may legitimately
      // not exist yet — default 0n so the encoding can still be exercised. But on a
      // LIVE settle a missing escrow means we'd broadcast a real tx built against a
      // nonexistent / wrong on-chain state (wrong pending PDA, guaranteed-fail-or-
      // worse) — so FAIL LOUD instead (SEV: Codex money-path finding).
      if (!cfg.dryRun) {
        return {
          ok: false,
          code: 'on_chain_error',
          message:
            'settleCallsV2Usdc: escrow account not found on-chain — refusing a ' +
            'LIVE settle against a nonexistent/unfunded escrow (would build a wrong pending PDA).',
        };
      }
      settlementIndex = 0n;
    }
  } catch (err) {
    return classifyChainError('settleCallsV2Usdc:readIndex', err);
  }

  const [pendingPda] = findPendingPda(cfg.programId, escrowPda, settlementIndex);
  const auditRoot = Buffer.from(input.auditRoot);

  try {
    const tx = new Transaction();
    // Idempotent creates for the fee destination (treasury) + the worker ATA the settle
    // references. Payer = the worker (settle signer). No-op if they already exist.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: workerWallet,
        ata: treasuryAta,
        owner: cfg.treasuryPubkey,
        mint,
      }),
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: workerWallet,
        ata: workerAta,
        owner: workerWallet,
        mint,
      }),
    );
    // settle_calls_v2 — charges the fee to treasury + INITS the pending settlement.
    // SPL remaining order is LOAD-BEARING (tokenProgram idx2, treasury idx3, pending W idx4).
    tx.add(
      await buildSettleCallsV2Ix(getProgram(), {
        workerWallet,
        agentPda,
        agentStatsPda,
        escrowPda,
        escrowNonce: input.escrowNonce,
        callsToSettle: input.callsToSettle,
        serviceHash: auditRoot,
        remaining: assembleV2SplRemaining('settle', {
          vaultAta,
          workerAta,
          treasuryAta,
          pendingPda,
          tokenMint: mint,
        }),
      }),
    );
    return executeTx(cfg, 'settleCallsV2Usdc', tx, keypair, {
      worker: workerWallet.toBase58(),
      agent: agentPda.toBase58(),
      agentStats: agentStatsPda.toBase58(),
      escrow: escrowPda.toBase58(),
      vaultAta: vaultAta.toBase58(),
      workerAta: workerAta.toBase58(),
      treasuryAta: treasuryAta.toBase58(),
      pending: pendingPda.toBase58(),
      settlementIndex: settlementIndex.toString(),
    });
  } catch (err) {
    return classifyChainError('settleCallsV2Usdc:build', err);
  }
}

export interface FinalizeSettlementUsdcInput {
  /**
   * The CRANK/payer avatar — signs + pays. finalize_settlement is permissionless once
   * the window elapses, so ANY funded avatar (e.g. a house crank) can call it.
   */
  payerAvatarId: string;
  /** Worker's registered wallet pubkey (base58) — release destination + agent PDA seed. */
  workerWalletPubkey: string;
  /** Depositor's wallet pubkey (base58) — the escrow PDA seed component. */
  depositorWalletPubkey: string;
  escrowNonce: bigint;
  settlementIndex: bigint;
}

/**
 * DisputeWindow release STEP 2 — finalize_settlement releases the PRINCIPAL vault →
 * worker after the dispute window elapses with no dispute. Prepends an idempotent
 * worker-ATA create (the release destination). Permissionless: signer = any funded
 * payer/crank avatar. SPL remaining [vaultAta, workerAta, tokenProgram] (NO mint).
 * (devnet-confirmed 2026-07-09 tx 21QKsYjxm3PK8i79KWPKabPjXbwWQXhTAMTQSfMNdgKPqFg5cZor7Exo8KHu3vAkPJibHwyVHCugC3WxyMSSc7iy)
 */
export async function finalizeSettlementUsdc(
  input: FinalizeSettlementUsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  const modeGate = disputeWindowModeGate(cfg);
  if (modeGate) return modeGate;
  let workerWallet: PublicKey;
  let depositorWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
    depositorWallet = new PublicKey(input.depositorWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'invalid worker/depositor wallet pubkey.' };
  }

  const handle = await loadAvatarWallet(input.payerAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: payer } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [agentStatsPda] = findStatsPda(cfg.programId, agentPda);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositorWallet, input.escrowNonce);
  const [pendingPda] = findPendingPda(cfg.programId, escrowPda, input.settlementIndex);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const workerAta = getAssociatedTokenAddress(mint, workerWallet, false);

  try {
    const tx = new Transaction();
    // Idempotent worker-ATA create (the release DESTINATION) — payer = the crank.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer,
        ata: workerAta,
        owner: workerWallet,
        mint,
      }),
    );
    tx.add(
      await buildFinalizeSettlementIx(getProgram(), {
        payer,
        agentWallet: workerWallet,
        escrowPda,
        pendingPda,
        agentStatsPda,
        remaining: assembleV2SplRemaining('finalize', { vaultAta, workerAta, tokenMint: mint }),
      }),
    );
    return executeTx(cfg, 'finalizeSettlementUsdc', tx, keypair, {
      payer: payer.toBase58(),
      worker: workerWallet.toBase58(),
      agent: agentPda.toBase58(),
      agentStats: agentStatsPda.toBase58(),
      escrow: escrowPda.toBase58(),
      pending: pendingPda.toBase58(),
      vaultAta: vaultAta.toBase58(),
      workerAta: workerAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('finalizeSettlementUsdc:build', err);
  }
}

// ── DISPUTE PATH DISABLED (SDK 1.0.0) ─────────────────────────────────────────
// There is deliberately NO reachable executor/route that files OR resolves a
// dispute through the ClawVille surface:
//   - resolve_dispute DOES NOT EXIST in the deployed 1.0.0 program (the old
//     arbiter-signed path targeted a phantom instruction → InstructionFallbackNotFound;
//     removed). 1.0.0 resolution is the permissionless `auto_resolve_dispute`
//     (merkle-proof + stake-slash) + `submit_agent_evidence` — NOT wired (it moves
//     real stake on a lost dispute; a deliberate follow-up).
//   - file_dispute: the `buildFileDisputeIx` BUILDER stays (correct 1.0.0 shape,
//     wire-parity tested), but NO `fileDisputeUsdc` executor is exposed. A filed
//     dispute sets pending.is_disputed and BLOCKS finalize with no resolution path
//     we control, so v1 posture is DisputeWindow-as-timelock: no dispute filed
//     through our surface; finalize releases after the window elapses. An EXTERNAL
//     depositor can still call file_dispute on-chain directly (the program is public)
//     → an `auto_resolve_dispute` crank is a REQUIRED follow-up BEFORE the rail serves
//     untrusted external depositors. Safe to defer now — the rail is gated OFF and
//     early smoke uses a ClawVille-controlled depositor.

export interface WithdrawEscrowV2UsdcInput {
  depositorAvatarId: string;
  workerWalletPubkey: string;
  escrowNonce: bigint;
  amount: bigint;
}

/**
 * withdraw_escrow_v2 (USDC) — the DEPOSITOR (creator) reclaims unspent USDC after the
 * work-deadline expires (or on cancel; works on an ACTIVE escrow — recovery path).
 * Prepends an idempotent depositor-ATA create (the refund destination may have been
 * closed). Signer = the depositor. SPL remaining [vaultAta, depositorAta, tokenProgram]
 * (NO mint).
 * (devnet-confirmed 2026-07-09 tx 3TXwu7CnzNGQGMHS43b1VtMBLTcRRy6BY5zUKKHo4ZTRXPhDxyMZqw1zDSrbBwZiqZWWkUf3SFmkdCTvyzq69Frg)
 */
export async function withdrawEscrowV2Usdc(
  input: WithdrawEscrowV2UsdcInput,
): Promise<SapWriteResult> {
  const cfg = getConfig();
  const gate = usdcEscrowGate(cfg);
  if (gate) return gate;
  if (input.amount <= 0n) {
    return { ok: false, code: 'invalid_amount', message: 'amount must be > 0.' };
  }
  let workerWallet: PublicKey;
  try {
    workerWallet = new PublicKey(input.workerWalletPubkey);
  } catch {
    return { ok: false, code: 'invalid_pubkey', message: 'workerWalletPubkey is not a valid pubkey.' };
  }

  const handle = await loadAvatarWallet(input.depositorAvatarId);
  if ('ok' in handle && handle.ok === false) return handle;
  const { keypair, publicKey: depositor } = handle as AvatarWalletHandle;

  const mint = usdcMintForEscrow(cfg);
  const [agentPda] = findAgentPda(cfg.programId, workerWallet);
  const [escrowPda] = findEscrowPda(cfg.programId, agentPda, depositor, input.escrowNonce);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositor, false);

  try {
    const tx = new Transaction();
    // Idempotent depositor-ATA create (the refund DESTINATION) — payer = the depositor.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction({
        payer: depositor,
        ata: depositorAta,
        owner: depositor,
        mint,
      }),
    );
    tx.add(
      await buildWithdrawEscrowV2Ix(getProgram(), {
        depositor,
        escrowPda,
        amount: input.amount,
        remaining: assembleV2SplRemaining('withdraw', { vaultAta, depositorAta, tokenMint: mint }),
      }),
    );
    return executeTx(cfg, 'withdrawEscrowV2Usdc', tx, keypair, {
      depositor: depositor.toBase58(),
      escrow: escrowPda.toBase58(),
      vaultAta: vaultAta.toBase58(),
      depositorAta: depositorAta.toBase58(),
    });
  } catch (err) {
    return classifyChainError('withdrawEscrowV2Usdc:build', err);
  }
}
