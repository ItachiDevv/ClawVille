/**
 * Idempotently provision the dedicated SAP bounty gas sponsor wallet.
 *
 * Run from apps/api:
 *   bun run scripts/sap/provision-gas-wallet.ts
 *
 * Prints only the public funding address and its current SOL balance. Secret
 * bytes are encrypted immediately under VANITY_ENCRYPTION_KEY and never logged.
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../../../.env.local") });

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { db, eq, treasuryWallets } from "@clawville/database";
import { encryptSecretKey } from "../../src/services/keypair-vault";
import { loadSapConfig } from "../../src/services/sap/sap-config";

async function main(): Promise<void> {
  if (!process.env.VANITY_ENCRYPTION_KEY) {
    throw new Error(
      "VANITY_ENCRYPTION_KEY is required to provision the gas wallet",
    );
  }

  const [existing] = await db
    .select({ id: treasuryWallets.id, publicKey: treasuryWallets.publicKey })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.purpose, "sap-gas-sponsor"))
    .limit(1);

  let row = existing;
  if (!row) {
    const keypair = Keypair.generate();
    const encrypted = encryptSecretKey(keypair.secretKey);
    [row] = await db
      .insert(treasuryWallets)
      .values({
        purpose: "sap-gas-sponsor",
        publicKey: keypair.publicKey.toBase58(),
        encryptedSecretKey: encrypted.encryptedSecretKey,
        encryptionIv: encrypted.encryptionIv,
        encryptionTag: encrypted.encryptionTag,
        notes:
          "Dedicated SOL sponsor for composed-bounty SAP settle/finalize gas",
      })
      .returning({
        id: treasuryWallets.id,
        publicKey: treasuryWallets.publicKey,
      });
    console.log("[sap-gas-sponsor] Created dedicated treasury wallet.");
  } else {
    console.log("[sap-gas-sponsor] Existing dedicated treasury wallet found.");
  }

  const connection = new Connection(loadSapConfig().rpcUrl, "confirmed");
  const balanceLamports = await connection.getBalance(
    new PublicKey(row.publicKey),
    "confirmed",
  );
  console.log(`Public key to fund: ${row.publicKey}`);
  console.log(
    `Current balance: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`,
  );
}

main().catch((err) => {
  console.error(
    "[sap-gas-sponsor] Provisioning failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
