/**
 * V2 DisputeWindow devnet smoke — drives the SAP Escrow V2 USDC lifecycle against the
 * DEPLOYED devnet program via the OFFICIAL SDK 1.0.0 path (Anchor-built instructions off
 * `@oobe-protocol-labs/synapse-sap-sdk`). The wire itself is already PROVEN byte-identical
 * to the devnet-verified shapes by the offline unit test
 * (`src/services/sap/__tests__/sap-escrow-v2.test.ts`); this script exercises the FULL
 * lifecycle against the live program (account resolution + on-chain state transitions).
 *
 * TWO LEVELS:
 *   L1 (SIMULATE, no USDC needed): builds each V2 instruction with our assembled account
 *      layout and `simulateTransaction`s it against the real program. A WRONG remaining-
 *      account order trips a loud ACCOUNT/CONSTRAINT error BEFORE the token transfer — a
 *      RIGHT order passes account validation and only then fails on funds. Self-reliant.
 *   L2 (LIVE, needs devnet USDC): provisions the worker (register → init_stake ≥0.1 SOL →
 *      update_agent pricing tier), then create_escrow_v2 (DisputeWindow) → settle_calls_v2
 *      (charges fee + INITS pending itself — NO separate create_pending) → wait window →
 *      finalize_settlement. Produces a REAL settled escrow bound to the worker.
 *
 * Run (WE RUN THIS SEPARATELY — do not auto-run):
 *   cd apps/api && SAP_SMOKE=1 bun run scripts/sap/v2-dispute-window-smoke.ts          # L1 simulate
 *   cd apps/api && SAP_SMOKE=1 bun run scripts/sap/v2-dispute-window-smoke.ts --live   # + L2 live (needs USDC)
 *
 * Throwaway keypairs persist (gitignored `.smoke-v2-*.json`). NO DB, NO keypair-vault, NO
 * prod. Devnet only (hard-checked via genesis hash). Dispute RESOLUTION (auto_resolve/merkle)
 * is NOT exercised here — it is not wired in the client (see docs/sap-integration.md).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, type Commitment,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import idlJson from '@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json' with { type: 'json' };
import {
  deriveAgentPdaSet, findAgentPda, findStatsPda, findStakePda, findPricingPda,
  findEscrowPda, findPendingPda, findDisputePda,
} from '../../src/services/sap/sap-pdas';
import {
  buildCreateEscrowV2Ix, buildSettleCallsV2Ix,
  buildFinalizeSettlementIx, buildFileDisputeIx, buildWithdrawEscrowV2Ix,
  assembleV2SplRemaining, SETTLEMENT_SECURITY, DISPUTE_TYPE,
} from '../../src/services/sap/sap-escrow-v2';
import { SAP_TREASURY_PUBKEY_DEFAULT } from '../../src/services/sap/sap-config';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction,
  USDC_DECIMALS,
} from '../../src/services/sap/sap-spl';

const RPC = process.env.SAP_DEVNET_RPC ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const USDC_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TREASURY = new PublicKey(SAP_TREASURY_PUBKEY_DEFAULT);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDL = idlJson as any;
const PROGRAM_ID = new PublicKey(IDL.address);
const LIVE = process.argv.includes('--live');
const ARBITER_PATH = join(import.meta.dir, '.smoke-v2-arbiter.json');
const DEPOSITOR_PATH = join(import.meta.dir, '.smoke-v2-depositor.json');
const WORKER_PATH = join(import.meta.dir, '.smoke-v2-worker.json');

function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), 'utf8');
  return kp;
}

function placeholderProgram(connection: Connection): Program {
  const kp = Keypair.generate();
  const provider = new AnchorProvider(
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { publicKey: kp.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t, payer: kp } as any,
    { commitment: COMMITMENT },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider);
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, COMMITMENT);
      return;
    } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}

/** Classify a simulation for the layout question. */
function classifySim(sim: SimulatedTransactionResponse): { layout: 'ok' | 'bad' | 'unfunded'; note: string } {
  const logs = (sim.logs ?? []).join('\n');
  const err = sim.err ? JSON.stringify(sim.err) : '';
  const invoked = logs.includes(`Program ${PROGRAM_ID.toBase58()} invoke`);
  if (/ConstraintRaw|AccountNotFound|NotEnoughAccountKeys|An account required by the instruction is missing|AccountOwnedByWrongProgram|invalid account data|ConstraintTokenMint|ConstraintTokenOwner|ConstraintAssociated/i.test(logs + err)) {
    return { layout: 'bad', note: (logs.match(/Error Code: \w+|Error Message: [^\n]+/g) ?? [err]).slice(0, 2).join(' | ') };
  }
  if (/insufficient funds|InsufficientFunds|0x1$|custom program error: 0x1\b/i.test(logs + err)) {
    return { layout: 'ok', note: 'account layout accepted; failed on insufficient funds (expected without USDC/stake)' };
  }
  if (!sim.err) return { layout: 'ok', note: 'simulated cleanly (no err)' };
  if (invoked) return { layout: 'ok', note: `program ran; non-account err: ${err}` };
  return { layout: 'unfunded', note: `program not reached (fund payer / create ATAs first): ${err}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sim(connection: Connection, ixs: any[], signers: Keypair[], label: string): Promise<void> {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  const { blockhash } = await connection.getLatestBlockhash(COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  try { tx.sign(...signers); } catch { /* co-signer we may not hold — sigVerify off below */ }
  const res = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const c = classifySim(res.value);
  const mark = c.layout === 'ok' ? '✅ LAYOUT OK' : c.layout === 'bad' ? '❌ LAYOUT BAD' : '⏳ INCONCLUSIVE';
  console.log(`   ${mark}  ${label}\n       ${c.note}`);
}

async function main() {
  console.log(`SAP V2 DisputeWindow smoke (SDK 1.0.0 path) · program ${PROGRAM_ID.toBase58()} · ${RPC.split('?')[0]}`);
  console.log(`SDK IDL version = ${IDL.metadata?.version} · mode=${LIVE ? 'LIVE (+simulate)' : 'SIMULATE-only'}\n`);
  const connection = new Connection(RPC, COMMITMENT);
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) { console.error(`❌ RPC is NOT devnet (genesis ${genesis}). Refusing.`); process.exit(2); }
  const program = placeholderProgram(connection);

  const depositor = loadOrCreate(DEPOSITOR_PATH);
  const worker = loadOrCreate(WORKER_PATH);
  const arbiter = loadOrCreate(ARBITER_PATH);
  console.log(`depositor = ${depositor.publicKey.toBase58()}`);
  console.log(`worker    = ${worker.publicKey.toBase58()}  (HermesTest SAP wallet)`);
  console.log(`arbiter   = ${arbiter.publicKey.toBase58()}\n`);

  for (const [name, kp] of [['depositor', depositor], ['worker', worker], ['arbiter', arbiter]] as const) {
    let bal = await connection.getBalance(kp.publicKey);
    if (bal < 0.15 * LAMPORTS_PER_SOL) { await airdrop(connection, kp.publicKey, 1); bal = await connection.getBalance(kp.publicKey); }
    console.log(`  ${name} SOL = ${(bal / LAMPORTS_PER_SOL).toFixed(3)}`);
    if (bal < 0.05 * LAMPORTS_PER_SOL) {
      console.log(`\n⏳ FUND (one-time, persists): ${kp.publicKey.toBase58()} — ~0.3 devnet SOL via https://faucet.solana.com`);
      process.exit(3);
    }
  }

  const escrowNonce = 1n;
  const [agentPda] = findAgentPda(PROGRAM_ID, worker.publicKey);
  const [agentStakePda] = findStakePda(PROGRAM_ID, agentPda);
  const [agentStatsPda] = findStatsPda(PROGRAM_ID, agentPda);
  const [pricingMenuPda] = findPricingPda(PROGRAM_ID, agentPda);
  const [escrowPda] = findEscrowPda(PROGRAM_ID, agentPda, depositor.publicKey, escrowNonce);
  const mint = USDC_DEVNET;
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositor.publicKey, false);
  const workerAta = getAssociatedTokenAddress(mint, worker.publicKey, false);
  const treasuryAta = getAssociatedTokenAddress(mint, TREASURY, true);
  const settlementIndex = 0n;
  const [pendingPda] = findPendingPda(PROGRAM_ID, escrowPda, settlementIndex);
  const [disputePda] = findDisputePda(PROGRAM_ID, pendingPda);

  const price = 1_000_000n; // 1 USDC (6 decimals)
  const deposit = 1_010_000n; // > obligation (fee headroom)
  const auditRoot = Buffer.alloc(32, 7);

  // ── register + stake + pricing provisioning (prerequisites for create_escrow_v2) ──
  console.log('\n1) provision worker (register_agent -> init_stake >=0.1 SOL -> update_agent pricing) ...');
  try {
    const { agent, stats, pricing, global } = deriveAgentPdaSet(PROGRAM_ID, worker.publicKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exists = await (program.account as any).agentAccount.fetchNullable(agent);
    if (!exists) {
      const tx: Transaction = await program.methods
        .registerAgent('HermesTest', 'ClawVille test Hermes agent (bounty worker)', [], [], ['clawville', 'bounty'], null, null, null)
        .accountsStrict({ wallet: worker.publicKey, agent, agentStats: stats, pricingMenu: pricing, globalRegistry: global, systemProgram: SystemProgram.programId })
        .transaction();
      await sendAndConfirmTransaction(connection, tx, [worker], { commitment: COMMITMENT });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stake = await (program.account as any).agentStake.fetchNullable(agentStakePda);
    if (!stake) {
      const tx: Transaction = await program.methods
        .initStake(new BN((110_000_000).toString())) // 0.11 SOL (> 0.1 MIN)
        .accountsStrict({ wallet: worker.publicKey, agent, stake: agentStakePda, systemProgram: SystemProgram.programId })
        .transaction();
      await sendAndConfirmTransaction(connection, tx, [worker], { commitment: COMMITMENT });
    }
    // update_agent(pricing) — seed a "standard" Escrow-mode USDC tier so create finds a matching tier.
    const tier = {
      tierId: 'standard', pricePerCall: new BN(price.toString()), minPricePerCall: null, maxPricePerCall: null,
      rateLimit: 100, maxCallsPerSession: 1000, burstLimit: null, tokenType: { usdc: {} }, tokenMint: mint,
      tokenDecimals: USDC_DECIMALS, settlementMode: { escrow: {} }, minEscrowDeposit: null, batchIntervalSec: null, volumeCurve: null,
    };
    const upd: Transaction = await program.methods
      .updateAgent(null, null, null, [tier], null, null, null, null)
      .accountsStrict({ wallet: worker.publicKey, agent, pricingMenu: pricing, systemProgram: SystemProgram.programId })
      .transaction();
    await sendAndConfirmTransaction(connection, upd, [worker], { commitment: COMMITMENT });
    console.log('   ✅ worker provisioned (registered + staked + priced)');
  } catch (e) { console.log(`   ⚠ provisioning: ${e instanceof Error ? e.message : e} (continuing to layout sims)`); }

  console.log('\n2) ensure ATAs (depositor, vault, worker, treasury) exist (empty ok) ...');
  try {
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction({ payer: depositor.publicKey, ata: depositorAta, owner: depositor.publicKey, mint }))
      .add(createAssociatedTokenAccountIdempotentInstruction({ payer: depositor.publicKey, ata: vaultAta, owner: escrowPda, mint }))
      .add(createAssociatedTokenAccountIdempotentInstruction({ payer: depositor.publicKey, ata: treasuryAta, owner: TREASURY, mint }));
    await sendAndConfirmTransaction(connection, tx, [depositor], { commitment: COMMITMENT });
    const tx2 = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction({ payer: worker.publicKey, ata: workerAta, owner: worker.publicKey, mint }));
    await sendAndConfirmTransaction(connection, tx2, [worker], { commitment: COMMITMENT });
    console.log('   ✅ ATAs ready');
  } catch (e) { console.log(`   ⚠ ATA create: ${e instanceof Error ? e.message : e}`); }

  // ── SPL remaining assemblies via the SSOT (assembleV2SplRemaining) — the thing under test ──
  const splCreate = assembleV2SplRemaining('create', { vaultAta, depositorAta, tokenMint: mint });
  const splSettle = assembleV2SplRemaining('settle', { vaultAta, workerAta, treasuryAta, pendingPda, tokenMint: mint });
  const splFinalize = assembleV2SplRemaining('finalize', { vaultAta, workerAta, tokenMint: mint });
  const splWithdraw = assembleV2SplRemaining('withdraw', { vaultAta, depositorAta, tokenMint: mint });

  console.log('\n3) LAYOUT SIMULATIONS (a WRONG remaining-account order -> LAYOUT BAD; a right one -> passes account validation):');

  await sim(connection, [await buildCreateEscrowV2Ix(program, {
    depositor: depositor.publicKey, agentPda, agentStakePda, agentStatsPda, pricingMenuPda, escrowPda, escrowNonce,
    pricePerCall: price, maxCalls: 1n, initialDeposit: deposit, expiresAt: 0n, tokenMint: mint,
    tokenDecimals: USDC_DECIMALS, settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
    disputeWindowSlots: 2160n, coSigner: null, arbiter: arbiter.publicKey, remaining: splCreate,
  })], [depositor], 'create_escrow_v2 [depositorAta, vaultAta, tokenProgram]');

  // settle_calls_v2 — 1.0.0: ONE ix charges the fee + INITS the pending itself (NO create_pending).
  await sim(connection, [await buildSettleCallsV2Ix(program, {
    workerWallet: worker.publicKey, agentPda, agentStatsPda, escrowPda, escrowNonce, callsToSettle: 1n, serviceHash: auditRoot, remaining: splSettle,
  })], [worker], 'settle_calls_v2 [vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]');

  await sim(connection, [await buildFinalizeSettlementIx(program, {
    payer: worker.publicKey, agentWallet: worker.publicKey, escrowPda, pendingPda, agentStatsPda, remaining: splFinalize,
  })], [worker], 'finalize_settlement [vaultAta, workerAta, tokenProgram]');

  await sim(connection, [await buildFileDisputeIx(program, {
    depositor: depositor.publicKey, escrowPda, pendingPda, disputePda, evidenceHash: Buffer.alloc(32, 9), disputeType: DISPUTE_TYPE.NonDelivery,
  })], [depositor], 'file_dispute (evidence + dispute_type, no SPL)');

  await sim(connection, [await buildWithdrawEscrowV2Ix(program, {
    depositor: depositor.publicKey, escrowPda, amount: price, remaining: splWithdraw,
  })], [depositor], 'withdraw_escrow_v2 [vaultAta, depositorAta, tokenProgram]');

  console.log('\n   LAYOUT OK = the program accepted the account context; LAYOUT BAD = a real remaining-account bug.');

  const depBal = await connection.getTokenAccountBalance(depositorAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  console.log(`\n4) depositor USDC balance = ${(Number(depBal) / 10 ** USDC_DECIMALS).toFixed(2)} USDC`);
  if (!LIVE) { console.log('   (SIMULATE-only run — pass --live + fund the depositor USDC ATA to produce the real settled record.)'); return; }
  if (depBal < deposit) {
    console.log(`\n⏳ To produce the REAL bounty record, fund the depositor USDC ATA with >= 1.01 devnet USDC:`);
    console.log(`     owner: ${depositor.publicKey.toBase58()}   ATA: ${depositorAta.toBase58()}`);
    console.log(`     mint : ${mint.toBase58()}  (Circle devnet USDC — https://faucet.circle.com)`);
    process.exit(4);
  }

  const LIVE_WINDOW_SLOTS = 5n;
  const exists = async (p: PublicKey) => (await connection.getAccountInfo(p)) !== null;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = nowSec + 86_400n;

  console.log(`\n5) LIVE create_escrow_v2 (DisputeWindow, window=${LIVE_WINDOW_SLOTS} slots) ...`);
  if (await exists(escrowPda)) {
    console.log(`   escrow already exists (${escrowPda.toBase58()}) — reusing`);
  } else {
    const ix = await buildCreateEscrowV2Ix(program, {
      depositor: depositor.publicKey, agentPda, agentStakePda, agentStatsPda, pricingMenuPda, escrowPda, escrowNonce,
      pricePerCall: price, maxCalls: 1n, initialDeposit: deposit, expiresAt, tokenMint: mint,
      tokenDecimals: USDC_DECIMALS, settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
      disputeWindowSlots: LIVE_WINDOW_SLOTS, coSigner: null, arbiter: arbiter.publicKey, remaining: splCreate,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [depositor], { commitment: COMMITMENT });
    console.log(`   ✅ escrow created + funded ${(Number(deposit) / 10 ** USDC_DECIMALS).toFixed(2)} USDC · ${sig}`);
  }

  console.log('\n6) LIVE settle_calls_v2 (charges fee to treasury + INITS pending, one ix, worker signs) ...');
  if (await exists(pendingPda)) {
    console.log(`   pending settlement already exists (${pendingPda.toBase58()}) — reusing`);
  } else {
    const settleIx = await buildSettleCallsV2Ix(program, { workerWallet: worker.publicKey, agentPda, agentStatsPda, escrowPda, escrowNonce, callsToSettle: 1n, serviceHash: auditRoot, remaining: splSettle });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(settleIx), [worker], { commitment: COMMITMENT });
    console.log(`   ✅ settled + pending inited · ${sig}`);
  }

  console.log(`\n7) wait ${LIVE_WINDOW_SLOTS} dispute-window slots, then finalize_settlement (vault -> worker) ...`);
  const baselineSlot = await connection.getSlot(COMMITMENT);
  const targetSlot = baselineSlot + Number(LIVE_WINDOW_SLOTS) + 2;
  for (let i = 0; i < 60; i++) {
    const s = await connection.getSlot(COMMITMENT);
    if (s >= targetSlot) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const workerBal0 = await connection.getTokenAccountBalance(workerAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const finalizeIx = await buildFinalizeSettlementIx(program, { payer: worker.publicKey, agentWallet: worker.publicKey, escrowPda, pendingPda, agentStatsPda, remaining: splFinalize });
  let finalizeSig = '';
  try {
    finalizeSig = await sendAndConfirmTransaction(connection, new Transaction().add(finalizeIx), [worker], { commitment: COMMITMENT });
    console.log(`   ✅ finalize_settlement · ${finalizeSig}`);
  } catch (e) {
    console.error(`   ❌ finalize FAILED: ${e instanceof Error ? e.message : e}`);
    process.exit(5);
  }
  const workerBal1 = await connection.getTokenAccountBalance(workerAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const delta = workerBal1 - workerBal0;
  console.log(`\n   worker USDC: ${(Number(workerBal0) / 10 ** USDC_DECIMALS).toFixed(2)} -> ${(Number(workerBal1) / 10 ** USDC_DECIMALS).toFixed(2)}  (delta ${(Number(delta) / 10 ** USDC_DECIMALS).toFixed(2)})`);
  if (delta <= 0n) { console.error('   ❌ worker balance did NOT increase — finalize did not release funds.'); process.exit(6); }

  console.log('\n================================================================');
  console.log('  ✅ VERIFIED BOUNTY RECORD (devnet, SAP DisputeWindow, SDK 1.0.0 path):');
  console.log(`     program    = ${PROGRAM_ID.toBase58()}`);
  console.log(`     agent PDA  = ${agentPda.toBase58()}  (worker = ${worker.publicKey.toBase58()})`);
  console.log(`     escrow PDA = ${escrowPda.toBase58()}`);
  console.log(`     finalize   = ${finalizeSig}`);
  console.log(`     released   = ${(Number(delta) / 10 ** USDC_DECIMALS).toFixed(2)} USDC -> worker ATA ${workerAta.toBase58()}`);
  console.log('================================================================');
}

main().catch((e) => { console.error('\n❌ v2 smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });
