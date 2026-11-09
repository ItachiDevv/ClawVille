/**
 * Own AI for hosted agents (MCP hub step 4 part A, 2026-11-09, migration 0099).
 * A human picks the AI that powers their hosted agent: ClawVille AI (default),
 * their own key (OpenAI, Anthropic, OpenRouter) or a UsePod token (pasted, or
 * registered here at `POST https://api.usepod.ai/v1/register`). Also a model, a
 * speed and a daily dollar limit on the ESTIMATED spend (tokens x price table).
 *
 * Secrets: the key or UsePod token is encrypted at rest (keypair-vault
 * `encryptToken`) and written under the avatar's spend-rules lock. Only the last
 * 4 characters are returned. The key, the token, the dashboard link (it holds
 * the token) and provider error bodies are never logged and never put in an
 * error: every failure maps to a short code. Provider hosts are fixed constants
 * (OWN_AI_PROVIDER_SPECS); no user URL is ever fetched.
 *
 * Contract: brain `plans/mcp-hub-step4-own-ai-board.md`.
 */

import { agentAiSettings, agentAiUsage, and, db, eq, sql } from '@clawville/database';
import {
  OWN_AI_CALL_TIMEOUT_MS,
  OWN_AI_DEFAULT_MAX_TOKENS,
  OWN_AI_DEFAULT_SPEED_SECONDS,
  OWN_AI_FALLBACK_REASONS,
  OWN_AI_PROVIDER_SPECS,
  OWN_AI_REASONING_MAX_TOKENS,
  OWN_AI_REASONING_TIMEOUT_MS,
  OWN_AI_USEPOD_TOKEN_PATTERN,
  estimateOwnAiMicroUsd,
  isOwnAiDailyLimitCents,
  isOwnAiModelId,
  isOwnAiProvider,
  isOwnAiReasoningModel,
  isOwnAiSource,
  isOwnAiSpeedSeconds,
  ownAiLimitMicroUsd,
  type OwnAiFallbackReason,
  type OwnAiProvider,
  type OwnAiSource,
  type OwnAiStatus,
} from '@clawville/shared';
import { decryptToken, encryptToken } from './keypair-vault';
import { lockSpendRules } from './spend-policy';

// ---------------------------------------------------------------------------
// Errors (short codes only: never a key, a token, a URL or a provider body)
// ---------------------------------------------------------------------------

export type OwnAiErrorCode =
  | 'invalid_source'
  | 'invalid_provider'
  | 'provider_source_mismatch'
  | 'invalid_model'
  | 'invalid_speed'
  | 'invalid_daily_limit'
  | 'invalid_key'
  | 'key_required'
  | 'usepod_already_registered'
  | 'usepod_token_registered'
  | 'raise_needs_signature'
  | 'key_rejected'
  | 'balance_empty'
  | 'model_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error';

const ERROR_HTTP_STATUS: Record<OwnAiErrorCode, number> = {
  invalid_source: 400,
  invalid_provider: 400,
  provider_source_mismatch: 400,
  invalid_model: 400,
  invalid_speed: 400,
  invalid_daily_limit: 400,
  invalid_key: 400,
  key_required: 400,
  usepod_already_registered: 409,
  usepod_token_registered: 400,
  raise_needs_signature: 403,
  key_rejected: 400,
  balance_empty: 402,
  model_unavailable: 400,
  rate_limited: 429,
  timeout: 504,
  provider_error: 502,
};

export class OwnAiError extends Error {
  readonly code: OwnAiErrorCode;
  /** Suggested HTTP status for a route. */
  readonly httpStatus: number;
  constructor(code: OwnAiErrorCode) {
    super(code);
    this.name = 'OwnAiError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
  }
}

// ---------------------------------------------------------------------------
// Test seam: crypto (needs VANITY_ENCRYPTION_KEY). Fetch is the global fetch.
// ---------------------------------------------------------------------------

interface OwnAiDeps {
  encrypt: (plaintext: string) => { enc: string; iv: string; tag: string };
  decrypt: (enc: string, iv: string, tag: string) => string;
}
const deps: OwnAiDeps = { encrypt: encryptToken, decrypt: decryptToken };

/** Test hook. Returns a restore function. */
export function setOwnAiDepsForTest(overrides: Partial<OwnAiDeps>): () => void {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  return () => {
    Object.assign(deps, saved);
  };
}

// ---------------------------------------------------------------------------
// Settings-changed pub-sub (the orchestrator restarts a running runtime)
// ---------------------------------------------------------------------------

const listeners = new Set<(avatarId: string) => void>();

export function onOwnAiSettingsChanged(cb: (avatarId: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emitSettingsChanged(avatarId: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(avatarId);
    } catch {
      // A listener failure never breaks a save.
    }
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const UTC_TODAY = sql`(now() AT TIME ZONE 'UTC')::date`;
/**
 * Sticky reasons are owned by the DB: own AI does not resume until a save (or,
 * for balance_empty, a funded balance read) clears them.
 */
const STICKY_REASONS: readonly OwnAiFallbackReason[] = ['key_rejected', 'balance_empty', 'model_unavailable'];

function isSticky(reason: string | null): boolean {
  return reason !== null && (STICKY_REASONS as readonly string[]).includes(reason);
}

/** True for a fallback that keeps the agent on ClawVille AI until a save (driver lane). */
export function isOwnAiStickyFallback(reason: string | null): boolean {
  return isSticky(reason);
}

export interface OwnAiSettingsRow {
  source: string;
  provider: string | null;
  model: string | null;
  speedSeconds: number;
  dailyLimitCents: number | null;
  keyLast4: string | null;
  usepodTokenLast4: string | null;
  usepodRegistered: boolean;
  fallbackReason: string | null;
  fallbackAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface OwnAiUsageRow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedMicroUsd: number;
}

const statusColumns = {
  source: agentAiSettings.source,
  provider: agentAiSettings.provider,
  model: agentAiSettings.model,
  speedSeconds: agentAiSettings.speedSeconds,
  dailyLimitCents: agentAiSettings.dailyLimitCents,
  keyLast4: agentAiSettings.keyLast4,
  usepodTokenLast4: agentAiSettings.usepodTokenLast4,
  usepodRegistered: agentAiSettings.usepodRegistered,
  fallbackReason: agentAiSettings.fallbackReason,
  fallbackAt: agentAiSettings.fallbackAt,
  updatedAt: agentAiSettings.updatedAt,
};

export interface OwnAiActiveRow {
  source: string;
  dailyLimitCents: number | null;
  fallbackReason: string | null;
  fallbackAt: Date | string | null;
  estimatedMicroUsd: number | null;
}

/**
 * Pure: what the agent uses now. 'clawville' when the source is clawville, a
 * sticky fallback is stored (key_rejected, balance_empty, model_unavailable),
 * or the daily limit is reached today (stored fallback of today, or today's
 * estimate at or above the limit).
 */
export function computeOwnAiActiveNow(row: OwnAiActiveRow | null, now: Date = new Date()): 'own' | 'clawville' {
  if (!row || row.source === 'clawville' || !isOwnAiSource(row.source)) return 'clawville';
  if (isSticky(row.fallbackReason)) return 'clawville';
  const fallbackAt = toIso(row.fallbackAt);
  if (row.fallbackReason === 'daily_limit' && fallbackAt !== null && fallbackAt.slice(0, 10) === now.toISOString().slice(0, 10)) {
    return 'clawville';
  }
  if (row.dailyLimitCents === null || num(row.estimatedMicroUsd) >= ownAiLimitMicroUsd(row.dailyLimitCents)) return 'clawville';
  return 'own';
}

function toIso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function asFallbackReason(v: string | null): OwnAiFallbackReason | null {
  return v !== null && (OWN_AI_FALLBACK_REASONS as readonly string[]).includes(v) ? (v as OwnAiFallbackReason) : null;
}

/** Pure: the status from the stored row and today's usage (`activeNow`: computeOwnAiActiveNow). */
export function buildOwnAiStatus(row: OwnAiSettingsRow | null, usage: OwnAiUsageRow | null, now: Date = new Date()): OwnAiStatus {
  const micro = num(usage?.estimatedMicroUsd);
  const today = {
    calls: num(usage?.calls),
    inputTokens: num(usage?.inputTokens),
    outputTokens: num(usage?.outputTokens),
    estimatedCents: Math.ceil(micro / 10_000),
  };
  if (!row) {
    return {
      source: 'clawville',
      provider: null,
      model: null,
      speedSeconds: OWN_AI_DEFAULT_SPEED_SECONDS,
      dailyLimitCents: null,
      keyLast4: null,
      usepodRegistered: false,
      today,
      activeNow: 'clawville',
      fallbackReason: null,
      fallbackAt: null,
      updatedAt: null,
    };
  }
  const source: OwnAiSource = isOwnAiSource(row.source) ? row.source : 'clawville';
  const fallbackReason = asFallbackReason(row.fallbackReason);
  const fallbackAt = toIso(row.fallbackAt);
  const registeredInUse = source === 'usepod' && row.usepodRegistered === true;
  return {
    source,
    provider: isOwnAiProvider(row.provider) ? row.provider : null,
    model: row.model,
    speedSeconds: isOwnAiSpeedSeconds(row.speedSeconds) ? row.speedSeconds : OWN_AI_DEFAULT_SPEED_SECONDS,
    dailyLimitCents: row.dailyLimitCents,
    keyLast4: registeredInUse ? row.usepodTokenLast4 : row.keyLast4,
    usepodRegistered: row.usepodRegistered === true,
    today,
    activeNow: computeOwnAiActiveNow(
      { source, dailyLimitCents: row.dailyLimitCents, fallbackReason, fallbackAt, estimatedMicroUsd: micro },
      now,
    ),
    fallbackReason,
    fallbackAt,
    updatedAt: toIso(row.updatedAt),
  };
}

async function readTodayUsage(avatarId: string): Promise<OwnAiUsageRow | null> {
  const [row] = await db
    .select({
      calls: agentAiUsage.calls,
      inputTokens: agentAiUsage.inputTokens,
      outputTokens: agentAiUsage.outputTokens,
      estimatedMicroUsd: agentAiUsage.estimatedMicroUsd,
    })
    .from(agentAiUsage)
    .where(and(eq(agentAiUsage.avatarId, avatarId), eq(agentAiUsage.day, UTC_TODAY)))
    .limit(1);
  return row ?? null;
}

export async function readOwnAiStatus(avatarId: string): Promise<OwnAiStatus> {
  const [row] = await db.select(statusColumns).from(agentAiSettings).where(eq(agentAiSettings.avatarId, avatarId)).limit(1);
  const usage = await readTodayUsage(avatarId);
  return buildOwnAiStatus(row ?? null, usage);
}

/** Cheap single-row read for the orchestrator: what the agent uses at this moment. */
export async function ownAiActiveNow(avatarId: string): Promise<'own' | 'clawville'> {
  const [row] = await db
    .select({
      source: agentAiSettings.source,
      dailyLimitCents: agentAiSettings.dailyLimitCents,
      fallbackReason: agentAiSettings.fallbackReason,
      fallbackAt: agentAiSettings.fallbackAt,
      estimatedMicroUsd: agentAiUsage.estimatedMicroUsd,
    })
    .from(agentAiSettings)
    .leftJoin(agentAiUsage, and(eq(agentAiUsage.avatarId, agentAiSettings.avatarId), eq(agentAiUsage.day, UTC_TODAY)))
    .where(eq(agentAiSettings.avatarId, avatarId))
    .limit(1);
  return computeOwnAiActiveNow(row ?? null);
}

// ---------------------------------------------------------------------------
// Save / clear
// ---------------------------------------------------------------------------

export interface SaveOwnAiInput {
  source: OwnAiSource;
  provider?: OwnAiProvider;
  model?: string;
  speedSeconds?: number;
  dailyLimitCents?: number;
  key?: string /* omit = keep stored key when provider unchanged */;
  /**
   * Set true by the route ONLY after the linked-wallet raise proof passed. A
   * limit above the stored one without it is refused (raise_needs_signature),
   * checked inside the spend-rules lock so no concurrent save can race it.
   */
  limitRaiseProven?: boolean;
}

export interface OwnAiStoredForSave {
  provider: string | null;
  speedSeconds: number;
  dailyLimitCents: number | null;
  /** The own-key slot holds a key. */
  hasKey: boolean;
  /** ClawVille registered a UsePod token (its own columns). */
  usepodRegistered: boolean;
}

export interface ResolvedOwnAiSave {
  source: Exclude<OwnAiSource, 'clawville'>;
  provider: OwnAiProvider;
  model: string;
  speedSeconds: number;
  dailyLimitCents: number;
  /**
   * The own-key slot: 'set' = encrypt `newKey`; 'keep' = the stored key stays;
   * 'wipe' = source 'usepod' runs on the registered token, so the slot is emptied.
   * The registered-token columns are never written by a save.
   */
  keyAction: 'set' | 'keep' | 'wipe';
  newKey: string | null;
}

/** Pure validation of an own_key / usepod save against the stored row. Throws OwnAiError. */
export function resolveOwnAiSave(input: SaveOwnAiInput, stored: OwnAiStoredForSave | null): ResolvedOwnAiSave {
  if (!isOwnAiSource(input.source) || input.source === 'clawville') throw new OwnAiError('invalid_source');
  if (!isOwnAiProvider(input.provider)) throw new OwnAiError('invalid_provider');
  const provider = input.provider;
  if ((input.source === 'usepod') !== (provider === 'usepod')) throw new OwnAiError('provider_source_mismatch');
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!isOwnAiModelId(model)) throw new OwnAiError('invalid_model');

  const speedSeconds = input.speedSeconds ?? stored?.speedSeconds ?? OWN_AI_DEFAULT_SPEED_SECONDS;
  if (!isOwnAiSpeedSeconds(speedSeconds)) throw new OwnAiError('invalid_speed');
  const dailyLimitCents = input.dailyLimitCents ?? stored?.dailyLimitCents ?? null;
  if (!isOwnAiDailyLimitCents(dailyLimitCents)) throw new OwnAiError('invalid_daily_limit');
  const storedLimit = stored?.dailyLimitCents ?? null;
  if (storedLimit !== null && dailyLimitCents > storedLimit && input.limitRaiseProven !== true) {
    throw new OwnAiError('raise_needs_signature');
  }

  const base = { source: input.source, provider, model, speedSeconds, dailyLimitCents };
  if (input.source === 'usepod' && stored?.usepodRegistered) {
    // The registered token wins; a pasted token would never be used.
    if (input.key !== undefined) throw new OwnAiError('usepod_token_registered');
    return { ...base, keyAction: 'wipe', newKey: null };
  }
  if (input.key !== undefined) {
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!OWN_AI_PROVIDER_SPECS[provider].keyPattern.test(key)) throw new OwnAiError('invalid_key');
    return { ...base, keyAction: 'set', newKey: key };
  }
  if (!stored || !stored.hasKey || stored.provider !== provider) throw new OwnAiError('key_required');
  return { ...base, keyAction: 'keep', newKey: null };
}

/** Validates, encrypts a new key, clears the fallback; written under the spend-rules lock. */
export async function saveOwnAiSettings(avatarId: string, userId: string, input: SaveOwnAiInput): Promise<OwnAiStatus> {
  if (!isOwnAiSource(input?.source)) throw new OwnAiError('invalid_source');
  if (input.source === 'clawville') {
    await clearOwnAiInternal(avatarId, userId);
    return readOwnAiStatus(avatarId);
  }
  await db.transaction(async (tx) => {
    await lockSpendRules(tx, avatarId);
    const [stored] = await tx
      .select({
        provider: agentAiSettings.provider,
        speedSeconds: agentAiSettings.speedSeconds,
        dailyLimitCents: agentAiSettings.dailyLimitCents,
        keyEnc: agentAiSettings.keyEnc,
        usepodRegistered: agentAiSettings.usepodRegistered,
      })
      .from(agentAiSettings)
      .where(eq(agentAiSettings.avatarId, avatarId))
      .limit(1);
    const resolved = resolveOwnAiSave(
      input,
      stored
        ? {
            provider: stored.provider,
            speedSeconds: stored.speedSeconds,
            dailyLimitCents: stored.dailyLimitCents,
            hasKey: stored.keyEnc !== null,
            usepodRegistered: stored.usepodRegistered === true,
          }
        : null,
    );
    let keyValues: Record<string, string | null> = {};
    if (resolved.keyAction === 'set' && resolved.newKey !== null) {
      const sealed = deps.encrypt(resolved.newKey);
      keyValues = { keyEnc: sealed.enc, keyIv: sealed.iv, keyTag: sealed.tag, keyLast4: resolved.newKey.slice(-4) };
    } else if (resolved.keyAction === 'wipe') {
      keyValues = { keyEnc: null, keyIv: null, keyTag: null, keyLast4: null };
    }
    const values = {
      source: resolved.source,
      provider: resolved.provider,
      model: resolved.model,
      speedSeconds: resolved.speedSeconds,
      dailyLimitCents: resolved.dailyLimitCents,
      ...keyValues,
      fallbackReason: null,
      fallbackAt: null,
      updatedByUserId: userId,
      updatedAt: new Date(),
    };
    await tx
      .insert(agentAiSettings)
      .values({ avatarId, ...values })
      .onConflictDoUpdate({ target: agentAiSettings.avatarId, set: values });
  });
  emitSettingsChanged(avatarId);
  return readOwnAiStatus(avatarId);
}

/**
 * Back to ClawVille AI. Wipes the own-key slot, the provider and the model. A
 * registered UsePod token (its own columns) stays: it holds the user's funded
 * balance. The speed and the daily limit stay, so a later raise is still
 * compared with the last limit the human set.
 */
export async function clearOwnAi(avatarId: string): Promise<void> {
  await clearOwnAiInternal(avatarId, null);
}

async function clearOwnAiInternal(avatarId: string, userId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSpendRules(tx, avatarId);
    await tx
      .update(agentAiSettings)
      .set({
        source: 'clawville',
        provider: null,
        model: null,
        keyEnc: null,
        keyIv: null,
        keyTag: null,
        keyLast4: null,
        fallbackReason: null,
        fallbackAt: null,
        ...(userId ? { updatedByUserId: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agentAiSettings.avatarId, avatarId));
  });
  emitSettingsChanged(avatarId);
}

// ---------------------------------------------------------------------------
// Runtime config, budget gate, meter, fallback
// ---------------------------------------------------------------------------

/** For the orchestrator only. Decrypted key in memory; never log it. null when source='clawville'. */
export interface OwnAiRuntimeConfig {
  avatarId: string;
  provider: OwnAiProvider;
  protocol: 'openai-compat' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: boolean;
  maxTokensFloor: number;
  timeoutMs: number;
  speedSeconds: number;
}

interface StoredRow {
  source: string;
  provider: string | null;
  model: string | null;
  speedSeconds: number;
  fallbackReason: string | null;
  usepodRegistered: boolean;
  keyEnc: string | null;
  keyIv: string | null;
  keyTag: string | null;
  usepodTokenEnc: string | null;
  usepodTokenIv: string | null;
  usepodTokenTag: string | null;
}

async function loadStoredRow(avatarId: string): Promise<StoredRow | null> {
  const [row] = await db
    .select({
      source: agentAiSettings.source,
      provider: agentAiSettings.provider,
      model: agentAiSettings.model,
      speedSeconds: agentAiSettings.speedSeconds,
      fallbackReason: agentAiSettings.fallbackReason,
      usepodRegistered: agentAiSettings.usepodRegistered,
      keyEnc: agentAiSettings.keyEnc,
      keyIv: agentAiSettings.keyIv,
      keyTag: agentAiSettings.keyTag,
      usepodTokenEnc: agentAiSettings.usepodTokenEnc,
      usepodTokenIv: agentAiSettings.usepodTokenIv,
      usepodTokenTag: agentAiSettings.usepodTokenTag,
    })
    .from(agentAiSettings)
    .where(eq(agentAiSettings.avatarId, avatarId))
    .limit(1);
  return row ?? null;
}

/** Decrypts one sealed secret and checks it against the provider pattern; null on any failure. Never logs the secret. */
function openSecret(avatarId: string, provider: OwnAiProvider, enc: string | null, iv: string | null, tag: string | null): string | null {
  if (!enc || !iv || !tag) return null;
  let secret: string;
  try {
    secret = deps.decrypt(enc, iv, tag);
  } catch {
    console.warn(`[own-ai] stored secret for avatar ${avatarId} cannot be decrypted`);
    return null;
  }
  return OWN_AI_PROVIDER_SPECS[provider].keyPattern.test(secret) ? secret : null;
}

/** The ClawVille-registered UsePod token, or null. */
function registeredToken(avatarId: string, row: StoredRow | null): string | null {
  if (!row || row.usepodRegistered !== true) return null;
  return openSecret(avatarId, 'usepod', row.usepodTokenEnc, row.usepodTokenIv, row.usepodTokenTag);
}

/** The own-key slot when it belongs to `provider`, or null. */
function slotKey(avatarId: string, row: StoredRow | null, provider: OwnAiProvider): string | null {
  if (!row || row.provider !== provider) return null;
  return openSecret(avatarId, provider, row.keyEnc, row.keyIv, row.keyTag);
}

/**
 * The secret for `provider`: for usepod the registered token when present, else
 * a pasted token in the own-key slot. Human session only (the models route with
 * the key omitted); never return it to a client.
 */
export async function loadStoredOwnAiKey(avatarId: string, provider: OwnAiProvider): Promise<string | null> {
  const row = await loadStoredRow(avatarId);
  if (provider === 'usepod') return registeredToken(avatarId, row) ?? slotKey(avatarId, row, 'usepod');
  return slotKey(avatarId, row, provider);
}

/**
 * null when source='clawville', when a sticky fallback is stored (the DB owns
 * it: own AI resumes only after a save or a funded balance read clears it and
 * the settings-changed event restarts the runtime), or when the row is broken.
 * A daily_limit fallback does NOT null the config: ownAiMayCall gates each call
 * and the next UTC day resumes without a restart.
 */
export async function loadOwnAiRuntimeConfig(avatarId: string): Promise<OwnAiRuntimeConfig | null> {
  const row = await loadStoredRow(avatarId);
  if (!row || row.source === 'clawville' || !isOwnAiSource(row.source) || !isOwnAiProvider(row.provider)) return null;
  if (isSticky(row.fallbackReason)) return null;
  const provider = row.provider;
  if ((row.source === 'usepod') !== (provider === 'usepod')) return null;
  if (!row.model || !isOwnAiModelId(row.model)) return null;
  const key = row.source === 'usepod' && row.usepodRegistered ? registeredToken(avatarId, row) : slotKey(avatarId, row, provider);
  if (!key) return null;
  const spec = OWN_AI_PROVIDER_SPECS[provider];
  const reasoning = isOwnAiReasoningModel(provider, row.model);
  return {
    avatarId,
    provider,
    protocol: spec.protocol,
    baseUrl: spec.baseUrl(key),
    apiKey: key,
    model: row.model,
    reasoning,
    maxTokensFloor: reasoning ? OWN_AI_REASONING_MAX_TOKENS : OWN_AI_DEFAULT_MAX_TOKENS,
    timeoutMs: reasoning ? OWN_AI_REASONING_TIMEOUT_MS : OWN_AI_CALL_TIMEOUT_MS,
    speedSeconds: isOwnAiSpeedSeconds(row.speedSeconds) ? row.speedSeconds : OWN_AI_DEFAULT_SPEED_SECONDS,
  };
}

export interface OwnAiGateRow {
  source: string;
  dailyLimitCents: number | null;
  fallbackReason: string | null;
  estimatedMicroUsd: number | null;
  /** Budget held by own-AI calls in flight today (null = no usage row yet). */
  reservedMicroUsd?: number | null;
}

/** The worst-case token estimate of one own-AI call (prompt chars/4 in, max_tokens out). */
export interface OwnAiCallEstimate {
  inputTokens: number;
  outputTokens: number;
}

/** The budget one in-flight own-AI call holds, in micro-USD, on the usage row of `day` (UTC, YYYY-MM-DD). */
export interface OwnAiReservation {
  microUsd: number;
  day: string;
}

/** Worst-case cost of one call in micro-USD (at least 1, so a full budget never admits a call). */
export function ownAiEstimateMicroUsd(model: string, estimate: OwnAiCallEstimate): number {
  const micro = estimateOwnAiMicroUsd(
    typeof model === 'string' ? model : '',
    tokenCount(estimate?.inputTokens),
    tokenCount(estimate?.outputTokens),
  );
  return Math.max(1, micro);
}

/**
 * Pure budget gate for one call of `estimateMicroUsd`. `allow` when own AI is
 * set, no sticky fallback is stored (key_rejected, balance_empty,
 * model_unavailable) and estimated + reserved + estimate fits under the limit.
 * `recordDailyLimit` only when the SPENT estimate plus this call does not fit:
 * a refusal caused only by other in-flight reservations is not "limit reached"
 * (that budget frees up when those calls settle).
 */
export function decideOwnAiMayCall(
  row: OwnAiGateRow | null,
  estimateMicroUsd: number = 1,
): { allow: boolean; recordDailyLimit: boolean } {
  if (!row || row.source === 'clawville' || row.dailyLimitCents === null) return { allow: false, recordDailyLimit: false };
  if (isSticky(row.fallbackReason)) return { allow: false, recordDailyLimit: false };
  const limit = ownAiLimitMicroUsd(row.dailyLimitCents);
  const spent = num(row.estimatedMicroUsd);
  const est = Math.max(1, num(estimateMicroUsd));
  if (spent + est > limit) return { allow: false, recordDailyLimit: true };
  if (spent + num(row.reservedMicroUsd) + est > limit) return { allow: false, recordDailyLimit: false };
  return { allow: true, recordDailyLimit: false };
}

/**
 * Budget gate before each call: RESERVES the call's worst-case cost (priced with
 * `model`) in ONE conditional upsert on today's usage row. The row is written
 * only when own AI is set, no sticky fallback is stored and
 * estimated + reserved + estimate <= the daily limit, so parallel calls near
 * the limit cannot all pass (Postgres re-checks the condition on the locked,
 * latest row). Returns the reservation, or null when refused; a refusal because
 * the spent estimate itself has no room records the 'daily_limit' fallback.
 * Every reservation goes back once, on the row of the day it was made:
 * recordOwnAiUsage (the call spent tokens) or releaseOwnAiReservation (it did
 * not). Only today's UTC row counts, so a crashed process holds at most its
 * in-flight reservations until midnight UTC.
 */
export async function ownAiMayCall(avatarId: string, model: string, estimate: OwnAiCallEstimate): Promise<OwnAiReservation | null> {
  const micro = ownAiEstimateMicroUsd(model, estimate);
  const reserved = await db.execute<{ day: string }>(sql`
    INSERT INTO agent_ai_usage AS u (avatar_id, day, reserved_micro_usd)
    SELECT s.avatar_id, ${UTC_TODAY}, ${micro}::bigint
    FROM agent_ai_settings s
    WHERE s.avatar_id = ${avatarId}
      AND s.source <> 'clawville'
      AND s.daily_limit_cents IS NOT NULL
      AND (s.fallback_reason IS NULL OR s.fallback_reason NOT IN ('key_rejected', 'balance_empty', 'model_unavailable'))
      AND ${micro}::bigint <= s.daily_limit_cents::bigint * 10000
    ON CONFLICT (avatar_id, day) DO UPDATE
      SET reserved_micro_usd = u.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
          updated_at = now()
      WHERE u.estimated_micro_usd + u.reserved_micro_usd + EXCLUDED.reserved_micro_usd
        <= (SELECT s2.daily_limit_cents::bigint * 10000 FROM agent_ai_settings s2 WHERE s2.avatar_id = u.avatar_id)
    RETURNING u.day::text AS day
  `);
  const day = (Array.from(reserved)[0] as { day?: unknown } | undefined)?.day;
  if (isIsoDay(day)) return { microUsd: micro, day };

  // Refused: read why, only to decide whether "limit reached" is true.
  const [row] = await db
    .select({
      source: agentAiSettings.source,
      dailyLimitCents: agentAiSettings.dailyLimitCents,
      fallbackReason: agentAiSettings.fallbackReason,
      estimatedMicroUsd: agentAiUsage.estimatedMicroUsd,
      reservedMicroUsd: agentAiUsage.reservedMicroUsd,
    })
    .from(agentAiSettings)
    .leftJoin(agentAiUsage, and(eq(agentAiUsage.avatarId, agentAiSettings.avatarId), eq(agentAiUsage.day, UTC_TODAY)))
    .where(eq(agentAiSettings.avatarId, avatarId))
    .limit(1);
  if (decideOwnAiMayCall(row ?? null, micro).recordDailyLimit) await recordOwnAiFallback(avatarId, 'daily_limit');
  return null;
}

function isIsoDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** The micro-USD a reservation holds, or 0 for a missing or malformed one. */
function reservationMicro(reservation: OwnAiReservation | null | undefined): number {
  const n = Number(reservation?.microUsd);
  return Number.isSafeInteger(n) && n > 0 && isIsoDay(reservation?.day) ? n : 0;
}

/**
 * Settles one own-AI call in ONE atomic upsert on the row of the RESERVATION's
 * day: adds the call, its tokens and its real estimated cost there, and
 * subtracts its reservation (never below 0). A call reserved before midnight UTC
 * and settled after it is charged to the day it was reserved on, and its
 * reservation is released there (the new day's row is not touched). Without a
 * reservation the call lands on today's row. Then clears a 'provider_error'
 * fallback (the provider works again).
 */
export async function recordOwnAiUsage(
  avatarId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  reservation: OwnAiReservation | null = null,
): Promise<void> {
  const inTok = tokenCount(inputTokens);
  const outTok = tokenCount(outputTokens);
  const micro = estimateOwnAiMicroUsd(typeof model === 'string' ? model : '', inTok, outTok);
  const held = reservationMicro(reservation);
  // reservationMicro > 0 implies a well-formed reservation day.
  const day = held > 0 && reservation ? sql`${reservation.day}::date` : UTC_TODAY;
  await db
    .insert(agentAiUsage)
    .values({ avatarId, day, calls: 1, inputTokens: inTok, outputTokens: outTok, estimatedMicroUsd: micro })
    .onConflictDoUpdate({
      target: [agentAiUsage.avatarId, agentAiUsage.day],
      set: {
        calls: sql`${agentAiUsage.calls} + 1`,
        inputTokens: sql`${agentAiUsage.inputTokens} + ${inTok}::bigint`,
        outputTokens: sql`${agentAiUsage.outputTokens} + ${outTok}::bigint`,
        estimatedMicroUsd: sql`${agentAiUsage.estimatedMicroUsd} + ${micro}::bigint`,
        reservedMicroUsd: held > 0
          ? sql`GREATEST(${agentAiUsage.reservedMicroUsd} - ${held}::bigint, 0)`
          : sql`${agentAiUsage.reservedMicroUsd}`,
        updatedAt: sql`now()`,
      },
    });
  await db
    .update(agentAiSettings)
    .set({ fallbackReason: null, fallbackAt: null })
    .where(and(eq(agentAiSettings.avatarId, avatarId), eq(agentAiSettings.fallbackReason, 'provider_error')));
}

/** Gives back the reservation of a call that spent nothing (failed, or the gate answer came too late). One UPDATE. */
export async function releaseOwnAiReservation(avatarId: string, reservation: OwnAiReservation | null): Promise<void> {
  const held = reservationMicro(reservation);
  if (held === 0 || !reservation) return;
  await db
    .update(agentAiUsage)
    .set({
      reservedMicroUsd: sql`GREATEST(${agentAiUsage.reservedMicroUsd} - ${held}::bigint, 0)`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentAiUsage.avatarId, avatarId), eq(agentAiUsage.day, reservation.day)));
}

function tokenCount(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 100_000_000);
}

/**
 * Stores the fallback reason + time. One UPDATE, no write when nothing changes:
 * the same reason is not rewritten ('daily_limit' once per UTC day), and a
 * passing reason (daily_limit, provider_error) never replaces a sticky one
 * (key_rejected, balance_empty, model_unavailable).
 */
export async function recordOwnAiFallback(avatarId: string, reason: OwnAiFallbackReason): Promise<void> {
  if (!(OWN_AI_FALLBACK_REASONS as readonly string[]).includes(reason)) return;
  const changed =
    reason === 'daily_limit'
      ? sql`(${agentAiSettings.fallbackReason} IS DISTINCT FROM 'daily_limit' OR ${agentAiSettings.fallbackAt} IS NULL OR (${agentAiSettings.fallbackAt} AT TIME ZONE 'UTC')::date <> ${UTC_TODAY})`
      : sql`${agentAiSettings.fallbackReason} IS DISTINCT FROM ${reason}`;
  const notSticky = isSticky(reason)
    ? sql`TRUE`
    : sql`(${agentAiSettings.fallbackReason} IS NULL OR ${agentAiSettings.fallbackReason} NOT IN ('key_rejected', 'balance_empty', 'model_unavailable'))`;
  await db
    .update(agentAiSettings)
    .set({ fallbackReason: reason, fallbackAt: sql`now()` })
    .where(and(eq(agentAiSettings.avatarId, avatarId), sql`${agentAiSettings.source} <> 'clawville'`, changed, notSticky));
}

// ---------------------------------------------------------------------------
// Provider calls (fixed hosts, timeouts, no redirects, size caps, safe codes)
// ---------------------------------------------------------------------------

const MODELS_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 15_000;
const USEPOD_TIMEOUT_MS = 10_000;
const MODELS_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_MAX_BYTES = 64 * 1024;
export const OWN_AI_MODELS_LIST_MAX = 200;
const USEPOD_API = 'https://api.usepod.ai';

type CallKind = 'models' | 'test' | 'balance' | 'register';

/** Pure: an HTTP status from a provider as a safe code (null for 2xx). */
export function mapProviderStatus(status: number, kind: CallKind): OwnAiErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 402) return 'balance_empty';
  if (status === 429) return 'rate_limited';
  if (status === 404) {
    if (kind === 'test') return 'model_unavailable';
    if (kind === 'balance') return 'key_rejected';
    return 'provider_error';
  }
  if ((status === 400 || status === 422) && kind === 'test') return 'model_unavailable';
  return 'provider_error'; // 3xx (redirect: manual), other 4xx, 5xx
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OwnAiError('provider_error');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * One provider request. Fetch and body read share one timeout. Returns the
 * parsed JSON (or null when `readBody` is false). Any failure throws an
 * OwnAiError with a short code; the URL, headers and body never reach it.
 */
async function callProvider(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  opts: { kind: CallKind; timeoutMs: number; maxBytes: number; readBody: boolean },
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: ac.signal });
    const code = mapProviderStatus(res.status, opts.kind);
    if (code) {
      await res.body?.cancel().catch(() => {});
      throw new OwnAiError(code);
    }
    if (!opts.readBody) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res, opts.maxBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OwnAiError('provider_error');
    }
  } catch (err) {
    if (err instanceof OwnAiError) throw err;
    throw new OwnAiError(ac.signal.aborted ? 'timeout' : 'provider_error');
  } finally {
    clearTimeout(timer);
  }
}

function providerHeaders(provider: OwnAiProvider, key: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'usepod') {
    // The token in the path is the credential; UsePod accepts any bearer.
    headers.Authorization = 'Bearer UsePod';
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://clawville.world';
    headers['X-Title'] = 'ClawVille';
  }
  return headers;
}

function checkedKey(provider: unknown, key: unknown): { provider: OwnAiProvider; key: string } {
  if (!isOwnAiProvider(provider)) throw new OwnAiError('invalid_provider');
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!OWN_AI_PROVIDER_SPECS[provider].keyPattern.test(trimmed)) throw new OwnAiError('invalid_key');
  return { provider, key: trimmed };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Pure: model ids from a `{ data: [{ id }] }` list; control characters stripped, valid ids only, unique, at most 200. */
export function sanitizeModelList(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new OwnAiError('provider_error');
  const out = new Set<string>();
  for (const item of data) {
    if (out.size >= OWN_AI_MODELS_LIST_MAX) break;
    const raw = (item as { id?: unknown } | null)?.id;
    if (typeof raw !== 'string' || raw.length > 512) continue;
    const id = raw.replace(CONTROL_CHARS, '').trim();
    if (isOwnAiModelId(id)) out.add(id);
  }
  return [...out];
}

/** Live list from the provider with the given key; 8 s timeout; ids only, capped 200, sanitized. */
export async function listProviderModels(provider: OwnAiProvider, key: string): Promise<string[]> {
  const checked = checkedKey(provider, key);
  const spec = OWN_AI_PROVIDER_SPECS[checked.provider];
  const query = checked.provider === 'anthropic' ? '?limit=1000' : '';
  const body = await callProvider(
    `${spec.baseUrl(checked.key)}${spec.modelsPath}${query}`,
    { method: 'GET', headers: providerHeaders(checked.provider, checked.key) },
    { kind: 'models', timeoutMs: MODELS_TIMEOUT_MS, maxBytes: MODELS_MAX_BYTES, readBody: true },
  );
  return sanitizeModelList(body);
}

/** Max tokens of the test call. A reasoning model needs room to think or it fails on a tiny cap. */
const TEST_MAX_TOKENS = 8;
const TEST_REASONING_MAX_TOKENS = 512;
/** Input tokens reserved for the test prompt ('Reply with OK.' plus the provider's message overhead). */
const TEST_INPUT_TOKENS = 32;

/** Worst-case tokens of one key test call (it is a paid call on the user's key). */
export function ownAiTestEstimate(provider: OwnAiProvider, model: string): OwnAiCallEstimate {
  return {
    inputTokens: TEST_INPUT_TOKENS,
    outputTokens: isOwnAiReasoningModel(provider, model) ? TEST_REASONING_MAX_TOKENS : TEST_MAX_TOKENS,
  };
}

/**
 * Reserves a key test call through the same atomic reservation as a normal
 * call: ONE conditional upsert on today's usage row, written only when
 * estimated + reserved + estimate fits under the STORED daily limit, or, on a
 * first save with no stored limit, under `requestLimitCents`. Unlike a normal
 * call it does not require an own-AI source or the absence of a sticky
 * fallback (a save is how the human fixes those), and a refusal records no
 * fallback. Returns the reservation, or null when it does not fit.
 */
export async function reserveOwnAiTestCall(
  avatarId: string,
  model: string,
  estimate: OwnAiCallEstimate,
  requestLimitCents: number | null,
): Promise<OwnAiReservation | null> {
  const micro = ownAiEstimateMicroUsd(model, estimate);
  const requestLimit = isOwnAiDailyLimitCents(requestLimitCents) ? requestLimitCents : null;
  const limitMicro = sql`(COALESCE((SELECT s.daily_limit_cents FROM agent_ai_settings s WHERE s.avatar_id = ${avatarId}), ${requestLimit}::integer)::bigint * 10000)`;
  const reserved = await db.execute<{ day: string }>(sql`
    INSERT INTO agent_ai_usage AS u (avatar_id, day, reserved_micro_usd)
    SELECT ${avatarId}::uuid, ${UTC_TODAY}, ${micro}::bigint
    WHERE ${micro}::bigint <= ${limitMicro}
    ON CONFLICT (avatar_id, day) DO UPDATE
      SET reserved_micro_usd = u.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
          updated_at = now()
      WHERE u.estimated_micro_usd + u.reserved_micro_usd + EXCLUDED.reserved_micro_usd <= ${limitMicro}
    RETURNING u.day::text AS day
  `);
  const day = (Array.from(reserved)[0] as { day?: unknown } | undefined)?.day;
  return isIsoDay(day) ? { microUsd: micro, day } : null;
}

/**
 * The key test of a save, metered: reserve its worst-case cost (refused ->
 * `daily_limit_reached`, no provider call), run testOwnAiKey, then settle the
 * reservation at the worst-case estimate (the test reads no usage body) when it
 * worked, or release it when it failed, like a normal call.
 */
export async function runMeteredOwnAiKeyTest(
  avatarId: string,
  provider: OwnAiProvider,
  key: string,
  model: string,
  requestLimitCents: number | null,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const estimate = ownAiTestEstimate(provider, model);
  const reservation = await reserveOwnAiTestCall(avatarId, model, estimate, requestLimitCents);
  if (!reservation) return { ok: false, code: 'daily_limit_reached' };
  let result: { ok: true } | { ok: false; code: string };
  try {
    result = await testOwnAiKey(provider, key, model);
  } catch {
    result = { ok: false, code: 'provider_error' };
  }
  try {
    if (result.ok) {
      await recordOwnAiUsage(avatarId, model, estimate.inputTokens, estimate.outputTokens, reservation);
    } else {
      await releaseOwnAiReservation(avatarId, reservation);
    }
  } catch (err) {
    // The reservation stays held (it can only over-count, until midnight UTC). Never log the message.
    console.warn(`[own-ai] test_meter_failed avatar=${avatarId} name=${err instanceof Error ? err.name : 'unknown'}`);
  }
  return result;
}

/** One tiny test call to prove the key + model work before save. Returns ok or a short safe error code. */
export async function testOwnAiKey(
  provider: OwnAiProvider,
  key: string,
  model: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const checked = checkedKey(provider, key);
    const modelId = typeof model === 'string' ? model.trim() : '';
    if (!isOwnAiModelId(modelId)) throw new OwnAiError('invalid_model');
    const spec = OWN_AI_PROVIDER_SPECS[checked.provider];
    const maxTokens = isOwnAiReasoningModel(checked.provider, modelId) ? TEST_REASONING_MAX_TOKENS : TEST_MAX_TOKENS;
    const messages = [{ role: 'user', content: 'Reply with OK.' }];
    let url: string;
    let payload: Record<string, unknown>;
    if (spec.protocol === 'anthropic') {
      url = `${spec.baseUrl(checked.key)}/v1/messages`;
      payload = { model: modelId, max_tokens: maxTokens, messages };
    } else {
      url = `${spec.baseUrl(checked.key)}/chat/completions`;
      // OpenAI's own API refuses `max_tokens` on reasoning models; it takes `max_completion_tokens`.
      payload = checked.provider === 'openai'
        ? { model: modelId, max_completion_tokens: maxTokens, messages }
        : { model: modelId, max_tokens: maxTokens, messages };
    }
    await callProvider(
      url,
      {
        method: 'POST',
        headers: { ...providerHeaders(checked.provider, checked.key), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { kind: 'test', timeoutMs: TEST_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES, readBody: false },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err instanceof OwnAiError ? err.code : 'provider_error' };
  }
}

// ---------------------------------------------------------------------------
// UsePod
// ---------------------------------------------------------------------------

const DEPOSIT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function usepodDashboardUrl(token: string): string {
  return `https://usepod.ai/dashboard/${token.toLowerCase()}`;
}

/** True for an `https://usepod.ai/...` URL with no credentials or port. */
export function isUsepodDashboardUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 512) return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === 'usepod.ai' && url.port === '' && url.username === '' && url.password === '';
}

/** Pure: validates the register reply. Throws OwnAiError('provider_error') on any unexpected shape. */
export function parseUsepodRegisterResponse(body: unknown): { token: string; depositCode: string; contractAddress: string } {
  const b = body as {
    api_token?: unknown;
    deposit_code?: unknown;
    instructions?: { contract_address?: unknown; dashboard_url?: unknown } | null;
  } | null;
  const token = b?.api_token;
  const depositCode = b?.deposit_code;
  const contractAddress = b?.instructions?.contract_address;
  const dashboardUrl = b?.instructions?.dashboard_url;
  if (typeof token !== 'string' || !OWN_AI_USEPOD_TOKEN_PATTERN.test(token)) throw new OwnAiError('provider_error');
  if (typeof depositCode !== 'string' || !DEPOSIT_CODE_PATTERN.test(depositCode)) throw new OwnAiError('provider_error');
  if (typeof contractAddress !== 'string' || !SOLANA_ADDRESS_PATTERN.test(contractAddress)) throw new OwnAiError('provider_error');
  if (!isUsepodDashboardUrl(dashboardUrl)) throw new OwnAiError('provider_error');
  return { token: token.toLowerCase(), depositCode, contractAddress };
}

async function readUsepodRegistered(executor: Pick<typeof db, 'select'>, avatarId: string): Promise<boolean> {
  const [row] = await executor
    .select({ usepodRegistered: agentAiSettings.usepodRegistered })
    .from(agentAiSettings)
    .where(eq(agentAiSettings.avatarId, avatarId))
    .limit(1);
  return row?.usepodRegistered === true;
}

/**
 * POST https://api.usepod.ai/v1/register; the token goes in its OWN columns
 * (usepod_token_*), never the own-key slot, and nothing else in the row changes.
 * The dashboardUrl CONTAINS the token (usepod.ai/dashboard/<token>): return it to
 * a HUMAN session only (register, and the human-only link route), never to an
 * agent session, never in OwnAiStatus, never in logs. Refused when a registered
 * token is already stored: it may hold a funded balance (replacing or deleting
 * it is out of scope for part A). To use it the human saves source 'usepod'
 * with a model and a limit and no key.
 */
export async function registerUsepodToken(
  avatarId: string,
  userId: string,
): Promise<{ dashboardUrl: string; depositCode: string; contractAddress: string }> {
  if (await readUsepodRegistered(db, avatarId)) throw new OwnAiError('usepod_already_registered');
  const body = await callProvider(
    `${USEPOD_API}/v1/register`,
    { method: 'POST', headers: { Accept: 'application/json' } },
    { kind: 'register', timeoutMs: USEPOD_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES, readBody: true },
  );
  const reg = parseUsepodRegisterResponse(body);
  await db.transaction(async (tx) => {
    await lockSpendRules(tx, avatarId);
    if (await readUsepodRegistered(tx, avatarId)) throw new OwnAiError('usepod_already_registered');
    const sealed = deps.encrypt(reg.token);
    const values = {
      usepodTokenEnc: sealed.enc,
      usepodTokenIv: sealed.iv,
      usepodTokenTag: sealed.tag,
      usepodTokenLast4: reg.token.slice(-4),
      usepodRegistered: true,
      updatedByUserId: userId,
      updatedAt: new Date(),
    };
    await tx
      .insert(agentAiSettings)
      .values({ avatarId, ...values })
      .onConflictDoUpdate({ target: agentAiSettings.avatarId, set: values });
  });
  emitSettingsChanged(avatarId);
  return { dashboardUrl: usepodDashboardUrl(reg.token), depositCode: reg.depositCode, contractAddress: reg.contractAddress };
}

/** Human-only: rebuild the dashboard link from the REGISTERED token (so the user can fund it, or use what UsePod's own dashboard offers). */
export async function readUsepodDashboardLink(avatarId: string): Promise<string | null> {
  const token = registeredToken(avatarId, await loadStoredRow(avatarId));
  return token ? usepodDashboardUrl(token) : null;
}

/** Pure: validates a balance reply. */
export function parseUsepodBalance(body: unknown): { usdcMicro: number; isActive: boolean } {
  const b = body as { usdc_balance?: unknown; is_active?: unknown } | null;
  const usdc = b?.usdc_balance;
  if (typeof usdc !== 'number' || !Number.isSafeInteger(usdc) || usdc < 0) throw new OwnAiError('provider_error');
  if (typeof b?.is_active !== 'boolean') throw new OwnAiError('provider_error');
  return { usdcMicro: usdc, isActive: b.is_active };
}

/**
 * The UsePod balance, or null when no UsePod token is stored. Reads the
 * registered token; without one, a token the user pasted (own-key slot,
 * provider 'usepod'). A funded, active balance clears a 'balance_empty'
 * fallback (the human funds on UsePod's own site, so no save happens) and
 * restarts the runtime.
 */
export async function readUsepodBalance(avatarId: string): Promise<{ usdcMicro: number; isActive: boolean } | null> {
  const row = await loadStoredRow(avatarId);
  const token = registeredToken(avatarId, row) ?? slotKey(avatarId, row, 'usepod');
  if (!token) return null;
  const body = await callProvider(
    `${USEPOD_API}/proxy/${token.toLowerCase()}/balance`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    { kind: 'balance', timeoutMs: USEPOD_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES, readBody: true },
  );
  const balance = parseUsepodBalance(body);
  if (balance.usdcMicro > 0 && balance.isActive) {
    const cleared = await db
      .update(agentAiSettings)
      .set({ fallbackReason: null, fallbackAt: null })
      .where(and(eq(agentAiSettings.avatarId, avatarId), eq(agentAiSettings.fallbackReason, 'balance_empty')))
      .returning({ avatarId: agentAiSettings.avatarId });
    if (cleared.length > 0) emitSettingsChanged(avatarId);
  }
  return balance;
}
