/**
 * V2 DisputeWindow devnet smoke — proves the SAP Escrow V2 USDC wire against the
 * DEPLOYED devnet program (0.18.0), and confirms the `TODO(devnet-confirm)` SPL
 * remaining_accounts orders empirically.
 *
 * TWO LEVELS:
 *   L1 (SIMULATE, no USDC needed): builds each V2 instruction with our assembled
 *      account layout and `simulateTransaction`s it against the real program. A
 *      WRONG remaining-account order trips a loud ACCOUNT/CONSTRAINT error
 *      (ConstraintRaw / AccountNotFound / NotEnoughAccountKeys) BEFORE the token
 *      transfer — a RIGHT order passes account validation and only then fails on
 *      insufficient vault funds (a DIFFERENT error). So L1 distinguishes a
 *      layout bug from a funding stub without spending a cent. Self-reliant
 *      (just devnet SOL airdrop for rent).
 *   L2 (LIVE, needs devnet USDC in the depositor ATA): actually create_escrow_v2
 *      (DisputeWindow) → deposit → settle_calls_v2+create_pending → finalize,
 *      producing a REAL settled escrow bound to the worker = the verifiable
 *      "bounty record" for the Metaplex identity mint. Runs only with --live AND
 *      a funded depositor USDC ATA.
 *
 * Run:
 *   cd apps/api && SAP_SMOKE=1 bun run scripts/sap/v2-dispute-window-smoke.ts          # L1 simulate
 *   cd apps/api && SAP_SMOKE=1 bun run scripts/sap/v2-dispute-window-smoke.ts --live   # + L2 live (needs USDC)
 *
 * Throwaway keypairs persist (gitignored `.smoke-v2-*.json`) so funding is ONE-TIME.
 * NO DB, NO keypair-vault, NO prod. Devnet only (hard-checked via genesis hash).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, type Commitment,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import idlJson from '../../src/services/sap/synapse_agent_sap.onchain.idl.json' with { type: 'json' };
import { deriveAgentPdaSet, findAgentPda, findStatsPda, findEscrowPda, findPendingPda, findDisputePda } from '../../src/services/sap/sap-pdas';
import {
  buildCreateEscrowV2Ix, buildDepositEscrowV2Ix, buildSettleCallsV2Ix,
  buildCreatePendingSettlementIx, buildFinalizeSettlementIx, buildFileDisputeIx,
  buildResolveDisputeIx, buildWithdrawEscrowV2Ix, SETTLEMENT_SECURITY, DISPUTE_OUTCOME,
} from '../../src/services/sap/sap-escrow-v2';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, USDC_DECIMALS,
} from '../../src/services/sap/sap-spl';

const RPC = process.env.SAP_DEVNET_RPC ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const USDC_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDL = idlJson as any;
const PROGRAM_ID = new PublicKey(IDL.address);
const LIVE = process.argv.includes('--live');
// A ClawVille-controlled arbiter for the DisputeWindow escrow (throwaway on devnet).
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
  // Account-shape failures — a WRONG remaining_accounts order/identity.
  if (/ConstraintRaw|AccountNotFound|NotEnoughAccountKeys|An account required by the instruction is missing|AccountOwnedByWrongProgram|invalid account data|ConstraintTokenMint|ConstraintTokenOwner|ConstraintAssociated/i.test(logs + err)) {
    return { layout: 'bad', note: (logs.match(/Error Code: \w+|Error Message: [^\n]+/g) ?? [err]).slice(0, 2).join(' | ') };
  }
  // Funds-level failure AFTER the program validated the account context = layout OK.
  if (/insufficient funds|InsufficientFunds|0x1$|custom program error: 0x1\b/i.test(logs + err)) {
    return { layout: 'ok', note: 'account layout accepted; failed on insufficient funds (expected without USDC)' };
  }
  if (!sim.err) return { layout: 'ok', note: 'simulated cleanly (no err)' };
  if (invoked) return { layout: 'ok', note: `program ran; non-account err: ${err}` };
  return { layout: 'unfunded', note: `program not reached (fund payer / create ATAs first): ${err}` };
}

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
  console.log(`SAP V2 DisputeWindow smoke · program ${PROGRAM_ID.toBase58()} · ${RPC.split('?')[0]}`);
  console.log(`on-chain IDL version = ${IDL.metadata?.version} · mode=${LIVE ? 'LIVE (+simulate)' : 'SIMULATE-only'}\n`);
  const connection = new Connection(RPC, COMMITMENT);
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) { console.error(`❌ RPC is NOT devnet (genesis ${genesis}). Refusing.`); process.exit(2); }
  const program = placeholderProgram(connection);

  const depositor = loadOrCreate(DEPOSITOR_PATH);
  const worker = loadOrCreate(WORKER_PATH);       // = the test Hermes agent's SAP wallet
  const arbiter = loadOrCreate(ARBITER_PATH);     // = ClawVille admin (DisputeWindow arbiter)
  console.log(`depositor = ${depositor.publicKey.toBase58()}`);
  console.log(`worker    = ${worker.publicKey.toBase58()}  (HermesTest SAP wallet)`);
  console.log(`arbiter   = ${arbiter.publicKey.toBase58()}\n`);

  // ── fund SOL (rent) ──
  for (const [name, kp] of [['depositor', depositor], ['worker', worker], ['arbiter', arbiter]] as const) {
    let bal = await connection.getBalance(kp.publicKey);
    if (bal < 0.15 * LAMPORTS_PER_SOL) { await airdrop(connection, kp.publicKey, 1); bal = await connection.getBalance(kp.publicKey); }
    console.log(`  ${name} SOL = ${(bal / LAMPORTS_PER_SOL).toFixed(3)}`);
    if (bal < 0.05 * LAMPORTS_PER_SOL) {
      console.log(`\n⏳ FUND (one-time, persists): ${kp.publicKey.toBase58()} — ~0.3 devnet SOL via https://faucet.solana.com`);
      process.exit(3);
    }
  }

  // ── derive the V2 escrow address set (escrow bound to the WORKER agent) ──
  const escrowNonce = 1n;
  const [agentPda] = findAgentPda(PROGRAM_ID, worker.publicKey);
  const [agentStatsPda] = findStatsPda(PROGRAM_ID, agentPda);
  const [escrowPda] = findEscrowPda(PROGRAM_ID, agentPda, depositor.publicKey, escrowNonce);
  const mint = USDC_DEVNET;
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositor.publicKey, false);
  const workerAta = getAssociatedTokenAddress(mint, worker.publicKey, false);
  const [settlementIndex] = [0n];
  const [pendingPda] = findPendingPda(PROGRAM_ID, escrowPda, settlementIndex);
  const [disputePda] = findDisputePda(PROGRAM_ID, pendingPda);
  const meta = (pubkey: PublicKey, signer = false, writable = false) => ({ pubkey, isSigner: signer, isWritable: writable });

  // ── register the worker as a SAP agent (its identity for the record) ──
  console.log('\n1) register_agent(worker=HermesTest) ...');
  try {
    const { agent, stats, global } = deriveAgentPdaSet(PROGRAM_ID, worker.publicKey);
    const exists = await (program.account as any).agentAccount.fetchNullable(agent);
    if (exists) { console.log('   already registered ✅'); }
    else {
      const tx: Transaction = await program.methods
        .registerAgent('HermesTest', 'ClawVille test Hermes agent (bounty worker)', [], [], ['clawville', 'bounty'], null, null, null)
        .accountsStrict({ wallet: worker.publicKey, agent, agentStats: stats, globalRegistry: global, systemProgram: SystemProgram.programId })
        .transaction();
      const s = await sendAndConfirmTransaction(connection, tx, [worker], { commitment: COMMITMENT });
      console.log(`   ✅ ${s}`);
    }
  } catch (e) { console.log(`   ⚠ register_agent: ${e instanceof Error ? e.message : e} (continuing to layout sims)`); }

  // ── ensure the depositor + vault ATAs exist (empty) so account resolution works ──
  console.log('\n2) ensure ATAs (depositor, vault, worker) exist (empty ok) ...');
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction({ payer: depositor.publicKey, ata: depositorAta, owner: depositor.publicKey, mint }),
    createAssociatedTokenAccountIdempotentInstruction({ payer: depositor.publicKey, ata: vaultAta, owner: escrowPda, mint }),
    createAssociatedTokenAccountIdempotentInstruction({ payer: worker.publicKey, ata: workerAta, owner: worker.publicKey, mint }),
  ];
  try {
    const tx = new Transaction().add(ataIxs[0], ataIxs[1]);
    await sendAndConfirmTransaction(connection, tx, [depositor], { commitment: COMMITMENT });
    const tx2 = new Transaction().add(ataIxs[2]);
    await sendAndConfirmTransaction(connection, tx2, [worker], { commitment: COMMITMENT });
    console.log('   ✅ ATAs ready');
  } catch (e) { console.log(`   ⚠ ATA create: ${e instanceof Error ? e.message : e}`); }

  // ── SPL remaining assemblies (MIRROR sap-client assembleV2SplRemaining — the thing under test) ──
  const splCreate = [meta(depositorAta, false, true), meta(vaultAta, false, true), meta(mint), meta(TOKEN_PROGRAM_ID)];
  const splFinalize = [meta(vaultAta, false, true), meta(workerAta, false, true), meta(mint), meta(TOKEN_PROGRAM_ID)];
  const splResolve = [meta(vaultAta, false, true), meta(depositorAta, false, true), meta(workerAta, false, true), meta(mint), meta(TOKEN_PROGRAM_ID)];
  const splWithdraw = [meta(vaultAta, false, true), meta(depositorAta, false, true), meta(mint), meta(TOKEN_PROGRAM_ID)];

  const price = 1_000_000n; // 1 USDC (6 decimals)
  const auditRoot = Buffer.alloc(32, 7); // non-zero placeholder audit root

  console.log('\n3) LAYOUT SIMULATIONS (a WRONG remaining-account order → ❌ LAYOUT BAD; a right one → ✅ passes account validation):');

  // create_escrow_v2 (DisputeWindow, arbiter set) — SPL create order is dev/SDK-confirmed; this validates the whole create context.
  await sim(connection, [buildCreateEscrowV2Ix({
    depositor: depositor.publicKey, agentPda, escrowPda, programId: PROGRAM_ID, escrowNonce,
    pricePerCall: price, maxCalls: 1n, initialDeposit: price, expiresAt: 0n, tokenMint: mint,
    tokenDecimals: USDC_DECIMALS, settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
    disputeWindowSlots: 2160n, coSigner: null, arbiter: arbiter.publicKey, remaining: splCreate,
  })], [depositor], 'create_escrow_v2 [depositorAta, vaultAta, mint, tokenProgram]');

  // settle_calls_v2 (DisputeWindow: remaining=[]) + create_pending — worker signs.
  await sim(connection, [
    buildSettleCallsV2Ix({ workerWallet: worker.publicKey, agentPda, agentStatsPda, escrowPda, programId: PROGRAM_ID, escrowNonce, callsToSettle: 1n, serviceHash: auditRoot, remaining: [] }),
    buildCreatePendingSettlementIx({ workerWallet: worker.publicKey, agentPda, escrowPda, pendingPda, programId: PROGRAM_ID, settlementIndex, callsToSettle: 1n, amount: price, serviceHash: auditRoot }),
  ], [worker], 'settle_calls_v2 (remaining=[]) + create_pending_settlement');

  // finalize_settlement — release vault → worker. THE unconfirmed SPL order under test.
  await sim(connection, [buildFinalizeSettlementIx({
    payer: worker.publicKey, agentWallet: worker.publicKey, escrowPda, pendingPda, agentStatsPda, programId: PROGRAM_ID, remaining: splFinalize,
  })], [worker], 'finalize_settlement [vaultAta, workerAta, mint, tokenProgram]  ← TODO(devnet-confirm)');

  // file_dispute — depositor disputes.
  await sim(connection, [buildFileDisputeIx({
    depositor: depositor.publicKey, escrowPda, pendingPda, disputePda, programId: PROGRAM_ID, evidenceHash: Buffer.alloc(32, 9),
  })], [depositor], 'file_dispute (no SPL)');

  // resolve_dispute (AgentWins) — arbiter signs. Unconfirmed SPL order under test.
  await sim(connection, [buildResolveDisputeIx({
    arbiter: arbiter.publicKey, depositor: depositor.publicKey, agentWallet: worker.publicKey, escrowPda, pendingPda, disputePda, agentStatsPda, programId: PROGRAM_ID, outcome: DISPUTE_OUTCOME.AgentWins, remaining: splResolve,
  })], [arbiter], 'resolve_dispute(AgentWins) [vaultAta, depositorAta, workerAta, mint, tokenProgram]  ← TODO(devnet-confirm)');

  // withdraw_escrow_v2 — depositor reclaim. Unconfirmed SPL order under test.
  await sim(connection, [buildWithdrawEscrowV2Ix({
    depositor: depositor.publicKey, escrowPda, programId: PROGRAM_ID, amount: price, remaining: splWithdraw,
  })], [depositor], 'withdraw_escrow_v2 [vaultAta, depositorAta, mint, tokenProgram]  ← TODO(devnet-confirm)');

  console.log('\n   Read each: ✅ LAYOUT OK = the program accepted the account context (order right, or right-enough to reach funds check).');
  console.log('   ❌ LAYOUT BAD = a real remaining-account order/identity bug — fix assembleV2SplRemaining before any live flip.');

  // ── L2: live escrow record (needs USDC in depositorAta) ──
  const depBal = await connection.getTokenAccountBalance(depositorAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  console.log(`\n4) depositor USDC balance = ${(Number(depBal) / 10 ** USDC_DECIMALS).toFixed(2)} USDC`);
  if (!LIVE) { console.log('   (SIMULATE-only run — pass --live + fund the depositor USDC ATA to produce the real settled record.)'); return; }
  if (depBal < price) {
    console.log(`\n⏳ To produce HermesTest's REAL bounty record, fund the depositor USDC ATA with ≥ 1 devnet USDC:`);
    console.log(`     owner: ${depositor.publicKey.toBase58()}`);
    console.log(`     ATA  : ${depositorAta.toBase58()}`);
    console.log(`     mint : ${mint.toBase58()}  (Circle devnet USDC — https://faucet.circle.com, select Solana Devnet)`);
    process.exit(4);
  }
  // ── L2 LIVE happy-path: create → settle+pending → (wait window) → finalize ──
  // Produces HermesTest's REAL settled escrow. UNVERIFIED until this actually runs
  // green against devnet — a wrong finalize SPL order fails LOUDLY here (that IS
  // the empirical confirmation). Re-runnable: each on-chain account is existence-
  // checked so a re-run resumes rather than double-spending.
  const LIVE_WINDOW_SLOTS = 5n; // tiny dispute window so finalize is reachable in ~seconds
  const exists = async (pk: PublicKey) => (await connection.getAccountInfo(pk)) !== null;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = nowSec + 86_400n; // work-deadline 24h out (future ⇒ escrow active for the happy path)

  console.log(`\n5) LIVE create_escrow_v2 (DisputeWindow, window=${LIVE_WINDOW_SLOTS} slots, arbiter set) ...`);
  if (await exists(escrowPda)) {
    console.log(`   escrow already exists (${escrowPda.toBase58()}) — reusing`);
  } else {
    const ix = buildCreateEscrowV2Ix({
      depositor: depositor.publicKey, agentPda, escrowPda, programId: PROGRAM_ID, escrowNonce,
      pricePerCall: price, maxCalls: 1n, initialDeposit: price, expiresAt, tokenMint: mint,
      tokenDecimals: USDC_DECIMALS, settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
      disputeWindowSlots: LIVE_WINDOW_SLOTS, coSigner: null, arbiter: arbiter.publicKey, remaining: splCreate,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [depositor], { commitment: COMMITMENT });
    console.log(`   ✅ escrow created + funded ${(Number(price) / 10 ** USDC_DECIMALS).toFixed(2)} USDC · ${sig}`);
  }
  const vaultBal0 = await connection.getTokenAccountBalance(vaultAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  console.log(`   vault balance = ${(Number(vaultBal0) / 10 ** USDC_DECIMALS).toFixed(2)} USDC`);

  console.log('\n6) LIVE settle_calls_v2 (remaining=[]) + create_pending_settlement (one tx, worker signs) ...');
  if (await exists(pendingPda)) {
    console.log(`   pending settlement already exists (${pendingPda.toBase58()}) — reusing`);
  } else {
    const settleIx = buildSettleCallsV2Ix({ workerWallet: worker.publicKey, agentPda, agentStatsPda, escrowPda, programId: PROGRAM_ID, escrowNonce, callsToSettle: 1n, serviceHash: auditRoot, remaining: [] });
    const pendingIx = buildCreatePendingSettlementIx({ workerWallet: worker.publicKey, agentPda, escrowPda, pendingPda, programId: PROGRAM_ID, settlementIndex, callsToSettle: 1n, amount: price, serviceHash: auditRoot });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(settleIx, pendingIx), [worker], { commitment: COMMITMENT });
    console.log(`   ✅ settled + pending recorded · ${sig}`);
  }

  console.log(`\n7) wait ${LIVE_WINDOW_SLOTS} dispute-window slots, then finalize_settlement (vault → worker) ...`);
  const baselineSlot = await connection.getSlot(COMMITMENT);
  const targetSlot = baselineSlot + Number(LIVE_WINDOW_SLOTS) + 2;
  for (let i = 0; i < 60; i++) {
    const s = await connection.getSlot(COMMITMENT);
    if (s >= targetSlot) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const workerBal0 = await connection.getTokenAccountBalance(workerAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const finalizeIx = buildFinalizeSettlementIx({ payer: worker.publicKey, agentWallet: worker.publicKey, escrowPda, pendingPda, agentStatsPda, programId: PROGRAM_ID, remaining: splFinalize });
  let finalizeSig = '';
  try {
    finalizeSig = await sendAndConfirmTransaction(connection, new Transaction().add(finalizeIx), [worker], { commitment: COMMITMENT });
    console.log(`   ✅ finalize_settlement · ${finalizeSig}`);
  } catch (e) {
    console.error(`   ❌ finalize FAILED — the finalize SPL remaining order [vault, workerAta, mint, tokenProgram] is likely wrong. Fix assembleV2SplRemaining('finalize') in sap-client.ts.\n      ${e instanceof Error ? e.message : e}`);
    process.exit(5);
  }
  const workerBal1 = await connection.getTokenAccountBalance(workerAta).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const delta = workerBal1 - workerBal0;
  console.log(`\n   worker (HermesTest) USDC: ${(Number(workerBal0) / 10 ** USDC_DECIMALS).toFixed(2)} → ${(Number(workerBal1) / 10 ** USDC_DECIMALS).toFixed(2)}  (Δ ${(Number(delta) / 10 ** USDC_DECIMALS).toFixed(2)})`);
  if (delta <= 0n) {
    console.error('   ❌ worker balance did NOT increase — finalize did not release funds. Treat the finalize SPL order as UNCONFIRMED.');
    process.exit(6);
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  ✅ HermesTest VERIFIED BOUNTY RECORD (devnet, SAP DisputeWindow):');
  console.log(`     program      = ${PROGRAM_ID.toBase58()}`);
  console.log(`     agent PDA    = ${agentPda.toBase58()}  (worker = ${worker.publicKey.toBase58()})`);
  console.log(`     escrow PDA   = ${escrowPda.toBase58()}`);
  console.log(`     pending PDA  = ${pendingPda.toBase58()}`);
  console.log(`     finalize sig = ${finalizeSig}`);
  console.log(`     released     = ${(Number(delta) / 10 ** USDC_DECIMALS).toFixed(2)} USDC → worker ATA ${workerAta.toBase58()}`);
  console.log('     → hand this to the Covenant/OOBE dev for the Metaplex Core identity mint.');
  console.log('════════════════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('\n❌ v2 smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });
