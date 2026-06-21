/**
 * SAP — pure PDA derivation helpers.
 *
 * Every seed here was confirmed by `jq`-ing the VENDORED 0.25.0 IDL
 * (`synapse_agent_sap.idl.json`), the authoritative source — NOT the SDK's
 * `pdas/index.ts`, which has stale seeds for several accounts (it uses
 * `[sap_stake, wallet]` and a 4-byte u32 escrow nonce, while the on-chain
 * program defines `["sap_stake", agentPda]` and a `u64` (8-byte LE) nonce).
 *
 * Seed conventions (per IDL):
 *   - ASCII string consts (`"sap_agent"`, …) → `Buffer.from(str, 'utf8')`.
 *   - `u64` args used as a seed (escrow nonce, settlement index) → 8-byte
 *     little-endian (Borsh's u64 encoding, which is what an Anchor `arg`-kind
 *     PDA seed serializes to).
 *   - 32-byte hashes (tool_name_hash, service_hash) → raw 32 bytes.
 *   - pubkeys → 32-byte `.toBuffer()`.
 *
 * All helpers are pure + deterministic (memoizable). They never touch the
 * network or the DB.
 */

import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';

// ── seed string constants (verbatim from the IDL `value` byte arrays) ─────────
const SEED_AGENT = Buffer.from('sap_agent', 'utf8');
const SEED_STATS = Buffer.from('sap_stats', 'utf8');
const SEED_PRICING = Buffer.from('sap_pricing', 'utf8');
const SEED_GLOBAL = Buffer.from('sap_global', 'utf8');
const SEED_TOOL = Buffer.from('sap_tool', 'utf8');
const SEED_FEEDBACK = Buffer.from('sap_feedback', 'utf8');
// Attestation seed = the IDL const byte array [115,97,112,95,97,116,116,101,115,116]
// → ASCII "sap_attest" (verified by jq on the on-chain 0.18.0 IDL's
// create_attestation/revoke_attestation/close_attestation account contexts).
const SEED_ATTEST = Buffer.from('sap_attest', 'utf8');
const SEED_STAKE = Buffer.from('sap_stake', 'utf8');
const SEED_ESCROW_V2 = Buffer.from('sap_escrow_v2', 'utf8');
const SEED_RECV = Buffer.from('sap_recv', 'utf8');
const SEED_PENDING = Buffer.from('sap_pending', 'utf8');

/** Encode a u64 (bigint) as 8-byte little-endian — the Borsh seed encoding. */
export function u64LE(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64LE out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

/** sha256(name) → 32 raw bytes. Used for tool_name_hash + protocol/desc hashes. */
export function sha256Bytes(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Convenience: sha256 of a tool name → the 32-byte `tool_name_hash` arg. */
export function toolNameHash(name: string): Buffer {
  return sha256Bytes(name);
}

/**
 * Convenience: a canonical 32-byte `service_hash` (escrow settlement anti-replay
 * key) from one-or-more parts. Joins with a NUL separator so distinct part
 * tuples can't collide. Callers may pass a pre-computed 32-byte Buffer instead.
 */
export function serviceHash(...parts: (string | Buffer)[]): Buffer {
  const h = createHash('sha256');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) h.update(Buffer.from([0]));
    h.update(typeof parts[i] === 'string' ? Buffer.from(parts[i] as string, 'utf8') : (parts[i] as Buffer));
  }
  return h.digest();
}

// ── PDA derivations ───────────────────────────────────────────────────────────

/** agent: ["sap_agent", walletPubkey] */
export function findAgentPda(programId: PublicKey, wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_AGENT, wallet.toBuffer()], programId);
}

/** stats: ["sap_stats", agentPda] */
export function findStatsPda(programId: PublicKey, agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_STATS, agent.toBuffer()], programId);
}

/** pricing: ["sap_pricing", agentPda] */
export function findPricingPda(programId: PublicKey, agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_PRICING, agent.toBuffer()], programId);
}

/** global: ["sap_global"] */
export function findGlobalPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_GLOBAL], programId);
}

/** tool: ["sap_tool", agentPda, tool_name_hash(32)] */
export function findToolPda(
  programId: PublicKey,
  agent: PublicKey,
  toolNameHash32: Buffer,
): [PublicKey, number] {
  if (toolNameHash32.length !== 32) {
    throw new Error(`tool_name_hash must be 32 bytes (got ${toolNameHash32.length})`);
  }
  return PublicKey.findProgramAddressSync(
    [SEED_TOOL, agent.toBuffer(), toolNameHash32],
    programId,
  );
}

/** feedback: ["sap_feedback", agentPda, reviewerWallet] */
export function findFeedbackPda(
  programId: PublicKey,
  agent: PublicKey,
  reviewer: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_FEEDBACK, agent.toBuffer(), reviewer.toBuffer()],
    programId,
  );
}

/**
 * attestation: ["sap_attest", agentPda, attesterWallet]
 *
 * SEED ORDER (verbatim from the on-chain 0.18.0 IDL's create_attestation PDA):
 * the SUBJECT agent PDA comes FIRST, then the attester wallet — i.e.
 * `[SEED, agent, attester]`. This mirrors `findFeedbackPda`'s `[SEED, agent,
 * reviewer]` shape (subject-then-actor), and the AgentAttestation account struct
 * stores `agent` then `attester` in the same order. One attestation per
 * (agent, attester) pair. The attester is the caller's OWN wallet (signer); the
 * agent is the body-supplied SUBJECT pubkey (never a signer).
 */
export function findAttestationPda(
  programId: PublicKey,
  agent: PublicKey,
  attester: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ATTEST, agent.toBuffer(), attester.toBuffer()],
    programId,
  );
}

/** stake: ["sap_stake", agentPda] */
export function findStakePda(programId: PublicKey, agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_STAKE, agent.toBuffer()], programId);
}

/** escrow: ["sap_escrow_v2", agentPda, depositorWallet, nonce(u64 LE 8B)] */
export function findEscrowPda(
  programId: PublicKey,
  agent: PublicKey,
  depositor: PublicKey,
  nonce: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ESCROW_V2, agent.toBuffer(), depositor.toBuffer(), u64LE(nonce)],
    programId,
  );
}

/**
 * receipt: ["sap_recv", escrowPda, service_hash(32)]
 *
 * NOTE (audit FIX-A): the DEPLOYED 0.18.0 program has NO settlement_receipt
 * account on settle_calls_v2, so this PDA is NOT used by the live client today.
 * Retained for the future 0.25.0 program (which adds the on-chain receipt) +
 * potential off-chain receipt bookkeeping. Do not wire it into a 0.18.0 settle.
 */
export function findReceiptPda(
  programId: PublicKey,
  escrow: PublicKey,
  serviceHash32: Buffer,
): [PublicKey, number] {
  if (serviceHash32.length !== 32) {
    throw new Error(`service_hash must be 32 bytes (got ${serviceHash32.length})`);
  }
  return PublicKey.findProgramAddressSync(
    [SEED_RECV, escrow.toBuffer(), serviceHash32],
    programId,
  );
}

/**
 * pending: ["sap_pending", escrowPda, settlementIndex(u64 LE 8B)]
 *
 * NOTE (audit FIX-A): unused by the live 0.18.0 client (the CoSigned/DisputeWindow
 * settlement path is deferred). Retained for a future non-custodial settlement mode.
 */
export function findPendingPda(
  programId: PublicKey,
  escrow: PublicKey,
  settlementIndex: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_PENDING, escrow.toBuffer(), u64LE(settlementIndex)],
    programId,
  );
}

/**
 * Derive the full Phase-1 PDA set for an agent in one call (agent + its stats +
 * pricing + the shared global registry). Convenience for register/discovery.
 */
export function deriveAgentPdaSet(programId: PublicKey, wallet: PublicKey) {
  const [agent] = findAgentPda(programId, wallet);
  const [stats] = findStatsPda(programId, agent);
  const [pricing] = findPricingPda(programId, agent);
  const [global] = findGlobalPda(programId);
  return { agent, stats, pricing, global };
}
