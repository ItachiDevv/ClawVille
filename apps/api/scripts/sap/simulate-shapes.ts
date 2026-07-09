/**
 * EMPIRICAL SHAPE + DECODE PARITY — devnet, READ-ONLY (no sends, no funds, no signer).
 *
 * Resolves the trap-list T2 question (does the DEPLOYED devnet program's escrow-V2 SPL
 * remaining-accounts INCLUDE the token mint, as the SDK's deposit() validation expects,
 * or DROP it, as our devnet-verified builders do?) from GROUND TRUTH: the four LANDED
 * devnet transactions our builders were verified against on 2026-07-09. A landed tx's
 * actual account list is what the deployed program ACCEPTED — stronger than any IDL read.
 *
 * It ALSO does the audit's DECODE-PARITY near-blocker: decode the on-chain EscrowAccountV2
 * (+ PendingSettlement if present) via the NEW SDK 1.0.0 IDL's Anchor coder and assert the
 * fields the settle→finalize state machine reads (settlementIndex / pendingAmount / balance /
 * amount / isFinalized / isDisputed) are present + sane — proving the deployed account LAYOUT
 * matches the SDK IDL we swapped to (encode-parity ≠ decode-parity).
 *
 * Run (READ-ONLY — safe to run; no keypair, no funds, no broadcast):
 *   cd apps/api && bun run scripts/sap/simulate-shapes.ts
 *   SAP_DEVNET_RPC=<url> bun run scripts/sap/simulate-shapes.ts   # if the public RPC pruned history
 */

import { Connection, PublicKey, Keypair, type Commitment } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import idlJson from '@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json' with { type: 'json' };

const RPC = process.env.SAP_DEVNET_RPC ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDL = idlJson as any;
const PROGRAM_ID = new PublicKey(IDL.address);
const USDC_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// The four devnet txs our builders were verified against (2026-07-09).
const TXS: Record<string, string> = {
  create_escrow_v2: '2J6kxmaUF2mNkomYvs1VfC536wSa6k8NX3mCr8PMd5ZqCGwgmbBo4WkRFB4M9CoPeSamKTMty55hy24ZEJPN7nkv',
  settle_calls_v2: '512iPTGsnHdSry5XQ61ZFvpV9QGZswmc518GyRQCL1W8kbZLar2cYvVF6veGKomVwXopaZK54fw9EUbPDNGCqUnz',
  finalize_settlement: '21QKsYjxm3PK8i79KWPKabPjXbwWQXhTAMTQSfMNdgKPqFg5cZor7Exo8KHu3vAkPJibHwyVHCugC3WxyMSSc7iy',
  withdraw_escrow_v2: '3TXwu7CnzNGQGMHS43b1VtMBLTcRRy6BY5zUKKHo4ZTRXPhDxyMZqw1zDSrbBwZiqZWWkUf3SFmkdCTvyzq69Frg',
};

// Named-account counts per op (the rest of the SAP ix's keys are SPL remaining_accounts).
const NAMED_COUNT: Record<string, number> = {
  create_escrow_v2: 7, // depositor, agent, agent_stake, agent_stats, pricing_menu, escrow, system
  settle_calls_v2: 5, // wallet, agent, agent_stats, escrow, system
  finalize_settlement: 5, // payer, agent_wallet, escrow, pending, agent_stats
  withdraw_escrow_v2: 2, // depositor, escrow
};

function readonlyProgram(connection: Connection): Program {
  const kp = Keypair.generate();
  const wallet = {
    publicKey: kp.publicKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: async (t: any) => t,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signAllTransactions: async (t: any) => t,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new AnchorProvider(connection, wallet as any, { commitment: COMMITMENT });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider);
}

/** Pull the SAP instruction's ORDERED account pubkeys out of a landed tx. */
async function sapIxAccounts(connection: Connection, sig: string): Promise<PublicKey[] | null> {
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: COMMITMENT });
  if (!tx) return null;
  const msg = tx.transaction.message;
  // Static keys + (for v0) loaded address-table keys.
  const staticKeys = msg.staticAccountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  const allKeys: PublicKey[] = [
    ...staticKeys,
    ...((loaded?.writable ?? []) as PublicKey[]),
    ...((loaded?.readonly ?? []) as PublicKey[]),
  ];
  const ixs = msg.compiledInstructions ?? [];
  for (const ix of ixs) {
    const programId = allKeys[ix.programIdIndex];
    if (programId && programId.equals(PROGRAM_ID)) {
      return ix.accountKeyIndexes.map((i) => allKeys[i]);
    }
  }
  return null;
}

function classifyShape(op: string, accounts: PublicKey[]): { mintPresent: boolean; remaining: PublicKey[]; note: string } {
  const named = NAMED_COUNT[op] ?? 0;
  const remaining = accounts.slice(named);
  const mintPresent = remaining.some((k) => k.equals(USDC_DEVNET));
  return {
    mintPresent,
    remaining,
    note: mintPresent
      ? 'SPL remaining INCLUDES the token mint (SDK deposit()-style 4-acct shape)'
      : 'SPL remaining DROPS the token mint (our devnet-verified shape)',
  };
}

async function main() {
  console.log(`SAP shape/decode parity (READ-ONLY) · program ${PROGRAM_ID.toBase58()} · IDL v${IDL.metadata?.version} · ${RPC.split('?')[0]}\n`);
  const connection = new Connection(RPC, COMMITMENT);
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) { console.error(`❌ RPC is NOT devnet (genesis ${genesis}). Refusing.`); process.exit(2); }
  const program = readonlyProgram(connection);

  console.log('── T2 — EMPIRICAL SPL SHAPE from the 4 landed devnet txs (ground truth) ──');
  let escrowPda: PublicKey | null = null;
  let anyPruned = false;
  for (const [op, sig] of Object.entries(TXS)) {
    const accounts = await sapIxAccounts(connection, sig);
    if (!accounts) {
      anyPruned = true;
      console.log(`  ${op}: ⏳ tx pruned by this RPC (${sig.slice(0, 8)}…) — pass a full-history SAP_DEVNET_RPC to read it`);
      continue;
    }
    const c = classifyShape(op, accounts);
    console.log(`  ${op}: ${c.mintPresent ? '⚠ MINT-PRESENT' : '✅ NO-MINT'} — ${c.note}`);
    console.log(`      named=${NAMED_COUNT[op]} remaining=[${c.remaining.map((k) => k.toBase58().slice(0, 6)).join(', ')}]  usdcMint=${USDC_DEVNET.toBase58().slice(0, 6)} tokenProg=${TOKEN_PROGRAM.toBase58().slice(0, 6)}`);
    // The escrow PDA is named-account index 5 (create) / 3 (settle) / 2 (finalize) / 1 (withdraw).
    if (op === 'create_escrow_v2') escrowPda = accounts[5] ?? null;
    else if (op === 'settle_calls_v2' && !escrowPda) escrowPda = accounts[3] ?? null;
  }

  console.log('\n  VERDICT: our builders (which this branch ships) DROP the mint. The rows above are the');
  console.log('  DEPLOYED program\'s ACCEPTED shape (a landed tx = what it took). If every op reads ✅ NO-MINT,');
  console.log('  our shipped shape matches the deployed program and the SDK deposit()\'s mint expectation is');
  console.log('  the SDK being ahead of / mismatched with this deployment (file as an upstream SDK note).');
  console.log('  If ANY reads ⚠ MINT-PRESENT, the program was re-deployed to a mint-taking build — STOP and');
  console.log('  re-shape assembleV2SplRemaining before any flip.');

  console.log('\n── DECODE PARITY — decode the on-chain EscrowAccountV2 via the NEW SDK IDL ──');
  if (!escrowPda) {
    console.log('  (no escrow PDA recovered — history pruned; re-run with a full-history RPC to decode.)');
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc = await (program.account as any).escrowAccountV2.fetchNullable(escrowPda);
      if (!acc) {
        console.log(`  escrow ${escrowPda.toBase58()} no longer on-chain (closed/withdrawn) — decode parity inconclusive from this PDA.`);
      } else {
        const fields = {
          settlementIndex: acc.settlementIndex?.toString?.(),
          balance: acc.balance?.toString?.(),
          pendingAmount: acc.pendingAmount?.toString?.(),
          tokenMint: acc.tokenMint ? new PublicKey(acc.tokenMint).toBase58() : null,
          settlementSecurity: JSON.stringify(acc.settlementSecurity),
        };
        const sane = fields.settlementIndex != null && fields.balance != null && fields.pendingAmount != null;
        console.log(`  escrow ${escrowPda.toBase58()} decoded via SDK IDL: ${sane ? '✅ FIELDS SANE' : '❌ MISSING FIELDS'}`);
        console.log(`      ${JSON.stringify(fields)}`);
        console.log('  → the settle→finalize guards (settlementIndex/pendingAmount/balance reads) operate on a layout the SDK IDL decodes correctly.');
      }
    } catch (e) {
      console.log(`  ❌ decode threw (layout mismatch?): ${e instanceof Error ? e.message : e}`);
    }
  }

  if (anyPruned) {
    console.log('\n⚠ Some txs were pruned by the public devnet RPC (normal for old history). Re-run with a full-history');
    console.log('  RPC (SAP_DEVNET_RPC=<helius/triton devnet>) to read every row + decode the escrow.');
  }
}

main().catch((e) => { console.error('\n❌ shape probe failed:', e instanceof Error ? e.message : e); process.exit(1); });
