/**
 * moderation-service — v1 content guardrail for ClawVille's live chat surfaces.
 *
 * ONE public entry point (`moderateText`) sits in front of a SWAPPABLE backend
 * so a future classifier (the founder's planned IBM Granite Guardian) drops in
 * by registering a `ModerationBackend` and flipping `MODERATION_BACKEND` — no
 * call-site touched. v1 backend = OpenAI's `omni-moderation-latest` moderation
 * endpoint (free, low-latency), called with the SAME `OPENAI_API_KEY` that backs
 * text-gen + embeddings (2026-06-05) — deliberately NO new key env var.
 *
 * Design contract (do not weaken without an adversarial pass):
 *  - FAIL-OPEN. Chat availability outranks moderation coverage. Any backend
 *    error/timeout/misconfig returns `allowed:true, decision:'error'`, bumps a
 *    counter, and logs a WARN. A flaky moderation API must NEVER take chat down.
 *  - BLOCK only on an affirmative `flagged:true` from the backend.
 *  - PRIVACY. Never log the moderated text. On a block we log a sha256 hash
 *    PREFIX (correlation without content) + the category names — never scores of
 *    raw text, never the text itself.
 *  - Input moderation runs BEFORE the LLM (saves tokens on blocked input);
 *    output moderation runs on model replies that reach a human.
 *
 * Env:
 *  - MODERATION_ENABLED  (default 'true')   — 'false'/'0'/'off' → allow-all,
 *                                             no backend call (kill switch).
 *  - MODERATION_BACKEND  (default 'openai') — selects the registered backend.
 *
 * Same-diff docs: ARCHITECTURE.md service-catalog row.
 */

import { createHash } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModerationDirection = 'input' | 'output';

export interface ModerationContext {
  /** Human-readable chokepoint id for logs/metrics, e.g. 'system-chat'. */
  surface: string;
  /** input = user/agent text entering; output = model text leaving to a human. */
  direction: ModerationDirection;
}

/** 'block' = flagged; 'allow' = clean; 'error' = fail-open; 'disabled' = kill switch. */
export type ModerationDecision = 'allow' | 'block' | 'error' | 'disabled';

export interface ModerationResult {
  /** The only field call sites should branch on. False ONLY on a real block. */
  allowed: boolean;
  decision: ModerationDecision;
  /** Category names that tripped (e.g. ['hate','violence']). Empty unless blocked. */
  flaggedCategories: string[];
  /** Backend name that produced the verdict (or 'disabled'/'none'). */
  backend: string;
  latencyMs: number;
}

/** What a backend returns. Kept minimal so Granite/NeMo/etc. map onto it cleanly. */
export interface BackendVerdict {
  flagged: boolean;
  /** Category names whose flag is true. */
  categories: string[];
}

export interface ModerationBackend {
  readonly name: string;
  /** MUST throw on any transport/parse failure so the service fail-opens. */
  moderate(text: string): Promise<BackendVerdict>;
}

// ─── Call-site constants ──────────────────────────────────────────────────────

/** snake_case error code the web ApiError layer branches on (never the message). */
export const CONTENT_BLOCKED_CODE = 'content_blocked';
export const CONTENT_BLOCKED_MESSAGE =
  'Your message was blocked by our content policy. Please rephrase and try again.';
/** Replacement text when a model REPLY is blocked (never echo the flagged text). */
export const OUTPUT_REFUSAL_MESSAGE =
  "I can't help with that one — let's keep it friendly. Ask me something else!";

// ─── Config ───────────────────────────────────────────────────────────────────

const BACKEND_TIMEOUT_MS = 2_500;

function moderationEnabled(): boolean {
  const raw = (process.env.MODERATION_ENABLED ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

function selectedBackendName(): string {
  return (process.env.MODERATION_BACKEND ?? 'openai').trim().toLowerCase();
}

// ─── OpenAI backend (v1) ──────────────────────────────────────────────────────
// Reuses OPENAI_API_KEY (same plumbing as chat-transient.ts + the inference
// router). The moderations endpoint is FREE and separate from chat completions.

const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';

class OpenAIModerationBackend implements ModerationBackend {
  readonly name = 'openai';

  async moderate(text: string): Promise<BackendVerdict> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // Treated as an error by the caller → fail-open. A missing key must not
      // silently BLOCK all chat (that would be fail-closed).
      throw new Error('OPENAI_API_KEY not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input: text }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`openai moderations ${res.status}`);
      }

      const data = (await res.json()) as {
        results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
      };
      const result = data?.results?.[0];
      if (!result) {
        throw new Error('openai moderations: empty results');
      }

      const categories = Object.entries(result.categories ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k);

      return { flagged: Boolean(result.flagged), categories };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Backend registry (the swap seam) ─────────────────────────────────────────
// Register a backend by name; `MODERATION_BACKEND` selects it. Granite Guardian
// lands as `registerModerationBackend(new GraniteBackend())` + MODERATION_BACKEND=granite.

const backends = new Map<string, ModerationBackend>();

export function registerModerationBackend(backend: ModerationBackend): void {
  backends.set(backend.name, backend);
}

registerModerationBackend(new OpenAIModerationBackend());

// Test seam: inject a fake backend without touching env/registry. Cleared with null.
let backendOverrideForTests: ModerationBackend | null = null;
export function __setModerationBackendForTests(backend: ModerationBackend | null): void {
  backendOverrideForTests = backend;
}

function resolveBackend(): ModerationBackend | null {
  if (backendOverrideForTests) return backendOverrideForTests;
  return backends.get(selectedBackendName()) ?? null;
}

// ─── Fail-open telemetry (counters only — never per-message DB writes in v1) ──

const counters = {
  checked: 0,
  blocked: 0,
  failOpen: 0,
  disabled: 0,
};

/** Snapshot for a future /dash card. Process-local (single-pod), like the reward limiter. */
export function getModerationCounters(): Readonly<typeof counters> {
  return { ...counters };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Moderate a piece of chat text. NEVER throws. Call sites branch ONLY on
 * `result.allowed`. Blocked input → the route returns 400 `content_blocked`;
 * blocked output → the route substitutes `OUTPUT_REFUSAL_MESSAGE`.
 */
export async function moderateText(
  text: string,
  ctx: ModerationContext,
): Promise<ModerationResult> {
  const started = Date.now();

  if (!moderationEnabled()) {
    counters.disabled++;
    return { allowed: true, decision: 'disabled', flaggedCategories: [], backend: 'disabled', latencyMs: 0 };
  }

  // Empty/whitespace can't be flagged; skip the round-trip.
  if (!text || !text.trim()) {
    return { allowed: true, decision: 'allow', flaggedCategories: [], backend: 'none', latencyMs: 0 };
  }

  const backend = resolveBackend();
  if (!backend) {
    // Misconfigured MODERATION_BACKEND → fail-open (availability > coverage).
    counters.failOpen++;
    console.warn(
      `[moderation] no backend for MODERATION_BACKEND='${selectedBackendName()}' — failing OPEN`,
      { failOpen: counters.failOpen, surface: ctx.surface, direction: ctx.direction },
    );
    return { allowed: true, decision: 'error', flaggedCategories: [], backend: 'none', latencyMs: Date.now() - started };
  }

  counters.checked++;
  try {
    const verdict = await backend.moderate(text);
    const latencyMs = Date.now() - started;

    if (verdict.flagged) {
      counters.blocked++;
      // Content-free audit line: hash prefix (correlation) + category NAMES only.
      const hashPrefix = createHash('sha256').update(text).digest('hex').slice(0, 12);
      console.warn('[moderation] BLOCKED', {
        surface: ctx.surface,
        direction: ctx.direction,
        backend: backend.name,
        categories: verdict.categories,
        hash: hashPrefix,
        latencyMs,
      });
      return { allowed: false, decision: 'block', flaggedCategories: verdict.categories, backend: backend.name, latencyMs };
    }

    return { allowed: true, decision: 'allow', flaggedCategories: [], backend: backend.name, latencyMs };
  } catch (err) {
    // FAIL-OPEN. Log a WARN + counter — NEVER the text, NEVER throw.
    // Log the error CLASS name only, never `err.message`/`String(err)`: a
    // backend could echo the moderated (untrusted) text inside its thrown
    // error message, so surfacing that message would leak user content to logs.
    counters.failOpen++;
    console.warn('[moderation] backend error — failing OPEN', {
      surface: ctx.surface,
      direction: ctx.direction,
      backend: backend.name,
      failOpen: counters.failOpen,
      errorClass: err instanceof Error ? err.name : 'unknown',
    });
    return { allowed: true, decision: 'error', flaggedCategories: [], backend: backend.name, latencyMs: Date.now() - started };
  }
}
