/**
 * LIGHT devnet smoke — a REAL on-chain proof of the SAP "identity + attestation"
 * rung against the deployed devnet program (0.18.0). Uses THROWAWAY keypairs +
 * devnet airdrop — NO DB, NO keypair-vault, NO real agent keys, NO prod. It
 * mirrors sap-client.ts's EXACT account construction (the same on-chain IDL +
 * sap-pdas derivations the shipped client uses), so a green run proves the
 * deployed program ACCEPTS + CONFIRMS our register_agent + create_attestation and
 * the PDAs are readable — beyond the simulate-level conformance harness.
 *
 * Run: cd apps/api && SAP_SMOKE=1 bunx tsx scripts/sap/light-devnet-smoke.ts
 * (devnet airdrop is rate-limited; on 429 it reports the blocker, not a failure.)
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, type Commitment,
} from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import idlJson from '../../src/services/sap/synapse_agent_sap.onchain.idl.json' with { type: 'json' };
import { deriveAgentPdaSet, findGlobalPda, findAttestationPda } from '../../src/services/sap/sap-pdas';

const RPC = process.env.SAP_DEVNET_RPC ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IDL = idlJson as any;
const PROGRAM_ID = new PublicKey(IDL.address);

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

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, COMMITMENT);
      return true;
    } catch (err) {
      console.log(`  airdrop attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

async function registerAgent(program: Program, connection: Connection, kp: Keypair, name: string): Promise<string> {
  const { agent, stats, global } = deriveAgentPdaSet(PROGRAM_ID, kp.publicKey);
  const tx: Transaction = await program.methods
    .registerAgent(name, 'ClawVille SAP Light devnet smoke', [], [], ['clawville'], null, null, null)
    .accountsStrict({ wallet: kp.publicKey, agent, agentStats: stats, globalRegistry: global, systemProgram: SystemProgram.programId })
    .transaction();
  return sendAndConfirmTransaction(connection, tx, [kp], { commitment: COMMITMENT });
}

async function main() {
  console.log(`SAP LIGHT devnet smoke · program ${PROGRAM_ID.toBase58()} · ${RPC.split('?')[0]}`);
  console.log(`on-chain IDL version = ${IDL.metadata?.version}\n`);
  const connection = new Connection(RPC, COMMITMENT);
  const program = placeholderProgram(connection);

  const A = Keypair.generate(); // attester
  const B = Keypair.generate(); // subject
  console.log(`attester A = ${A.publicKey.toBase58()}`);
  console.log(`subject  B = ${B.publicKey.toBase58()}\n`);

  console.log('1) airdrop 1 SOL → A (devnet faucet, rate-limited) ...');
  if (!(await airdrop(connection, A.publicKey, 1))) {
    console.log('\n❌ BLOCKED: devnet airdrop unavailable (faucet rate-limit). The simulate-level');
    console.log('   conformance harness (13/13 vs the live program) + the cluster-IDL diff stand;');
    console.log('   re-run when the faucet is available, or pass a pre-funded SAP_SMOKE_PAYER.');
    process.exit(3);
  }
  console.log(`   A balance = ${(await connection.getBalance(A.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  console.log('2) A → B transfer 0.2 SOL (so B can pay its own register rent) ...');
  const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL }));
  await sendAndConfirmTransaction(connection, fund, [A], { commitment: COMMITMENT });

  console.log('3) register_agent(A) ...');
  const sigA = await registerAgent(program, connection, A, 'ClawVille-Smoke-A');
  console.log(`   ✅ ${sigA}`);
  console.log('4) register_agent(B) ...');
  const sigB = await registerAgent(program, connection, B, 'ClawVille-Smoke-B');
  console.log(`   ✅ ${sigB}`);

  console.log('5) create_attestation(A → B) ...');
  const { agent: agentB } = deriveAgentPdaSet(PROGRAM_ID, B.publicKey);
  const { agent: agentA } = deriveAgentPdaSet(PROGRAM_ID, A.publicKey);
  const [global] = findGlobalPda(PROGRAM_ID);
  const [attestation] = findAttestationPda(PROGRAM_ID, agentB, A.publicKey);
  const attTx: Transaction = await program.methods
    .createAttestation('clawville-smoke', Array.from(Buffer.alloc(32)), new BN(0))
    .accountsStrict({ attester: A.publicKey, agent: agentB, attestation, globalRegistry: global, systemProgram: SystemProgram.programId })
    .transaction();
  const sigAtt = await sendAndConfirmTransaction(connection, attTx, [A], { commitment: COMMITMENT });
  console.log(`   ✅ ${sigAtt}`);

  console.log('\n6) READ BACK on-chain state:');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;
  const aData = await acct.agentAccount.fetch(agentA);
  const bData = await acct.agentAccount.fetch(agentB);
  console.log(`   AgentAccount(A) name="${aData.name}" wallet=${(aData.wallet ?? aData.authority ?? '').toString()}`);
  console.log(`   AgentAccount(B) name="${bData.name}" reputationFeedbacks/attestations present=${'totalAttestations' in bData || 'attestationCount' in bData}`);
  const attData = await acct.agentAttestation.fetch(attestation);
  console.log(`   AgentAttestation type="${attData.attestationType}" agent=${attData.agent?.toString?.()} attester=${attData.attester?.toString?.()}`);

  console.log('\n✅ LIGHT SMOKE PASSED — register_agent (×2) + create_attestation CONFIRMED on devnet; PDAs readable.');
  console.log(`   explorer: https://explorer.solana.com/address/${agentA.toBase58()}?cluster=devnet`);
}

main().catch((e) => { console.error('\n❌ smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });
