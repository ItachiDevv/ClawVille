/**
 * The AI that powers a hosted agent (MCP hub step 4, "own AI" part A).
 *
 *   GET    /api/agent-ai                 `{ ai: OwnAiStatus }`. The human OR the
 *          avatar's own agent session (the agent may read its AI, never set it).
 *   POST   /api/agent-ai/challenge       body = the PUT values. The message the
 *          linked wallet signs for a daily-limit RAISE. Human only.
 *   PUT    /api/agent-ai                 body = SaveOwnAiInput + optional `proof`.
 *          Source, provider, key, model, speed and the FIRST daily limit need
 *          only the human login. A limit ABOVE the stored one also needs the
 *          linked wallet's signature over the challenge (founder 2026-11-08
 *          decision 6): 403 `raise_needs_signature` without it, 403
 *          `invalid_wallet_proof` for a bad one. Lowering never needs it. A new
 *          key, provider or model is proven with one tiny test call first. That
 *          test is a PAID call on the user's key: it reserves its worst-case
 *          cost under the daily limit like a normal call (the stored limit; on a
 *          first save the requested one; no room -> 429 `daily_limit_reached`,
 *          no call), at most 6 per 10 minutes per avatar (429 `rate_limited`)
 *          and one at a time per avatar (409 `test_in_progress`).
 *          Human only.
 *   DELETE /api/agent-ai                 back to ClawVille AI; the key is wiped. Human only.
 *   POST   /api/agent-ai/models          body `{ provider, key? }` -> the live model
 *          list (key omitted = the stored key) + the recommended models.
 *          Human only; 10 per minute per avatar.
 *   POST   /api/agent-ai/usepod/register/challenge
 *   POST   /api/agent-ai/usepod/link/challenge
 *          The message the linked wallet signs for that UsePod action
 *          (`{ nonce, expiresAt, messageToSign, walletPubkey }`). Human only;
 *          no linked wallet -> 403 `wallet_link_required` (the user can paste a
 *          token from their own UsePod account instead).
 *   POST   /api/agent-ai/usepod/register body `{ proof }`. ClawVille registers a
 *          UsePod token for the agent -> `{ dashboardUrl, depositCode,
 *          contractAddress, ai }`. Human only + the linked wallet's signature;
 *          1 per avatar per hour (counted only after a valid proof).
 *   GET    /api/agent-ai/usepod/balance  `{ usdcMicro, isActive }`. Human or agent.
 *   GET    /api/agent-ai/usepod/fee      `{ sponsored, avatarMinSolLamports }`.
 *          Human or agent. `sponsored` = a ClawVille fee wallet pays the
 *          deposit network fee (2026-11-11); else the avatar wallet needs SOL.
 *   POST   /api/agent-ai/usepod/link     body `{ proof }` -> `{ dashboardUrl }`.
 *          Human only + the linked wallet's signature.
 *
 * Why the UsePod token needs the wallet: the dashboard link contains the token,
 * which controls the funded UsePod balance. A magic_link session is not proof
 * of a human (the link passes through the agent), so the token never reaches a
 * session without the linked wallet's signature. Register needs it too: else an
 * agent could register, keep the link, and wait for the human to fund it. A
 * missing proof answers 403 `usepod_needs_signature`, a bad one 403
 * `invalid_wallet_proof`. Each action signs its own purpose line ('ClawVille
 * UsePod register' / 'ClawVille UsePod link'), so no other signature replays.
 *
 * Every answer carries `Cache-Control: private, no-store`. A save (PUT and
 * UsePod register) answers 409 `openclaw_gateway_set` when the avatar's agent
 * is an OpenClaw bot with its own gateway (the gateway already chooses the AI).
 * No route returns or logs a key, a UsePod token or a provider error body.
 *
 * PARITY (Rule E5): settings writes are human-only (the owner chooses whose
 * AI account pays, like the Studios key and the spend rules). Agent path: read
 * `GET /api/agent-ai` and the UsePod balance with the agent session header
 * (MCP `clawville_call`); the driver and the runtime then use the setting.
 * Both bind to the same avatar row. Part B adds POST /usepod/deposit for human
 * and ledger-capable agent identities. Approval-on agents are refused; humans
 * sign POST /usepod/deposit/challenge terms with their linked wallet.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { safeBodyLimit } from '../middleware/safe-body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  OWN_AI_DAILY_LIMIT_MAX_CENTS,
  OWN_AI_USEPOD_DEPOSIT_MIN_CENTS,
  OWN_AI_USEPOD_DEPOSIT_MAX_CENTS,
  OWN_AI_USEPOD_MIN_SOL_LAMPORTS,
  OWN_AI_DAILY_LIMIT_MIN_CENTS,
  OWN_AI_PROVIDERS,
  OWN_AI_PROVIDER_SPECS,
  OWN_AI_RECOMMENDED_MODELS,
  OWN_AI_SOURCES,
  isOwnAiModelId,
  isOwnAiSpeedSeconds,
  type OwnAiProvider,
} from '@clawville/shared';
import { and, avatars, db, eq, platformAgents, users } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter } from '../middleware/rate-limit';
import { requireAuthOrAgentSession, type ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity, requireNonGuestUser } from '../middleware/require-non-guest';
import {
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import {
  issueOwnAiLimitChallenge,
  issueUsepodChallenge,
  verifyOwnAiLimitProof,
  verifyUsepodProof,
  type UsepodProofAction,
} from '../services/spend-policy-proof';
import {
  OwnAiError,
  clearOwnAi,
  listProviderModels,
  loadStoredOwnAiKey,
  readOwnAiStatus,
  readUsepodBalance,
  readUsepodDashboardLink,
  registerUsepodToken,
  runMeteredOwnAiKeyTest,
  saveOwnAiSettings,
} from '../services/own-ai';
import { createUsepodDepositChallenge, depositUsepod, hasPriorUsepodDeposit } from '../services/usepod-deposit';
import { readUsepodFeePayer } from '../services/usepod-fee-payer';

export const agentAiRoutes = new Hono<ActivityAuthContext>();
// Own prefix with no public sibling, so a router-wide no-store is safe here.
agentAiRoutes.use('*', sessionMiddleware, noStorePrivate);

const modelsRateLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
const registerRateLimiter = createRateLimiter({ maxPerWindow: 1, windowMs: 60 * 60_000 });
// Each balance read is one UsePod call; an agent loop is slowed per avatar.
const balanceRateLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
const depositRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 60_000 });
const depositChallengeRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 60_000 });
// A save that changes the key, provider or model makes one PAID test call.
const keyTestRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 10 * 60_000 });
/** Avatars with a key test call in flight (one at a time per avatar). */
const keyTestsInFlight = new Set<string>();

/** Test-only: reset the per-avatar limiters between cases. */
export function resetAgentAiRateLimits(): void {
  modelsRateLimiter.reset();
  registerRateLimiter.reset();
  balanceRateLimiter.reset();
  depositRateLimiter.reset();
  depositChallengeRateLimiter.reset();
  keyTestRateLimiter.reset();
  keyTestsInFlight.clear();
}

const smallBody = safeBodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
});

const GATE: HumanGateCopy = {
  humanOnlyCode: 'human_only',
  humanOnlyMessage: 'Only the human owner can choose the AI of this agent. Ask your human to set it in the ClawVille wallet panel.',
  needsLoginCode: 'needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then change the AI of your agent.',
};
const humanGate = [refuseAgentHeader(GATE), requireAuth, requireHumanSessionOrigin(GATE), requireNonGuestUser] as const;
const readGate = [requireAuthOrAgentSession, requireNonGuestIdentity] as const;
// Apply the existing human gate only to human identities. An agent must hold
// ledger capability before this route can reach the custodial signing service.
const depositIdentityGate = createMiddleware<ActivityAuthContext>(async (c, next) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) return c.json({ error: 'avatar_required', code: 'avatar_required' }, 403);
  if (identity.kind === 'agent' && !identity.ledgerCapable) {
    return c.json({ error: 'ledger_capability_required', code: 'ledger_capability_required' }, 403);
  }
  return next();
});
const depositHumanGate = (humanGate as readonly MiddlewareHandler[]).map((gate) => createMiddleware<ActivityAuthContext>((c, next) =>
  c.get('identity').kind === 'agent' ? next() : gate(c, next)));

function refusal(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: code, code, message, ...extra };
}

const GATEWAY_SET = refusal(
  'openclaw_gateway_set',
  'This agent runs on its own OpenClaw gateway, which already chooses its AI. Disconnect the gateway first.',
);
const WALLET_LINK_REQUIRED = refusal(
  'wallet_link_required',
  'Link your own wallet first. Your linked wallet must approve a higher daily limit.',
);
const RAISE_NEEDS_SIGNATURE = refusal(
  'raise_needs_signature',
  'A higher daily limit needs a signature from your linked wallet.',
);
const USEPOD_WALLET_LINK_REQUIRED = refusal(
  'wallet_link_required',
  'Link your own wallet first: your linked wallet must approve a ClawVille UsePod balance and its link. '
    + 'Or paste a token from your own UsePod account instead.',
);
const USEPOD_NEEDS_SIGNATURE = refusal(
  'usepod_needs_signature',
  'The UsePod balance and its link need a signature from your linked wallet.',
);
const INVALID_WALLET_PROOF = refusal('invalid_wallet_proof', 'The wallet signature did not match. Try again.');
const KEY_REQUIRED = refusal('key_required', 'Paste the API key for this provider.');
const RATE_LIMITED = refusal('rate_limited', 'Too many requests. Wait, then try again.');
const KEY_TEST_RATE_LIMITED = refusal(
  'rate_limited',
  'Each save with a new key, provider or model makes a test call on your key. Wait a few minutes, then try again.',
);
const TEST_IN_PROGRESS = refusal('test_in_progress', 'A test call for this agent is already running. Wait for it, then try again.');
const DAILY_LIMIT_REACHED = refusal(
  'daily_limit_reached',
  'The daily limit has no room for the test call on your key. Raise the limit or wait until 00:00 UTC.',
);

// ── Input schemas ──────────────────────────────────────────────────────────

const providerSchema = z.enum(OWN_AI_PROVIDERS);
const keySchema = z.string().trim().min(1).max(256);

/** Key shape per provider (the fixed allow-list; no custom host is ever accepted). */
function keyMatches(provider: OwnAiProvider, key: string): boolean {
  return OWN_AI_PROVIDER_SPECS[provider].keyPattern.test(key);
}

export const saveOwnAiSchema = z
  .object({
    source: z.enum(OWN_AI_SOURCES),
    provider: providerSchema.optional(),
    model: z.string().trim().refine(isOwnAiModelId, 'invalid model id').optional(),
    speedSeconds: z.number().refine(isOwnAiSpeedSeconds, 'speed must be 25, 20, 15 or 10').optional(),
    dailyLimitCents: z.number().int().min(OWN_AI_DAILY_LIMIT_MIN_CENTS).max(OWN_AI_DAILY_LIMIT_MAX_CENTS).optional(),
    key: keySchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.source === 'clawville') return;
    if (!input.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'provider is required' });
    if (!input.model) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model is required' });
    if (input.dailyLimitCents === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dailyLimitCents'], message: 'a daily limit is required' });
    }
    if (input.provider && (input.source === 'usepod') !== (input.provider === 'usepod')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'source usepod goes with provider usepod only' });
    }
    if (input.provider && input.key !== undefined && !keyMatches(input.provider, input.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'the key does not have the shape of this provider key' });
    }
  });
type SaveOwnAiBody = z.infer<typeof saveOwnAiSchema>;

// 32-byte base58 nonce: 43-44 chars; 64-byte base58 signature: 86-88 chars.
const proofSchema = z.object({
  nonce: z.string().min(32).max(64),
  signature: z.string().min(80).max(100),
}).strict();

const modelsBodySchema = z
  .object({ provider: providerSchema, key: keySchema.optional() })
  .strict()
  .refine((body) => body.key === undefined || keyMatches(body.provider, body.key), {
    path: ['key'],
    message: 'the key does not have the shape of this provider key',
  });

function invalid(issues: z.ZodIssue[]) {
  return refusal('invalid_agent_ai', 'The AI settings are not valid.', { issues });
}

/**
 * The service throws `OwnAiError` with a safe code and a suggested status
 * (it never carries a key or a provider body). Anything else is rethrown.
 */
function ownAiFailure(c: Context, err: unknown, fallback?: { code: string; message: string; status: 502 }): Response {
  if (err instanceof OwnAiError) {
    return c.json(refusal(err.code, OWN_AI_ERROR_MESSAGES[err.code] ?? 'The AI provider refused the request.'), err.httpStatus as 400);
  }
  if (fallback) return c.json(refusal(fallback.code, fallback.message), fallback.status);
  throw err;
}

const OWN_AI_ERROR_MESSAGES: Record<string, string> = {
  invalid_source: 'The AI settings are not valid.',
  invalid_provider: 'Pick one of the listed providers.',
  provider_source_mismatch: 'UsePod goes with the UsePod source only.',
  invalid_model: 'The model id is not valid.',
  invalid_speed: 'The speed must be 25, 20, 15 or 10 seconds.',
  invalid_daily_limit: 'Set a daily limit between $0.10 and $500.',
  invalid_key: 'The key does not have the shape of this provider key.',
  raise_needs_signature: 'A higher daily limit needs a signature from your linked wallet.',
  usepod_token_registered: 'ClawVille registered a UsePod token for this agent. Save without pasting a token.',
  key_required: 'Paste the API key for this provider.',
  key_rejected: 'The provider refused this key.',
  usepod_not_activated: 'UsePod has not activated this token yet. The first deposit activates it.',
  balance_empty: 'The UsePod balance is empty. Add funds on UsePod.',
  model_unavailable: 'The provider does not offer this model for this key.',
  rate_limited: 'The provider is rate limiting this key. Wait, then try again.',
  timeout: 'The provider did not answer in time. Try again.',
  provider_error: 'The provider did not answer correctly. Try again later.',
  usepod_already_registered: 'ClawVille already registered a UsePod token for this agent. Use "Show my UsePod link".',
};

function splitBody(body: unknown): { values: unknown; proof: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { values: body, proof: undefined };
  const { proof, ...values } = body as Record<string, unknown>;
  return { values, proof };
}

// ── Lookups ────────────────────────────────────────────────────────────────

async function activeAvatar(userId: string): Promise<{ id: string; platformAgentId: string | null }> {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true, platformAgentId: true },
  });
  if (!avatar) throw new HTTPException(403, { message: 'avatar_required' });
  return avatar;
}

/** True when the avatar's agent is an OpenClaw bot with its own gateway (`customization.gateway`). */
async function hasOpenclawGateway(platformAgentId: string | null): Promise<boolean> {
  if (!platformAgentId) return false;
  const agent = await db.query.platformAgents.findFirst({
    where: eq(platformAgents.id, platformAgentId),
    columns: { type: true, customization: true },
  });
  return agent?.type === 'openclaw-bot' && !!agent.customization?.gateway;
}

async function linkedWallet(userId: string): Promise<string | null> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { linkedWalletPubkey: true } });
  return owner?.linkedWalletPubkey ?? null;
}

function currentUser(c: Context): { id: string } {
  return c.get('user') as { id: string };
}

// ── Routes ─────────────────────────────────────────────────────────────────

agentAiRoutes.get('/', ...readGate, async (c) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) throw new HTTPException(403, { message: 'avatar_required' });
  return c.json({ ai: await readOwnAiStatus(identity.avatarId) });
});

agentAiRoutes.post('/challenge', smallBody, ...humanGate, async (c) => {
  const user = currentUser(c);
  // The card sends the full PUT values. The key (and any proof) is dropped
  // here: it is never checked, echoed or put in the signed message.
  const { values } = splitBody(await c.req.json().catch(() => null));
  const { key: _ignoredKey, ...withoutKey } =
    values && typeof values === 'object' ? (values as Record<string, unknown>) : ({} as Record<string, unknown>);
  const parsed = saveOwnAiSchema.safeParse(values && typeof values === 'object' ? withoutKey : values);
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  if (parsed.data.dailyLimitCents === undefined) {
    return c.json(invalid([{ code: z.ZodIssueCode.custom, path: ['dailyLimitCents'], message: 'a daily limit is required' }]), 400);
  }
  const avatar = await activeAvatar(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(WALLET_LINK_REQUIRED, 403);
  return c.json({ ...issueOwnAiLimitChallenge(user.id, avatar.id, parsed.data.dailyLimitCents), walletPubkey: wallet });
});

agentAiRoutes.put('/', smallBody, ...humanGate, async (c) => {
  const user = currentUser(c);
  const { values, proof } = splitBody(await c.req.json().catch(() => null));
  const parsed = saveOwnAiSchema.safeParse(values);
  const parsedProof = proof === undefined ? null : proofSchema.safeParse(proof);
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  if (parsedProof && !parsedProof.success) return c.json(invalid(parsedProof.error.issues), 400);
  const input: SaveOwnAiBody = parsed.data;

  const avatar = await activeAvatar(user.id);
  if (input.source !== 'clawville' && await hasOpenclawGateway(avatar.platformAgentId)) {
    return c.json(GATEWAY_SET, 409);
  }

  const current = await readOwnAiStatus(avatar.id);

  // A registered UsePod token always wins (a pasted token would never be
  // used): refused before the test call; the service refuses it again.
  if (input.source === 'usepod' && current.usepodRegistered && input.key !== undefined) {
    return ownAiFailure(c, new OwnAiError('usepod_token_registered'));
  }

  // A raise above the stored limit needs the linked wallet. The first limit
  // (none stored) and any lower limit need only the login. The proof must be
  // present before the test call, and is verified (nonce consumed) after it,
  // so a failed key test does not burn the signature.
  const isRaise = input.source !== 'clawville'
    && input.dailyLimitCents !== undefined
    && current.dailyLimitCents !== null
    && input.dailyLimitCents > current.dailyLimitCents;
  let wallet: string | null = null;
  if (isRaise) {
    wallet = await linkedWallet(user.id);
    if (!wallet) return c.json(WALLET_LINK_REQUIRED, 403);
    if (!parsedProof?.success) return c.json(RAISE_NEEDS_SIGNATURE, 403);
  }

  // A new key, provider or model is proven with one tiny call before save.
  // Key omitted = the stored secret of this provider (usepod: the registered
  // token first), read even while the source is still 'clawville' (right
  // after a UsePod register) or a sticky fallback is stored.
  if (input.source !== 'clawville' && input.provider && input.model) {
    const changed = input.key !== undefined || input.provider !== current.provider || input.model !== current.model;
    if (changed) {
      const key = input.key ?? await loadStoredOwnAiKey(avatar.id, input.provider);
      if (!key) return c.json(KEY_REQUIRED, 400);
      // The test is a PAID call on the user's key: one in flight per avatar
      // (process-local; the API runs one process), a per-avatar rate limit, and
      // the same atomic daily-limit reservation as a normal call.
      if (keyTestsInFlight.has(avatar.id)) return c.json(TEST_IN_PROGRESS, 409);
      if (!keyTestRateLimiter.check(avatar.id)) return c.json(KEY_TEST_RATE_LIMITED, 429);
      keyTestsInFlight.add(avatar.id);
      let test: Awaited<ReturnType<typeof runMeteredOwnAiKeyTest>>;
      try {
        test = await runMeteredOwnAiKeyTest(avatar.id, input.provider, key, input.model, input.dailyLimitCents ?? null);
      } finally {
        keyTestsInFlight.delete(avatar.id);
      }
      if (!test.ok && test.code === 'daily_limit_reached') return c.json(DAILY_LIMIT_REACHED, 429);
      if (!test.ok) {
        return c.json(refusal('key_test_failed', 'The provider refused a test call with this key and model.', { reason: test.code }), 400);
      }
    }
  }

  let limitRaiseProven = false;
  if (isRaise && wallet && parsedProof?.success) {
    const verdict = verifyOwnAiLimitProof({
      userId: user.id,
      avatarId: avatar.id,
      dailyLimitCents: input.dailyLimitCents as number,
      nonce: parsedProof.data.nonce,
      signature: parsedProof.data.signature,
      walletPubkey: wallet,
    });
    if (verdict !== 'ok') return c.json(INVALID_WALLET_PROOF, 403);
    limitRaiseProven = true;
  }

  try {
    // Only this route sets `limitRaiseProven` (the strict body schema cannot
    // carry it); the service re-checks the raise under the save lock.
    return c.json({ ai: await saveOwnAiSettings(avatar.id, user.id, { ...input, limitRaiseProven }) });
  } catch (err) {
    return ownAiFailure(c, err);
  }
});

agentAiRoutes.delete('/', ...humanGate, async (c) => {
  const avatar = await activeAvatar(currentUser(c).id);
  await clearOwnAi(avatar.id);
  return c.json({ ai: await readOwnAiStatus(avatar.id) });
});

agentAiRoutes.post('/models', smallBody, ...humanGate, async (c) => {
  const parsed = modelsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const avatar = await activeAvatar(currentUser(c).id);
  if (!modelsRateLimiter.check(avatar.id)) return c.json(RATE_LIMITED, 429);
  const { provider } = parsed.data;
  const key = parsed.data.key ?? await loadStoredOwnAiKey(avatar.id, provider);
  if (!key) return c.json(KEY_REQUIRED, 400);
  let models: string[];
  try {
    models = await listProviderModels(provider, key);
  } catch (err) {
    // Never echo a raw provider error: it can contain the key.
    return ownAiFailure(c, err, {
      code: 'models_unavailable',
      message: 'The provider did not return a model list. Check the key.',
      status: 502,
    });
  }
  return c.json({ models, recommended: OWN_AI_RECOMMENDED_MODELS.filter((m) => m.provider === provider) });
});

const usepodProofBodySchema = z.object({ proof: proofSchema }).strict();

/**
 * The UsePod token never reaches a session without the linked wallet's
 * signature. Returns null when the proof is good (nonce consumed), else the
 * refusal. Order: linked wallet, proof present, proof valid.
 */
async function checkUsepodProof(
  c: Context,
  action: UsepodProofAction,
  userId: string,
  avatarId: string,
  body: unknown,
): Promise<Response | null> {
  const wallet = await linkedWallet(userId);
  if (!wallet) return c.json(USEPOD_WALLET_LINK_REQUIRED, 403);
  const proof = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { proof?: unknown }).proof : undefined);
  if (proof === undefined) return c.json(USEPOD_NEEDS_SIGNATURE, 403);
  const parsed = usepodProofBodySchema.safeParse(body);
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const verdict = verifyUsepodProof({
    action,
    userId,
    avatarId,
    nonce: parsed.data.proof.nonce,
    signature: parsed.data.proof.signature,
    walletPubkey: wallet,
  });
  return verdict === 'ok' ? null : c.json(INVALID_WALLET_PROOF, 403);
}

function usepodChallengeRoute(action: UsepodProofAction) {
  return async (c: Context) => {
    const user = currentUser(c);
    const avatar = await activeAvatar(user.id);
    const wallet = await linkedWallet(user.id);
    if (!wallet) return c.json(USEPOD_WALLET_LINK_REQUIRED, 403);
    return c.json({ ...issueUsepodChallenge(action, user.id, avatar.id), walletPubkey: wallet });
  };
}

agentAiRoutes.post('/usepod/register/challenge', ...humanGate, usepodChallengeRoute('register'));
agentAiRoutes.post('/usepod/link/challenge', ...humanGate, usepodChallengeRoute('link'));

agentAiRoutes.post('/usepod/register', smallBody, ...humanGate, async (c) => {
  const user = currentUser(c);
  const avatar = await activeAvatar(user.id);
  if (await hasOpenclawGateway(avatar.platformAgentId)) return c.json(GATEWAY_SET, 409);
  // The proof comes before the rate limiter and the UsePod call: a refused
  // request burns neither the hourly slot nor a UsePod registration.
  const refused = await checkUsepodProof(c, 'register', user.id, avatar.id, await c.req.json().catch(() => null));
  if (refused) return refused;
  if (!registerRateLimiter.check(avatar.id)) {
    return c.json(refusal('rate_limited', 'One UsePod registration per hour. Wait, then try again.'), 429);
  }
  let registered: Awaited<ReturnType<typeof registerUsepodToken>>;
  try {
    registered = await registerUsepodToken(avatar.id, user.id);
  } catch (err) {
    return ownAiFailure(c, err, {
      code: 'usepod_register_failed',
      message: 'UsePod did not register a token. Try again later.',
      status: 502,
    });
  }
  return c.json({
    dashboardUrl: registered.dashboardUrl,
    depositCode: registered.depositCode,
    contractAddress: registered.contractAddress,
    ai: await readOwnAiStatus(avatar.id),
  });
});

agentAiRoutes.get('/usepod/balance', ...readGate, async (c) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) throw new HTTPException(403, { message: 'avatar_required' });
  if (!balanceRateLimiter.check(identity.avatarId)) return c.json(RATE_LIMITED, 429);
  let balance: Awaited<ReturnType<typeof readUsepodBalance>>;
  try {
    balance = await readUsepodBalance(identity.avatarId);
  } catch (err) {
    // Registered token that never held a balance: report an empty, inactive
    // balance. After a deposit that may have moved money, the same reply means
    // the token is unavailable, not empty.
    if (err instanceof OwnAiError && err.code === 'usepod_not_activated') {
      let prior: boolean;
      try {
        prior = await hasPriorUsepodDeposit(db, identity.avatarId);
      } catch (dbErr) {
        return ownAiFailure(c, dbErr, { code: 'provider_error', message: 'UsePod did not answer. Try again later.', status: 502 });
      }
      if (!prior) return c.json({ usdcMicro: 0, isActive: false });
      return ownAiFailure(c, new OwnAiError('key_rejected'), {
        code: 'provider_error',
        message: 'UsePod did not answer. Try again later.',
        status: 502,
      });
    }
    return ownAiFailure(c, err, {
      code: 'provider_error',
      message: 'UsePod did not answer. Try again later.',
      status: 502,
    });
  }
  if (!balance) return c.json(refusal('usepod_not_set', 'This agent has no UsePod token.'), 404);
  return c.json({ usdcMicro: balance.usdcMicro, isActive: balance.isActive });
});

/**
 * Who pays the network fee of a UsePod deposit (2026-11-11). `sponsored` is
 * true while a ClawVille fee wallet is provisioned; the deposit itself still
 * falls back to the avatar wallet when the fee wallet is low or at its daily
 * cap. Human and agent sessions read the same answer.
 */
agentAiRoutes.get('/usepod/fee', ...readGate, async (c) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) throw new HTTPException(403, { message: 'avatar_required' });
  let sponsored = false;
  try {
    sponsored = (await readUsepodFeePayer()) !== null;
  } catch {
    /* A failed read is reported as not sponsored; the deposit decides again. */
  }
  return c.json({ sponsored, avatarMinSolLamports: OWN_AI_USEPOD_MIN_SOL_LAMPORTS });
});

agentAiRoutes.post('/usepod/link', smallBody, ...humanGate, async (c) => {
  const user = currentUser(c);
  const avatar = await activeAvatar(user.id);
  const refused = await checkUsepodProof(c, 'link', user.id, avatar.id, await c.req.json().catch(() => null));
  if (refused) return refused;
  const dashboardUrl = await readUsepodDashboardLink(avatar.id);
  if (!dashboardUrl) return c.json(refusal('usepod_not_set', 'This agent has no UsePod token.'), 404);
  return c.json({ dashboardUrl });
});

const depositBodySchema = z.object({
  amountCents: z.number().int().min(OWN_AI_USEPOD_DEPOSIT_MIN_CENTS).max(OWN_AI_USEPOD_DEPOSIT_MAX_CENTS),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  nonce: proofSchema.shape.nonce.optional(),
  signature: proofSchema.shape.signature.optional(),
}).strict();

agentAiRoutes.post('/usepod/deposit/challenge', smallBody, ...humanGate, async (c) => {
  const parsed = depositBodySchema.omit({ nonce: true, signature: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const user = currentUser(c);
  const avatar = await activeAvatar(user.id);
  if (!depositChallengeRateLimiter.check(avatar.id)) return c.json(RATE_LIMITED, 429);
  const walletPubkey = await linkedWallet(user.id);
  if (!walletPubkey) return c.json(USEPOD_WALLET_LINK_REQUIRED, 403);
  const result = await createUsepodDepositChallenge({ ...parsed.data, actor: 'human', userId: user.id, avatarId: avatar.id });
  if (!result.ok) return c.json({ ...result, error: result.code }, 400);
  return c.json({ ...result, walletPubkey });
});

agentAiRoutes.post('/usepod/deposit', smallBody, ...readGate, depositIdentityGate, ...depositHumanGate, async (c) => {
  const parsed = depositBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const identity = c.get('identity');
  if (!depositRateLimiter.check(identity.avatarId)) return c.json(RATE_LIMITED, 429);
  const result = await depositUsepod({
    ...parsed.data, avatarId: identity.avatarId, userId: identity.userId,
    actor: identity.kind === 'agent' ? 'agent' : 'human',
  });
  if (!result.ok) return c.json({ ...result, error: result.code }, ['approval_required', 'signature_required', 'invalid_wallet_proof'].includes(result.code) ? 403 : 400);
  return c.json(result);
});
