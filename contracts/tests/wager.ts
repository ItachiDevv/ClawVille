/**
 * Comprehensive Mocha+Chai test suite for the clawville-wager Anchor program.
 *
 * Run via: `anchor test` (Anchor.toml `[scripts] test`).
 *
 * Conventions:
 * - Each test uses a unique lobbyId (monotonic counter) so PDAs never collide.
 * - The program's Config PDA is initialized once in the top-level `before` hook;
 *   downstream tests inherit it.
 * - Settlement authority and treasury are FRESH keypairs stored in module-scope
 *   constants — every settle test signs with the same key and asserts against
 *   the same treasury pubkey.
 * - Negative-path expectations match Anchor 0.31's AnchorError shape:
 *   `err.error.errorCode.code` (PascalCase string from `#[error_code]`).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorError } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

import { ClawvilleWager } from "../target/types/clawville_wager";

// ---------------------------------------------------------------------------
// Module-scope provider + program + canonical actors.
// ---------------------------------------------------------------------------
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.ClawvilleWager as Program<ClawvilleWager>;
const connection = provider.connection;

const RAKE_BPS = 500; // 5%

const admin = Keypair.generate();
const settlementAuthority = Keypair.generate();
const gamblingTreasury = Keypair.generate();
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();

let configPda: PublicKey;
let lobbyCounter = 1n;

const nextLobbyId = (): BN => {
  const id = new BN(Date.now()).muln(1000).addn(Number(lobbyCounter));
  lobbyCounter += 1n;
  return id;
};

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
const u64ToLeBytes = (n: BN): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n.toString()));
  return buf;
};

const deriveConfig = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];

const deriveLobby = (lobbyId: BN): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("lobby"), u64ToLeBytes(lobbyId)],
    program.programId,
  )[0];

const deriveVault = (lobbyId: BN): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), u64ToLeBytes(lobbyId)],
    program.programId,
  )[0];

const derivePlayer = (lobbyId: BN, player: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("player"), u64ToLeBytes(lobbyId), player.toBuffer()],
    program.programId,
  )[0];

// ---------------------------------------------------------------------------
// Funding + assertion helpers
// ---------------------------------------------------------------------------
const airdrop = async (pubkey: PublicKey, sol: number): Promise<void> => {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
};

const expectAnchorError = async (
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> => {
  try {
    await fn();
    throw new Error(`expected AnchorError ${code} but call succeeded`);
  } catch (err) {
    if (err instanceof AnchorError) {
      expect(err.error.errorCode.code).to.equal(code);
      return;
    }
    // Anchor sometimes wraps in SendTransactionError; sniff its log lines.
    const msg = (err as Error)?.toString?.() ?? String(err);
    if (msg.includes(code)) return;
    throw err;
  }
};

// Accept any failure (used for double-join PDA-already-exists where Anchor
// surfaces a raw SendTransactionError, not an AnchorError).
const expectAnyFailure = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    throw new Error("expected call to fail but it succeeded");
  } catch (err) {
    const msg = (err as Error)?.toString?.() ?? String(err);
    if (msg === "expected call to fail but it succeeded") throw err;
    // any other thrown value = expected failure
  }
};

// ---------------------------------------------------------------------------
// Lobby creation helpers
// ---------------------------------------------------------------------------
type CreateSolResult = {
  lobbyId: BN;
  lobbyPda: PublicKey;
  vaultPda: PublicKey;
  creatorPlayerPda: PublicKey;
};

const createLobbySol = async (
  creator: Keypair,
  wagerLamports: BN,
  maxPlayers: number,
): Promise<CreateSolResult> => {
  const lobbyId = nextLobbyId();
  const lobbyPda = deriveLobby(lobbyId);
  const vaultPda = deriveVault(lobbyId);
  const creatorPlayerPda = derivePlayer(lobbyId, creator.publicKey);
  await program.methods
    .createLobbySol(lobbyId, wagerLamports, maxPlayers)
    .accountsStrict({
      config: configPda,
      lobby: lobbyPda,
      vault: vaultPda,
      creatorPlayer: creatorPlayerPda,
      creator: creator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator])
    .rpc();
  return { lobbyId, lobbyPda, vaultPda, creatorPlayerPda };
};

const joinLobbySol = async (
  player: Keypair,
  lobbyId: BN,
): Promise<PublicKey> => {
  const playerPda = derivePlayer(lobbyId, player.publicKey);
  await program.methods
    .joinLobbySol()
    .accountsStrict({
      config: configPda,
      lobby: deriveLobby(lobbyId),
      vault: deriveVault(lobbyId),
      player: playerPda,
      playerSigner: player.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([player])
    .rpc();
  return playerPda;
};

const lockLobby = async (lobbyId: BN, signer: Keypair): Promise<void> => {
  await program.methods
    .lockLobby()
    .accountsStrict({
      config: configPda,
      lobby: deriveLobby(lobbyId),
      settlementAuthority: signer.publicKey,
    })
    .signers([signer])
    .rpc();
};

const cancelLobby = async (lobbyId: BN, signer: Keypair): Promise<void> => {
  await program.methods
    .cancelLobby()
    .accountsStrict({
      config: configPda,
      lobby: deriveLobby(lobbyId),
      signer: signer.publicKey,
    })
    .signers([signer])
    .rpc();
};

const settleLobbySol = async (params: {
  lobbyId: BN;
  winner: PublicKey;
  authority: Keypair;
  treasury?: PublicKey;
  creator: PublicKey;
}): Promise<void> => {
  const { lobbyId, winner, authority, creator } = params;
  const treasury = params.treasury ?? gamblingTreasury.publicKey;
  await program.methods
    .settleLobbySol(winner)
    .accountsStrict({
      config: configPda,
      lobby: deriveLobby(lobbyId),
      vault: deriveVault(lobbyId),
      winnerPlayer: derivePlayer(lobbyId, winner),
      settlementAuthority: authority.publicKey,
      winnerAccount: winner,
      treasury,
      creator,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
};

const claimRefundSol = async (
  lobbyId: BN,
  player: Keypair,
  creator: PublicKey,
): Promise<void> => {
  await program.methods
    .claimRefundSol()
    .accountsStrict({
      lobby: deriveLobby(lobbyId),
      vault: deriveVault(lobbyId),
      player: derivePlayer(lobbyId, player.publicKey),
      playerSigner: player.publicKey,
      creator,
      systemProgram: SystemProgram.programId,
    })
    .signers([player])
    .rpc();
};

// ---------------------------------------------------------------------------
// SPL helpers (test-local mint)
// ---------------------------------------------------------------------------
type SplFixture = {
  mint: PublicKey;
  decimals: number;
  fundUserAta: (user: Keypair, amount: bigint) => Promise<PublicKey>;
};

const createSplFixture = async (mintAuthority: Keypair): Promise<SplFixture> => {
  const decimals = 6;
  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    decimals,
  );
  const fundUserAta = async (user: Keypair, amount: bigint): Promise<PublicKey> => {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      mintAuthority,
      mint,
      user.publicKey,
    );
    if (amount > 0n) {
      await mintTo(connection, mintAuthority, mint, ata.address, mintAuthority, amount);
    }
    return ata.address;
  };
  return { mint, decimals, fundUserAta };
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("clawville-wager", () => {
  before(async () => {
    // Fund all actors. Provider wallet pays admin's airdrop fee + initial config.
    await Promise.all([
      airdrop(admin.publicKey, 50),
      airdrop(settlementAuthority.publicKey, 50),
      airdrop(gamblingTreasury.publicKey, 5),
      airdrop(alice.publicKey, 50),
      airdrop(bob.publicKey, 50),
      airdrop(carol.publicKey, 50),
    ]);

    configPda = deriveConfig();

    // Initialize the singleton Config exactly once.
    const existing = await connection.getAccountInfo(configPda);
    if (!existing) {
      await program.methods
        .initializeConfig(RAKE_BPS, settlementAuthority.publicKey, gamblingTreasury.publicKey)
        .accountsStrict({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    }
  });

  // -------------------------------------------------------------------------
  describe("Happy path — SOL wager", () => {
    it("creates, joins x2, locks, settles, payouts and rake match the formula", async () => {
      const wager = new BN(1).mul(new BN(LAMPORTS_PER_SOL)); // 1 SOL
      const { lobbyId, vaultPda } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);
      await joinLobbySol(carol, lobbyId);

      await lockLobby(lobbyId, settlementAuthority);

      const bobBefore = await connection.getBalance(bob.publicKey);
      const treasuryBefore = await connection.getBalance(gamblingTreasury.publicKey);

      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
      });

      const bobAfter = await connection.getBalance(bob.publicKey);
      const treasuryAfter = await connection.getBalance(gamblingTreasury.publicKey);

      const pot = wager.muln(3).toNumber();
      const expectedRake = Math.floor((pot * RAKE_BPS) / 10_000);
      const expectedPayout = pot - expectedRake;

      expect(bobAfter - bobBefore).to.equal(expectedPayout);
      expect(treasuryAfter - treasuryBefore).to.equal(expectedRake);

      // Vault should be drained to 0.
      const vaultLamports = await connection.getBalance(vaultPda);
      expect(vaultLamports).to.equal(0);

      const lobby = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(lobby.state).to.equal(2); // Settled
      expect(lobby.winner.toBase58()).to.equal(bob.publicKey.toBase58());
    });

    it("close_loser_player reclaims rent for a loser", async () => {
      const wager = new BN(LAMPORTS_PER_SOL).divn(10); // 0.1 SOL
      const { lobbyId } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);
      await joinLobbySol(carol, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);
      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
      });

      const carolPlayerPda = derivePlayer(lobbyId, carol.publicKey);
      const before = await connection.getBalance(carol.publicKey);
      const rentBefore = (await connection.getAccountInfo(carolPlayerPda))?.lamports ?? 0;
      expect(rentBefore).to.be.greaterThan(0);

      await program.methods
        .closeLoserPlayer()
        .accountsStrict({
          lobby: deriveLobby(lobbyId),
          player: carolPlayerPda,
          playerSigner: carol.publicKey,
        })
        .signers([carol])
        .rpc();

      const after = await connection.getBalance(carol.publicKey);
      const accountInfo = await connection.getAccountInfo(carolPlayerPda);
      expect(accountInfo).to.equal(null);
      expect(after).to.be.greaterThan(before);
    });
  });

  // -------------------------------------------------------------------------
  describe("Happy path — SPL wager", () => {
    it("creates, joins, locks, settles with correct ATA balances", async () => {
      const fixture = await createSplFixture(admin);
      const wager = new BN(1_000_000); // 1 token at 6 decimals

      // Pre-fund every player ATA with 5 tokens so they can wager.
      const aliceAta = await fixture.fundUserAta(alice, 5_000_000n);
      const bobAta = await fixture.fundUserAta(bob, 5_000_000n);
      const carolAta = await fixture.fundUserAta(carol, 5_000_000n);

      const lobbyId = nextLobbyId();
      const lobbyPda = deriveLobby(lobbyId);
      const vaultPda = deriveVault(lobbyId);
      const vaultAta = await getAssociatedTokenAddress(fixture.mint, vaultPda, true);

      // Create SPL lobby (alice).
      await program.methods
        .createLobbySpl(lobbyId, wager, fixture.mint, 3)
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          creatorPlayer: derivePlayer(lobbyId, alice.publicKey),
          creator: alice.publicKey,
          wagerMintAccount: fixture.mint,
          creatorTokenAccount: aliceAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      // Join bob.
      await program.methods
        .joinLobbySpl()
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          player: derivePlayer(lobbyId, bob.publicKey),
          playerSigner: bob.publicKey,
          wagerMintAccount: fixture.mint,
          playerTokenAccount: bobAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      // Join carol.
      await program.methods
        .joinLobbySpl()
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          player: derivePlayer(lobbyId, carol.publicKey),
          playerSigner: carol.publicKey,
          wagerMintAccount: fixture.mint,
          playerTokenAccount: carolAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();

      const vaultBalance = (await getAccount(connection, vaultAta)).amount;
      expect(vaultBalance.toString()).to.equal((wager.toNumber() * 3).toString());

      await lockLobby(lobbyId, settlementAuthority);

      const winnerAta = await getAssociatedTokenAddress(fixture.mint, bob.publicKey);
      const treasuryAtaAddr = await getAssociatedTokenAddress(
        fixture.mint,
        gamblingTreasury.publicKey,
      );

      const bobBefore = (await getAccount(connection, winnerAta)).amount;

      await program.methods
        .settleLobbySpl(bob.publicKey)
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          winnerPlayer: derivePlayer(lobbyId, bob.publicKey),
          settlementAuthority: settlementAuthority.publicKey,
          winnerAccount: bob.publicKey,
          treasury: gamblingTreasury.publicKey,
          creator: alice.publicKey,
          wagerMintAccount: fixture.mint,
          vaultTokenAccount: vaultAta,
          winnerTokenAccount: winnerAta,
          treasuryTokenAccount: treasuryAtaAddr,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([settlementAuthority])
        .rpc();

      const pot = wager.toNumber() * 3;
      const expectedRake = Math.floor((pot * RAKE_BPS) / 10_000);
      const expectedPayout = pot - expectedRake;

      const bobAfter = (await getAccount(connection, winnerAta)).amount;
      const treasuryAfter = (await getAccount(connection, treasuryAtaAddr)).amount;
      expect((bobAfter - bobBefore).toString()).to.equal(expectedPayout.toString());
      expect(treasuryAfter.toString()).to.equal(expectedRake.toString());

      // Vault ATA closed.
      const vaultAtaInfo = await connection.getAccountInfo(vaultAta);
      expect(vaultAtaInfo).to.equal(null);

      const lobby = await program.account.lobby.fetch(lobbyPda);
      expect(lobby.state).to.equal(2);
      expect(lobby.winner.toBase58()).to.equal(bob.publicKey.toBase58());
    });
  });

  // -------------------------------------------------------------------------
  describe("Happy path — Free lobby", () => {
    it("create + join + lock + settle with no transfers, state transitions correctly", async () => {
      const { lobbyId, vaultPda } = await createLobbySol(alice, new BN(0), 2);
      await joinLobbySol(bob, lobbyId);

      await lockLobby(lobbyId, settlementAuthority);

      const lockedLobby = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(lockedLobby.state).to.equal(1); // Locked

      const bobBefore = await connection.getBalance(bob.publicKey);

      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
      });

      // Free lobby → no payout but vault rent residual goes to creator.
      const bobAfter = await connection.getBalance(bob.publicKey);
      expect(bobAfter).to.equal(bobBefore);

      const settled = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(settled.state).to.equal(2);
      expect(settled.winner.toBase58()).to.equal(bob.publicKey.toBase58());

      const vaultAfter = await connection.getBalance(vaultPda);
      expect(vaultAfter).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Cancel + refund (SOL)", () => {
    it("creator cancels pre-lock; both players refund and recover lamports", async () => {
      const wager = new BN(LAMPORTS_PER_SOL);
      const { lobbyId, vaultPda } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);

      await cancelLobby(lobbyId, alice);

      const lobbyAfterCancel = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(lobbyAfterCancel.state).to.equal(3); // Cancelled

      const aliceBefore = await connection.getBalance(alice.publicKey);
      const bobBefore = await connection.getBalance(bob.publicKey);

      await claimRefundSol(lobbyId, bob, alice.publicKey);
      await claimRefundSol(lobbyId, alice, alice.publicKey);

      const aliceAfter = await connection.getBalance(alice.publicKey);
      const bobAfter = await connection.getBalance(bob.publicKey);
      // Bob's refund = exactly wager + rent of his Player PDA (closed to him).
      expect(bobAfter - bobBefore).to.be.greaterThan(wager.toNumber());
      // Alice gets her wager + her PDA rent + vault rent residual (last refund).
      expect(aliceAfter - aliceBefore).to.be.greaterThan(wager.toNumber());

      // Vault drained.
      const vaultAfter = await connection.getBalance(vaultPda);
      expect(vaultAfter).to.equal(0);

      // Player PDAs closed.
      const aliceP = await connection.getAccountInfo(derivePlayer(lobbyId, alice.publicKey));
      const bobP = await connection.getAccountInfo(derivePlayer(lobbyId, bob.publicKey));
      expect(aliceP).to.equal(null);
      expect(bobP).to.equal(null);
    });

    it("settlement_authority can cancel a Locked lobby and players refund", async () => {
      const wager = new BN(LAMPORTS_PER_SOL).divn(2); // 0.5 SOL
      const { lobbyId } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);

      // Creator alone CANNOT cancel a Locked lobby — would be Unauthorized.
      // Only settlement authority can. Verify the auth-cancel path:
      await cancelLobby(lobbyId, settlementAuthority);
      const lobbyState = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(lobbyState.state).to.equal(3);

      await claimRefundSol(lobbyId, bob, alice.publicKey);
      await claimRefundSol(lobbyId, alice, alice.publicKey);

      const aliceP = await connection.getAccountInfo(derivePlayer(lobbyId, alice.publicKey));
      const bobP = await connection.getAccountInfo(derivePlayer(lobbyId, bob.publicKey));
      expect(aliceP).to.equal(null);
      expect(bobP).to.equal(null);
    });
  });

  // -------------------------------------------------------------------------
  describe("Negative paths", () => {
    it("double-join fails (PDA already in use)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      // alice's creator_player PDA already exists; second join attempt
      // collides on init.
      await expectAnyFailure(() => joinLobbySol(alice, lobbyId));
    });

    // NOTE: Wrong-wager-amount is unexpressible at the client level — the
    // program transfers exactly `lobby.wager_amount` from the player signer
    // via system_program::transfer; the caller cannot override the amount
    // because join_lobby_sol takes no `amount` arg. Documented here per spec.

    it("settle by non-authority fails (Unauthorized)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);

      await expectAnchorError(
        () =>
          program.methods
            .settleLobbySol(bob.publicKey)
            .accountsStrict({
              config: configPda,
              lobby: deriveLobby(lobbyId),
              vault: deriveVault(lobbyId),
              winnerPlayer: derivePlayer(lobbyId, bob.publicKey),
              settlementAuthority: alice.publicKey, // wrong signer
              winnerAccount: bob.publicKey,
              treasury: gamblingTreasury.publicKey,
              creator: alice.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([alice])
            .rpc(),
        "Unauthorized",
      );
    });

    it("lock by non-authority fails (Unauthorized)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      await expectAnchorError(() => lockLobby(lobbyId, alice), "Unauthorized");
    });

    it("settle without lock fails (InvalidLobbyState)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      // No lockLobby — Open state.
      await expectAnchorError(
        () =>
          settleLobbySol({
            lobbyId,
            winner: bob.publicKey,
            authority: settlementAuthority,
            creator: alice.publicKey,
          }),
        "InvalidLobbyState",
      );
    });

    it("settle twice fails (InvalidLobbyState)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);
      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
      });
      await expectAnchorError(
        () =>
          settleLobbySol({
            lobbyId,
            winner: bob.publicKey,
            authority: settlementAuthority,
            creator: alice.publicKey,
          }),
        "InvalidLobbyState",
      );
    });

    it("join after lock fails (InvalidLobbyState)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);
      await expectAnchorError(() => joinLobbySol(carol, lobbyId), "InvalidLobbyState");
    });

    it("lock with too few players fails (NotEnoughPlayers)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      // Only the creator joined automatically; joined_count = 1 < MIN_PLAYERS=2.
      await expectAnchorError(
        () => lockLobby(lobbyId, settlementAuthority),
        "NotEnoughPlayers",
      );
    });

    it("settle to a non-joined player fails", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);

      const stranger = Keypair.generate();
      // Player PDA for `stranger` doesn't exist — Anchor account-not-initialized error.
      await expectAnyFailure(() =>
        settleLobbySol({
          lobbyId,
          winner: stranger.publicKey,
          authority: settlementAuthority,
          creator: alice.publicKey,
        }),
      );
    });

    it("calling join_lobby_spl on a SOL lobby fails (WrongTokenVariant)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      // Build an SPL fixture purely to satisfy the account schema.
      const fixture = await createSplFixture(admin);
      const bobAta = await fixture.fundUserAta(bob, 1_000_000n);
      const vaultAta = await getAssociatedTokenAddress(
        fixture.mint,
        deriveVault(lobbyId),
        true,
      );
      // The vault ATA does not exist for a SOL lobby; the constraint
      // `associated_token::authority = vault` will error before the
      // WrongTokenVariant check. Both are valid failure paths — accept any.
      await expectAnyFailure(() =>
        program.methods
          .joinLobbySpl()
          .accountsStrict({
            config: configPda,
            lobby: deriveLobby(lobbyId),
            vault: deriveVault(lobbyId),
            player: derivePlayer(lobbyId, bob.publicKey),
            playerSigner: bob.publicKey,
            wagerMintAccount: fixture.mint,
            playerTokenAccount: bobAta,
            vaultTokenAccount: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bob])
          .rpc(),
      );
    });

    it("calling join_lobby_sol on an SPL lobby fails (WrongTokenVariant)", async () => {
      const fixture = await createSplFixture(admin);
      const aliceAta = await fixture.fundUserAta(alice, 5_000_000n);

      const lobbyId = nextLobbyId();
      const lobbyPda = deriveLobby(lobbyId);
      const vaultPda = deriveVault(lobbyId);
      const vaultAta = await getAssociatedTokenAddress(fixture.mint, vaultPda, true);

      await program.methods
        .createLobbySpl(lobbyId, new BN(1_000_000), fixture.mint, 3)
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          creatorPlayer: derivePlayer(lobbyId, alice.publicKey),
          creator: alice.publicKey,
          wagerMintAccount: fixture.mint,
          creatorTokenAccount: aliceAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      await expectAnchorError(() => joinLobbySol(bob, lobbyId), "WrongTokenVariant");
    });

    it("cancelled lobby cannot be settled (InvalidLobbyState)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      await cancelLobby(lobbyId, alice);
      // Bob's player PDA still exists (refunded=false); settle preflight will hit
      // the state check first.
      await expectAnchorError(
        () =>
          settleLobbySol({
            lobbyId,
            winner: bob.publicKey,
            authority: settlementAuthority,
            creator: alice.publicKey,
          }),
        "InvalidLobbyState",
      );
    });

    it("refund on a non-cancelled lobby fails (InvalidLobbyState)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      // Open state — refund must reject.
      await expectAnchorError(
        () => claimRefundSol(lobbyId, bob, alice.publicKey),
        "InvalidLobbyState",
      );
    });

    it("close_loser_player by the winner fails (WinnerCannotCloseAsLoser)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 2);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);
      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
      });

      await expectAnchorError(
        () =>
          program.methods
            .closeLoserPlayer()
            .accountsStrict({
              lobby: deriveLobby(lobbyId),
              player: derivePlayer(lobbyId, bob.publicKey),
              playerSigner: bob.publicKey,
            })
            .signers([bob])
            .rpc(),
        "WinnerCannotCloseAsLoser",
      );
    });

    it("paused config blocks create + join, unpausing restores both", async () => {
      // Pause.
      await program.methods
        .updateConfig(null, null, null, true)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      // Create attempt fails.
      const lobbyId = nextLobbyId();
      const lobbyPda = deriveLobby(lobbyId);
      const vaultPda = deriveVault(lobbyId);
      const creatorPlayerPda = derivePlayer(lobbyId, alice.publicKey);
      await expectAnchorError(
        () =>
          program.methods
            .createLobbySol(lobbyId, new BN(LAMPORTS_PER_SOL).divn(10), 2)
            .accountsStrict({
              config: configPda,
              lobby: lobbyPda,
              vault: vaultPda,
              creatorPlayer: creatorPlayerPda,
              creator: alice.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([alice])
            .rpc(),
        "Paused",
      );

      // Unpause and create succeeds.
      await program.methods
        .updateConfig(null, null, null, false)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      const open = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);

      // Pause again, then attempt to join the open lobby — should fail.
      await program.methods
        .updateConfig(null, null, null, true)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      await expectAnchorError(() => joinLobbySol(bob, open.lobbyId), "Paused");

      // Unpause again so subsequent tests are unaffected.
      await program.methods
        .updateConfig(null, null, null, false)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it("cancel_lobby by a third party fails (Unauthorized)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      await joinLobbySol(bob, lobbyId);
      // carol is neither creator nor settlement authority.
      await expectAnchorError(() => cancelLobby(lobbyId, carol), "Unauthorized");
    });

    it("treasury snapshot — admin cannot reroute rake on in-flight lobby", async () => {
      const wager = new BN(LAMPORTS_PER_SOL);
      const { lobbyId } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);
      await lockLobby(lobbyId, settlementAuthority);

      // Admin tries to reroute treasury mid-flight.
      const newTreasury = Keypair.generate();
      await airdrop(newTreasury.publicKey, 1);
      await program.methods
        .updateConfig(null, newTreasury.publicKey, null, null)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      // Settle with the NEW treasury — must fail because the lobby snapshotted
      // the original treasury at create-time.
      await expectAnchorError(
        () =>
          settleLobbySol({
            lobbyId,
            winner: bob.publicKey,
            authority: settlementAuthority,
            creator: alice.publicKey,
            treasury: newTreasury.publicKey,
          }),
        "AccountMismatch",
      );

      // Re-call with the original treasury — succeeds.
      await settleLobbySol({
        lobbyId,
        winner: bob.publicKey,
        authority: settlementAuthority,
        creator: alice.publicKey,
        treasury: gamblingTreasury.publicKey,
      });

      const lobby = await program.account.lobby.fetch(deriveLobby(lobbyId));
      expect(lobby.state).to.equal(2);

      // Restore live config so subsequent tests reading config aren't surprised.
      await program.methods
        .updateConfig(null, gamblingTreasury.publicKey, null, null)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });

  // -------------------------------------------------------------------------
  // Admin-transfer flow. Each test hands admin to a fresh keypair, asserts
  // the previous holder is locked out, then hands admin back to the canonical
  // `admin` keypair so subsequent tests in this suite still have a working
  // admin signer for `updateConfig` etc.
  // -------------------------------------------------------------------------
  describe("Admin transfer", () => {
    it("transferAdmin happy path — old admin loses access", async () => {
      const newAdmin = Keypair.generate();
      await airdrop(newAdmin.publicKey, 5);

      await program.methods
        .transferAdmin(newAdmin.publicKey)
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      const cfg = await program.account.config.fetch(configPda);
      expect(cfg.admin.toBase58()).to.equal(newAdmin.publicKey.toBase58());

      // Old admin attempt now fails.
      await expectAnchorError(
        () =>
          program.methods
            .updateConfig(null, null, null, false)
            .accountsStrict({ config: configPda, admin: admin.publicKey })
            .signers([admin])
            .rpc(),
        "Unauthorized",
      );

      // New admin can mutate config.
      await program.methods
        .updateConfig(null, null, null, false)
        .accountsStrict({ config: configPda, admin: newAdmin.publicKey })
        .signers([newAdmin])
        .rpc();

      // Hand admin back so subsequent suites still work.
      await program.methods
        .transferAdmin(admin.publicKey)
        .accountsStrict({ config: configPda, admin: newAdmin.publicKey })
        .signers([newAdmin])
        .rpc();
    });

    it("transferAdmin by non-admin fails (Unauthorized)", async () => {
      await expectAnchorError(
        () =>
          program.methods
            .transferAdmin(bob.publicKey)
            .accountsStrict({ config: configPda, admin: bob.publicKey })
            .signers([bob])
            .rpc(),
        "Unauthorized",
      );
    });
  });

  // -------------------------------------------------------------------------
  // cleanup_cancelled_lobby_sol — happy path requires mid-test clock warping
  // which vanilla `solana-test-validator` does not expose to a running test
  // process. We assert the negative (too-soon) path here and skip the
  // happy-path test with a documented comment so an auditor can spot it.
  // The `it.skip` body is the exact sequence to run if the validator gains
  // a warp helper later.
  // -------------------------------------------------------------------------
  describe("cleanup_cancelled_lobby (SOL)", () => {
    const cleanupSol = async (
      lobbyId: BN,
      creator: Keypair,
      treasury: PublicKey = gamblingTreasury.publicKey,
    ): Promise<void> => {
      await program.methods
        .cleanupCancelledLobbySol()
        .accountsStrict({
          lobby: deriveLobby(lobbyId),
          vault: deriveVault(lobbyId),
          creator: creator.publicKey,
          treasury,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    };

    it("rejects cleanup before grace period (GracePeriodNotElapsed)", async () => {
      const wager = new BN(LAMPORTS_PER_SOL).divn(4);
      const { lobbyId } = await createLobbySol(alice, wager, 3);
      await joinLobbySol(bob, lobbyId);
      await cancelLobby(lobbyId, alice);

      // bob abandons (never claims refund).
      await expectAnchorError(() => cleanupSol(lobbyId, alice), "GracePeriodNotElapsed");
    });

    it("rejects cleanup with wrong treasury (AccountMismatch)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(8), 3);
      await joinLobbySol(bob, lobbyId);
      await cancelLobby(lobbyId, alice);
      const wrongTreasury = Keypair.generate().publicKey;
      // Wrong-treasury constraint fires regardless of whether the grace
      // period has elapsed — it's an account-validation failure, not a
      // handler-body check.
      await expectAnchorError(
        () => cleanupSol(lobbyId, alice, wrongTreasury),
        "AccountMismatch",
      );
    });

    it.skip("happy path — see tests/wager-litesvm.ts for clock-warped coverage", async () => {
      // Anchor's solana-test-validator harness can't warp the cluster clock
      // mid-test, so the happy-path coverage for cleanup lives in the
      // LiteSVM file (`bun run test:litesvm`). The intended sequence is
      // documented there. Kept as `it.skip` here so the test list still
      // signals the gap to readers.
    });

    it("rejects cleanup by non-creator (Unauthorized)", async () => {
      const { lobbyId } = await createLobbySol(alice, new BN(LAMPORTS_PER_SOL).divn(10), 3);
      await joinLobbySol(bob, lobbyId);
      await cancelLobby(lobbyId, alice);
      // bob is not the creator.
      await expectAnchorError(() => cleanupSol(lobbyId, bob), "Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  describe("cleanup_cancelled_lobby (SPL)", () => {
    it("rejects cleanup with wrong treasury (AccountMismatch)", async () => {
      const fixture = await createSplFixture(admin);
      const aliceAta = await fixture.fundUserAta(alice, 5_000_000n);
      await fixture.fundUserAta(bob, 5_000_000n);

      const lobbyId = nextLobbyId();
      const lobbyPda = deriveLobby(lobbyId);
      const vaultPda = deriveVault(lobbyId);
      const vaultAta = await getAssociatedTokenAddress(fixture.mint, vaultPda, true);

      await program.methods
        .createLobbySpl(lobbyId, new BN(1_000_000), fixture.mint, 3)
        .accountsStrict({
          config: configPda,
          lobby: lobbyPda,
          vault: vaultPda,
          creatorPlayer: derivePlayer(lobbyId, alice.publicKey),
          creator: alice.publicKey,
          wagerMintAccount: fixture.mint,
          creatorTokenAccount: aliceAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      await cancelLobby(lobbyId, alice);

      const wrongTreasury = Keypair.generate().publicKey;
      const wrongTreasuryAta = await getAssociatedTokenAddress(
        fixture.mint,
        wrongTreasury,
      );

      await expectAnchorError(
        () =>
          program.methods
            .cleanupCancelledLobbySpl()
            .accountsStrict({
              lobby: lobbyPda,
              vault: vaultPda,
              creator: alice.publicKey,
              wagerMintAccount: fixture.mint,
              vaultTokenAccount: vaultAta,
              treasury: wrongTreasury,
              treasuryTokenAccount: wrongTreasuryAta,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([alice])
            .rpc(),
        "AccountMismatch",
      );
    });

    it.skip("happy path — see tests/wager-litesvm.ts for clock-warped coverage", async () => {
      // See SOL variant note above. SPL clock-warp coverage lives in the
      // LiteSVM file because solana-test-validator can't be warped mid-run.
    });
  });
});
