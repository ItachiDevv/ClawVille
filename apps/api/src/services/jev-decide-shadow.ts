// FEATURE_GATE: jev_decide_shadow
// Status: shadow (no game effect)
// Metric to graduate: Jev verb agreement with local model and latency over >=2 days, founder go
// Current reading: none (new)
// Review deadline: 2026-10-16
// On deadline: delete the shadow or promote Jev to decide with local fallback (founder decision)
// Reference: ops/house-traders/research-20261007/JEV-AGENT-DECIDE-PLAN.md

/**
 * jev-decide-shadow.ts — measure whether Jev (a fast yes/no probability model)
 * picks the same next ACTION VERB as the hosted agent's local decide model.
 *
 * SHADOW ONLY. Jev's answer changes NOTHING in the game: the driver fires this
 * without awaiting it, every error is caught here, and the only side effect is
 * one row in `jev_decide_shadow` (migration 0081) for the report script
 * `apps/api/scripts/jev-decide-shadow-report.ts`.
 *
 * Enabled only when `JEV_API_KEY` is set. The key is never logged or stored;
 * every logged or stored error text is redacted of it.
 *
 * Spend cap (founder: $1 TOTAL across both boxes) is IN CODE, not env:
 * production $0.90 total / $0.25 per UTC day; any other env $0.10 / $0.05.
 * Before each call one transaction takes a fixed advisory lock, sums `usd`
 * over all rows (total + today), refuses if the estimate would cross a cap,
 * and otherwise inserts a `reserved` row with the estimate. After the call the
 * row gets the actual cost from `usage.input_tokens` (the reserved upper bound
 * stays when usage is missing, and on error/timeout, because a failed call may
 * still bill). The reservation is an upper bound (UTF-8 bytes + envelope), so
 * the ledger never sits below the real spend.
 */

import { HATCHER_ACTION_MENU } from '@clawville/shared';
import { db, sql } from '@clawville/database';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
/** USD per 1,000,000 billed input tokens. */
export const JEV_USD_PER_MTOK = 0.042;
export const JEV_TIMEOUT_MS = 5_000;
/** Token allowance for the request envelope (model name, JSON keys). */
export const JEV_ENVELOPE_TOKENS = 256;
/** Fixed advisory-lock key that serializes the cap check + reserve insert. */
export const JEV_CAP_LOCK_KEY = 7_413_008_101;
export const JEV_MAX_GLOBAL_IN_FLIGHT = 2;

export interface JevSpendCaps {
  totalUsd: number;
  dailyUsd: number;
}

/** Caps are constants by `CLAWVILLE_ENV`; production + one other env = $1. */
export function jevSpendCaps(clawvilleEnv: string | undefined): JevSpendCaps {
  return clawvilleEnv === 'production'
    ? { totalUsd: 0.9, dailyUsd: 0.25 }
    : { totalUsd: 0.1, dailyUsd: 0.05 };
}

export interface JevShadowInput {
  /** The exact prompt string the local model got. Never stored. */
  prompt: string;
  avatarId: string;
  isHouse: boolean;
  localVerb: string | null;
  localEmpty: boolean;
  localMs: number;
}

export type JevShadowStatus = 'reserved' | 'ok' | 'error' | 'timeout' | 'skipped_cap';

export interface JevReserveRow {
  avatarId: string;
  isHouse: boolean;
  localVerb: string | null;
  localEmpty: boolean;
  localMs: number;
  estimateUsd: number;
}

export type JevReserveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'total' | 'daily' };

export interface JevFinishPatch {
  status: Exclude<JevShadowStatus, 'reserved' | 'skipped_cap'>;
  jevVerb: string | null;
  jevTopProb: number | null;
  jevProbs: Record<string, number> | null;
  jevMs: number;
  inputTokens: number | null;
  /** null = keep the reserved estimate. */
  usd: number | null;
  error: string | null;
}

/** DB seam (the cap ledger). The default writes `jev_decide_shadow`. */
export interface JevShadowLedger {
  /** Atomic cap check + reserve insert. Must refuse when estimate would cross a cap. */
  reserve(row: JevReserveRow, caps: JevSpendCaps): Promise<JevReserveResult>;
  finish(id: string, patch: JevFinishPatch): Promise<void>;
  /** One usd=0 row so the report can count cap refusals. */
  recordSkippedCap(row: Omit<JevReserveRow, 'estimateUsd'>, reason: 'total' | 'daily'): Promise<void>;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JevShadowDeps {
  fetch: FetchLike;
  ledger: JevShadowLedger;
  getApiKey: () => string | undefined;
  getEnv: () => string | undefined;
  now: () => number;
  log: { warn: (line: string) => void };
  timeoutMs?: number;
}

interface JevQuestion {
  type: 'noul';
  instructions: string;
}

/** One `noul` question per whitelisted verb (name = verb). */
export function buildJevQuestions(): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const item of HATCHER_ACTION_MENU) {
    questions[item.verb] = {
      type: 'noul',
      instructions: `Probability that \`${item.verb}\` is the single best next action for this agent right now. Use: ${item.whenToUse}`,
    };
  }
  return questions;
}

/**
 * UPPER BOUND on the billed cost, not a guess: a byte-level tokenizer emits at
 * most one token per UTF-8 byte, so request bytes + a fixed envelope allowance
 * bound the billed input tokens. Reserving this before the call keeps the
 * ledger at or above the real spend (Codex r1: a chars/3 estimate could be
 * exceeded by the actual usage and push the total past the cap).
 */
export function estimateJevUsd(promptBytes: number, questionBytes: number): number {
  const tokens = promptBytes + questionBytes + JEV_ENVELOPE_TOKENS;
  return tokens * JEV_USD_PER_MTOK / 1_000_000;
}

/** Highest probability wins; ties keep menu order. null when no valid answer. */
export function pickJevVerb(
  answers: unknown,
): { verb: string; prob: number; probs: Record<string, number> } | null {
  if (!answers || typeof answers !== 'object') return null;
  const probs: Record<string, number> = {};
  let best: { verb: string; prob: number } | null = null;
  for (const item of HATCHER_ACTION_MENU) {
    const answer = (answers as Record<string, unknown>)[item.verb];
    const p = answer && typeof answer === 'object' ? (answer as Record<string, unknown>).noul : undefined;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) continue;
    probs[item.verb] = p;
    if (!best || p > best.prob) best = { verb: item.verb, prob: p };
  }
  return best ? { ...best, probs } : null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function redact(text: string, key: string): string {
  const safe = key.length > 0 ? text.split(key).join('[redacted]') : text;
  return safe.slice(0, 200);
}

export function createJevDecideShadow(deps: JevShadowDeps) {
  const inFlightAgents = new Set<string>();
  let globalInFlight = 0;
  // Latches: once a cap refuses, stop calling (and writing) until it can pass.
  let totalCapHit = false;
  let dailyCapDay: string | null = null;
  let capWarned = false;
  const questions = buildJevQuestions();
  const questionBytes = Buffer.byteLength(JSON.stringify(questions), 'utf8');

  async function run(input: JevShadowInput): Promise<void> {
    const apiKey = deps.getApiKey()?.trim();
    if (!apiKey) return;
    if (totalCapHit) return;
    const today = utcDay(deps.now());
    if (dailyCapDay === today) return;
    if (inFlightAgents.has(input.avatarId) || globalInFlight >= JEV_MAX_GLOBAL_IN_FLIGHT) return;

    inFlightAgents.add(input.avatarId);
    globalInFlight++;
    try {
      const base = {
        avatarId: input.avatarId,
        isHouse: input.isHouse,
        localVerb: input.localVerb,
        localEmpty: input.localEmpty,
        localMs: Math.max(0, Math.round(input.localMs)),
      };
      const estimateUsd = estimateJevUsd(Buffer.byteLength(input.prompt, 'utf8'), questionBytes);
      const reserved = await deps.ledger.reserve({ ...base, estimateUsd }, jevSpendCaps(deps.getEnv()));
      if (!reserved.ok) {
        if (reserved.reason === 'total') totalCapHit = true;
        else dailyCapDay = today;
        if (!capWarned) {
          capWarned = true;
          deps.log.warn(`[JevShadow] spend cap reached (${reserved.reason}); shadow calls refused`);
        }
        await deps.ledger.recordSkippedCap(base, reserved.reason);
        return;
      }

      const started = deps.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? JEV_TIMEOUT_MS);
      let patch: JevFinishPatch;
      try {
        const res = await deps.fetch(JEV_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: JEV_MODEL, state: input.prompt, questions }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const body = (await res.json()) as {
          answers?: unknown;
          usage?: { input_tokens?: unknown };
        } | null;
        const rawTokens = body?.usage?.input_tokens;
        const inputTokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0
          ? Math.round(rawTokens)
          : null;
        const usd = inputTokens === null ? null : inputTokens * JEV_USD_PER_MTOK / 1_000_000;
        const pick = pickJevVerb(body?.answers);
        patch = pick
          ? {
            status: 'ok', jevVerb: pick.verb, jevTopProb: pick.prob, jevProbs: pick.probs,
            jevMs: deps.now() - started, inputTokens, usd, error: null,
          }
          : {
            status: 'error', jevVerb: null, jevTopProb: null, jevProbs: null,
            jevMs: deps.now() - started, inputTokens, usd, error: 'no_valid_answers',
          };
      } catch (err) {
        const timedOut = controller.signal.aborted;
        const message = redact(err instanceof Error ? err.message : String(err), apiKey);
        patch = {
          status: timedOut ? 'timeout' : 'error', jevVerb: null, jevTopProb: null, jevProbs: null,
          jevMs: deps.now() - started, inputTokens: null, usd: null,
          error: timedOut ? 'timeout' : message,
        };
        deps.log.warn(`[JevShadow] call ${timedOut ? 'timed out' : `failed: ${message}`}`);
      } finally {
        clearTimeout(timer);
      }
      await deps.ledger.finish(reserved.id, patch);
    } finally {
      inFlightAgents.delete(input.avatarId);
      globalInFlight--;
    }
  }

  /** Fire-and-forget entry: never throws, never rejects. */
  function fire(input: JevShadowInput): void {
    let key = '';
    try {
      key = deps.getApiKey()?.trim() ?? '';
      if (!key) return;
      void run(input).catch((err: unknown) => {
        deps.log.warn(`[JevShadow] shadow failed: ${redact(err instanceof Error ? err.message : String(err), key)}`);
      });
    } catch (err) {
      deps.log.warn(`[JevShadow] shadow failed: ${redact(err instanceof Error ? err.message : String(err), key)}`);
    }
  }

  return { run, fire };
}

/** Every ledger write runs bounded (Codex r1 2026-10-14): a stalled shadow write must never hold a shared pool
 *  connection that the trading / driver paths need. A timeout throws; the caller's catch logs it. */
async function boundedWrite(query: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    await tx.execute(query);
  });
}

/** Default ledger: `jev_decide_shadow` through the shared Drizzle client. */
export const dbJevShadowLedger: JevShadowLedger = {
  async reserve(row, caps) {
    return db.transaction(async (tx) => {
      // Bounded: a stalled lock or sum must never hold a shared pool
      // connection for long (Codex r1). A timeout throws; fire() logs it.
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${JEV_CAP_LOCK_KEY})`);
      const sums = await tx.execute<{ total: string | null; today: string | null }>(sql`
        SELECT COALESCE(SUM(usd), 0)::text AS total,
               COALESCE(SUM(usd) FILTER (
                 WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
               ), 0)::text AS today
        FROM jev_decide_shadow`);
      const total = Number(sums[0]?.total ?? 0);
      const today = Number(sums[0]?.today ?? 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' } as const;
      if (today + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' } as const;
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO jev_decide_shadow (avatar_id, is_house, status, local_verb, local_empty, local_ms, usd)
        VALUES (${row.avatarId}, ${row.isHouse}, 'reserved', ${row.localVerb}, ${row.localEmpty},
                ${row.localMs}, ${row.estimateUsd.toFixed(8)}::numeric)
        RETURNING id`);
      const id = inserted[0]?.id;
      if (!id) throw new Error('reserve insert returned no id');
      return { ok: true, id } as const;
    });
  },
  async finish(id, patch) {
    const probs = patch.jevProbs === null ? null : JSON.stringify(patch.jevProbs);
    const usd = patch.usd === null ? null : patch.usd.toFixed(8);
    await boundedWrite(sql`
      UPDATE jev_decide_shadow SET
        status = ${patch.status},
        jev_verb = ${patch.jevVerb},
        jev_top_prob = ${patch.jevTopProb},
        jev_probs = ${probs}::jsonb,
        jev_ms = ${Math.max(0, Math.round(patch.jevMs))},
        input_tokens = ${patch.inputTokens},
        usd = COALESCE(${usd}::numeric, usd),
        error = ${patch.error}
      WHERE id = ${id}`);
  },
  async recordSkippedCap(row, reason) {
    await boundedWrite(sql`
      INSERT INTO jev_decide_shadow (avatar_id, is_house, status, local_verb, local_empty, local_ms, usd, error)
      VALUES (${row.avatarId}, ${row.isHouse}, 'skipped_cap', ${row.localVerb}, ${row.localEmpty},
              ${row.localMs}, 0, ${`cap_${reason}`})`);
  },
};

const defaultShadow = createJevDecideShadow({
  fetch: (url, init) => fetch(url, init),
  ledger: dbJevShadowLedger,
  getApiKey: () => process.env.JEV_API_KEY,
  getEnv: () => process.env.CLAWVILLE_ENV,
  now: () => Date.now(),
  log: { warn: (line) => console.warn(line) },
});

/**
 * Driver hook. Fire-and-forget: returns immediately, never throws, and its
 * result never reaches the game.
 */
export function fireJevDecideShadow(input: JevShadowInput): void {
  defaultShadow.fire(input);
}
