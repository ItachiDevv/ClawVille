/**
 * READ-ONLY diagnostic: fetch the SAP program's on-chain IDL from BOTH devnet and
 * mainnet and diff the version + the escrow/settlement account contexts. Answers
 * the open question from docs/sap-covenant-payai-architecture.md §5.1: does the
 * DEPLOYED program enforce CoSigned (co_signer account on settle_calls_v2)? Devnet
 * is 0.18.0 (no co_signer); the Covenant dev says it works on mainnet too — so
 * mainnet may be a newer (0.25.0) deployment.
 *
 * NO writes, NO signing, NO config load (so the FIX-D mainnet-RPC guard isn't hit).
 * Run: cd apps/api && bunx tsx scripts/sap/compare-clusters-idl.ts
 */

import { Connection, Keypair, PublicKey, type Commitment } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';

const PROGRAM_ID = new PublicKey('SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ');
const COMMITMENT: Commitment = 'confirmed';
const CLUSTERS: Record<string, string> = {
  devnet: process.env.SAP_DEVNET_RPC ?? 'https://api.devnet.solana.com',
  mainnet: process.env.SAP_MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com',
};
// The instructions whose account context decides the Covenant CoSigned model.
const FOCUS = ['create_escrow_v2', 'settle_calls_v2', 'create_attestation', 'register_agent'];

function placeholderProvider(connection: Connection) {
  const kp = Keypair.generate();
  return new AnchorProvider(
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { publicKey: kp.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t, payer: kp } as any,
    { commitment: COMMITMENT },
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function acctLine(a: any): string {
  const flags = [a.signer ? 'S' : '', a.writable ? 'W' : '', a.pda ? 'pda' : ''].filter(Boolean).join('/');
  return `${a.name}${flags ? `(${flags})` : ''}`;
}

async function main() {
  for (const [cluster, rpc] of Object.entries(CLUSTERS)) {
    console.log(`\n========== ${cluster.toUpperCase()}  (${rpc}) ==========`);
    try {
      const idl = await Program.fetchIdl(PROGRAM_ID, placeholderProvider(new Connection(rpc, COMMITMENT)));
      if (!idl) { console.log('  NO on-chain IDL at this program on this cluster.'); continue; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const x = idl as any;
      console.log(`  metadata.version = ${x.metadata?.version ?? '(none)'} · instructions=${(x.instructions ?? []).length}`);
      for (const name of FOCUS) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ix = (x.instructions ?? []).find((i: any) => i.name === name);
        if (!ix) { console.log(`  • ${name}: NOT PRESENT`); continue; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accts = (ix.accounts ?? []).map(acctLine).join(', ');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = (ix.args ?? []).map((a: any) => `${a.name}:${typeof a.type === 'string' ? a.type : JSON.stringify(a.type)}`).join(', ');
        const hasCoSigner = JSON.stringify(ix).includes('co_signer') || JSON.stringify(ix).includes('coSigner');
        const hasReceipt = (ix.accounts ?? []).some((a: { name?: string }) => /receipt/i.test(a.name ?? ''));
        console.log(`  • ${name}: [${accts}]`);
        if (name === 'create_escrow_v2') console.log(`      args mention co_signer? ${hasCoSigner}`);
        if (name === 'settle_calls_v2') console.log(`      has receipt account? ${hasReceipt}`);
      }
    } catch (err) {
      console.log(`  fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('\n(read-only — no writes, no signing)');
}

main().catch((e) => { console.error(e); process.exit(1); });
