/**
 * Durable SAP identity registrar.
 *
 * ECONOMIC / STATUS DISCIPLINE
 * - Admission is fire-and-forget and never changes the triggering route result.
 * - The avatar's own custodial wallet funds and signs every chain write; no
 *   treasury subsidy and no caller-supplied signer are accepted.
 * - A 0.06 SOL balance floor is only a conservative preflight. The deployed
 *   register flow currently consumes about 0.056 SOL of rent, while OOBE source
 *   carries a future (not deployed) 0.1 SOL protocol fee. The chain remains the
 *   authority; insufficient balance parks the row without consuming an attempt.
 * - Registration is adoptable: every retry probes the deterministic PDA first.
 *   A broadcast-unknown send is therefore never blindly retried. Adoption only
 *   becomes public after the real historical register signature is recovered.
 * - Metaplex mint+attach persists its generated asset before broadcast. An
 *   unknown send is re-verified, never reminted. `identity_attached` is written
 *   only after SDK `verifyLink` returns true.
 */

import {
  and,
  asc,
  avatars,
  db,
  eq,
  platformAgents,
  sapAgentIdentities,
  sql,
  users,
  wallets,
  type SapAgentIdentity,
} from '@clawville/database';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { MetaplexBridge } from '@oobe-protocol-labs/synapse-sap-sdk/registries';
import bs58 from 'bs58';
import { alertError, type AlertErrorParams } from '../alert-error';
import { withKeyedMutex } from '../keyed-mutex';
import { findAgentPda } from './sap-pdas';
import {
  classifyChainError,
  executeSapIdentityAttachTx,
  fetchAgentProfile,
  findAgentRegistrationSignature,
  getSapConnectionForIdentityRegistrar,
  getSapProgramForIdentityBridge,
  loadAvatarWalletForSigning,
  registerAgent,
  sapConfigSnapshot,
  type AgentProfile,
  type RegisterAgentInput,
  type SapFailure,
  type SapWriteResult,
} from './sap-client';
import { buildRegisterIdentityV1Instruction } from './sap-dreg-identity';

export const SAP_REGISTER_BALANCE_FLOOR_LAMPORTS = 60_000_000;
export const SAP_IDENTITY_REGISTRATION_BASE_URL = 'https://api.clawville.world';
const MAX_ATTEMPTS = 10;
const WORKER_BATCH = 50;
const POLL_MS_DEFAULT = 300_000;
const POLL_MS_FLOOR = 60_000;
const CLAIM_STALE_MS = 10 * 60_000;

type IdentityPatch = Partial<
  Pick<
    SapAgentIdentity,
    | 'status'
    | 'registerTxSig'
    | 'agentPda'
    | 'metaplexAsset'
    | 'identityRegistration'
    | 'metaplexTxSig'
    | 'attempts'
    | 'lastError'
    | 'updatedAt'
  >
>;

export interface SapIdentityAttachResult {
  ok: boolean;
  dryRun?: boolean;
  broadcast?: boolean;
  signature?: string;
  asset: string;
  identityRegistration?: string;
  registrationUrl: string;
  code?: string;
  message?: string;
}

export interface SapIdentityRegistrarDeps {
  getBalanceLamports(wallet: string): Promise<number>;
  fetchProfile(wallet: string): ReturnType<typeof fetchAgentProfile>;
  findRegistrationSignature(wallet: string): ReturnType<typeof findAgentRegistrationSignature>;
  register(input: RegisterAgentInput): Promise<SapWriteResult>;
  persistPatch(id: string, patch: IdentityPatch): Promise<SapAgentIdentity>;
  mintAndAttach(
    row: SapAgentIdentity,
    persistPreparedAsset: (asset: string, identityRegistration: string) => Promise<void>,
  ): Promise<SapIdentityAttachResult>;
  assetExists(asset: string): Promise<boolean>;
  findMetaplexTxSignature(asset: string, wallet: string): Promise<string | null>;
  verifyLink(row: SapAgentIdentity): Promise<boolean>;
  alert(params: AlertErrorParams): Promise<void>;
}

function registrationUrl(agentPda: string): string {
  return `${SAP_IDENTITY_REGISTRATION_BASE_URL}/agents/${agentPda}/eip-8004.json`;
}

function metadataUrl(agentPda: string): string {
  return `${SAP_IDENTITY_REGISTRATION_BASE_URL}/agents/${agentPda}/metadata.json`;
}

/** Pure route/SDK contract helper, exported for the immutable-URL unit test. */
export function buildSapIdentityRegistrationUrl(agentPda: string): string {
  return registrationUrl(agentPda);
}

/** Pure Core-metadata URL paired with the immutable EIP-8004 route above. */
export function buildSapIdentityMetadataUrl(agentPda: string): string {
  return metadataUrl(agentPda);
}

function bridge(): MetaplexBridge {
  return new MetaplexBridge(
    getSapProgramForIdentityBridge() as unknown as ConstructorParameters<typeof MetaplexBridge>[0],
  );
}

async function persistPatch(id: string, patch: IdentityPatch): Promise<SapAgentIdentity> {
  const [updated] = await db
    .update(sapAgentIdentities)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(sapAgentIdentities.id, id))
    .returning();
  if (!updated) throw new Error(`SAP identity row ${id} disappeared during processing.`);
  return updated;
}

async function mintAndAttach(
  row: SapAgentIdentity,
  persistPreparedAsset: (asset: string, identityRegistration: string) => Promise<void>,
): Promise<SapIdentityAttachResult> {
  try {
    const owner = await loadAvatarWalletForSigning(row.avatarId);
    if (!('keypair' in owner)) {
      return {
        ok: false,
        asset: row.metaplexAsset ?? '',
        registrationUrl: registrationUrl(row.agentPda),
        code: owner.code,
        message: owner.message,
      };
    }
    if (!owner.publicKey.equals(new PublicKey(row.wallet))) {
      return {
        ok: false,
        asset: row.metaplexAsset ?? '',
        registrationUrl: registrationUrl(row.agentPda),
        code: 'wallet_mismatch',
        message: 'Custodial wallet no longer matches the queued SAP identity owner.',
      };
    }

    const sdk = bridge();
    const agentPda = new PublicKey(row.agentPda);
    const expectedUrl = registrationUrl(row.agentPda);
    const derivedUrl = sdk.deriveRegistrationUrl(agentPda, SAP_IDENTITY_REGISTRATION_BASE_URL);
    if (derivedUrl !== expectedUrl) {
      throw new Error(`Metaplex registration URL drift: ${derivedUrl}`);
    }
    const cfg = sapConfigSnapshot();
    const built = await sdk.buildMintAndAttachIxs({
      sapAgentOwner: owner.publicKey,
      authority: owner.publicKey,
      payer: owner.publicKey,
      owner: owner.publicKey,
      name: row.name,
      metadataUri: metadataUrl(row.agentPda),
      registrationBaseUrl: SAP_IDENTITY_REGISTRATION_BASE_URL,
      rpcUrl: cfg.rpcUrl,
    });
    if (built.registrationUrl !== expectedUrl) {
      throw new Error(`Metaplex builder registration URL drift: ${built.registrationUrl}`);
    }
    const createAssetInstruction = built.instructions[0];
    if (!createAssetInstruction) {
      throw new Error('Metaplex builder returned no CreateV2 instruction.');
    }

    const asset = built.assetAddress.toBase58();
    const registerIdentity = buildRegisterIdentityV1Instruction({
      asset: built.assetAddress,
      owner: owner.publicKey,
      registrationUrl: expectedUrl,
    });
    const identityRegistration = registerIdentity.identityPda.toBase58();
    await persistPreparedAsset(asset, identityRegistration);
    const transaction = new Transaction().add(
      createAssetInstruction,
      registerIdentity.instruction,
    );
    const sent = await executeSapIdentityAttachTx({
      transaction,
      ownerSigner: owner.keypair,
      assetSigner: Keypair.fromSecretKey(built.assetSecretKey),
      accounts: {
        wallet: row.wallet,
        agent: row.agentPda,
        metaplexAsset: asset,
      },
    });
    if (!sent.ok) {
      return {
        ok: false,
        asset,
        identityRegistration,
        registrationUrl: expectedUrl,
        code: sent.code,
        message: sent.message,
        broadcast: sent.broadcast,
        signature: sent.signature,
      };
    }
    if (sent.dryRun) {
      return {
        ok: true,
        dryRun: true,
        asset,
        identityRegistration,
        registrationUrl: expectedUrl,
      };
    }
    return {
      ok: true,
      dryRun: false,
      signature: sent.signature,
      asset,
      identityRegistration,
      registrationUrl: expectedUrl,
    };
  } catch (err) {
    const failure = classifyChainError('attachAgentIdentity:build', err);
    return {
      ok: false,
      asset: row.metaplexAsset ?? '',
      registrationUrl: registrationUrl(row.agentPda),
      code: failure.code,
      message: failure.message,
    };
  }
}

async function verifyLink(row: SapAgentIdentity): Promise<boolean> {
  if (!row.metaplexAsset) return false;
  return bridge().verifyLink({
    asset: new PublicKey(row.metaplexAsset),
    sapAgentPda: new PublicKey(row.agentPda),
    rpcUrl: sapConfigSnapshot().rpcUrl,
  });
}

async function findMetaplexTxSignature(asset: string, wallet: string): Promise<string | null> {
  const connection = getSapConnectionForIdentityRegistrar();
  const assetKey = new PublicKey(asset);
  const walletKey = new PublicKey(wallet);
  const signatures = await connection.getSignaturesForAddress(
    assetKey,
    { limit: 20 },
    'confirmed',
  );
  const successful = signatures.filter((item) => item.err == null);
  if (successful.length === 0) return null;
  const parsed = await connection.getParsedTransactions(
    successful.map((item) => item.signature),
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  );
  for (let index = 0; index < parsed.length; index += 1) {
    const tx = parsed[index];
    const signature = successful[index]?.signature;
    if (!tx || !signature || tx.meta?.err || !isRealSignature(signature)) continue;
    const ownerSigned = tx.transaction.message.accountKeys.some(
      (key) => key.signer && key.pubkey.equals(walletKey),
    );
    const assetSigned = tx.transaction.message.accountKeys.some(
      (key) => key.signer && key.pubkey.equals(assetKey),
    );
    // Core create requires the ephemeral asset keypair as a signer. Requiring
    // both signers excludes later owner-signed rename/update transactions from
    // being misidentified as the mint+attach proof.
    if (ownerSigned && assetSigned) return signature;
  }
  return null;
}

const defaultDeps: SapIdentityRegistrarDeps = {
  getBalanceLamports: async (wallet) =>
    getSapConnectionForIdentityRegistrar().getBalance(new PublicKey(wallet), 'confirmed'),
  fetchProfile: fetchAgentProfile,
  findRegistrationSignature: findAgentRegistrationSignature,
  register: registerAgent,
  persistPatch,
  mintAndAttach,
  assetExists: async (asset) =>
    (await getSapConnectionForIdentityRegistrar().getAccountInfo(
      new PublicKey(asset),
      'confirmed',
    )) !== null,
  findMetaplexTxSignature,
  verifyLink,
  alert: alertError,
};

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isAlreadyRegisteredFailure(result: SapFailure): boolean {
  if (result.code !== 'on_chain_error') return false;
  const message = result.message.toLowerCase();
  return (
    message.includes('already in use') ||
    message.includes('already initialized') ||
    message.includes('already registered') ||
    message.includes('accountalreadyinitialized') ||
    message.includes('custom program error: 0x0')
  );
}

function isRealSignature(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

async function recordFailure(
  row: SapAgentIdentity,
  message: string,
  retryStatus: SapAgentIdentity['status'],
  deps: SapIdentityRegistrarDeps,
  patch: IdentityPatch = {},
): Promise<SapAgentIdentity> {
  const attempts = Math.min(MAX_ATTEMPTS, row.attempts + 1);
  const terminal = attempts >= MAX_ATTEMPTS;
  const updated = await deps.persistPatch(row.id, {
    ...patch,
    status: terminal ? 'failed' : retryStatus,
    attempts,
    lastError: message.slice(0, 2_000),
  });
  if (terminal) {
    try {
      await deps.alert({
        severity: 'critical',
        source: 'sap-identity-registrar',
        message: `SAP identity ${row.id} failed after ${attempts} attempts: ${message}`,
        context: { avatarId: row.avatarId, agentPda: row.agentPda, status: row.status },
      });
    } catch (err) {
      console.warn('[sap-identity-registrar] terminal alert failed (non-fatal):', messageOf(err));
    }
  }
  return updated;
}

type RegistrationStageOutcome =
  | { readyForAttach: true; row: SapAgentIdentity }
  | { readyForAttach: false; row: SapAgentIdentity };

async function adoptExistingProfile(
  row: SapAgentIdentity,
  profile: AgentProfile,
  deps: SapIdentityRegistrarDeps,
): Promise<RegistrationStageOutcome> {
  if (profile.wallet !== row.wallet || profile.agentPda !== row.agentPda) {
    const failed = await recordFailure(
      row,
      'On-chain SAP profile does not match the queued wallet/PDA.',
      'pending_funding',
      deps,
    );
    return { readyForAttach: false, row: failed };
  }
  const recovered = await deps.findRegistrationSignature(row.wallet);
  if (!recovered.ok || !isRealSignature(recovered.data)) {
    const failed = await recordFailure(
      row,
      recovered.ok
        ? 'SAP profile exists but its real register transaction signature could not be recovered.'
        : `SAP registration signature lookup failed: ${recovered.message}`,
      'pending_funding',
      deps,
    );
    return { readyForAttach: false, row: failed };
  }
  const registered = await deps.persistPatch(row.id, {
    status: 'registered',
    agentPda: profile.agentPda,
    registerTxSig: recovered.data,
    lastError: null,
  });
  return { readyForAttach: true, row: registered };
}

async function registerStage(
  row: SapAgentIdentity,
  deps: SapIdentityRegistrarDeps,
): Promise<RegistrationStageOutcome> {
  // Broadcast-unknown recovery: always probe before building another register.
  const profile = await deps.fetchProfile(row.wallet);
  if (!profile.ok) {
    const failed = await recordFailure(
      row,
      `SAP profile preflight failed: ${profile.message}`,
      'pending_funding',
      deps,
    );
    return { readyForAttach: false, row: failed };
  }
  if (profile.data) return adoptExistingProfile(row, profile.data, deps);

  const result = await deps.register({
    avatarId: row.avatarId,
    name: row.name,
    description: row.description,
    capabilities: row.capabilities,
    protocols: ['clawville'],
    agentUri: registrationUrl(row.agentPda),
  });
  if (result.ok) {
    if (result.dryRun) {
      const parked = await deps.persistPatch(row.id, {
        status: 'pending_funding',
        lastError: 'SAP_DRY_RUN simulated registration; no on-chain identity was recorded.',
      });
      return { readyForAttach: false, row: parked };
    }
    if (!isRealSignature(result.signature)) {
      const failed = await recordFailure(
        row,
        'SAP register returned no valid transaction signature.',
        'pending_funding',
        deps,
      );
      return { readyForAttach: false, row: failed };
    }
    const agentPda = result.accounts.agent;
    if (agentPda !== row.agentPda) {
      const failed = await recordFailure(
        row,
        'SAP register returned an unexpected AgentAccount PDA.',
        'pending_funding',
        deps,
      );
      return { readyForAttach: false, row: failed };
    }
    const registered = await deps.persistPatch(row.id, {
      status: 'registered',
      registerTxSig: result.signature,
      lastError: null,
    });
    return { readyForAttach: true, row: registered };
  }

  // A register race or an unknown post-broadcast outcome is adoptable, but only
  // after a fresh profile probe and recovery of the real historical signature.
  if (result.broadcast || isAlreadyRegisteredFailure(result)) {
    const reprobe = await deps.fetchProfile(row.wallet);
    if (reprobe.ok && reprobe.data) return adoptExistingProfile(row, reprobe.data, deps);
  }
  const failed = await recordFailure(
    row,
    `${result.code}: ${result.message}${result.signature ? ` (tx ${result.signature})` : ''}`,
    'pending_funding',
    deps,
  );
  return { readyForAttach: false, row: failed };
}

async function attachStage(
  row: SapAgentIdentity,
  deps: SapIdentityRegistrarDeps,
): Promise<SapAgentIdentity> {
  if (!isRealSignature(row.registerTxSig)) {
    return recordFailure(
      row,
      'Refusing Metaplex attach without a real confirmed SAP register signature.',
      'pending_funding',
      deps,
    );
  }

  if (row.metaplexAsset) {
    try {
      const exists = await deps.assetExists(row.metaplexAsset);
      if (!exists) {
        if (Date.now() - row.updatedAt.getTime() < CLAIM_STALE_MS) {
          return row;
        }
        // A signed tx can still have reverted on-chain. Only account existence,
        // not signature presence, proves the Core asset landed. After the stale
        // blockhash window an absent asset is safe to discard and mint afresh.
        return deps.persistPatch(row.id, {
          status: 'registered',
          metaplexAsset: null,
          identityRegistration: null,
          metaplexTxSig: null,
          lastError: 'Prepared Metaplex asset was absent after the stale window; mint will retry.',
        });
      }
      if (!isRealSignature(row.metaplexTxSig)) {
        const recovered = await deps.findMetaplexTxSignature(row.metaplexAsset, row.wallet);
        if (!isRealSignature(recovered)) {
          return recordFailure(
            row,
            'Metaplex asset exists but its real mint+attach transaction signature could not be recovered.',
            'attaching_identity',
            deps,
          );
        }
        row = await deps.persistPatch(row.id, { metaplexTxSig: recovered });
      }
    } catch (err) {
      return recordFailure(
        row,
        `Metaplex asset reconciliation failed: ${messageOf(err)}`,
        'attaching_identity',
        deps,
      );
    }
    try {
      if (await deps.verifyLink(row)) {
        return deps.persistPatch(row.id, { status: 'identity_attached', lastError: null });
      }
      return recordFailure(
        row,
        'Metaplex AgentIdentity link is not yet verifiable.',
        'attaching_identity',
        deps,
      );
    } catch (err) {
      return recordFailure(
        row,
        `Metaplex verifyLink failed: ${messageOf(err)}`,
        'attaching_identity',
        deps,
      );
    }
  }

  let working = row;
  const attached = await deps.mintAndAttach(row, async (asset, identityRegistration) => {
    working = await deps.persistPatch(row.id, {
      status: 'attaching_identity',
      metaplexAsset: asset,
      identityRegistration,
      lastError: null,
    });
  });
  if (!attached.ok) {
    // If nothing reached the wire, the generated asset can be discarded and a
    // later pass may build a fresh mint. After broadcast, retain it and verify.
    return recordFailure(
      working,
      `${attached.code ?? 'attach_failed'}: ${attached.message ?? 'Metaplex attach failed.'}`,
      attached.broadcast ? 'attaching_identity' : 'registered',
      deps,
      {
        metaplexAsset: attached.broadcast ? attached.asset : null,
        identityRegistration: attached.broadcast
          ? attached.identityRegistration ?? working.identityRegistration
          : null,
        metaplexTxSig: attached.broadcast ? attached.signature ?? null : null,
      },
    );
  }
  if (attached.dryRun) {
    return deps.persistPatch(row.id, {
      status: 'registered',
      metaplexAsset: null,
      identityRegistration: null,
      metaplexTxSig: null,
      lastError: 'SAP_DRY_RUN simulated Metaplex attach; no asset was minted.',
    });
  }
  if (!isRealSignature(attached.signature)) {
    return recordFailure(
      working,
      'Metaplex attach returned no valid transaction signature.',
      'attaching_identity',
      deps,
      { metaplexAsset: attached.asset, metaplexTxSig: null },
    );
  }
  working = await deps.persistPatch(row.id, {
    status: 'attaching_identity',
    metaplexAsset: attached.asset,
    identityRegistration: attached.identityRegistration ?? working.identityRegistration,
    metaplexTxSig: attached.signature ?? null,
  });
  try {
    if (await deps.verifyLink(working)) {
      return deps.persistPatch(row.id, { status: 'identity_attached', lastError: null });
    }
    return recordFailure(
      working,
      'Metaplex transaction confirmed but AgentIdentity link is not yet verifiable.',
      'attaching_identity',
      deps,
    );
  } catch (err) {
    return recordFailure(
      working,
      `Metaplex transaction confirmed; verifyLink failed: ${messageOf(err)}`,
      'attaching_identity',
      deps,
    );
  }
}

/** Process one already-claimed durable row. Exported as the unit-test seam. */
export async function processSapIdentityRow(
  row: SapAgentIdentity,
  deps: SapIdentityRegistrarDeps = defaultDeps,
): Promise<SapAgentIdentity> {
  if (row.status === 'identity_attached' || row.status === 'failed') return row;

  // A persisted asset needs only read-side reconciliation/verification. Do it
  // even when minting consumed the wallet below the 0.06-SOL send floor; requiring
  // a refill here would strand an already-confirmed link forever.
  if (row.metaplexAsset && isRealSignature(row.registerTxSig)) {
    return attachStage(row, deps);
  }

  let balance: number;
  try {
    balance = await deps.getBalanceLamports(row.wallet);
  } catch (err) {
    return recordFailure(
      row,
      `SOL balance preflight failed: ${messageOf(err)}`,
      row.registerTxSig ? 'registered' : 'pending_funding',
      deps,
    );
  }
  if (balance < SAP_REGISTER_BALANCE_FLOOR_LAMPORTS) {
    return deps.persistPatch(row.id, {
      status: isRealSignature(row.registerTxSig) ? 'registered' : 'pending_funding',
      lastError:
        `Waiting for ${SAP_REGISTER_BALANCE_FLOOR_LAMPORTS} lamports; current balance ${balance}.`,
    });
  }

  let working = row;
  if (!isRealSignature(working.registerTxSig)) {
    const registration = await registerStage(working, deps);
    if (!registration.readyForAttach) return registration.row;
    working = registration.row;
  }
  return attachStage(working, deps);
}

function extractDescription(
  avatarName: string,
  characterConfig: unknown,
  customization: unknown,
  agentConfig: unknown,
): string {
  const candidates: unknown[] = [];
  for (const source of [customization, agentConfig]) {
    if (source && typeof source === 'object') {
      candidates.push((source as Record<string, unknown>).description);
      candidates.push((source as Record<string, unknown>).bio);
    }
  }
  if (characterConfig && typeof characterConfig === 'object') {
    candidates.push((characterConfig as Record<string, unknown>).bio);
  }
  for (const candidate of candidates) {
    const text = Array.isArray(candidate) ? candidate.filter((v) => typeof v === 'string').join(' ') : candidate;
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 512);
  }
  return `${avatarName} — ClawVille agent (https://clawville.world)`.slice(0, 512);
}

async function enqueueSapIdentity(avatarId: string, triggerSource: string): Promise<void> {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.identityAutoregEnabled) return;
  const [subject] = await db
    .select({
      avatarId: avatars.id,
      avatarName: avatars.name,
      isGuest: avatars.isGuest,
      userIsGuest: users.isGuest,
      characterConfig: avatars.characterConfig,
      platformAgentName: platformAgents.name,
      platformCustomization: platformAgents.customization,
      platformConfig: platformAgents.config,
      wallet: wallets.publicKey,
    })
    .from(avatars)
    .innerJoin(users, eq(users.id, avatars.userId))
    .innerJoin(
      wallets,
      and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatars.id)),
    )
    .leftJoin(platformAgents, eq(platformAgents.id, avatars.platformAgentId))
    .where(eq(avatars.id, avatarId))
    .limit(1);
  if (!subject || subject.userIsGuest || subject.isGuest || !subject.wallet) return;

  const name = (subject.platformAgentName || subject.avatarName || 'ClawVille Agent').trim().slice(0, 64);
  const description = extractDescription(
    name,
    subject.characterConfig,
    subject.platformCustomization,
    subject.platformConfig,
  );
  const [agentPda] = findAgentPda(new PublicKey(cfg.programId), new PublicKey(subject.wallet));
  await db
    .insert(sapAgentIdentities)
    .values({
      avatarId: subject.avatarId,
      wallet: subject.wallet,
      agentPda: agentPda.toBase58(),
      cluster: cfg.cluster as 'devnet' | 'mainnet',
      status: 'pending_funding',
      name: name || 'ClawVille Agent',
      description: description || `${name || 'Agent'} — ClawVille agent (https://clawville.world)`,
      capabilities: [],
      triggerSource: triggerSource.trim().slice(0, 200) || 'economic_action',
    })
    .onConflictDoNothing({ target: sapAgentIdentities.avatarId });
}

/** Fire-and-forget admission. Errors are logged and never escape the caller. */
export function ensureSapIdentityQueued(avatarId: string, triggerSource: string): void {
  void enqueueSapIdentity(avatarId, triggerSource).catch((err) => {
    console.warn('[sap-identity-registrar] enqueue failed (non-fatal):', messageOf(err));
  });
}

function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
}

function rowDue(row: SapAgentIdentity, now: number): boolean {
  const age = now - row.updatedAt.getTime();
  if (row.status === 'registering') return age >= CLAIM_STALE_MS;
  if (row.status === 'attaching_identity') return age >= CLAIM_STALE_MS;
  return age >= retryDelayMs(row.attempts);
}

async function claimRow(
  candidate: SapAgentIdentity,
  cluster: 'devnet' | 'mainnet',
): Promise<SapAgentIdentity | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sap-identity:${candidate.avatarId}`}, 0))`,
    );
    const current = await tx.query.sapAgentIdentities.findFirst({
      where: eq(sapAgentIdentities.id, candidate.id),
    });
    if (!current || current.cluster !== cluster || !rowDue(current, Date.now())) return null;
    if (current.status === 'identity_attached' || current.status === 'failed') return null;
    const status =
      current.status === 'pending_funding'
        ? 'registering'
        : current.status === 'registered'
          ? 'attaching_identity'
          : current.status;
    const [claimed] = await tx
      .update(sapAgentIdentities)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(sapAgentIdentities.id, current.id), eq(sapAgentIdentities.status, current.status)))
      .returning();
    if (!claimed) return null;
    // Preserve the pre-claim age in-memory for crash-prepared reconciliation;
    // the DB timestamp was refreshed above so another pod cannot also claim it.
    return { ...claimed, updatedAt: current.updatedAt };
  });
}

/** One bounded durable sweep; rows are isolated so one failure never aborts the batch. */
export async function runSapIdentityRegistrarPass(
  deps: SapIdentityRegistrarDeps = defaultDeps,
): Promise<void> {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.identityAutoregEnabled) return;
  const candidates = await db
    .select()
    .from(sapAgentIdentities)
    .where(
      and(
        eq(sapAgentIdentities.cluster, cfg.cluster as 'devnet' | 'mainnet'),
        sql`${sapAgentIdentities.status} IN ('pending_funding', 'registering', 'registered', 'attaching_identity')`,
      ),
    )
    .orderBy(asc(sapAgentIdentities.updatedAt))
    .limit(WORKER_BATCH);

  for (const candidate of candidates) {
    try {
      await withKeyedMutex(`sap-identity:${candidate.avatarId}`, async () => {
        const claimed = await claimRow(candidate, cfg.cluster as 'devnet' | 'mainnet');
        if (claimed) await processSapIdentityRow(claimed, deps);
      });
    } catch (err) {
      console.error(`[sap-identity-registrar] row ${candidate.id} failed (non-fatal):`, messageOf(err));
    }
  }
}

function resolvePollMs(): number {
  const parsed = Number(process.env.SAP_IDENTITY_REGISTRAR_POLL_MS);
  return Number.isFinite(parsed) && parsed >= POLL_MS_FLOOR ? parsed : POLL_MS_DEFAULT;
}

let workerInterval: ReturnType<typeof setInterval> | null = null;

export function startSapIdentityRegistrarWorker(): void {
  if (workerInterval) return;
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.identityAutoregEnabled) return;
  const periodMs = resolvePollMs();
  void runSapIdentityRegistrarPass().catch((err) => {
    console.error('[sap-identity-registrar] initial pass failed (non-fatal):', messageOf(err));
  });
  workerInterval = setInterval(() => {
    void runSapIdentityRegistrarPass().catch((err) => {
      console.error('[sap-identity-registrar] worker pass failed (non-fatal):', messageOf(err));
    });
  }, periodMs);
  console.log(`[sap-identity-registrar] worker started (poll ${periodMs}ms)`);
}

export function stopSapIdentityRegistrarWorker(): void {
  if (!workerInterval) return;
  clearInterval(workerInterval);
  workerInterval = null;
}
