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
  Transaction,
  type Commitment,
} from '@solana/web3.js';
import {
  AnchorProvider,
  BN,
  Program,
  AnchorError,
} from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/esm/nodewallet.js';
import bs58 from 'bs58';
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
  inArray,
  sql,
  treasuryWallets,
  wallets,
  avatars,
  lobbies,
  lobbyPlayers,
  lobbyEvents,
  wagerChainIntents,
  type LobbyEventKind,
  type WagerChainIntent,
} from '@clawville/database';
import { decryptSecretKey, decryptWalletRow } from './keypair-vault';

// ─── module-scope singletons ──────────────────────────────────────────────

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const COMMITMENT: Commitment = 'confirmed';

/** Full `getGenesisHash()` values (not the 32-char CAIP-2 prefixes). */
export const SOLANA_DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SOLANA_MAINNET_GENESIS_HASH =
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_TESTNET_GENESIS_HASH =
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
/**
 * Code-review gate: the wager package/program id is devnet/localnet-only today.
 * A future mainnet deployment must deliberately change this constant together
 * with the package program-id contract; env flags alone can never unlock it.
 */
export const WAGER_MAINNET_PAID_CODE_APPROVED = false as boolean;

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
      | 'network_refused'
      | 'on_chain_error'
      | 'insufficient_funds',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WagerClientError';
  }
}

/**
 * Ground-truth cluster gate. Every wager broadcast calls this immediately
 * before building/signing with a fresh genesis probe. Devnet is the default;
 * localnet requires a non-production loopback triple gate. Mainnet additionally
 * requires the code-review constant/program-id deployment plus the existing
 * cluster signal; env configuration alone cannot unlock it. Unknown/testnet
 * clusters fail closed.
 */
export async function assertWagerBroadcastCluster(
  conn: Pick<Connection, 'getGenesisHash' | 'rpcEndpoint'>,
  label: string,
): Promise<void> {
  let genesis: string;
  try {
    genesis = await conn.getGenesisHash();
  } catch (err) {
    throw new WagerClientError(
      `Could not verify the Solana cluster before ${label}; refusing to broadcast`,
      'network_refused',
      err,
    );
  }

  if (genesis === SOLANA_DEVNET_GENESIS_HASH) return;

  const mainnetEnabled =
    WAGER_MAINNET_PAID_CODE_APPROVED &&
    process.env.WAGER_PROGRAM_CLUSTER === 'mainnet';
  if (genesis === SOLANA_MAINNET_GENESIS_HASH) {
    if (mainnetEnabled) return;
    throw new WagerClientError(
      'Wager broadcast refused: mainnet requires the code-reviewed program-id deployment/code gate plus WAGER_PROGRAM_CLUSTER=mainnet',
      'network_refused',
    );
  }
  if (genesis === SOLANA_TESTNET_GENESIS_HASH) {
    throw new WagerClientError(
      'Wager broadcast refused: Solana testnet is not an approved wager cluster',
      'network_refused',
    );
  }

  let loopbackRpc = false;
  try {
    const host = new URL(conn.rpcEndpoint).hostname.toLowerCase();
    loopbackRpc =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1';
  } catch {
    loopbackRpc = false;
  }
  const localnetEnabled =
    process.env.WAGER_PROGRAM_CLUSTER === 'localnet' &&
    process.env.NODE_ENV !== 'production' &&
    process.env.CLAWVILLE_ENV !== 'production' &&
    loopbackRpc;
  if (localnetEnabled) return;

  throw new WagerClientError(
    `Wager ${label} refused: RPC cluster is not approved devnet/localnet`,
    'network_refused',
  );
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

interface DurableBroadcastInput {
  intentId: string;
  label: string;
  transaction: Transaction;
  feePayer: PublicKey;
  signers: Keypair[];
  targetPda: PublicKey;
}

type WagerDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const WAGER_PREPARED_STALE_MS = 5 * 60_000;

async function acquireWagerLobbyFence(tx: WagerDbTx, lobbyId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wager-lobby:${lobbyId}`}, 0))`,
  );
}

async function markPreparedIntentFailed(intentId: string, reason: string): Promise<void> {
  await db
    .update(wagerChainIntents)
    .set({ status: 'failed', lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(wagerChainIntents.id, intentId),
        eq(wagerChainIntents.status, 'prepared'),
      ),
    );
}

/**
 * Only RPC preflight/simulation rejection proves the node did not broadcast.
 * Transport errors, timeouts, and generic send failures remain ambiguous.
 */
export function isDefinitelyUnsentWagerBroadcastError(err: unknown): boolean {
  const named = err as { name?: unknown; message?: unknown } | null;
  const name = typeof named?.name === 'string' ? named.name : '';
  const message =
    typeof named?.message === 'string'
      ? named.message
      : err instanceof Error
        ? err.message
        : String(err);
  return (
    name === 'SendTransactionError' ||
    message.includes('Simulation failed') ||
    message.includes('Transaction simulation failed')
  );
}

async function resetDefinitelyUnsentIntent(
  intentId: string,
  signature: string,
  reason: string,
): Promise<void> {
  await db
    .update(wagerChainIntents)
    .set({
      status: 'failed',
      txSignature: null,
      blockhash: null,
      lastValidBlockHeight: null,
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(wagerChainIntents.id, intentId),
        eq(wagerChainIntents.status, 'sending'),
        eq(wagerChainIntents.txSignature, signature),
      ),
    );
}

/** Capture the deterministic first signature before broadcasting exact bytes. */
async function broadcastDurableTransaction(
  input: DurableBroadcastInput,
): Promise<string> {
  await assertWagerBroadcastCluster(connection, input.label);
  const { blockhash, lastValidBlockHeight } = await withChainErrors(
    `${input.label}:getLatestBlockhash`,
    () => connection.getLatestBlockhash(COMMITMENT),
  );
  input.transaction.feePayer = input.feePayer;
  input.transaction.recentBlockhash = blockhash;
  input.transaction.sign(...input.signers);
  if (!input.transaction.signature) {
    throw new WagerClientError(
      `${input.label} signing produced no transaction signature`,
      'on_chain_error',
    );
  }
  const signature = bs58.encode(input.transaction.signature);

  // Capture and lifecycle transitions share one cross-pod advisory lock. The
  // capture commits BEFORE any bytes are sent, while cancel/lock/settle hold
  // the same lock until their DB state advances. Therefore either capture wins
  // first (and lifecycle sees an unresolved `sending` intent and refuses), or
  // lifecycle wins first (and this re-check sees a non-open lobby and refuses
  // without broadcasting).
  const captured = await db.transaction(async (tx) => {
    const intent = await tx.query.wagerChainIntents.findFirst({
      where: eq(wagerChainIntents.id, input.intentId),
    });
    if (!intent) return null;
    await acquireWagerLobbyFence(tx, intent.lobbyId);

    const lobby = await tx.query.lobbies.findFirst({
      where: eq(lobbies.id, intent.lobbyId),
      columns: { state: true, onChainCreateStatus: true },
    });
    const lifecycleAllowsBroadcast =
      lobby?.state === 'open' &&
      (intent.operation === 'create'
        ? lobby.onChainCreateStatus !== 'confirmed'
        : lobby.onChainCreateStatus === 'confirmed');
    if (!lifecycleAllowsBroadcast) return null;

    const [row] = await tx
      .update(wagerChainIntents)
      .set({
        status: 'sending',
        txSignature: signature,
        blockhash,
        lastValidBlockHeight: BigInt(lastValidBlockHeight),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(wagerChainIntents.id, input.intentId),
          eq(wagerChainIntents.status, 'prepared'),
          eq(wagerChainIntents.targetPda, input.targetPda.toBase58()),
          sql`${wagerChainIntents.txSignature} IS NULL`,
        ),
      )
      .returning({ id: wagerChainIntents.id });
    return row ?? null;
  });
  if (!captured) {
    throw new WagerClientError(
      `${input.label} intent is no longer prepared; refusing duplicate broadcast`,
      'state_noop',
    );
  }

  let wireTransaction: Buffer;
  try {
    wireTransaction = input.transaction.serialize();
  } catch (err) {
    await resetDefinitelyUnsentIntent(input.intentId, signature, 'serialization_failed');
    throw new WagerClientError(
      `${input.label} transaction could not be serialized before broadcast`,
      'on_chain_error',
      err,
    );
  }

  let sent = false;
  try {
    const echoedSignature = await connection.sendRawTransaction(
      wireTransaction,
      { skipPreflight: false, preflightCommitment: COMMITMENT },
    );
    sent = true;
    if (echoedSignature !== signature) throw new Error('rpc_signature_mismatch');
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );
    if (confirmation.value.err) {
      await db
        .update(wagerChainIntents)
        .set({
          status: 'reconcile',
          lastError: 'tx_failed_on_chain',
          updatedAt: new Date(),
        })
        .where(eq(wagerChainIntents.id, input.intentId));
      throw new WagerClientError(
        `On-chain ${input.label} transaction failed; reconciliation required`,
        'on_chain_error',
        confirmation.value.err,
      );
    }
  } catch (err) {
    if (err instanceof WagerClientError && err.message.includes('reconciliation required')) {
      throw err;
    }
    if (!sent && isDefinitelyUnsentWagerBroadcastError(err)) {
      await resetDefinitelyUnsentIntent(input.intentId, signature, 'preflight_rejected');
      throw new WagerClientError(
        `On-chain ${input.label} preflight rejected before broadcast`,
        'on_chain_error',
        err,
      );
    }
    await db
      .update(wagerChainIntents)
      .set({
        status: 'reconcile',
        lastError: sent ? 'confirm_ambiguous' : 'send_ambiguous',
        updatedAt: new Date(),
      })
      .where(eq(wagerChainIntents.id, input.intentId));
    throw new WagerClientError(
      `RPC outcome ambiguous during ${input.label}; reconciliation required`,
      'rpc_unreachable',
      err,
    );
  }

  await db
    .update(wagerChainIntents)
    .set({ status: 'confirmed', lastError: null, updatedAt: new Date() })
    .where(eq(wagerChainIntents.id, input.intentId));
  return signature;
}

export function deriveCreateSolLobbyIntentPda(lobbyIdBigint: bigint): PublicKey {
  return findLobbyPda(lobbyIdBigint)[0];
}

export async function deriveJoinSolLobbyIntentPda(input: {
  lobbyIdBigint: bigint;
  joinerAvatarId: string;
}): Promise<PublicKey> {
  const wallet = await db.query.wallets.findFirst({
    where: and(
      eq(wallets.subjectType, 'avatar'),
      eq(wallets.subjectId, input.joinerAvatarId),
    ),
    columns: { publicKey: true },
  });
  if (!wallet) {
    throw new WagerClientError(
      `Avatar ${input.joinerAvatarId} has no wallet row`,
      'avatar_wallet_missing',
    );
  }
  return findPlayerPda(input.lobbyIdBigint, new PublicKey(wallet.publicKey))[0];
}

export interface CreateSolLobbyInput {
  creatorAvatarId: string;
  lobbyIdBigint: bigint;
  wagerAmountLamports: bigint;
  maxPlayers: number;
  intentId: string;
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
  const feePayer = await loadSettlementAuthority();
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
        `Fund your wallet or use a free / vCLAW lobby.`,
      'insufficient_funds',
    );
  }

  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [creatorPlayerPda] = findPlayerPda(input.lobbyIdBigint, creatorPubkey);

  let txSig: string;
  try {
    const transaction = await program.methods
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
      .transaction();
    txSig = await broadcastDurableTransaction({
      intentId: input.intentId,
      label: 'createSolLobby',
      transaction,
      // Preserve AnchorProvider `.rpc()` semantics: its settlement-authority
      // wallet was the fee payer, while creator remained the deposit signer.
      feePayer: feePayer.publicKey,
      signers: [creator, feePayer],
      targetPda: lobbyPda,
    });
  } catch (err) {
    await markPreparedIntentFailed(input.intentId, 'pre_broadcast_failure');
    throw err;
  }

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
  intentId: string;
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
  const feePayer = await loadSettlementAuthority();
  const { keypair: joiner, publicKey: joinerPubkey } = await loadAvatarWallet(
    input.joinerAvatarId,
  );

  const [configPda] = findConfigPda();
  const [lobbyPda] = findLobbyPda(input.lobbyIdBigint);
  const [vaultPda] = findVaultPda(input.lobbyIdBigint);
  const [playerPda] = findPlayerPda(input.lobbyIdBigint, joinerPubkey);

  let txSig: string;
  try {
    const transaction = await program.methods
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
      .transaction();
    txSig = await broadcastDurableTransaction({
      intentId: input.intentId,
      label: 'joinSolLobby',
      transaction,
      feePayer: feePayer.publicKey,
      signers: [joiner, feePayer],
      targetPda: playerPda,
    });
  } catch (err) {
    await markPreparedIntentFailed(input.intentId, 'pre_broadcast_failure');
    throw err;
  }

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

  await assertWagerBroadcastCluster(connection, 'lockLobby');
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

  await assertWagerBroadcastCluster(connection, 'settleSolLobby');
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

  await assertWagerBroadcastCluster(connection, 'cancelLobby');
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

  await assertWagerBroadcastCluster(connection, 'claimSolRefund');
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
async function finalizeConfirmedWagerIntentInTx(
  tx: WagerDbTx,
  intent: WagerChainIntent,
): Promise<void> {
  if (intent.status !== 'confirmed' || !intent.txSignature) {
    throw new WagerClientError('wager_intent_not_confirmed', 'state_noop');
  }
  const lobby = await tx.query.lobbies.findFirst({
    where: eq(lobbies.id, intent.lobbyId),
  });
  if (!lobby) throw new WagerClientError('wager_intent_lobby_missing', 'state_noop');

  const witnessAvatarId =
    intent.operation === 'create' ? lobby.creatorAvatarId : intent.actorAvatarId;
  const witnessUserId =
    intent.operation === 'create'
      ? lobby.creatorUserId
      : (
          await tx.query.avatars.findFirst({
            where: eq(avatars.id, intent.actorAvatarId),
            columns: { userId: true },
          })
        )?.userId;
  if (!witnessUserId) {
    throw new WagerClientError('wager_intent_avatar_missing', 'state_noop');
  }

  const [inserted] = await tx
    .insert(lobbyPlayers)
    .values({
      lobbyId: lobby.id,
      userId: witnessUserId,
      avatarId: witnessAvatarId,
      depositAmountLamports: lobby.wagerAmountLamports,
      onChainJoinSig: intent.txSignature,
    })
    .onConflictDoNothing()
    .returning({ id: lobbyPlayers.id });

  // `lobby_players` is unique by (lobby,user). Never treat a conflict owned by
  // a different avatar as successful finalization: the on-chain Player PDA is
  // avatar-wallet-specific, so doing so would discard the real refund witness.
  const witness = await tx.query.lobbyPlayers.findFirst({
    where: and(
      eq(lobbyPlayers.lobbyId, lobby.id),
      eq(lobbyPlayers.avatarId, witnessAvatarId),
    ),
    columns: { id: true },
  });
  if (!witness) {
    throw new WagerClientError('wager_player_witness_identity_conflict', 'state_noop');
  }

  if (intent.operation === 'create') {
    await tx
      .update(lobbies)
      .set({
        onChainCreateStatus: 'confirmed',
        onChainCreateSig: intent.txSignature,
      })
      .where(eq(lobbies.id, lobby.id));
    return;
  }

  if (inserted) {
    await tx
      .update(lobbies)
      .set({ joinedCount: sql`${lobbies.joinedCount} + 1` })
      .where(eq(lobbies.id, lobby.id));
  }
}

/** Idempotently repair the off-chain witness after chain confirmation. */
export async function finalizeConfirmedWagerIntent(intentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const intent = await tx.query.wagerChainIntents.findFirst({
      where: eq(wagerChainIntents.id, intentId),
    });
    if (!intent) throw new WagerClientError('wager_intent_not_found', 'state_noop');
    await finalizeConfirmedWagerIntentInTx(tx, intent);
  });
}

export class WagerIntentFenceError extends Error {
  constructor(
    public readonly lobbyId: string,
    public readonly unresolvedIntentIds: string[],
  ) {
    super('wager_intent_reconciliation_required');
    this.name = 'WagerIntentFenceError';
  }
}

/**
 * Reconcile every signed/confirmed create or join intent for a lobby. Prepared
 * rows are deliberately left alone here: a live request may be between reserve
 * and capture. The advisory-fenced lifecycle path expires only prepared rows
 * older than five minutes, then refuses while any newer one remains.
 */
export async function reconcileLobbyWagerIntents(lobbyId: string): Promise<void> {
  const intents = await db.query.wagerChainIntents.findMany({
    where: and(
      eq(wagerChainIntents.lobbyId, lobbyId),
      inArray(wagerChainIntents.status, ['sending', 'confirmed', 'reconcile']),
    ),
  });
  for (const intent of intents) {
    await reconcileWagerChainIntent(intent.id);
  }
}

/**
 * Cross-pod lifecycle fence shared by route and activity-bridge transitions.
 * Reconciliation happens first without a lock (RPC may be slow), then the
 * advisory lock prevents a create/join capture from interleaving with the
 * final unresolved check and the caller's chain+DB lifecycle transition.
 */
export async function withResolvedWagerLobbyFence<T>(
  lobbyId: string,
  run: (tx: WagerDbTx) => Promise<T>,
): Promise<T> {
  await reconcileLobbyWagerIntents(lobbyId);
  return db.transaction(async (tx) => {
    await acquireWagerLobbyFence(tx, lobbyId);

    const staleBefore = new Date(Date.now() - WAGER_PREPARED_STALE_MS);
    await tx
      .update(wagerChainIntents)
      .set({ status: 'failed', lastError: 'prepared_stale', updatedAt: new Date() })
      .where(
        and(
          eq(wagerChainIntents.lobbyId, lobbyId),
          eq(wagerChainIntents.status, 'prepared'),
          sql`${wagerChainIntents.updatedAt} <= ${staleBefore}`,
          sql`${wagerChainIntents.txSignature} IS NULL`,
        ),
      );

    const intents = await tx.query.wagerChainIntents.findMany({
      where: eq(wagerChainIntents.lobbyId, lobbyId),
    });
    for (const intent of intents) {
      if (intent.status === 'confirmed') {
        await finalizeConfirmedWagerIntentInTx(tx, intent);
      }
    }
    const unresolved = intents.filter((intent) =>
      intent.status === 'prepared' ||
      intent.status === 'sending' ||
      intent.status === 'reconcile',
    );
    if (unresolved.length > 0) {
      throw new WagerIntentFenceError(lobbyId, unresolved.map((intent) => intent.id));
    }
    return run(tx);
  });
}

export type WagerIntentReconcileResult =
  | { status: 'confirmed'; evidence: 'signature' | 'pda' }
  | { status: 'reconcile'; evidence: 'pending' | 'tx_failed_on_chain' | 'expired_absent' }
  | { status: 'failed'; evidence: 'never_signed' };

const LOBBY_ACCOUNT_DISCRIMINATOR = Uint8Array.from([
  167, 194, 217, 163, 92, 92, 103, 49,
]);
const PLAYER_ACCOUNT_DISCRIMINATOR = Uint8Array.from([
  205, 222, 112, 7, 165, 155, 206, 218,
]);

function hasDiscriminator(data: Buffer, expected: Uint8Array): boolean {
  return data.length >= expected.length && expected.every((byte, index) => data[index] === byte);
}

export interface DecodedWagerLobbyAccount {
  lobbyId: bigint;
  creator: string;
  wagerAmountLamports: bigint;
  wagerMint: string;
  maxPlayers: number;
  state: number;
}

export interface DecodedWagerPlayerAccount {
  lobbyId: bigint;
  player: string;
  depositAmountLamports: bigint;
  refunded: boolean;
}

export function decodeWagerLobbyAccount(data: Buffer): DecodedWagerLobbyAccount | null {
  if (!hasDiscriminator(data, LOBBY_ACCOUNT_DISCRIMINATOR) || data.length < 183) return null;
  return {
    lobbyId: data.readBigUInt64LE(8),
    creator: new PublicKey(data.subarray(16, 48)).toBase58(),
    wagerAmountLamports: data.readBigUInt64LE(48),
    wagerMint: new PublicKey(data.subarray(56, 88)).toBase58(),
    maxPlayers: data[88]!,
    state: data[90]!,
  };
}

export function decodeWagerPlayerAccount(data: Buffer): DecodedWagerPlayerAccount | null {
  if (!hasDiscriminator(data, PLAYER_ACCOUNT_DISCRIMINATOR) || data.length < 58) return null;
  return {
    lobbyId: data.readBigUInt64LE(8),
    player: new PublicKey(data.subarray(16, 48)).toBase58(),
    depositAmountLamports: data.readBigUInt64LE(48),
    refunded: data[56] === 1,
  };
}

export function wagerLobbyAccountMatches(input: {
  account: DecodedWagerLobbyAccount;
  lobbyId: bigint;
  creator: string;
  wagerAmountLamports: bigint;
  maxPlayers: number;
  state: number;
}): boolean {
  return (
    input.account.lobbyId === input.lobbyId &&
    input.account.creator === input.creator &&
    input.account.wagerAmountLamports === input.wagerAmountLamports &&
    input.account.wagerMint === PublicKey.default.toBase58() &&
    input.account.maxPlayers === input.maxPlayers &&
    input.account.state === input.state
  );
}

export function wagerPlayerAccountMatches(input: {
  account: DecodedWagerPlayerAccount;
  lobbyId: bigint;
  player: string;
  depositAmountLamports: bigint;
}): boolean {
  return (
    input.account.lobbyId === input.lobbyId &&
    input.account.player === input.player &&
    input.account.depositAmountLamports === input.depositAmountLamports &&
    input.account.refunded === false
  );
}

const WAGER_CHAIN_STATE: Record<string, number> = {
  open: 0,
  locked: 1,
  settled: 2,
  cancelled: 3,
};

async function loadAvatarWalletPublicKey(avatarId: string): Promise<PublicKey> {
  const wallet = await db.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    columns: { publicKey: true },
  });
  if (!wallet) {
    throw new WagerClientError(`Avatar ${avatarId} has no wallet row`, 'avatar_wallet_missing');
  }
  return new PublicKey(wallet.publicKey);
}

async function deriveExpectedIntentContext(intent: WagerChainIntent) {
  const lobby = await db.query.lobbies.findFirst({
    where: eq(lobbies.id, intent.lobbyId),
    columns: {
      lobbyId: true,
      creatorAvatarId: true,
      wagerAmountLamports: true,
      maxPlayers: true,
      state: true,
    },
  });
  if (!lobby) throw new WagerClientError('wager_intent_lobby_missing', 'state_noop');
  const creator = await loadAvatarWalletPublicKey(lobby.creatorAvatarId);
  const actor =
    intent.actorAvatarId === lobby.creatorAvatarId
      ? creator
      : await loadAvatarWalletPublicKey(intent.actorAvatarId);
  const expectedPda =
    intent.operation === 'create'
      ? deriveCreateSolLobbyIntentPda(lobby.lobbyId)
      : findPlayerPda(lobby.lobbyId, actor)[0];
  return { lobby, creator, actor, expectedPda };
}

/**
 * Forward-only create/join reconciliation hook. It never signs or sends. It
 * checks the stored signature first, then the exact derived program-owned PDA
 * and Anchor discriminator. Absence is definitive only after blockhash expiry.
 */
export async function reconcileWagerChainIntent(
  intentId: string,
): Promise<WagerIntentReconcileResult> {
  const intent = await db.query.wagerChainIntents.findFirst({
    where: eq(wagerChainIntents.id, intentId),
  });
  if (!intent) throw new WagerClientError('wager_intent_not_found', 'state_noop');
  if (intent.status === 'confirmed') {
    await finalizeConfirmedWagerIntent(intent.id);
    return { status: 'confirmed', evidence: 'signature' };
  }
  if (!intent.txSignature) {
    await markPreparedIntentFailed(intent.id, 'never_signed');
    return { status: 'failed', evidence: 'never_signed' };
  }

  await assertWagerBroadcastCluster(connection, 'reconcileWagerChainIntent');
  const expected = await deriveExpectedIntentContext(intent);
  const { expectedPda } = expected;
  if (intent.targetPda !== expectedPda.toBase58()) {
    throw new WagerClientError('wager_intent_target_pda_mismatch', 'pubkey_mismatch');
  }

  const statuses = await withChainErrors('reconcileWagerIntent:getSignatureStatuses', () =>
    connection.getSignatureStatuses([intent.txSignature!], { searchTransactionHistory: true }),
  );
  const status = statuses.value[0];
  if (status?.err) {
    await db.update(wagerChainIntents).set({
      status: 'reconcile',
      lastError: 'tx_failed_on_chain',
      updatedAt: new Date(),
    }).where(eq(wagerChainIntents.id, intent.id));
    return { status: 'reconcile', evidence: 'tx_failed_on_chain' };
  }
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    await db.update(wagerChainIntents).set({
      status: 'confirmed',
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(wagerChainIntents.id, intent.id));
    await finalizeConfirmedWagerIntent(intent.id);
    return { status: 'confirmed', evidence: 'signature' };
  }

  const account = await withChainErrors('reconcileWagerIntent:getAccountInfo', () =>
    connection.getAccountInfo(expectedPda, COMMITMENT),
  );
  const expectedState = WAGER_CHAIN_STATE[expected.lobby.state];
  if (expectedState === undefined) {
    throw new WagerClientError('wager_lobby_state_unknown', 'state_noop');
  }

  let accountMatches = false;
  if (account?.owner.equals(PROGRAM_ID)) {
    if (intent.operation === 'create') {
      const decoded = decodeWagerLobbyAccount(account.data);
      accountMatches = decoded !== null && wagerLobbyAccountMatches({
        account: decoded,
        lobbyId: expected.lobby.lobbyId,
        creator: expected.creator.toBase58(),
        wagerAmountLamports: expected.lobby.wagerAmountLamports,
        maxPlayers: expected.lobby.maxPlayers,
        state: expectedState,
      });
    } else {
      const decodedPlayer = decodeWagerPlayerAccount(account.data);
      const lobbyPda = deriveCreateSolLobbyIntentPda(expected.lobby.lobbyId);
      const lobbyAccount = await withChainErrors('reconcileWagerIntent:getLobbyAccountInfo', () =>
        connection.getAccountInfo(lobbyPda, COMMITMENT),
      );
      const decodedLobby =
        lobbyAccount?.owner.equals(PROGRAM_ID)
          ? decodeWagerLobbyAccount(lobbyAccount.data)
          : null;
      accountMatches =
        decodedPlayer !== null &&
        decodedLobby !== null &&
        wagerPlayerAccountMatches({
          account: decodedPlayer,
          lobbyId: expected.lobby.lobbyId,
          player: expected.actor.toBase58(),
          depositAmountLamports: expected.lobby.wagerAmountLamports,
        }) &&
        wagerLobbyAccountMatches({
          account: decodedLobby,
          lobbyId: expected.lobby.lobbyId,
          creator: expected.creator.toBase58(),
          wagerAmountLamports: expected.lobby.wagerAmountLamports,
          maxPlayers: expected.lobby.maxPlayers,
          state: expectedState,
        });
    }
  }
  if (accountMatches) {
    await db.update(wagerChainIntents).set({
      status: 'confirmed',
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(wagerChainIntents.id, intent.id));
    await finalizeConfirmedWagerIntent(intent.id);
    return { status: 'confirmed', evidence: 'pda' };
  }

  if (account) {
    await db.update(wagerChainIntents).set({
      status: 'reconcile',
      lastError: 'pda_account_mismatch',
      updatedAt: new Date(),
    }).where(eq(wagerChainIntents.id, intent.id));
    return { status: 'reconcile', evidence: 'pending' };
  }

  if (intent.lastValidBlockHeight != null) {
    const currentBlockHeight = await withChainErrors('reconcileWagerIntent:getBlockHeight', () =>
      connection.getBlockHeight(COMMITMENT),
    );
    if (BigInt(currentBlockHeight) > intent.lastValidBlockHeight) {
      await db.update(wagerChainIntents).set({
        status: 'reconcile',
        lastError: 'expired_absent',
        updatedAt: new Date(),
      }).where(eq(wagerChainIntents.id, intent.id));
      return { status: 'reconcile', evidence: 'expired_absent' };
    }
  }

  await db.update(wagerChainIntents).set({
    status: 'reconcile',
    lastError: 'chain_pending',
    updatedAt: new Date(),
  }).where(eq(wagerChainIntents.id, intent.id));
  return { status: 'reconcile', evidence: 'pending' };
}

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
