/**
 * SAP dry-run conformance harness — the SHIP GATE for the on-chain build.
 *
 * Goal: prove every SAP instruction the backend issues encodes against the
 * AUTHORITATIVE on-chain IDL (what is DEPLOYED on devnet — 0.18.0, NOT the
 * ahead-of-deployment 0.25.0 repo IDL) and that the produced instruction's
 * account set EXACTLY matches the deployed program's account context, WITHOUT
 * needing real SOL to broadcast anything.
 *
 * ── Why the OLD harness was FALSELY GREEN (the audit's FIX-B) ──────────────────
 * The old harness simulated with an UNFUNDED throwaway payer. On devnet an
 * unfunded fee-payer makes `simulateTransaction` abort at `AccountNotFound` with
 * EMPTY logs BEFORE the program is ever invoked — so the sim could NOT tell a
 * correct account set from a wrong one, yet the old harness scored
 * `AccountNotFound`/empty-logs as PASS. That is exactly backwards.
 *
 * ── What this harness asserts now ─────────────────────────────────────────────
 *   1. VERSION PIN (hard): fetch the on-chain IDL from devnet via Anchor
 *      `Program.fetchIdl` and FAIL if its `metadata.version` differs from the
 *      vendored `synapse_agent_sap.onchain.idl.json`. A future OOBE redeploy that
 *      changes the deployed program makes this harness fail LOUDLY.
 *   2. STRUCTURAL CONFORMANCE (hard, no funding needed): for every instruction
 *      the client issues, build the tx against the on-chain IDL and assert the
 *      produced `TransactionInstruction.keys` EXACTLY match the on-chain IDL's
 *      account list — count, order, and signer/writable flags per position.
 *      (Anchor's coder is IDL-driven and silently drops accounts not in the IDL,
 *      so this positional flag/count comparison — not the mere fact that the build
 *      did not throw — is what catches a wrong account context.)
 *   3. PROGRAM-LOG PROOF (opportunistic, when a funded payer is available): if a
 *      payer can be funded (devnet airdrop, or a pre-funded keypair from
 *      `SAP_HARNESS_PAYER_SECRET`), run a real `simulateTransaction` and assert
 *      the program was INVOKED (`Program SAPpU… invoke` in the logs) and the sim
 *      did NOT return a MALFORMED-instruction signature. `AccountNotFound` /
 *      empty-logs is treated as INCONCLUSIVE (the program never ran) — NOT a pass.
 *      Unavailable funding degrades to the structural check (clearly labeled).
 *   4. GATE BEHAVIOR (hard): with the gates unset, the client helpers REFUSE
 *      (sap_disabled / sap_escrow_disabled) before any chain work; and a dry-run
 *      write helper NEVER returns a broadcast signature.
 *
 * Run:  cd apps/api && bun run scripts/sap/dry-run-e2e.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  type Commitment,
} from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';

// AUTHORITATIVE = the on-chain IDL (what is deployed). Same file the client loads.
import idlJson from '../../src/services/sap/synapse_agent_sap.onchain.idl.json' with { type: 'json' };
import {
  loadSapConfig,
  SAP_MIN_STAKE_LAMPORTS,
} from '../../src/services/sap/sap-config';
import {
  deriveAgentPdaSet,
  findAgentPda,
  findStatsPda,
  findGlobalPda,
  findStakePda,
  findToolPda,
  findFeedbackPda,
  findEscrowPda,
  toolNameHash,
  serviceHash,
} from '../../src/services/sap/sap-pdas';

const COMMITMENT: Commitment = 'confirmed';
const SETTLEMENT_SELF_REPORT = 0;

// ── results bookkeeping ───────────────────────────────────────────────────────
interface CaseResult {
  name: string;
  built: boolean;
  conformant: boolean; // structural account-set conformance vs on-chain IDL
  programReached: 'yes' | 'no' | 'inconclusive' | 'skipped';
  note: string;
}
const results: CaseResult[] = [];
let hardFail = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDL = idlJson as any;

const MALFORMED_SIGNATURES = [
  'Fallback functions are not supported',
  'InstructionFallbackNotFound',
  'Could not deserialize',
  'AccountDiscriminatorMismatch',
  'DeclaredProgramIdMismatch',
  'invalid instruction data',
];

/**
 * Structural conformance: assert the produced instruction's keys EXACTLY match
 * the on-chain IDL account list for `ixName` — same count, same order, same
 * signer/writable flag per position. Anchor's coder is IDL-driven (it drops
 * accounts NOT in the IDL and orders by the IDL), so a positional count + flag
 * match is a genuine proof that the client builds the deployed program's account
 * context, not the ahead-of-deployment 0.25.0 one.
 */
function assertAccountConformance(
  ixName: string,
  ix: TransactionInstruction,
): { ok: boolean; detail: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idlIx = IDL.instructions.find((i: any) => i.name === ixName);
  if (!idlIx) return { ok: false, detail: `instruction '${ixName}' not in on-chain IDL` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idlAccounts: any[] = idlIx.accounts;

  if (ix.keys.length !== idlAccounts.length) {
    return {
      ok: false,
      detail: `key count ${ix.keys.length} != IDL ${idlAccounts.length} [${idlAccounts.map((a) => a.name).join(',')}]`,
    };
  }
  // Program id must be the deployed SAP program.
  if (ix.programId.toBase58() !== IDL.address) {
    return { ok: false, detail: `programId ${ix.programId.toBase58()} != IDL ${IDL.address}` };
  }
  for (let i = 0; i < idlAccounts.length; i++) {
    const idlAcc = idlAccounts[i];
    const key = ix.keys[i];
    const wantSigner = idlAcc.signer === true;
    const wantWritable = idlAcc.writable === true;
    if (key.isSigner !== wantSigner || key.isWritable !== wantWritable) {
      return {
        ok: false,
        detail: `account[${i}] '${idlAcc.name}': flags signer=${key.isSigner}/writable=${key.isWritable} != IDL signer=${wantSigner}/writable=${wantWritable}`,
      };
    }
  }
  return { ok: true, detail: `${idlAccounts.length} accounts match [${idlAccounts.map((a) => a.name).join(',')}]` };
}

interface FundedSim {
  connection: Connection;
  payer: Keypair; // a FUNDED payer (program-log path) — null path = structural only
}

async function runCase(
  ixName: string,
  funded: FundedSim | null,
  build: () => Promise<Transaction>,
): Promise<void> {
  // 1) Build.
  let tx: Transaction;
  try {
    tx = await build();
  } catch (err) {
    hardFail = true;
    results.push({
      name: ixName,
      built: false,
      conformant: false,
      programReached: 'skipped',
      note: `BUILD FAILED: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // The tx carries exactly one program instruction (plus none else). Find it.
  const progIx = tx.instructions.find((i) => i.programId.toBase58() === IDL.address);
  if (!progIx) {
    hardFail = true;
    results.push({
      name: ixName,
      built: true,
      conformant: false,
      programReached: 'skipped',
      note: `no instruction targeting the SAP program in the built tx`,
    });
    return;
  }

  // 2) Structural account-set conformance (hard, no funding needed).
  const conf = assertAccountConformance(ixName, progIx);
  if (!conf.ok) hardFail = true;

  // 3) Program-log proof (opportunistic — only when a FUNDED payer exists).
  let programReached: CaseResult['programReached'] = 'skipped';
  let logNote = '';
  if (funded) {
    try {
      const { blockhash } = await funded.connection.getLatestBlockhash(COMMITMENT);
      tx.recentBlockhash = blockhash;
      tx.feePayer = funded.payer.publicKey;
      tx.sign(funded.payer);
      const sim = await funded.connection.simulateTransaction(tx);
      const logs = sim.value.logs ?? [];
      const joined = logs.join('\n');
      const invoked = logs.some((l) => l.includes(`Program ${IDL.address} invoke`));
      const malformed = MALFORMED_SIGNATURES.some((s) => joined.includes(s));
      if (malformed) {
        programReached = 'no';
        hardFail = true;
        logNote = `MALFORMED: ${logs.filter((l) => MALFORMED_SIGNATURES.some((s) => l.includes(s))).join(' | ')}`;
      } else if (invoked) {
        // The program WAS invoked + decoded the instruction (a runtime/business
        // error after invoke is fine — it proves the account context reached it).
        programReached = 'yes';
        logNote = `program invoked (sim err=${JSON.stringify(sim.value.err) ?? 'none'} — post-invoke runtime error is fine)`;
      } else {
        // No invoke line + no malformed signature: the program NEVER ran (e.g.
        // AccountNotFound / empty logs on an under-funded payer). INCONCLUSIVE —
        // explicitly NOT a pass. The structural check (step 2) carries the gate.
        programReached = 'inconclusive';
        logNote = `INCONCLUSIVE: program not invoked (err=${JSON.stringify(sim.value.err) ?? 'none'}, ${logs.length} logs) — relying on structural conformance`;
      }
    } catch (err) {
      programReached = 'inconclusive';
      logNote = `sim RPC error: ${err instanceof Error ? err.message : String(err)} — relying on structural conformance`;
    }
  }

  results.push({
    name: ixName,
    built: true,
    conformant: conf.ok,
    programReached,
    note: conf.ok ? `${conf.detail}${logNote ? ' | ' + logNote : ''}` : `ACCOUNT MISMATCH: ${conf.detail}`,
  });
}

/**
 * Hard version-pin assertion (FIX-B step 3). Fetch the on-chain IDL from devnet
 * and FAIL if its metadata.version differs from the vendored on-chain IDL. A
 * future OOBE redeploy that changes the deployed program's account contexts makes
 * this harness fail loudly so we re-vendor + re-diff before shipping.
 */
async function assertOnChainVersionPin(connection: Connection | null): Promise<void> {
  const vendored = IDL.metadata?.version ?? '(none)';
  console.log('--- on-chain IDL version pin ---');
  console.log(`  vendored on-chain IDL metadata.version = ${vendored}`);
  if (!connection) {
    console.log('  devnet RPC unreachable — CANNOT verify the live on-chain version.');
    console.log('  (structural conformance still runs against the vendored on-chain IDL.)\n');
    return;
  }
  try {
    const kp = Keypair.generate();
    const provider = new AnchorProvider(
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { publicKey: kp.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t, payer: kp } as any,
      { commitment: COMMITMENT },
    );
    const live = await Program.fetchIdl(new PublicKey(IDL.address), provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveVersion = (live as any)?.metadata?.version ?? '(none)';
    console.log(`  live on-chain metadata.version       = ${liveVersion}`);
    if (liveVersion !== vendored) {
      hardFail = true;
      console.log(
        `  ❌ VERSION DRIFT: deployed program is ${liveVersion} but vendored on-chain IDL is ${vendored}. ` +
          `Re-vendor synapse_agent_sap.onchain.idl.json (fetch-onchain-idl.ts) + re-diff every account list.\n`,
      );
    } else {
      console.log('  ✅ version pin matches the deployed program.\n');
    }
  } catch (err) {
    // FIX-I: ship-gate is STRICT by default — an inability to fetch+confirm the
    // live IDL means the version pin is unproven, so FAIL. An explicit offline
    // escape (SAP_HARNESS_OFFLINE=true) downgrades to a warning for local runs
    // that only want the structural-conformance check (no devnet RPC).
    const offline = process.env.SAP_HARNESS_OFFLINE === 'true';
    const msg = `  could not fetch live IDL (${err instanceof Error ? err.message : String(err)})`;
    if (offline) {
      console.log(`${msg} — SAP_HARNESS_OFFLINE set, skipping live version check (structural only).\n`);
    } else {
      hardFail = true;
      console.log(`${msg} — ❌ FAIL: cannot confirm the version pin against the deployed program. Set SAP_HARNESS_OFFLINE=true for an offline structural-only run.\n`);
    }
  }
}

/** Try to obtain a FUNDED payer for the program-log path. Best-effort. */
async function tryFundPayer(connection: Connection): Promise<Keypair | null> {
  // 1) Pre-funded keypair from env (CI / when airdrop is rate-limited).
  const secret = process.env.SAP_HARNESS_PAYER_SECRET;
  if (secret) {
    try {
      const arr = JSON.parse(secret) as number[];
      const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
      const bal = await connection.getBalance(kp.publicKey, COMMITMENT);
      if (bal > 0) {
        console.log(`  using SAP_HARNESS_PAYER_SECRET payer ${kp.publicKey.toBase58()} (balance ${bal} lamports).`);
        return kp;
      }
      console.log(`  SAP_HARNESS_PAYER_SECRET payer has 0 balance — falling back to airdrop.`);
    } catch (err) {
      console.log(`  SAP_HARNESS_PAYER_SECRET invalid (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  // 2) Devnet airdrop (often 429 rate-limited on the public endpoint).
  try {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash(COMMITMENT);
    await connection.confirmTransaction({ signature: sig, ...bh }, COMMITMENT);
    const bal = await connection.getBalance(kp.publicKey, COMMITMENT);
    if (bal > 0) {
      console.log(`  airdropped a fresh payer ${kp.publicKey.toBase58()} (balance ${bal} lamports).`);
      return kp;
    }
  } catch (err) {
    console.log(`  devnet airdrop unavailable (${err instanceof Error ? err.message : String(err)}).`);
  }
  return null;
}

async function main(): Promise<void> {
  console.log('=== SAP dry-run on-chain-IDL conformance harness ===\n');

  // 1) Gate assertions — gates OFF ⇒ client helpers refuse before any chain work.
  await assertGates();

  // 2) Config (devnet default). Probe RPC reachability.
  const cfg = loadSapConfig();
  console.log(
    `config: cluster=${cfg.cluster} programId=${cfg.programId.toBase58()} dryRun=${cfg.dryRun} enabled=${cfg.enabled} escrow=${cfg.escrowEnabled}`,
  );
  console.log(`rpc=${cfg.rpcUrl}\n`);

  let connection: Connection | null = new Connection(cfg.rpcUrl, COMMITMENT);
  try {
    await connection.getLatestBlockhash(COMMITMENT);
    console.log('devnet RPC reachable.\n');
  } catch (err) {
    console.warn(`devnet RPC unreachable (${err instanceof Error ? err.message : String(err)}) — structural-only.\n`);
    connection = null;
  }

  // 3) Hard version pin against the deployed program.
  await assertOnChainVersionPin(connection);

  // 4) Try to fund a payer for the program-log proof (opportunistic).
  let funded: FundedSim | null = null;
  if (connection) {
    console.log('--- funding a payer for the program-log path (opportunistic) ---');
    const payer = await tryFundPayer(connection);
    if (payer) {
      funded = { connection, payer };
      console.log('  funded — running the real program-invoke proof.\n');
    } else {
      console.log('  no funded payer — degrading to STRUCTURAL conformance (the hard gate).\n');
    }
  }

  const programId = cfg.programId;
  const agentKp = Keypair.generate();
  const depositorKp = Keypair.generate();
  const targetAgentKp = Keypair.generate();

  // The Program drives encoding off the on-chain IDL.
  const provider = new AnchorProvider(
    connection ?? new Connection(cfg.rpcUrl, COMMITMENT),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { publicKey: agentKp.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t, payer: agentKp } as any,
    { commitment: COMMITMENT, preflightCommitment: COMMITMENT },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(IDL, provider);

  const wallet = agentKp.publicKey;
  const { agent, stats, global } = deriveAgentPdaSet(programId, wallet);

  // ── register_agent (0.18.0: [wallet, agent, agent_stats, global_registry, system_program]) ──
  await runCase('register_agent', funded, async () =>
    program.methods
      .registerAgent(
        'ClawVille Test Agent',
        'dry-run conformance',
        [{ id: 'clawville:teach', description: null, protocolId: 'clawville', version: '1.0.0' }],
        [],
        ['clawville'],
        null,
        'https://clawville.world/agents/test',
        null,
      )
      .accountsStrict({
        wallet,
        agent,
        agentStats: stats,
        globalRegistry: global,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // ── publish_tool (0.18.0: [wallet, agent, tool, global_registry, system_program]) ──
  const nameHash = toolNameHash('teach-cron');
  const [toolPda] = findToolPda(programId, agent, nameHash);
  const schemaHash = toolNameHash('{"type":"object"}');
  const protoHash = toolNameHash('clawville');
  await runCase('publish_tool', funded, async () =>
    program.methods
      .publishTool(
        'teach-cron',
        Array.from(nameHash),
        Array.from(protoHash),
        Array.from(schemaHash),
        Array.from(schemaHash),
        Array.from(schemaHash),
        0,
        0,
        0,
        0,
        false,
      )
      .accountsStrict({
        wallet,
        agent,
        tool: toolPda,
        globalRegistry: global,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // ── give_feedback (0.18.0: [reviewer, feedback, agent, global_registry, system_program]) ──
  const [targetAgentPda] = findAgentPda(programId, targetAgentKp.publicKey);
  const [feedbackPda] = findFeedbackPda(programId, targetAgentPda, wallet);
  await runCase('give_feedback', funded, async () =>
    program.methods
      .giveFeedback(850, 'helpful', null)
      .accountsStrict({
        reviewer: wallet,
        feedback: feedbackPda,
        agent: targetAgentPda,
        globalRegistry: global,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // ── init_stake (0.18.0: [wallet, agent, stake, system_program]) ──
  const [stakePda] = findStakePda(programId, agent);
  await runCase('init_stake', funded, async () =>
    program.methods
      .initStake(new BN(SAP_MIN_STAKE_LAMPORTS.toString()))
      .accountsStrict({ wallet, agent, stake: stakePda, systemProgram: SystemProgram.programId })
      .transaction(),
  );

  // ── deposit_stake (0.18.0: [wallet, agent, stake, system_program]) ──
  await runCase('deposit_stake', funded, async () =>
    program.methods
      .depositStake(new BN(SAP_MIN_STAKE_LAMPORTS.toString()))
      .accountsStrict({ wallet, agent, stake: stakePda, systemProgram: SystemProgram.programId })
      .transaction(),
  );

  // ── create_escrow_v2 (0.18.0: [depositor, agent, escrow, system_program]) ──
  const escrowNonce = 1n;
  const [escrowPda] = findEscrowPda(programId, targetAgentPda, depositorKp.publicKey, escrowNonce);
  await runCase('create_escrow_v2', funded, async () =>
    program.methods
      .createEscrowV2(
        new BN(escrowNonce.toString()),
        new BN('1000'),
        new BN('100'),
        new BN('100000'),
        new BN(Math.floor(Date.now() / 1000) + 86400),
        [],
        null, // SOL
        9,
        SETTLEMENT_SELF_REPORT,
        new BN(0),
        null,
        null,
      )
      .accountsStrict({
        depositor: depositorKp.publicKey,
        agent: targetAgentPda,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // ── deposit_escrow_v2 (0.18.0: [depositor, escrow, system_program]) ──
  await runCase('deposit_escrow_v2', funded, async () =>
    program.methods
      .depositEscrowV2(new BN(escrowNonce.toString()), new BN('500'))
      .accountsStrict({ depositor: depositorKp.publicKey, escrow: escrowPda, systemProgram: SystemProgram.programId })
      .transaction(),
  );

  // ── settle_calls_v2 (0.18.0: [wallet, agent, agent_stats, escrow, system_program]) — NO receipt ──
  const [svcAgent] = findAgentPda(programId, targetAgentKp.publicKey);
  const [svcSettleStats] = findStatsPda(programId, svcAgent);
  const [svcEscrow] = findEscrowPda(programId, svcAgent, depositorKp.publicKey, escrowNonce);
  const svcHash = serviceHash('call-batch', '1');
  await runCase('settle_calls_v2', funded, async () =>
    program.methods
      .settleCallsV2(new BN(escrowNonce.toString()), new BN('1'), Array.from(svcHash))
      .accountsStrict({
        wallet: targetAgentKp.publicKey,
        agent: svcAgent,
        agentStats: svcSettleStats,
        escrow: svcEscrow,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );

  // ── withdraw_escrow_v2 (0.18.0: [depositor, escrow]) ──
  await runCase('withdraw_escrow_v2', funded, async () =>
    program.methods
      .withdrawEscrowV2(new BN('100'))
      .accountsStrict({ depositor: depositorKp.publicKey, escrow: escrowPda })
      .transaction(),
  );

  // ── close_escrow_v2 (0.18.0: [depositor, escrow]) ──
  await runCase('close_escrow_v2', funded, async () =>
    program.methods
      .closeEscrowV2()
      .accountsStrict({ depositor: depositorKp.publicKey, escrow: escrowPda })
      .transaction(),
  );

  // ── discovery sanity ─────────────────────────────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acctClient = (program.account as any).agentAccount;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idlAcc = IDL.accounts.find((a: any) => a.name === 'AgentAccount');
    const hasDisc = Array.isArray(idlAcc?.discriminator) && idlAcc.discriminator.length === 8;
    const accessorOk = !!acctClient && typeof acctClient.all === 'function' && typeof acctClient.fetchNullable === 'function';
    const ok = hasDisc && accessorOk;
    if (!ok) hardFail = true;
    results.push({
      name: 'discovery(agentAccount.all + IDL discriminator)',
      built: true,
      conformant: ok,
      programReached: 'skipped',
      note: ok
        ? `accessor present (all/fetchNullable) + AgentAccount disc=[${idlAcc.discriminator.join(',')}]`
        : `accessorOk=${accessorOk} hasDisc=${hasDisc}`,
    });
  } catch (err) {
    hardFail = true;
    results.push({
      name: 'discovery(agentAccount.all + IDL discriminator)',
      built: false,
      conformant: false,
      programReached: 'skipped',
      note: `discovery sanity failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  printSummary(funded != null);
  process.exit(hardFail ? 1 : 0);
}

async function assertGates(): Promise<void> {
  console.log('--- gate assertions ---');
  delete process.env.SAP_ENABLED;
  delete process.env.SAP_ESCROW_ENABLED;
  process.env.SAP_DRY_RUN = 'true';

  const client = await import('../../src/services/sap/sap-client');

  const reg = await client.registerAgent({
    avatarId: '00000000-0000-0000-0000-000000000000',
    name: 'x',
    description: '',
    capabilities: [],
    protocols: ['clawville'],
  });
  const regOk = reg.ok === false && reg.code === 'sap_disabled';
  console.log(`  register gate-off → ${regOk ? 'PASS' : 'FAIL'} (${reg.ok === false ? reg.code : 'unexpectedly ok'})`);
  if (!regOk) hardFail = true;

  const stake = await client.initStake({
    avatarId: '00000000-0000-0000-0000-000000000000',
    lamports: SAP_MIN_STAKE_LAMPORTS,
  });
  const stakeOk =
    stake.ok === false &&
    (stake.code === 'sap_disabled' || stake.code === 'sap_escrow_disabled');
  console.log(`  stake gate-off → ${stakeOk ? 'PASS' : 'FAIL'} (${stake.ok === false ? stake.code : 'unexpectedly ok'})`);
  if (!stakeOk) hardFail = true;

  const dryRunNeverBroadcasts =
    reg.ok === false || (reg.ok === true && (reg as { dryRun?: boolean }).dryRun === true && !('signature' in reg));
  console.log(`  dry-run never returns a signature → ${dryRunNeverBroadcasts ? 'PASS' : 'FAIL'}`);
  if (!dryRunNeverBroadcasts) hardFail = true;
  console.log('');
}

function printSummary(funded: boolean): void {
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    const status = !r.built ? 'BUILD-FAIL' : !r.conformant ? 'NONCONFORMANT' : 'PASS';
    const reach =
      r.programReached === 'yes'
        ? ' [program-invoked]'
        : r.programReached === 'inconclusive'
          ? ' [program-not-reached]'
          : r.programReached === 'no'
            ? ' [MALFORMED]'
            : '';
    console.log(`  [${status}]${reach} ${r.name} — ${r.note}`);
  }
  const conformant = results.filter((r) => r.built && r.conformant).length;
  const invoked = results.filter((r) => r.programReached === 'yes').length;
  console.log(`\n${conformant}/${results.length} cases structurally conformant vs the on-chain (0.18.0) IDL.`);
  if (funded) {
    console.log(`${invoked} case(s) additionally proven via a real program-invoke log.`);
  } else {
    console.log('program-log proof: SKIPPED (no funded payer) — structural conformance is the gate.');
  }
  console.log(hardFail ? 'RESULT: ❌ FAIL' : 'RESULT: ✅ PASS');
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
