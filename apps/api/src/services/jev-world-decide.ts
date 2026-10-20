// FEATURE_GATE: jev_world_decide_demo
// Status: staging-only demo (Jev decides the next world action for listed avatars; local LLM is the fallback)
// Metric to graduate: on staging, >=50 demo decisions with Jev p50 < 500 ms, >=60% decided by Jev (not fallback), no executor refusals above the local baseline, founder go
// Current reading: 2026-10-20 03:13-04:12Z run (one choice question, house avatar): 50 rows, 13 demo_jev (26%) / 37 demo_fallback, Jev p50 ~80 ms, spend $0.009; at gate 0.4 Jev would decide 50%, at 0.3 78%; Jev picks caused 1 refused action, local fallback picks 21 (8 out-of-bounds move, 13 session kills); top pick enter_kelp_forest on 31/50 rows. Metric NOT met (60% by Jev)
// Review deadline: 2026-10-23
// On deadline: delete this module and its driver branch, or write a production plan with a new cap (founder decision)
// Reference: GameFeatures.md (Jev decide shadow + world-decide demo bullets), ARCHITECTURE.md section 4

/**
 * jev-world-decide.ts - STAGING-ONLY demo: a few hosted agents take their next
 * world action from Jev (a fast probability model, ~70 ms) instead of waiting
 * for the local LLM (~7 s). The local LLM stays the fallback for every case
 * Jev cannot answer safely.
 *
 * Gate (all must hold, re-checked on every call):
 *   CLAWVILLE_ENV === 'staging' (production is refused in code),
 *   JEV_API_KEY set, and the avatar uuid listed in JEV_DECIDE_AVATAR_IDS.
 *
 * Safety: Jev never emits free text. It picks one verb from the FULL
 * HATCHER_ACTION_MENU (the same menu and the same prompt the local model
 * sees, as Jev `state`) with ONE `choice` question (`next_action`, one option
 * per menu verb; its probabilities sum to 1, so the top verb is not diluted
 * the way independent per-verb `noul` answers were). A house actor's options
 * omit HOUSE_REFUSED_AUTONOMY_VERBS, the verbs the executor refuses for it,
 * the same as its local decide menu. Only verbs whose params
 * come from a fixed list are accepted here: four no-param place verbs,
 * `emote` (names from the menu syntax), `enter_building` / `claim_tutorial_quest` / `salvage_node` (ids
 * the prompt already lists, picked with Jev `choice` questions). Any other
 * verb (money, land, free-text chat, move) falls back to local. The result is
 * an `[ACTION: verb(param=value)]` string that the driver parses and
 * dispatches through the same parser and executor whitelist as a local reply.
 *
 * Spend cap IN CODE: $0.25 total / $0.10 per UTC day. Rows share the
 * `jev_decide_shadow` ledger with a `demo_` status prefix; the demo cap sums
 * only demo rows and the shadow cap excludes them. A refusal falls back to
 * local. The API key is never logged or stored; errors are redacted.
 */

import { z } from 'zod';
import { HATCHER_ACTION_MENU } from '@clawville/shared';
import { db, sql } from '@clawville/database';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from './house-refused-verbs';
import {
  JEV_CAP_LOCK_KEY,
  JEV_DEMO_STATUS_PREFIX,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_USD_PER_MTOK,
  boundedWrite,
  estimateJevUsd,
  redact,
  utcDay,
  type JevReserveResult,
  type JevSpendCaps,
} from './jev-decide-shadow';

export const JEV_WORLD_TIMEOUT_MS = 3_000;
/** Jev's top verb probability must reach this, or the decision falls back to local. */
export const JEV_WORLD_MIN_TOP_PROB = 0.5;
export const JEV_WORLD_MAX_GLOBAL_IN_FLIGHT = 2;
/** Upper bound on options per param `choice` question (keeps the request small). */
export const JEV_WORLD_MAX_CHOICES = 24;
/** Name of the one `choice` question whose options are every menu verb. */
export const JEV_WORLD_ACTION_QUESTION = 'next_action';
/** Max chars of a verb's `whenToUse` sent as its option text (longest today is ~210). */
const ACTION_CRITERIA_MAX_CHARS = 240;
/** Demo caps (staging only). Separate from the shadow caps. */
export const JEV_WORLD_CAPS: JevSpendCaps = { totalUsd: 0.25, dailyUsd: 0.1 };

/** Ids that may appear inside an [ACTION:] tag: no comma, no paren, no space. */
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const NO_PARAM_VERBS: ReadonlySet<string> = new Set([
  'enter_cove',
  'enter_poker_room',
  'enter_kelp_forest',
  'enter_trading_floor',
]);

type ParamQuestion = 'param_building' | 'param_emote' | 'param_quest' | 'param_salvage';

const PARAM_VERBS: Readonly<Record<string, { param: string; question: ParamQuestion }>> = {
  enter_building: { param: 'buildingId', question: 'param_building' },
  emote: { param: 'name', question: 'param_emote' },
  claim_tutorial_quest: { param: 'questId', question: 'param_quest' },
  salvage_node: { param: 'nodeId', question: 'param_salvage' },
};

/** Emote names straight from the menu syntax, so they never drift from the executor manual. */
export function emoteNamesFromMenu(): string[] {
  const syntax = HATCHER_ACTION_MENU.find((item) => item.verb === 'emote')?.syntax ?? '';
  const match = /name=<([^>]+)>/.exec(syntax);
  return match ? match[1].split('|').map((name) => name.trim()).filter((name) => SAFE_ID_RE.test(name)) : [];
}

// ---------------------------------------------------------------- gate

const avatarIdsSchema = z.string().uuid();

/** Comma list of avatar uuids; invalid entries are dropped. */
export function parseDemoAvatarIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (avatarIdsSchema.safeParse(id).success) out.add(id);
  }
  return out;
}

export type JevWorldEnv = Readonly<Record<string, string | undefined>>;

/** True only on staging, with a key, for a listed avatar. Production is impossible. */
export function isJevWorldDecideEnabled(avatarId: string, env: JevWorldEnv = process.env): boolean {
  if (env.CLAWVILLE_ENV === 'production') return false;
  if (env.CLAWVILLE_ENV !== 'staging') return false;
  if (!env.JEV_API_KEY?.trim()) return false;
  return parseDemoAvatarIds(env.JEV_DECIDE_AVATAR_IDS).has(avatarId.trim().toLowerCase());
}

/** True when the demo could run for any avatar (used to arm the demo poll). */
export function isJevWorldDecideConfigured(env: JevWorldEnv = process.env): boolean {
  return env.CLAWVILLE_ENV === 'staging'
    && !!env.JEV_API_KEY?.trim()
    && parseDemoAvatarIds(env.JEV_DECIDE_AVATAR_IDS).size > 0;
}

// ---------------------------------------------------------------- questions

export interface JevWorldTarget {
  id: string;
  label: string;
}

export interface JevWorldTargets {
  buildings: JevWorldTarget[];
  quests: JevWorldTarget[];
  salvageNodes: JevWorldTarget[];
}

type JevWorldQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };

/**
 * One option per verb of the FULL menu (consumption mandate: never only the
 * verbs this demo accepts). A house actor gets the menu minus
 * HOUSE_REFUSED_AUTONOMY_VERBS, which is exactly what the executor runs for it.
 */
export function actionChoiceCriteria(isHouse = false): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const item of HATCHER_ACTION_MENU) {
    if (isHouse && HOUSE_REFUSED_AUTONOMY_VERBS.has(item.verb)) continue;
    criteria[item.verb] = item.whenToUse.replace(/\s+/g, ' ').trim().slice(0, ACTION_CRITERIA_MAX_CHARS) || item.verb;
  }
  return criteria;
}

function choiceCriteria(targets: readonly JevWorldTarget[]): Record<string, string> | null {
  const criteria: Record<string, string> = {};
  let n = 0;
  for (const target of targets) {
    if (n >= JEV_WORLD_MAX_CHOICES) break;
    if (!SAFE_ID_RE.test(target.id) || Object.prototype.hasOwnProperty.call(criteria, target.id)) continue;
    criteria[target.id] = target.label.replace(/\s+/g, ' ').slice(0, 160) || target.id;
    n += 1;
  }
  return n > 0 ? criteria : null;
}

/** One `choice` over every menu verb plus one `choice` per fixed param list that has options. */
export function buildJevWorldQuestions(targets: JevWorldTargets, isHouse = false): Record<string, JevWorldQuestion> {
  const questions: Record<string, JevWorldQuestion> = {
    [JEV_WORLD_ACTION_QUESTION]: {
      type: 'choice',
      instructions: 'Which single action from the menu is the best next action for this agent right now?',
      criteria: actionChoiceCriteria(isHouse),
    },
  };
  const add = (name: ParamQuestion, instructions: string, list: readonly JevWorldTarget[]) => {
    const criteria = choiceCriteria(list);
    if (criteria) questions[name] = { type: 'choice', instructions, criteria };
  };
  add('param_building', 'If this agent walks to a teacher building next, which buildingId fits best?', targets.buildings);
  add(
    'param_emote',
    'If this agent shows an emote next, which emote fits best?',
    emoteNamesFromMenu().map((name) => ({ id: name, label: `emote ${name}` })),
  );
  add('param_quest', 'If this agent claims a tutorial quest next, which questId fits best?', targets.quests);
  add('param_salvage', 'If this agent salvages a node next, which nodeId fits best?', targets.salvageNodes);
  return questions;
}

/** The chosen key of a `choice` answer, only when it is one of the offered options. */
export function pickChoice(answers: unknown, name: string, question: JevWorldQuestion | undefined): string | null {
  if (!question || question.type !== 'choice' || !answers || typeof answers !== 'object') return null;
  const raw = (answers as Record<string, unknown>)[name];
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== undefined && a.type !== 'choice') return null;
  const choice = a.choice;
  if (typeof choice !== 'string' || !Object.prototype.hasOwnProperty.call(question.criteria, choice)) return null;
  return SAFE_ID_RE.test(choice) ? choice : null;
}

export interface JevWorldVerbPick {
  verb: string;
  prob: number;
  /** Valid menu-verb probabilities from the answer (unknown keys dropped). */
  probs: Record<string, number>;
  /** Jev's own peakedness score; recorded nowhere yet, no gate uses it. */
  confidence: number | null;
}

/**
 * The menu verb with the highest probability in the `next_action` answer; ties
 * keep menu order. The answer's `choice` string is not trusted: the argmax of
 * `probabilities` wins. null when there is no valid probability for any menu
 * verb (a bare `choice` gives no probability for the gate). When `offered` is
 * given, only those verbs count, so a verb that was not an option never wins.
 */
export function pickJevWorldVerb(
  answers: unknown,
  offered?: Readonly<Record<string, string>>,
): JevWorldVerbPick | null {
  if (!answers || typeof answers !== 'object') return null;
  const raw = (answers as Record<string, unknown>)[JEV_WORLD_ACTION_QUESTION];
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== undefined && a.type !== 'choice') return null;
  const dist = a.probabilities;
  if (!dist || typeof dist !== 'object' || Array.isArray(dist)) return null;
  const probs: Record<string, number> = {};
  let best: { verb: string; prob: number } | null = null;
  for (const item of HATCHER_ACTION_MENU) {
    if (offered && !Object.prototype.hasOwnProperty.call(offered, item.verb)) continue;
    if (!Object.prototype.hasOwnProperty.call(dist, item.verb)) continue;
    const p = (dist as Record<string, unknown>)[item.verb];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) continue;
    probs[item.verb] = p;
    if (!best || p > best.prob) best = { verb: item.verb, prob: p };
  }
  if (!best) return null;
  const c = a.confidence;
  const confidence = typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null;
  return { ...best, probs, confidence };
}

export type JevWorldResolve =
  | { ok: true; verb: string; prob: number; probs: Record<string, number>; reply: string }
  | { ok: false; reason: string; verb: string | null; prob: number | null; probs: Record<string, number> | null };

/** Turn a Jev answer body into one `[ACTION: ...]` line, or a fallback reason. Pure. */
export function resolveJevWorldAction(
  answers: unknown,
  questions: Record<string, JevWorldQuestion>,
): JevWorldResolve {
  const pick = pickJevWorldVerb(answers, questions[JEV_WORLD_ACTION_QUESTION]?.criteria);
  if (!pick) return { ok: false, reason: 'no_valid_answers', verb: null, prob: null, probs: null };
  const miss = (reason: string): JevWorldResolve => ({
    ok: false, reason, verb: pick.verb, prob: pick.prob, probs: pick.probs,
  });
  if (pick.prob < JEV_WORLD_MIN_TOP_PROB) return miss('below_threshold');
  if (NO_PARAM_VERBS.has(pick.verb)) {
    return { ok: true, verb: pick.verb, prob: pick.prob, probs: pick.probs, reply: `[ACTION: ${pick.verb}()]` };
  }
  const spec = PARAM_VERBS[pick.verb];
  if (!spec) return miss('verb_not_supported');
  const value = pickChoice(answers, spec.question, questions[spec.question]);
  if (!value) return miss('params_unresolved');
  return {
    ok: true, verb: pick.verb, prob: pick.prob, probs: pick.probs,
    reply: `[ACTION: ${pick.verb}(${spec.param}=${value})]`,
  };
}

// ---------------------------------------------------------------- ledger

export type JevWorldStatus = 'demo_jev' | 'demo_fallback';

export interface JevWorldPatch {
  status: JevWorldStatus;
  jevVerb: string | null;
  jevTopProb: number | null;
  jevProbs: Record<string, number> | null;
  jevMs: number;
  inputTokens: number | null;
  /** null = keep the reserved estimate. */
  usd: number | null;
  localVerb: string | null;
  localEmpty: boolean;
  localMs: number | null;
  /** Fallback reason or redacted error; null on a Jev decision. */
  error: string | null;
}

export interface JevWorldLedger {
  reserve(row: { avatarId: string; isHouse: boolean; estimateUsd: number }, caps: JevSpendCaps): Promise<JevReserveResult>;
  finish(id: string, patch: JevWorldPatch): Promise<void>;
  recordSkippedCap(row: { avatarId: string; isHouse: boolean }, reason: 'total' | 'daily'): Promise<void>;
}

const DEMO_RESERVED = `${JEV_DEMO_STATUS_PREFIX}reserved`;
const DEMO_SKIP_CAP = `${JEV_DEMO_STATUS_PREFIX}skip_cap`;

/** Default ledger: `jev_decide_shadow` rows with a `demo_` status (no schema change). */
export const dbJevWorldLedger: JevWorldLedger = {
  async reserve(row, caps) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      // Same lock as the shadow, so both writers serialize on one ledger table.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${JEV_CAP_LOCK_KEY})`);
      const sums = await tx.execute<{ total: string | null; today: string | null }>(sql`
        SELECT COALESCE(SUM(usd), 0)::text AS total,
               COALESCE(SUM(usd) FILTER (
                 WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
               ), 0)::text AS today
        FROM jev_decide_shadow
        WHERE left(status, 5) = ${JEV_DEMO_STATUS_PREFIX}`);
      const total = Number(sums[0]?.total ?? 0);
      const today = Number(sums[0]?.today ?? 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' } as const;
      if (today + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' } as const;
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO jev_decide_shadow (avatar_id, is_house, status, local_empty, usd)
        VALUES (${row.avatarId}, ${row.isHouse}, ${DEMO_RESERVED}, false, ${row.estimateUsd.toFixed(8)}::numeric)
        RETURNING id`);
      const id = inserted[0]?.id;
      if (!id) throw new Error('reserve insert returned no id');
      return { ok: true, id } as const;
    });
  },
  async finish(id, patch) {
    const probs = patch.jevProbs === null ? null : JSON.stringify(patch.jevProbs);
    const usd = patch.usd === null ? null : patch.usd.toFixed(8);
    const localMs = patch.localMs === null ? null : Math.max(0, Math.round(patch.localMs));
    await boundedWrite(sql`
      UPDATE jev_decide_shadow SET
        status = ${patch.status},
        jev_verb = ${patch.jevVerb},
        jev_top_prob = ${patch.jevTopProb},
        jev_probs = ${probs}::jsonb,
        jev_ms = ${Math.max(0, Math.round(patch.jevMs))},
        input_tokens = ${patch.inputTokens},
        usd = COALESCE(${usd}::numeric, usd),
        local_verb = ${patch.localVerb},
        local_empty = ${patch.localEmpty},
        local_ms = ${localMs},
        error = ${patch.error}
      WHERE id = ${id}`);
  },
  async recordSkippedCap(row, reason) {
    await boundedWrite(sql`
      INSERT INTO jev_decide_shadow (avatar_id, is_house, status, local_empty, usd, error)
      VALUES (${row.avatarId}, ${row.isHouse}, ${DEMO_SKIP_CAP}, false, 0, ${`cap_${reason}`})`);
  },
};

// ---------------------------------------------------------------- runner

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JevWorldDeps {
  fetch: FetchLike;
  ledger: JevWorldLedger;
  env: () => JevWorldEnv;
  now: () => number;
  log: { warn: (line: string) => void };
  timeoutMs?: number;
}

export interface JevWorldDecideInput {
  /** The exact decide prompt the local model would get (Jev `state`). Never stored. */
  prompt: string;
  avatarId: string;
  isHouse: boolean;
  targets: JevWorldTargets;
  /** The local decide (timeout-wrapped by the driver). */
  localDecide: () => Promise<string>;
  /** The driver's own [ACTION:] parser, returning the verb (or null). */
  localVerbOf: (reply: string) => string | null;
}

export interface JevWorldDecideResult {
  reply: string;
  source: 'jev' | 'local_fallback' | 'local';
}

export function createJevWorldDecide(deps: JevWorldDeps) {
  const inFlightAgents = new Set<string>();
  let globalInFlight = 0;
  let totalCapHit = false;
  let dailyCapDay: string | null = null;
  let capWarned = false;

  function finishSoft(id: string, patch: JevWorldPatch, key: string): void {
    void deps.ledger.finish(id, patch).catch((err: unknown) => {
      deps.log.warn(`[JevWorld] ledger finish failed: ${redact(err instanceof Error ? err.message : String(err), key)}`);
    });
  }

  async function local(input: JevWorldDecideInput): Promise<{ reply: string; ms: number }> {
    const started = deps.now();
    const reply = await input.localDecide();
    return { reply, ms: deps.now() - started };
  }

  /**
   * Jev first; local on every refusal, miss or error. Never throws for a Jev
   * or ledger failure (a localDecide rejection propagates as it does today).
   */
  async function decide(input: JevWorldDecideInput): Promise<JevWorldDecideResult> {
    const env = deps.env();
    const apiKey = env.JEV_API_KEY?.trim() ?? '';
    if (!isJevWorldDecideEnabled(input.avatarId, env) || !apiKey) {
      return { reply: (await local(input)).reply, source: 'local' };
    }
    const today = utcDay(deps.now());
    if (totalCapHit || dailyCapDay === today
      || inFlightAgents.has(input.avatarId) || globalInFlight >= JEV_WORLD_MAX_GLOBAL_IN_FLIGHT) {
      return { reply: (await local(input)).reply, source: 'local' };
    }

    inFlightAgents.add(input.avatarId);
    globalInFlight++;
    let reservedId: string | null = null;
    let jevPart: Omit<JevWorldPatch, 'status' | 'localVerb' | 'localEmpty' | 'localMs' | 'error'> | null = null;
    let reason = 'jev_unavailable';
    try {
      const questions = buildJevWorldQuestions(input.targets, input.isHouse);
      const questionBytes = Buffer.byteLength(JSON.stringify(questions), 'utf8');
      const estimateUsd = estimateJevUsd(Buffer.byteLength(input.prompt, 'utf8'), questionBytes);
      const reserved = await deps.ledger.reserve(
        { avatarId: input.avatarId, isHouse: input.isHouse, estimateUsd },
        JEV_WORLD_CAPS,
      );
      if (!reserved.ok) {
        if (reserved.reason === 'total') totalCapHit = true;
        else dailyCapDay = today;
        if (!capWarned) {
          capWarned = true;
          deps.log.warn(`[JevWorld] demo spend cap reached (${reserved.reason}); local decide only`);
        }
        await deps.ledger.recordSkippedCap({ avatarId: input.avatarId, isHouse: input.isHouse }, reserved.reason)
          .catch(() => {});
        reason = `cap_${reserved.reason}`;
      } else {
        reservedId = reserved.id;
        const started = deps.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? JEV_WORLD_TIMEOUT_MS);
        try {
          const res = await deps.fetch(JEV_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: JEV_MODEL, state: input.prompt, questions }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`http ${res.status}`);
          const body = (await res.json()) as { answers?: unknown; usage?: { input_tokens?: unknown } } | null;
          const rawTokens = body?.usage?.input_tokens;
          const inputTokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0
            ? Math.round(rawTokens)
            : null;
          const resolved = resolveJevWorldAction(body?.answers, questions);
          jevPart = {
            jevVerb: resolved.verb,
            jevTopProb: resolved.prob,
            jevProbs: resolved.probs,
            jevMs: deps.now() - started,
            inputTokens,
            usd: inputTokens === null ? null : inputTokens * JEV_USD_PER_MTOK / 1_000_000,
          };
          if (resolved.ok) {
            // Same parser the driver dispatches with: a mismatch never reaches the executor.
            if (input.localVerbOf(resolved.reply) === resolved.verb) {
              finishSoft(reservedId, {
                ...jevPart, status: 'demo_jev', localVerb: null, localEmpty: false, localMs: null, error: null,
              }, apiKey);
              return { reply: resolved.reply, source: 'jev' };
            }
            reason = 'parse_mismatch';
          } else {
            reason = resolved.reason;
          }
        } catch (err) {
          const timedOut = controller.signal.aborted;
          reason = timedOut ? 'timeout' : redact(err instanceof Error ? err.message : String(err), apiKey);
          jevPart = {
            jevVerb: null, jevTopProb: null, jevProbs: null,
            jevMs: deps.now() - started, inputTokens: null, usd: null,
          };
          deps.log.warn(`[JevWorld] call ${timedOut ? 'timed out' : `failed: ${reason}`}; local fallback`);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      // Reserve/ledger failure: no Jev call was billed, or the row keeps its estimate.
      reason = `ledger: ${redact(err instanceof Error ? err.message : String(err), apiKey)}`;
      deps.log.warn(`[JevWorld] ${reason}; local fallback`);
    } finally {
      inFlightAgents.delete(input.avatarId);
      globalInFlight--;
    }

    const fallback = await local(input);
    if (reservedId) {
      finishSoft(reservedId, {
        jevVerb: null, jevTopProb: null, jevProbs: null, jevMs: 0, inputTokens: null, usd: null,
        ...(jevPart ?? {}),
        status: 'demo_fallback',
        localVerb: input.localVerbOf(fallback.reply),
        localEmpty: fallback.reply.trim() === '',
        localMs: fallback.ms,
        error: reason.slice(0, 200),
      }, apiKey);
    }
    return { reply: fallback.reply, source: 'local_fallback' };
  }

  return { decide };
}

const defaultWorldDecide = createJevWorldDecide({
  fetch: (url, init) => fetch(url, init),
  ledger: dbJevWorldLedger,
  env: () => process.env,
  now: () => Date.now(),
  log: { warn: (line) => console.warn(line) },
});

/** Driver hook: Jev first for demo avatars, local decide otherwise. */
export function jevWorldDecide(input: JevWorldDecideInput): Promise<JevWorldDecideResult> {
  return defaultWorldDecide.decide(input);
}
