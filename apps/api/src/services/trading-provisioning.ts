import bs58 from 'bs58';
import {
  agentBots,
  and,
  avatars,
  clawpumpAgentLinks,
  db,
  eq,
  isNull,
  or,
  sql,
  tradingWallets,
  wallets,
} from '@clawville/database';
import {
  DEFAULT_AGENT_HARNESS,
  DEFAULT_AGENT_MODEL_KEY,
  getAgentModel,
  type TradingObjective,
} from '@clawville/shared';
import { activateAutonomyForOwner } from './agent-autonomy-activation';
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
  | 'already_linked';

export class TradingProvisioningError extends Error {
  constructor(
    readonly code: TradingProvisioningErrorCode,
    readonly status: 400 | 401 | 404 | 409 | 500,
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
