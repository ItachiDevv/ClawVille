/**
 * SAP on-chain client — load the vendored 0.25.0 IDL + `Program`, a CUSTODIAL
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
  findToolPda,
  findFeedbackPda,
  findAttestationPda,
  findEscrowPda,
  toolNameHash,
  sha256Bytes,
  serviceHash as deriveServiceHash,
} from './sap-pdas';

// AUTHORITATIVE IDL = what is DEPLOYED on devnet (fetched via Anchor
// `Program.fetchIdl`), NOT the ahead-of-deployment repo IDL. The deployed
// program is 0.18.0; the repo IDL (`…idl.future-0.25.json`, kept for reference)
// is 0.25.0 with DIFFERENT account contexts (register/createEscrow/settle drop
// accounts; 0.18.0 has NO on-chain stake-gate and NO settle receipt anti-replay).
// Every account list + PDA seed below matches THIS file.
import idlJson from './synapse_agent_sap.onchain.idl.json' with { type: 'json' };

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
  | 'avatar_wallet_missing'
  | 'invalid_pubkey'
  | 'invalid_mint'
  | 'sol_only_for_now'
  | 'invalid_amount'
  | 'mainnet_broadcast_refused'
  | 'rpc_unreachable'
  | 'on_chain_error'
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
  // program id (the vendored 0.25.0 IDL pins SAPpU…FETZ).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cachedProgram = new Program(idlJson as any, provider);
  return cachedProgram;
}

/** Public, side-effect-free config read for the route layer's gate checks. */
export function sapConfigSnapshot(): {
  enabled: boolean;
  escrowEnabled: boolean;
  dryRun: boolean;
  cluster: string;
  programId: string;
  rpcUrl: string;
} {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    escrowEnabled: cfg.escrowEnabled,
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

// ─── error classification ─────────────────────────────────────────────────────

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
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );
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
  // 0.18.0 register_agent accounts = [wallet, agent, agent_stats, global_registry,
  // system_program] — NO pricing_menu account (the 0.25.0 IDL added it; the
  // deployed program does not have it). The `pricing` ARG (empty for the MVP)
  // is unchanged; only the ACCOUNT is omitted.
  const { agent, stats, global } = deriveAgentPdaSet(cfg.programId, wallet);

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
        globalRegistry: global,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .transaction();

    return executeTx(cfg, 'registerAgent', tx, keypair, {
      wallet: wallet.toBase58(),
      agent: agent.toBase58(),
      agentStats: stats.toBase58(),
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
