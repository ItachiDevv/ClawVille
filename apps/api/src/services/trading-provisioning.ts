import bs58 from 'bs58';
import {
  agentBots,
  and,
  avatars,
  clawpumpAgentLinks,
  db,
  eq,
  inArray,
  isNull,
  or,
  sql,
  tradingWallets,
  wallets,
  users,
  type TradingLink,
  type TradingWallet,
} from '@clawville/database';
import {
  DEFAULT_AGENT_HARNESS,
  DEFAULT_AGENT_MODEL_KEY,
  getAgentModel,
  type TradingObjective,
} from '@clawville/shared';
import { activateAutonomyForOwner } from './agent-autonomy-activation';
import { ClawPumpAgentMismatchError, ClawPumpClientError, clawPumpClient, type ClawPumpAgent, type ClawPumpAgentReader } from './clawpump-client';
import { withKeyedMutex } from './keyed-mutex';
import { provisionAvatarAgent } from './avatar-agent-provisioning';
import { ensureHostedAvatarAgentSession } from './hosted-avatar-agent-session';
import { identityFingerprint, resolveOrCreateUserByIdentity } from './identity-service';
import {
  bindClawPumpTradingWallet,
  bindCustodialTradingWallet,
  currentBindSlot,
  verifyTradingWalletOwnership,
} from './trading-wallets';
import { issueTradingWalletChallenge, tradingSubjectKey, type TradingSubject } from './trading-wallet-challenge';

const FLEET_IDENTITY_TYPE = 'clawville-fleet';

/** Immutable identity slots. Objective copy can change without changing identity. */
export const FLEET_SLOT_IDS: Record<TradingObjective, string> = {
  'momentum-board': 'trading-floor-slot-1',
  'ansem-clawville-dca': 'trading-floor-slot-2',
  'sol-usdc-mean-reversion': 'trading-floor-slot-3',
  'intel-signal-follower': 'trading-floor-slot-4',
  'conservative-rebalancer': 'trading-floor-slot-5',
};

export type TradingProvisioningErrorCode =
  | 'slot_occupied'
  | 'leaderboard_eligible_non_fleet'
  | 'wallet_proof_failed'
  | 'agent_session_failed'
  | 'autonomy_activation_failed'
  | 'avatar_not_found'
  | 'no_bound_clawville_agent'
  | 'agent_has_no_wallet'
  | 'ownership_proof_invalid'
  | 'already_linked'
  | 'clawpump_not_configured'
  | 'clawpump_unavailable'
  | 'clawpump_agent_not_owned'
  | 'avatar_not_observed_account'
  | 'not_observed_link';

export class TradingProvisioningError extends Error {
  constructor(
    readonly code: TradingProvisioningErrorCode,
    readonly status: 400 | 401 | 404 | 409 | 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'TradingProvisioningError';
  }
}

export interface TradingProvisioningDependencies {
  database: typeof db;
  resolveIdentity: typeof resolveOrCreateUserByIdentity;
  provisionAvatar: typeof provisionAvatarAgent;
  ensureHostedSession: typeof ensureHostedAvatarAgentSession;
  readBindSlot: typeof currentBindSlot;
  bindCustodialWallet: typeof bindCustodialTradingWallet;
  bindClawPumpWallet: typeof bindClawPumpTradingWallet;
  verifyWalletOwnership: typeof verifyTradingWalletOwnership;
  issueWalletChallenge: typeof issueTradingWalletChallenge;
  activateAutonomy: typeof activateAutonomyForOwner;
}

export const tradingProvisioningDependencies: TradingProvisioningDependencies = {
  database: db,
  resolveIdentity: resolveOrCreateUserByIdentity,
  provisionAvatar: provisionAvatarAgent,
  ensureHostedSession: ensureHostedAvatarAgentSession,
  readBindSlot: currentBindSlot,
  bindCustodialWallet: bindCustodialTradingWallet,
  bindClawPumpWallet: bindClawPumpTradingWallet,
  verifyWalletOwnership: verifyTradingWalletOwnership,
  issueWalletChallenge: issueTradingWalletChallenge,
  activateAutonomy: activateAutonomyForOwner,
};

function validWalletPubkey(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function fleetAvatarParams(traderName: string) {
  const model = getAgentModel(DEFAULT_AGENT_MODEL_KEY);
  if (!model) throw new Error(`Default fleet model '${DEFAULT_AGENT_MODEL_KEY}' is unavailable.`);
  return {
    name: traderName,
    species: 'fox' as const,
    color: 'blue' as const,
    gender: 'female' as const,
    archetypeId: 'cunning-trader' as const,
    personality: {
      habitat: 'sea' as const,
      hobby: 'reading-and-learning' as const,
      greeting: 'bow-politely' as const,
    },
    modelKey: DEFAULT_AGENT_MODEL_KEY,
    agentCategory: model.category,
    harness: DEFAULT_AGENT_HARNESS,
    learningFocus: 'Trading Floor risk controls and market analysis',
  };
}

export interface ProvisionFleetInput {
  objective: TradingObjective;
  traderName: string;
  leaderboardEligible: boolean;
  operatedByClawville: boolean;
}

export interface ProvisionFleetResult {
  ok: true;
  userId: string;
  avatarId: string;
  clawvilleAgentId: string;
  walletPubkey: string;
  objective: TradingObjective;
  armed: false;
  killed: true;
}

export async function provisionFleetAccount(
  input: ProvisionFleetInput,
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
): Promise<ProvisionFleetResult> {
  const slotId = FLEET_SLOT_IDS[input.objective];
  const expectedFingerprint = identityFingerprint(FLEET_IDENTITY_TYPE, slotId);
  const user = await deps.resolveIdentity(FLEET_IDENTITY_TYPE, slotId);

  if (user.identityFingerprint !== expectedFingerprint) {
    throw new TradingProvisioningError(
      'leaderboard_eligible_non_fleet',
      409,
      'Leaderboard policy can only be set during fleet provisioning.',
    );
  }

  const occupied = await deps.database.query.avatars.findFirst({
    where: eq(avatars.userId, user.id),
    columns: { id: true },
  });
  if (occupied) {
    throw new TradingProvisioningError('slot_occupied', 409, 'This fleet objective slot is occupied.');
  }

  const provisioned = await deps.provisionAvatar(user.id, fleetAvatarParams(input.traderName), {
    onNameCollision: 'suffix-retry',
    wallet: 'include-fatal',
    initialEconomy: 'zero',
    skipIfAvatarExists: true,
  });
  if (!provisioned.created || !provisioned.agentId) {
    throw new TradingProvisioningError('slot_occupied', 409, 'This fleet objective slot is occupied.');
  }

  // Keep only the public address. The one-time secret remains in local memory
  // until this call returns and is never logged, stored again, or serialized.
  const walletPubkey = provisioned.wallet?.address ?? provisioned.avatar.walletAddress;
  if (!walletPubkey) {
    throw new TradingProvisioningError('wallet_proof_failed', 500, 'Fleet wallet provisioning failed.');
  }

  // This creates the required openclaw_bots row and server-only session.
  // It does not enroll the autonomy driver. Activation remains the last step.
  const hosted = await deps.ensureHostedSession(provisioned.agentId);
  if (!hosted || hosted.agentId !== provisioned.agentId) {
    throw new TradingProvisioningError('agent_session_failed', 500, 'Fleet agent session provisioning failed.');
  }

  // RPC stays outside the database transaction. The bind receives this value.
  const boundSlot = await deps.readBindSlot();
  await deps.database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${provisioned.avatar.id}`}, 0))`);
    const [wallet] = await tx
      .select({
        publicKey: wallets.publicKey,
        subjectType: wallets.subjectType,
        subjectId: wallets.subjectId,
        custodyVerified: wallets.custodyVerified,
      })
      .from(wallets)
      .where(and(
        eq(wallets.subjectType, 'avatar'),
        eq(wallets.subjectId, provisioned.avatar.id),
        eq(wallets.publicKey, walletPubkey),
        eq(wallets.custodyVerified, true),
      ))
      .for('update')
      .limit(1);
    if (!wallet
      || wallet.subjectType !== 'avatar'
      || wallet.subjectId !== provisioned.avatar.id
      || wallet.publicKey !== walletPubkey
      || wallet.custodyVerified !== true) {
      throw new TradingProvisioningError('wallet_proof_failed', 500, 'Fleet wallet custody proof failed.');
    }

    const updatedAgent = await tx
      .update(agentBots)
      .set({ leaderboardEligible: input.leaderboardEligible, isHouse: false, updatedAt: new Date() })
      .where(and(eq(agentBots.agentId, hosted.agentId), eq(agentBots.userId, user.id)))
      .returning({ agentId: agentBots.agentId });
    if (updatedAgent.length !== 1) {
      throw new TradingProvisioningError('agent_session_failed', 500, 'Fleet agent binding changed.');
    }

    const subject = {
      kind: 'agent' as const,
      userId: user.id,
      avatarId: provisioned.avatar.id,
      agentId: hosted.agentId,
    };
    const bound = await deps.bindCustodialWallet({
      subject,
      operatedByClawville: true,
      tx,
      boundSlot,
    });
    if (bound.pubkey !== walletPubkey
      || bound.subjectKind !== 'agent'
      || bound.agentId !== hosted.agentId
      || bound.avatarId !== provisioned.avatar.id) {
      throw new TradingProvisioningError('wallet_proof_failed', 500, 'Fleet wallet binding changed.');
    }

    await tx.insert(clawpumpAgentLinks).values({
      avatarId: provisioned.avatar.id,
      userId: user.id,
      clawvilleAgentId: hosted.agentId,
      clawpumpAgentId: null,
      walletPubkey,
      objective: input.objective,
      armed: false,
      killed: true,
      floatStartLamports: '0',
      floatStartUsdMicros: '0',
      baselineSlot: null,
      baselineEvidence: null,
      operatedByClawville: true,
    });
  });

  try {
    const activation = await deps.activateAutonomy(user.id);
    if (!activation.ok) {
      throw new TradingProvisioningError(
        'autonomy_activation_failed',
        500,
        `Fleet autonomy activation failed: ${activation.code}`,
      );
    }
  } catch (error) {
    await deps.database
      .update(clawpumpAgentLinks)
      .set({ killed: true, updatedAt: new Date() })
      .where(eq(clawpumpAgentLinks.avatarId, provisioned.avatar.id));
    if (error instanceof TradingProvisioningError
      && error.code === 'autonomy_activation_failed') {
      throw error;
    }
    throw new TradingProvisioningError(
      'autonomy_activation_failed',
      500,
      'Fleet autonomy activation failed.',
    );
  }

  return {
    ok: true,
    userId: user.id,
    avatarId: provisioned.avatar.id,
    clawvilleAgentId: hosted.agentId,
    walletPubkey,
    objective: input.objective,
    armed: false,
    killed: true,
  };
}

/** Identity namespace of the dedicated account that carries one observed ClawPump agent.
 *  Not a public connect identity type, so no /api/agent/connect caller can mint it. */
export const CLAWPUMP_OBSERVED_IDENTITY_TYPE = 'clawpump-observed' as const;

export function observedAvatarName(name: string | null): string {
  const cleaned = (name ?? '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20);
  return cleaned.length >= 3 ? cleaned : 'ClawPumpTrader';
}

function clawPumpFailure(error: unknown): TradingProvisioningError {
  if (error instanceof TradingProvisioningError) return error;
  if (error instanceof ClawPumpAgentMismatchError) {
    return new TradingProvisioningError('clawpump_agent_not_owned', 404, 'The ClawPump agent reads disagree.');
  }
  if (error instanceof ClawPumpClientError) {
    if (error.code === 'not_configured' || error.code === 'invalid_base_url') {
      return new TradingProvisioningError('clawpump_not_configured', 503, 'The ClawPump API is not configured.');
    }
    if (error.code === 'not_found' || error.code === 'invalid_agent_id') {
      return new TradingProvisioningError('clawpump_agent_not_owned', 404, 'The ClawPump agent is not in the key account.');
    }
    return new TradingProvisioningError('clawpump_unavailable', 503, `The ClawPump read failed (${error.code}).`);
  }
  return new TradingProvisioningError('clawpump_unavailable', 503, 'The ClawPump read failed.');
}

/** Ownership proof: the agent is listed by the key's own account, and both reads agree. */
export async function readOwnedClawPumpAgent(
  clawpumpAgentId: string,
  clawpump: ClawPumpAgentReader = clawPumpClient,
): Promise<{ agent: ClawPumpAgent; walletPubkey: string }> {
  let listed: ClawPumpAgent | undefined;
  let single: ClawPumpAgent;
  try {
    listed = (await clawpump.listAgents()).find((agent) => agent.id === clawpumpAgentId);
    if (!listed) throw new TradingProvisioningError('clawpump_agent_not_owned', 404, 'The ClawPump agent is not in the key account.');
    single = await clawpump.getAgent(clawpumpAgentId);
  } catch (error) {
    throw clawPumpFailure(error);
  }
  if (single.id !== clawpumpAgentId || (listed.userId && single.userId && listed.userId !== single.userId)) {
    throw new TradingProvisioningError('clawpump_agent_not_owned', 404, 'The ClawPump agent reads disagree.');
  }
  const walletPubkey = listed.walletAddress ?? '';
  if (!walletPubkey || single.walletAddress !== walletPubkey || !validWalletPubkey(walletPubkey)) {
    throw new TradingProvisioningError('agent_has_no_wallet', 409, 'The ClawPump agent has no consistent Solana wallet.');
  }
  return { agent: listed, walletPubkey };
}

export interface ObservedClawPumpAgentRow {
  clawpumpAgentId: string; name: string | null; status: string | null;
  walletPubkey: string | null; pairedAvatarId: string | null;
}

export async function listObservedClawPumpAgents(
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
  clawpump: ClawPumpAgentReader = clawPumpClient,
): Promise<{ agents: ObservedClawPumpAgentRow[] }> {
  let agents: ClawPumpAgent[];
  try { agents = await clawpump.listAgents(); } catch (error) { throw clawPumpFailure(error); }
  const ids = agents.map((agent) => agent.id);
  const links = ids.length === 0 ? [] : await deps.database
    .select({ avatarId: clawpumpAgentLinks.avatarId, clawpumpAgentId: clawpumpAgentLinks.clawpumpAgentId })
    .from(clawpumpAgentLinks)
    .where(and(inArray(clawpumpAgentLinks.clawpumpAgentId, ids), eq(clawpumpAgentLinks.operatedByClawville, false)))
    .limit(200);
  return {
    agents: agents.map((agent) => ({
      clawpumpAgentId: agent.id, name: agent.name, status: agent.status, walletPubkey: agent.walletAddress,
      pairedAvatarId: links.find((link) => link.clawpumpAgentId === agent.id)?.avatarId ?? null,
    })),
  };
}

export interface ProvisionObservedResult {
  ok: true; created: boolean; userId: string; avatarId: string; avatarName: string;
  clawvilleAgentId: string; clawpumpAgentId: string; walletPubkey: string;
}

/** Idempotent. Never creates a ClawVille custodial wallet and never activates autonomy. */
export async function provisionObservedClawPumpAccount(
  input: { clawpumpAgentId: string },
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
  clawpump: ClawPumpAgentReader = clawPumpClient,
): Promise<ProvisionObservedResult> {
  const { agent, walletPubkey } = await readOwnedClawPumpAgent(input.clawpumpAgentId, clawpump);
  return withKeyedMutex(`clawpump-observed:${input.clawpumpAgentId}`, async () => {
    const user = await deps.resolveIdentity(CLAWPUMP_OBSERVED_IDENTITY_TYPE, input.clawpumpAgentId);
    if (user.identityFingerprint !== identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, input.clawpumpAgentId)) {
      throw new TradingProvisioningError('avatar_not_observed_account', 409, 'The observed identity does not match.');
    }
    const provisioned = await deps.provisionAvatar(user.id, fleetAvatarParams(observedAvatarName(agent.name)), {
      onNameCollision: 'suffix-retry',
      wallet: 'skip',
      initialEconomy: 'zero',
      skipIfAvatarExists: true,
    });
    const agentId = provisioned.agentId ?? provisioned.avatar.platformAgentId ?? null;
    if (!agentId) throw new TradingProvisioningError('agent_session_failed', 500, 'The observed account has no ClawVille agent.');
    // Creates the openclaw_bots row that agent-kind scoring needs (FK target). Same call as the fleet.
    const hosted = await deps.ensureHostedSession(agentId);
    if (!hosted || hosted.agentId !== agentId) {
      throw new TradingProvisioningError('agent_session_failed', 500, 'Observed agent session provisioning failed.');
    }
    const updated = await deps.database
      .update(agentBots)
      .set({ leaderboardEligible: true, isHouse: false, updatedAt: new Date() })
      .where(and(eq(agentBots.agentId, agentId), eq(agentBots.userId, user.id)))
      .returning({ agentId: agentBots.agentId });
    if (updated.length !== 1) throw new TradingProvisioningError('agent_session_failed', 500, 'Observed agent binding changed.');
    return {
      ok: true, created: provisioned.created, userId: user.id, avatarId: provisioned.avatar.id,
      avatarName: provisioned.avatar.name, clawvilleAgentId: agentId,
      clawpumpAgentId: input.clawpumpAgentId, walletPubkey,
    };
  });
}

export type ObservedPairState = 'fresh' | 'replay' | 'conflict';

/** Pure. `replay` only when BOTH rows exist once and match every field exactly. */
export function classifyObservedPairState(input: {
  wallets: Array<Pick<TradingWallet, 'avatarId' | 'pubkey' | 'source' | 'operatedByClawville' | 'subjectKind' | 'agentId' | 'metadata'>>;
  links: Array<Pick<TradingLink, 'avatarId' | 'clawpumpAgentId' | 'walletPubkey' | 'operatedByClawville' | 'armed' | 'objective'>>;
  avatarId: string; agentId: string; clawpumpAgentId: string; walletPubkey: string; objective: string;
}): ObservedPairState {
  if (input.wallets.length === 0 && input.links.length === 0) return 'fresh';
  const [wallet] = input.wallets;
  const [link] = input.links;
  const walletMatches = input.wallets.length === 1 && wallet.avatarId === input.avatarId
    && wallet.pubkey === input.walletPubkey && wallet.source === 'clawpump' && wallet.operatedByClawville === false
    && wallet.subjectKind === 'agent' && wallet.agentId === input.agentId
    && (wallet.metadata as { clawpumpAgentId?: unknown } | null)?.clawpumpAgentId === input.clawpumpAgentId;
  const linkMatches = input.links.length === 1 && link.avatarId === input.avatarId
    && link.clawpumpAgentId === input.clawpumpAgentId && link.walletPubkey === input.walletPubkey
    && link.operatedByClawville === false && link.armed === false && link.objective === input.objective;
  return walletMatches && linkMatches ? 'replay' : 'conflict';
}

export interface PairObservedInput { avatarId: string; clawpumpAgentId: string; objective: TradingObjective }
export interface PairObservedResult {
  ok: true; replayed: boolean; subjectKind: 'agent'; avatarId: string; clawvilleAgentId: string;
  clawpumpAgentId: string; walletPubkey: string; objective: TradingObjective;
  operatedByClawville: false; boundSlot: number;
}

async function resolveObservedSubject(input: PairObservedInput, deps: TradingProvisioningDependencies) {
  const [avatar] = await deps.database.select({ id: avatars.id, userId: avatars.userId, platformAgentId: avatars.platformAgentId })
    .from(avatars).where(eq(avatars.id, input.avatarId)).limit(1);
  if (!avatar) throw new TradingProvisioningError('avatar_not_found', 404, 'The avatar does not exist.');
  const [owner] = await deps.database.select({ fingerprint: users.identityFingerprint, isGuest: users.isGuest })
    .from(users).where(eq(users.id, avatar.userId)).limit(1);
  if (!owner || owner.isGuest
    || owner.fingerprint !== identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, input.clawpumpAgentId)) {
    throw new TradingProvisioningError('avatar_not_observed_account', 409, 'The avatar is not the observed account for this ClawPump agent.');
  }
  if (!avatar.platformAgentId) throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  const [bot] = await deps.database.select({ agentId: agentBots.agentId }).from(agentBots)
    .where(and(eq(agentBots.agentId, avatar.platformAgentId), eq(agentBots.userId, avatar.userId))).limit(1);
  if (!bot) throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  return { kind: 'agent' as const, userId: avatar.userId, avatarId: avatar.id, agentId: bot.agentId };
}

export async function pairObservedClawPumpAgent(
  input: PairObservedInput,
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
  clawpump: ClawPumpAgentReader = clawPumpClient,
): Promise<PairObservedResult> {
  const { walletPubkey } = await readOwnedClawPumpAgent(input.clawpumpAgentId, clawpump); // network: outside tx
  const subject = await resolveObservedSubject(input, deps);
  const boundSlot = await deps.readBindSlot();                                               // RPC: outside tx
  try {
    return await deps.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-clawpump:${input.clawpumpAgentId}`}, 0))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${input.avatarId}`}, 0))`);
      const [avatar] = await tx.select({ id: avatars.id, userId: avatars.userId, platformAgentId: avatars.platformAgentId })
        .from(avatars).where(eq(avatars.id, input.avatarId)).for('update').limit(1);
      if (!avatar || avatar.userId !== subject.userId || avatar.platformAgentId !== subject.agentId) {
        throw new TradingProvisioningError('ownership_proof_invalid', 409, 'The observed account changed.');
      }
      const walletRows = await tx.select().from(tradingWallets).where(and(
        isNull(tradingWallets.revokedAt),
        or(
          eq(tradingWallets.pubkey, walletPubkey),
          eq(tradingWallets.avatarId, avatar.id),
          sql`${tradingWallets.metadata}->>'clawpumpAgentId' = ${input.clawpumpAgentId}`,
        ),
      )).limit(10);
      const linkRows = await tx.select().from(clawpumpAgentLinks).where(or(
        eq(clawpumpAgentLinks.avatarId, avatar.id),
        eq(clawpumpAgentLinks.clawpumpAgentId, input.clawpumpAgentId),
        eq(clawpumpAgentLinks.walletPubkey, walletPubkey),
      )).limit(10);
      const state = classifyObservedPairState({
        wallets: walletRows, links: linkRows, avatarId: avatar.id, agentId: subject.agentId,
        clawpumpAgentId: input.clawpumpAgentId, walletPubkey, objective: input.objective,
      });
      const result = (replayed: boolean, slot: number): PairObservedResult => ({
        ok: true, replayed, subjectKind: 'agent', avatarId: avatar.id, clawvilleAgentId: subject.agentId,
        clawpumpAgentId: input.clawpumpAgentId, walletPubkey, objective: input.objective,
        operatedByClawville: false, boundSlot: slot,
      });
      if (state === 'replay') return result(true, walletRows[0]!.boundSlot);
      if (state === 'conflict') throw new TradingProvisioningError('already_linked', 409, 'A conflicting wallet or link exists. Unpair first.');
      const bound = await deps.bindClawPumpWallet({
        subject, walletPubkey, clawpumpAgentId: input.clawpumpAgentId, objective: input.objective,
        operatedByClawville: false, boundSlot, tx,
      });
      if (bound.pubkey !== walletPubkey || bound.source !== 'clawpump' || bound.operatedByClawville !== false
        || bound.subjectKind !== 'agent' || bound.agentId !== subject.agentId || bound.avatarId !== avatar.id) {
        throw new TradingProvisioningError('already_linked', 409, 'The observed binding changed.');
      }
      await tx.insert(clawpumpAgentLinks).values({
        avatarId: avatar.id,
        userId: avatar.userId,
        clawvilleAgentId: subject.agentId,
        clawpumpAgentId: input.clawpumpAgentId,
        walletPubkey,
        objective: input.objective,
        armed: false,
        killed: true,
        floatStartLamports: '0',
        floatStartUsdMicros: '0',
        baselineSlot: null,
        baselineEvidence: null,
        operatedByClawville: false,
      });
      return result(false, bound.boundSlot);
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') throw new TradingProvisioningError('already_linked', 409, 'A conflicting wallet or link exists. Unpair first.');
    throw error;
  }
}

export interface UnpairObservedResult {
  ok: true; alreadyUnpaired: boolean; avatarId: string; clawpumpAgentId: string; walletPubkey: string | null;
}

/** Stops future observation. Keeps trade history and earned points. No ClawPump call. */
export async function unpairObservedClawPumpAgent(
  input: { avatarId: string; clawpumpAgentId: string },
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
): Promise<UnpairObservedResult> {
  return deps.database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-clawpump:${input.clawpumpAgentId}`}, 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${input.avatarId}`}, 0))`);
    const [link] = await tx.select().from(clawpumpAgentLinks).where(and(
      eq(clawpumpAgentLinks.avatarId, input.avatarId),
      eq(clawpumpAgentLinks.clawpumpAgentId, input.clawpumpAgentId),
    )).for('update').limit(1);
    if (link && (link.operatedByClawville || link.armed)) {
      throw new TradingProvisioningError('not_observed_link', 409, 'Only an observe-only ClawPump link can be unpaired here.');
    }
    const revoked = await tx.update(tradingWallets).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(tradingWallets.avatarId, input.avatarId),
      eq(tradingWallets.source, 'clawpump'),
      eq(tradingWallets.operatedByClawville, false),
      isNull(tradingWallets.revokedAt),
      sql`${tradingWallets.metadata}->>'clawpumpAgentId' = ${input.clawpumpAgentId}`,
    )).returning({ pubkey: tradingWallets.pubkey });
    if (link) {
      await tx.delete(clawpumpAgentLinks).where(and(
        eq(clawpumpAgentLinks.avatarId, input.avatarId),
        eq(clawpumpAgentLinks.clawpumpAgentId, input.clawpumpAgentId),
        eq(clawpumpAgentLinks.operatedByClawville, false),
        eq(clawpumpAgentLinks.armed, false),
      ));
    }
    return {
      ok: true, alreadyUnpaired: !link && revoked.length === 0, avatarId: input.avatarId,
      clawpumpAgentId: input.clawpumpAgentId, walletPubkey: link?.walletPubkey ?? revoked[0]?.pubkey ?? null,
    };
  });
}

export interface PairFounderInput {
  avatarId: string;
  clawpumpAgentId: string;
  walletPubkey: string;
  objective: TradingObjective;
  nonce: string;
  signature: string;
}

export interface PairFounderResult {
  ok: true;
  subjectKind: 'agent';
  avatarId: string;
  clawvilleAgentId: string;
  clawpumpAgentId: string;
  walletPubkey: string;
  objective: TradingObjective;
  operatedByClawville: boolean;
}

async function resolveFounderTradingSubject(
  avatarId: string,
  deps: TradingProvisioningDependencies,
): Promise<TradingSubject> {
  const avatar = await deps.database.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
    columns: { id: true, userId: true, platformAgentId: true },
  });
  if (!avatar) throw new TradingProvisioningError('avatar_not_found', 404, 'The avatar does not exist.');
  if (!avatar.platformAgentId) throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  const bot = await deps.database.query.agentBots.findFirst({
    where: and(eq(agentBots.agentId, avatar.platformAgentId), eq(agentBots.userId, avatar.userId)),
    columns: { agentId: true },
  });
  if (!bot) throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  return { kind: 'agent', userId: avatar.userId, avatarId: avatar.id, agentId: bot.agentId };
}

export async function issueFounderPairChallenge(
  input: { avatarId: string; walletPubkey: string },
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
) {
  if (!validWalletPubkey(input.walletPubkey)) {
    throw new TradingProvisioningError('agent_has_no_wallet', 400, 'The observed agent has no valid wallet.');
  }
  const subject = await resolveFounderTradingSubject(input.avatarId, deps);
  return deps.issueWalletChallenge(tradingSubjectKey(subject), input.walletPubkey);
}

export async function pairFounderAgent(
  input: PairFounderInput,
  deps: TradingProvisioningDependencies = tradingProvisioningDependencies,
): Promise<PairFounderResult> {
  const walletPubkey = input.walletPubkey.trim();
  if (!walletPubkey || !validWalletPubkey(walletPubkey)) {
    throw new TradingProvisioningError('agent_has_no_wallet', 400, 'The observed agent has no valid wallet.');
  }

  const preflightAvatar = await deps.database.query.avatars.findFirst({
    where: eq(avatars.id, input.avatarId),
    columns: { id: true, userId: true, platformAgentId: true },
  });
  if (!preflightAvatar) {
    throw new TradingProvisioningError('avatar_not_found', 404, 'The avatar does not exist.');
  }
  if (!preflightAvatar.platformAgentId) {
    throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  }
  const preflightBot = await deps.database.query.agentBots.findFirst({
    where: and(
      eq(agentBots.agentId, preflightAvatar.platformAgentId),
      eq(agentBots.userId, preflightAvatar.userId),
    ),
    columns: { id: true },
  });
  if (!preflightBot) {
    throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
  }
  try {
    deps.verifyWalletOwnership({
      subject: { kind: 'agent', userId: preflightAvatar.userId, avatarId: preflightAvatar.id, agentId: preflightAvatar.platformAgentId },
      walletPubkey,
      nonce: input.nonce,
      signature: input.signature,
    });
  } catch {
    throw new TradingProvisioningError('ownership_proof_invalid', 401, 'The wallet ownership proof is invalid.');
  }
  const preflightExisting = await deps.database.query.tradingWallets.findFirst({
    where: and(
      isNull(tradingWallets.revokedAt),
      or(
        eq(tradingWallets.pubkey, walletPubkey),
        eq(tradingWallets.avatarId, input.avatarId),
        sql`${tradingWallets.metadata}->>'clawpumpAgentId' = ${input.clawpumpAgentId}`,
      ),
    ),
    columns: { id: true },
  });
  if (preflightExisting) {
    throw new TradingProvisioningError('already_linked', 409, 'This observed agent is already linked.');
  }

  // Read the slot before the transaction. Pairing never performs provider work
  // while it holds the trading-wallet advisory lock.
  const boundSlot = await deps.readBindSlot();
  const result = await deps.database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-clawpump:${input.clawpumpAgentId}`}, 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${input.avatarId}`}, 0))`);
    const [avatar] = await tx
      .select({ id: avatars.id, userId: avatars.userId, platformAgentId: avatars.platformAgentId })
      .from(avatars)
      .where(eq(avatars.id, input.avatarId))
      .for('update')
      .limit(1);
    if (!avatar) {
      throw new TradingProvisioningError('avatar_not_found', 404, 'The avatar does not exist.');
    }
    if (!avatar.platformAgentId) {
      throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
    }
    if (avatar.platformAgentId !== preflightAvatar.platformAgentId) {
      throw new TradingProvisioningError('ownership_proof_invalid', 401, 'The wallet ownership subject changed.');
    }

    const [bot] = await tx
      .select({ agentId: agentBots.agentId })
      .from(agentBots)
      .where(and(eq(agentBots.agentId, avatar.platformAgentId), eq(agentBots.userId, avatar.userId)))
      .limit(1);
    if (!bot) {
      throw new TradingProvisioningError('no_bound_clawville_agent', 400, 'No ClawVille agent is bound.');
    }

    const existing = await tx
      .select({ id: tradingWallets.id })
      .from(tradingWallets)
      .where(and(
        isNull(tradingWallets.revokedAt),
        or(
          eq(tradingWallets.pubkey, walletPubkey),
          eq(tradingWallets.avatarId, avatar.id),
          sql`${tradingWallets.metadata}->>'clawpumpAgentId' = ${input.clawpumpAgentId}`,
        ),
      ))
      .limit(1);
    if (existing[0]) {
      throw new TradingProvisioningError('already_linked', 409, 'This observed agent is already linked.');
    }

    const bound = await deps.bindClawPumpWallet({
      subject: {
        kind: 'agent',
        userId: avatar.userId,
        avatarId: avatar.id,
        agentId: bot.agentId,
      },
      walletPubkey,
      clawpumpAgentId: input.clawpumpAgentId,
      objective: input.objective,
      operatedByClawville: false,
      boundSlot,
      tx,
    });
    if (bound.pubkey !== walletPubkey
      || bound.source !== 'clawpump'
      || bound.subjectKind !== 'agent'
      || bound.avatarId !== avatar.id
      || bound.agentId !== bot.agentId) {
      throw new TradingProvisioningError('already_linked', 409, 'This observed agent is already linked.');
    }
    return { avatar, bot, bound };
  });

  return {
    ok: true,
    subjectKind: 'agent',
    avatarId: result.avatar.id,
    clawvilleAgentId: result.bot.agentId,
    clawpumpAgentId: input.clawpumpAgentId,
    walletPubkey: result.bound.pubkey,
    objective: input.objective,
    operatedByClawville: result.bound.operatedByClawville,
  };
}
