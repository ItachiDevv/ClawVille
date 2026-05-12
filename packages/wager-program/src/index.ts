/**
 * @clawville/wager-program
 *
 * Type-only + PDA-helper surface for the deployed `clawville_wager` Anchor
 * program. The IDL JSON and the corresponding camelCase IDL TS type are
 * committed in this package so downstream consumers (apps/api, scripts, FE
 * stubs) NEVER reach into the gambling-contracts worktree's gitignored
 * `target/` directory.
 *
 * Deployed devnet program (locked):
 *   address       : HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG
 *   config PDA    : AbvtPhFtbQNQ9oT8vQumPEWDowRXibtPeLpmDvTz5i2a
 *   rake_bps      : 500   (5 %)
 *   admin / settlement_authority / treasury :
 *                   G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy
 *
 * PDA seed schema (matches contracts/programs/clawville-wager/src/instructions/*):
 *   config  : [b"config"]
 *   lobby   : [b"lobby",  &lobby_id.to_le_bytes()[..]]            // u64 LE
 *   vault   : [b"vault",  &lobby_id.to_le_bytes()[..]]            // u64 LE
 *   player  : [b"player", &lobby_id.to_le_bytes()[..], player_pubkey]
 *
 * `lobby_id` is `u64` on-chain. We accept `bigint` for the helpers so callers
 * can use sequence-issued bigints without coercion, and we serialize via an
 * 8-byte little-endian buffer with overflow checks.
 */

import { PublicKey } from '@solana/web3.js';

import idlJson from './clawville-wager-idl.json' with { type: 'json' };
import type { ClawvilleWager as ClawvilleWagerType } from './clawville-wager-type.js';

/**
 * Deployed program id (devnet). The same id is baked into:
 *   - contracts/programs/clawville-wager/src/lib.rs `declare_id!`
 *   - target/idl/clawville_wager.json "address"
 *   - target/types/clawville_wager.ts "address"
 *   - this constant
 *
 * Verify on chain explorer:
 *   https://explorer.solana.com/address/HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG?cluster=devnet
 */
export const PROGRAM_ID = new PublicKey(
  'HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG',
);

/**
 * Solana cluster the wager program lives on. Default `devnet` matches the
 * deployed program. Override via `WAGER_PROGRAM_CLUSTER` env in consumers
 * that need to point at localnet for tests; mainnet wiring is intentionally
 * blocked behind a separate audit (no env override unlocks it).
 */
export type WagerCluster = 'devnet' | 'localnet';
export const CLUSTER: WagerCluster =
  (process.env.WAGER_PROGRAM_CLUSTER as WagerCluster | undefined) === 'localnet'
    ? 'localnet'
    : 'devnet';

/** Raw IDL JSON — exported for Anchor `new Program(idl, provider)`. */
export const IDL = idlJson as unknown as ClawvilleWagerType;

/**
 * Anchor-generated camelCase type alias. Use as the generic to
 * `Program<ClawvilleWager>` so all `program.methods.*` get typed.
 */
export type ClawvilleWager = ClawvilleWagerType;

/**
 * Cross-runtime conversion of a bigint lobby id to its little-endian
 * 8-byte buffer, matching the Anchor `u64.to_le_bytes()` seed. Throws on
 * overflow / negative values so we fail at PDA derivation time instead of
 * later at chain submission with a cryptic seed-mismatch error.
 */
function lobbyIdToLeBytes(lobbyId: bigint): Buffer {
  if (lobbyId < 0n) {
    throw new RangeError(`lobby_id must be non-negative, got ${lobbyId}`);
  }
  if (lobbyId > 0xffffffffffffffffn) {
    throw new RangeError(`lobby_id ${lobbyId} exceeds u64 max`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(lobbyId, 0);
  return buf;
}

/** [b"config"] singleton PDA. */
export function findConfigPda(programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
}

/** [b"lobby", lobby_id_le_8] — one Lobby account per lobby_id. */
export function findLobbyPda(
  lobbyId: bigint,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lobby'), lobbyIdToLeBytes(lobbyId)],
    programId,
  );
}

/** [b"vault", lobby_id_le_8] — SOL/SPL escrow PDA. */
export function findVaultPda(
  lobbyId: bigint,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), lobbyIdToLeBytes(lobbyId)],
    programId,
  );
}

/** [b"player", lobby_id_le_8, player_pubkey] — per-player deposit witness. */
export function findPlayerPda(
  lobbyId: bigint,
  player: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player'), lobbyIdToLeBytes(lobbyId), player.toBuffer()],
    programId,
  );
}

/**
 * Devnet config PDA constant, useful for sanity checks against the
 * computed value at boot time. Both the test and the script that
 * initialized the program logged this address.
 */
export const DEVNET_CONFIG_PDA = new PublicKey(
  'AbvtPhFtbQNQ9oT8vQumPEWDowRXibtPeLpmDvTz5i2a',
);

/**
 * Default settlement authority pubkey on devnet (matches deployer). The API
 * verifies that the decrypted settlement-authority keypair matches this
 * value (or the env-override `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`) before
 * accepting any settle/lock call.
 */
export const DEVNET_DEFAULT_SETTLEMENT_AUTHORITY = new PublicKey(
  'G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy',
);

/** On-chain rake constant — kept here so the FE can preview payout splits without an RPC call. */
export const DEFAULT_RAKE_BPS = 500; // 5 %
