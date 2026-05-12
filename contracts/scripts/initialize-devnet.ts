/**
 * One-shot devnet initialization for clawville_wager.
 * Calls `initialize_config(rake_bps=500, settlement_authority=deployer, gambling_treasury=deployer)`.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   node --import tsx scripts/initialize-devnet.ts
 *
 * Reads program id from target/idl/clawville_wager.json.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlPath = resolve(__dirname, "..", "target", "idl", "clawville_wager.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));
  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );

  // Idempotency: if config already exists, dump current state and exit.
  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    const config = await program.account.config.fetch(configPda);
    console.log("Config already initialized:");
    console.log(`  pda                  : ${configPda.toBase58()}`);
    console.log(`  admin                : ${config.admin.toBase58()}`);
    console.log(`  settlement_authority : ${config.settlementAuthority.toBase58()}`);
    console.log(`  gambling_treasury    : ${config.gamblingTreasury.toBase58()}`);
    console.log(`  rake_bps             : ${config.rakeBps}`);
    console.log(`  paused               : ${config.paused}`);
    return;
  }

  const RAKE_BPS = 500; // 5% — matches user spec
  const deployer = provider.wallet.publicKey;

  console.log("Initializing config:");
  console.log(`  program id           : ${programId.toBase58()}`);
  console.log(`  config pda           : ${configPda.toBase58()} (bump ${configBump})`);
  console.log(`  admin (deployer)     : ${deployer.toBase58()}`);
  console.log(`  settlement_authority : ${deployer.toBase58()} (rotate via update_config in prod)`);
  console.log(`  gambling_treasury    : ${deployer.toBase58()} (rotate via update_config in prod)`);
  console.log(`  rake_bps             : ${RAKE_BPS}`);

  const sig = await program.methods
    .initializeConfig(RAKE_BPS, deployer, deployer)
    .accounts({
      admin: deployer,
    })
    .rpc();

  console.log(`\nInitialized in tx: ${sig}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
