/**
 * Anchor program client for `clawville_wager` (concern 3 of the
 * gambling-contracts vertical slice).
 *
 * Responsibilities:
 *   1. Cold-boot loads the settlement-authority Keypair by decrypting the
 *      `treasury_wallets` row with `purpose='wager-settlement-authority'`.
 *      Hard-fails boot if the row is missing — operators must run
 *      `scripts/seed-wager-settlement-authority.ts` first.
 *   2. Wraps `program.methods.*` calls for the SOL-only instructions the
 *      backend issues: create / join / lock / settle / cancel / refund.
 *   3. Persists Anchor logs back to `lobby_events` (decoded event payload
 *      when available, else just the signature + null event).
 *   4. Loads avatar Keypairs on demand by decrypting the matching `wallets`
 *      row via the existing CF KEK / VANITY_ENCRYPTION_KEY pipeline.
 *
 * What this module DOES NOT do:
 *   - SPL flows — instructions exist on-chain but the Hono route gate
 *     keeps them off the FE for now (see routes/wager.ts FEATURE_GATE).
 *   - solo-bots — the FE creates these lobbies with `mode='solo-bots'` and
 *     the route bypasses this client entirely. No on-chain footprint.
 *   - Bot avatars — bots don't own custodial wallets, so the routes filter
 *     them out before calling `joinSolLobby`.
 *
 * Module-scope state:
 *   - `connection` (Solana RPC) — one Connection per process; HTTP-level
 *     keepalive is handled by web3.js internally.
 *   - `settlementAuthority` (Keypair) — cached after first call to
 *     `getSettlementAuthority()`. Re-fetch is cheap (DB + CF Worker) but
 *     unnecessary; the row is immutable until manual rotation.
 *   - `cachedProgram` — Anchor `Program<ClawvilleWager>` bound to the
 *     settlement-authority signer (acts as fee payer for lock/settle/
 *     authority-cancel).
 *
 * Failure modes:
 *   - RPC down → throws a tagged Error("wager_rpc_unreachable") so the
 *     route can return 503 instead of 500.
 *   - Already-in-target-state → returns a tagged Error("wager_state_noop")
 *     so the route can return 409 instead of 500.
 *   - Anchor program error (Unauthorized, InvalidLobbyState, etc.) → the
 *     AnchorError code surfaces in `err.error.errorCode.code`; callers
 *     pass it through unchanged.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type Commitment,
} from '@solana/web3.js';
import {
  AnchorProvider,
  BN,
  Program,
  AnchorError,
} from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/esm/nodewallet.js';
import {
  IDL,
  PROGRAM_ID,
  findConfigPda,
  findLobbyPda,
  findPlayerPda,
  findVaultPda,
  DEVNET_DEFAULT_SETTLEMENT_AUTHORITY,
  type ClawvilleWager,
} from '@clawville/wager-program';
import {
  db,
  eq,
  and,
  treasuryWallets,
  wallets,
  avatars,
  lobbies,
  lobbyEvents,
  type LobbyEventKind,
} from '@clawville/database';
import { decryptSecretKey, decryptWalletRow } from './keypair-vault';

// ─── module-scope singletons ──────────────────────────────────────────────

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';

const connection = new Connection(RPC_URL, COMMITMENT);

// Heuristic pre-check buffer for createLobbySol: the instruction rent-funds the
// lobby + vault + creatorPlayer accounts (~2.16M lamports each observed on-chain)
// plus the tx fee, with margin. NOT authoritative — the on-chain program is the
// final word (any shortfall still surfaces via withChainErrors → on_chain_error);
// this only lets an UNFUNDED custodial wallet fail fast with a clean 4xx +
// helpful message instead of a raw simulation error that pages as critical.
// ~0.0065 SOL.
const LOBBY_CREATE_RENT_FEE_BUFFER_LAMPORTS = 6_500_000n;

let settlementAuthorityCache: Keypair | null = null;
let programCache: Program<ClawvilleWager> | null = null;

/**
 * Tagged error so the Hono route layer can pattern-match on the message
 * and choose the right HTTP status without losing stack context.
 */
export class WagerClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'rpc_unreachable'
      | 'state_noop'
      | 'authority_missing'
      | 'avatar_wallet_missing'
      | 'pubkey_mismatch'
      | 'on_chain_error'
      | 'insufficient_funds',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WagerClientError';
  }
}

// ─── settlement authority loading ─────────────────────────────────────────

async function loadSettlementAuthority(): Promise<Keypair> {
  if (settlementAuthorityCache) return settlementAuthorityCache;

  const row = await db.query.treasuryWallets.findFirst({
    where: eq(treasuryWallets.purpose, 'wager-settlement-authority'),
  });
  if (!row) {
    throw new WagerClientError(
      `treasury_wallets row with purpose='wager-settlement-authority' not found. ` +
        `Run bun run scripts/seed-wager-settlement-authority.ts first.`,
      'authority_missing',
    );
  }

  const keypair = decryptSecretKey(
    row.encryptedSecretKey,
    row.encryptionIv,
    row.encryptionTag,
  );

  // Defense-in-depth: verify the decrypted pubkey matches the env-pinned or
  // devnet-default value. Mismatch ⇒ refuse to sign anything; operator must
  // re-seed or roll back the env override.
  const expected =
    process.env.WAGER_SETTLEMENT_AUTHORITY_PUBKEY?.trim() ||
    DEVNET_DEFAULT_SETTLEMENT_AUTHORITY.toBase58();

  if (keypair.publicKey.toBase58() !== expected) {
    throw new WagerClientError(
      `Settlement-authority pubkey mismatch. DB row: ${keypair.publicKey.toBase58()}, ` +
        `expected: ${expected}. Refusing to sign — re-seed or fix WAGER_SETTLEMENT_AUTHORITY_PUBKEY.`,
      'pubkey_mismatch',
    );
  }

  settlementAuthorityCache = keypair;
  return keypair;
}

async function getProgram(): Promise<Program<ClawvilleWager>> {
  if (programCache) return programCache;
  const authority = await loadSettlementAuthority();
  const provider = new AnchorProvider(connection, new NodeWallet(authority), {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });
  // Anchor 0.31 — IDL has `.address`; passing it as `programId` is optional
  // because Program reads address off the IDL itself.
  programCache = new Program<ClawvilleWager>(
    IDL as ClawvilleWager,
    provider,
  ) as Program<ClawvilleWager>;
  return programCache;
}

/** Idempotently warm the cache on cold boot. Call from index.ts. */
export async function preloadWagerProgram(): Promise<void> {
  await getProgram();
}

/** Get the settlement-authority pubkey without exposing the secret. */
export async function getSettlementAuthorityPubkey(): Promise<PublicKey> {
  const kp = await loadSettlementAuthority();
  return kp.publicKey;
}

// ─── avatar wallet loading ────────────────────────────────────────────────

interface AvatarWalletHandle {
  keypair: Keypair;
  publicKey: PublicKey;
  avatarId: string;
}

async function loadAvatarWallet(avatarId: string): Promise<AvatarWalletHandle> {
  const row = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
  });
  if (!row) {
    throw new WagerClientError(
      `Avatar ${avatarId} has no wallet row. Ensure the avatar was created via ensureWallet().`,
      'avatar_wallet_missing',
    );
  }
  const keypair = await decryptWalletRow(row);
  return { keypair, publicKey: keypair.publicKey, avatarId };
}

// ─── event persistence helper ─────────────────────────────────────────────

interface PersistedEventInput {
  lobbyRowId: string;
  kind: LobbyEventKind;
  actorUserId?: string | null;
  txSig?: string | null;
  rawEvent?: Record<string, unknown> | null;
}

async function persistLobbyEvent(input: PersistedEventInput): Promise<void> {
  try {
    await db.insert(lobbyEvents).values({
      lobbyId: input.lobbyRowId,
      kind: input.kind,
      actorUserId: input.actorUserId ?? null,
      txSig: input.txSig ?? null,
      rawEventJson: input.rawEvent ?? null,
    });
  } catch (err) {
    // Never let event-log failure break a settled transaction — log loudly
    // and move on. The on-chain state is authoritative anyway.
    console.error('[wager-client] persistLobbyEvent failed:', err);
  }
}

/**
 * Resolve the lobbies.id row for an on-chain lobby_id bigint. Used by event
 * persistence after a chain call so we can attribute the event to a row.
 * Returns null if the row doesn't exist (e.g. a manual chain-level interaction
 * we never logged off-chain).
 */
async function resolveLobbyRowId(lobbyIdBigint: bigint): Promise<string | null> {
  const row = await db.query.lobbies.findFirst({
    where: eq(lobbies.lobbyId, lobbyIdBigint),
    columns: { id: true },
  });
  return row?.id ?? null;
}

// ─── shared error wrapper ─────────────────────────────────────────────────

async function withChainErrors<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AnchorError) {
      // Bubble the Anchor error code through — route layer pattern-matches.
      throw new WagerClientError(
        `Anchor ${label} failed: ${err.error.errorCode.code} (${err.error.errorMessage})`,
        'on_chain_error',
        err,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('failed to send')
    ) {
      throw new WagerClientError(
        `RPC unreachable during ${label}: ${msg}`,
        'rpc_unreachable',
        err,
      );
    }
    // On-chain transaction / simulation failures (web3.js SendTransactionError,
    // program custom errors, insufficient lamports) are NOT AnchorErrors, so they
    // previously escaped raw → uncaught 500 + critical page. Wrap them as
    // 'on_chain_error' so the route maps them to a clean 400.
    if (
      msg.includes('Simulation failed') ||
      msg.includes('Transaction simulation failed') ||
      msg.includes('custom program error') ||
      msg.includes('insufficient lamports') ||
      msg.includes('SendTransactionError') ||
      (err as { name?: string } | null)?.name === 'SendTransactionError'
    ) {
      // Observability: this no longer pages as an uncaught 500, but a non-Anchor
      // on-chain failure on an ADMIN path (settle/lock) — e.g. the settlement
      // authority running out of SOL — is a real operational incident. Log it so
      // it stays visible in container logs even though the caller gets a clean 400.
      // (User insufficient-funds on create is caught earlier by the balance gate,
      // so this branch is NOT hit by that common case — no log spam.)
      console.error(`[wager] on-chain ${label} failed (→ on_chain_error / 400): ${msg}`);
      throw new WagerClientError(
        `On-chain ${label} failed: ${msg}`,
        'on_chain_error',
        err,
      );
    }
    throw err;
  }
}

// ─── public API ───────────────────────────────────────────────────────────

export interface CreateSolLobbyInput {
  creatorAvatarId: string;
  lobbyIdBigint: bigint;
  wagerAmountLamports: bigint;
  maxPlayers: number;
}

export interface CreateSolLobbyResult {
  txSig: string;
  lobbyPda: string;
  vaultPda: string;
  creatorPlayerPda: string;
  creatorPubkey: string;
}

/**
 * Create an on-chain SOL (or free) lobby. The creator avatar's custodial
 * wallet signs as fee payer + first depositor. Caller must already have
 * inserted the lobbies row (with `lobby_id` matching `lobbyIdBigint`) so
 * event persistence can find it.
 */
export async function createSolLobby(
  input: CreateSolLobbyInput,
): Promise<CreateSolLobbyResult> {
  const program = await getProgram();
  const { keypair: creator, publicKey: creatorPubkey } = await loadAvatarWallet(
    input.creatorAvatarId,
  );

  // GATE: pre-check the creator's on-chain SOL so an unfunded custodial wallet
  // fails fast with a clean 4xx ('insufficient_funds') instead of a failed
  // on-chain simulation that previously bubbled up as an uncaught 500 + critical
  // page. The chain remains the final authority — any residual shortfall on a
  // partially-funded wallet is now also caught gracefully in withChainErrors.
  const balanceLamports = await withChainErrors('createSolLobby:getBalance', () =>
    connection.getBalance(creatorPubkey, COMMITMENT),
  );
  const requiredLamports =
    input.wagerAmountLamports + LOBBY_CREATE_RENT_FEE_BUFFER_LAMPORTS;
  if (BigInt(balanceLamports) < requiredLamports) {
    throw new WagerClientError(
      `Insufficient SOL to create this lobby: wallet has ${balanceLamports} lamports, ` +
        `need ~${requiredLamports.toString()} (stake + account rent + fee). ` +
        `Fund your wallet or use a free / ClawToken lobby.`,
      'insufficient_funds',
    );
  }

  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [creatorPlayerPda] = findPlayerPda(input.lobbyIdBigint, creatorPubkey);

  const txSig = await withChainErrors('createSolLobby', () =>
    program.methods
      .createLobbySol(
        new BN(input.lobbyIdBigint.toString()),
        new BN(input.wagerAmountLamports.toString()),
        input.maxPlayers,
      )
      .accountsStrict({
        config: configPda,
        lobby: lobbyPda,
        vault: vaultPda,
        creatorPlayer: creatorPlayerPda,
        creator: creatorPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc(),
  );

  const rowId = await resolveLobbyRowId(input.lobbyIdBigint);
  if (rowId) {
    await persistLobbyEvent({
      lobbyRowId: rowId,
      kind: 'created',
      txSig,
      rawEvent: { lobbyId: input.lobbyIdBigint.toString(), creator: creatorPubkey.toBase58() },
    });
  }

  return {
    txSig,
    lobbyPda: lobbyPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    creatorPlayerPda: creatorPlayerPda.toBase58(),
    creatorPubkey: creatorPubkey.toBase58(),
  };
}

export interface JoinSolLobbyInput {
  joinerAvatarId: string;
  lobbyIdBigint: bigint;
}

export interface JoinSolLobbyResult {
  txSig: string;
  playerPda: string;
  joinerPubkey: string;
}

export async function joinSolLobby(
  input: JoinSolLobbyInput,
): Promise<JoinSolLobbyResult> {
  const program = await getProgram();
  const { keypair: joiner, publicKey: joinerPubkey } = await loadAvatarWallet(
    input.joinerAvatarId,
  );

  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [playerPda] = findPlayerPda(input.lobbyIdBigint, joinerPubkey);

  const txSig = await withChainErrors('joinSolLobby', () =>
    program.methods
      .joinLobbySol()
      .accountsStrict({
        config: configPda,
        lobby: lobbyPda,
        vault: vaultPda,
        player: playerPda,
        playerSigner: joinerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([joiner])
      .rpc(),
  );

  const rowId = await resolveLobbyRowId(input.lobbyIdBigint);
  if (rowId) {
    await persistLobbyEvent({
      lobbyRowId: rowId,
      kind: 'joined',
      txSig,
      rawEvent: { lobbyId: input.lobbyIdBigint.toString(), joiner: joinerPubkey.toBase58() },
    });
  }

  return {
    txSig,
    playerPda: playerPda.toBase58(),
    joinerPubkey: joinerPubkey.toBase58(),
  };
}

export interface LockLobbyInput {
  lobbyIdBigint: bigint;
}

export interface LockLobbyResult {
  txSig: string;
}

export async function lockLobby(input: LockLobbyInput): Promise<LockLobbyResult> {
  const program = await getProgram();
  const authority = await loadSettlementAuthority();
  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);

  const txSig = await withChainErrors('lockLobby', () =>
    program.methods
      .lockLobby()
      .accountsStrict({
        config: configPda,
        lobby: lobbyPda,
        settlementAuthority: authority.publicKey,
      })
      .signers([authority])
      .rpc(),
  );

  const rowId = await resolveLobbyRowId(input.lobbyIdBigint);
  if (rowId) {
    await persistLobbyEvent({
      lobbyRowId: rowId,
      kind: 'locked',
      txSig,
      rawEvent: { lobbyId: input.lobbyIdBigint.toString() },
    });
  }

  return { txSig };
}

export interface SettleSolLobbyInput {
  lobbyIdBigint: bigint;
  winnerAvatarId: string;
  /** Reserved for future "close loser PDA" sweeps — accepted but not yet used. */
  loserAvatarIds?: string[];
}

export interface SettleSolLobbyResult {
  txSig: string;
  winnerPubkey: string;
  /** Payout + rake amounts in lamports — computed off-chain for the UI / event log. */
  payoutLamports: bigint;
  rakeLamports: bigint;
}

export async function settleSolLobby(
  input: SettleSolLobbyInput,
): Promise<SettleSolLobbyResult> {
  const program = await getProgram();
  const authority = await loadSettlementAuthority();

  // We need: winner pubkey, treasury pubkey (= lobby.treasury_snapshot,
  // i.e. settlement authority on devnet), creator pubkey (for vault rent
  // residual). Pull the lobby + winner's avatar wallet.
  const lobbyRow = await db.query.lobbies.findFirst({
    where: eq(lobbies.lobbyId, input.lobbyIdBigint),
  });
  if (!lobbyRow) {
    throw new WagerClientError(
      `No lobbies row for on-chain lobby_id=${input.lobbyIdBigint}`,
      'state_noop',
    );
  }

  // Winner avatar wallet pubkey
  const winnerWalletRow = await db.query.wallets.findFirst({
    where: and(
      eq(wallets.subjectType, 'avatar'),
      eq(wallets.subjectId, input.winnerAvatarId),
    ),
    columns: { publicKey: true },
  });
  if (!winnerWalletRow) {
    throw new WagerClientError(
      `Winner avatar ${input.winnerAvatarId} has no wallet`,
      'avatar_wallet_missing',
    );
  }
  const winnerPubkey = new PublicKey(winnerWalletRow.publicKey);

  // Creator avatar wallet pubkey
  const creatorWalletRow = await db.query.wallets.findFirst({
    where: and(
      eq(wallets.subjectType, 'avatar'),
      eq(wallets.subjectId, lobbyRow.creatorAvatarId),
    ),
    columns: { publicKey: true },
  });
  if (!creatorWalletRow) {
    throw new WagerClientError(
      `Creator avatar ${lobbyRow.creatorAvatarId} has no wallet`,
      'avatar_wallet_missing',
    );
  }
  const creatorPubkey = new PublicKey(creatorWalletRow.publicKey);

  // Treasury is the settlement-authority pubkey on devnet — matches the
  // initialize_config call. Future production rotations would store the
  // chosen treasury pubkey somewhere queryable; we hard-code to authority
  // for now and the on-chain constraint (`treasury == lobby.treasury_snapshot`)
  // will fail loudly if this drifts.
  const treasuryPubkey = authority.publicKey;

  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [winnerPlayerPda] = findPlayerPda(input.lobbyIdBigint, winnerPubkey);

  const txSig = await withChainErrors('settleSolLobby', () =>
    program.methods
      .settleLobbySol(winnerPubkey)
      .accountsStrict({
        config: configPda,
        lobby: lobbyPda,
        vault: vaultPda,
        winnerPlayer: winnerPlayerPda,
        settlementAuthority: authority.publicKey,
        winnerAccount: winnerPubkey,
        treasury: treasuryPubkey,
        creator: creatorPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc(),
  );

  // Compute payout + rake for the event log. Same math as on-chain:
  //   pot      = wager_amount * joined_count
  //   rake     = floor(pot * rake_bps / 10000)
  //   payout   = pot - rake
  // Free lobbies: pot = 0 ⇒ both = 0.
  const pot = lobbyRow.wagerAmountLamports * BigInt(lobbyRow.joinedCount);
  // rake_bps_snapshot defaults to DEFAULT_RAKE_BPS at create time on the chain.
  // We don't store it off-chain — DEFAULT_RAKE_BPS is the only value the
  // config has ever had on devnet. If/when we rotate the config we should
  // mirror the new bps into a `rake_bps_snapshot` column on lobbies.
  // FEATURE_GATE: track-rake-snapshot
  // Status: TODO — single rake_bps value used today
  // Metric to graduate: any production rotation of config.rake_bps
  // Current reading: 500 bps (5%) — never rotated
  // Review deadline: 2026-07-01
  // On deadline: mirror rake_bps_snapshot into the lobbies row at create time
  // Reference: this file's settleSolLobby
  const rakeLamports = (pot * 500n) / 10000n;
  const payoutLamports = pot - rakeLamports;

  await persistLobbyEvent({
    lobbyRowId: lobbyRow.id,
    kind: 'settled',
    txSig,
    rawEvent: {
      lobbyId: input.lobbyIdBigint.toString(),
      winner: winnerPubkey.toBase58(),
      pot: pot.toString(),
      payoutLamports: payoutLamports.toString(),
      rakeLamports: rakeLamports.toString(),
    },
  });

  return {
    txSig,
    winnerPubkey: winnerPubkey.toBase58(),
    payoutLamports,
    rakeLamports,
  };
}

export interface CancelLobbyInput {
  lobbyIdBigint: bigint;
  /** Who signs cancel: the lobby creator (state=open) or the authority (state in open|locked). */
  signerKind: 'creator' | 'settlement-authority';
}

export interface CancelLobbyResult {
  txSig: string;
  signerPubkey: string;
}

export async function cancelLobby(
  input: CancelLobbyInput,
): Promise<CancelLobbyResult> {
  const program = await getProgram();
  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);

  let signer: Keypair;
  if (input.signerKind === 'settlement-authority') {
    signer = await loadSettlementAuthority();
  } else {
    const lobbyRow = await db.query.lobbies.findFirst({
      where: eq(lobbies.lobbyId, input.lobbyIdBigint),
    });
    if (!lobbyRow) {
      throw new WagerClientError(
        `No lobbies row for on-chain lobby_id=${input.lobbyIdBigint}`,
        'state_noop',
      );
    }
    const handle = await loadAvatarWallet(lobbyRow.creatorAvatarId);
    signer = handle.keypair;
  }

  const txSig = await withChainErrors('cancelLobby', () =>
    program.methods
      .cancelLobby()
      .accountsStrict({
        config: configPda,
        lobby: lobbyPda,
        signer: signer.publicKey,
      })
      .signers([signer])
      .rpc(),
  );

  const rowId = await resolveLobbyRowId(input.lobbyIdBigint);
  if (rowId) {
    await persistLobbyEvent({
      lobbyRowId: rowId,
      kind: 'cancelled',
      txSig,
      rawEvent: {
        lobbyId: input.lobbyIdBigint.toString(),
        signer: signer.publicKey.toBase58(),
        signerKind: input.signerKind,
      },
    });
  }

  return { txSig, signerPubkey: signer.publicKey.toBase58() };
}

export interface ClaimSolRefundInput {
  playerAvatarId: string;
  lobbyIdBigint: bigint;
}

export interface ClaimSolRefundResult {
  txSig: string;
  playerPubkey: string;
}

export async function claimSolRefund(
  input: ClaimSolRefundInput,
): Promise<ClaimSolRefundResult> {
  const program = await getProgram();
  const { keypair: player, publicKey: playerPubkey } = await loadAvatarWallet(
    input.playerAvatarId,
  );

  const lobbyRow = await db.query.lobbies.findFirst({
    where: eq(lobbies.lobbyId, input.lobbyIdBigint),
  });
  if (!lobbyRow) {
    throw new WagerClientError(
      `No lobbies row for on-chain lobby_id=${input.lobbyIdBigint}`,
      'state_noop',
    );
  }
  const creatorWalletRow = await db.query.wallets.findFirst({
    where: and(
      eq(wallets.subjectType, 'avatar'),
      eq(wallets.subjectId, lobbyRow.creatorAvatarId),
    ),
    columns: { publicKey: true },
  });
  if (!creatorWalletRow) {
    throw new WagerClientError(
      `Creator avatar ${lobbyRow.creatorAvatarId} has no wallet`,
      'avatar_wallet_missing',
    );
  }
  const creatorPubkey = new PublicKey(creatorWalletRow.publicKey);

  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [playerPda] = findPlayerPda(input.lobbyIdBigint, playerPubkey);

  const txSig = await withChainErrors('claimSolRefund', () =>
    program.methods
      .claimRefundSol()
      .accountsStrict({
        lobby: lobbyPda,
        vault: vaultPda,
        player: playerPda,
        playerSigner: playerPubkey,
        creator: creatorPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc(),
  );

  await persistLobbyEvent({
    lobbyRowId: lobbyRow.id,
    kind: 'refunded',
    txSig,
    rawEvent: {
      lobbyId: input.lobbyIdBigint.toString(),
      player: playerPubkey.toBase58(),
    },
  });

  return { txSig, playerPubkey: playerPubkey.toBase58() };
}

/**
 * Touch test — verifies RPC connectivity + settlement-authority decryption
 * without issuing a tx. Called by `/api/wager/health` (if we add one).
 */
export async function wagerHealthCheck(): Promise<{
  rpcUrl: string;
  authorityPubkey: string;
  configPda: string;
}> {
  const authority = await loadSettlementAuthority();
  await connection.getLatestBlockhash(COMMITMENT);
  return {
    rpcUrl: RPC_URL,
    authorityPubkey: authority.publicKey.toBase58(),
    configPda: findConfigPda()[0].toBase58(),
  };
}

// Suppress unused-import warning when settle/avatar paths are stubbed
void avatars;
