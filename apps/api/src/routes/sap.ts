/**
 * SAP (Synapse Agent Protocol) — on-chain agent identity / reputation / tool /
 * discovery (Phase 1) + escrow money rail (Phase 2, separately gated) routes.
 *
 * FEATURE_GATE: sap_onchain_agents
 * Status: FULLY built, gated OFF + devnet-first + dry-run by default. The whole
 *   layer is dark unless SAP_ENABLED=true; the money/stake rail needs
 *   SAP_ESCROW_ENABLED=true ON TOP; and even then SAP_DRY_RUN=true (the default)
 *   builds + simulates only — NEVER broadcasts. The in-game economy stays
 *   ClawTokens; SAP is an additive, flip-to-live, on-chain layer.
 *
 *   DEPLOYED PROGRAM IS 0.18.0 (audit FIX-A, 2026-06-20) — the client builds
 *   against the ON-CHAIN IDL (synapse_agent_sap.onchain.idl.json), NOT the 0.25.0
 *   repo IDL. The deployed 0.18.0 program has NO on-chain stake-gate at escrow
 *   creation and NO per-call settlement receipt anti-replay (both exist only in
 *   the not-yet-deployed 0.25.0). See docs/sap-integration.md (top box + §9).
 *
 *   ESCROW-RAIL PREREQUISITE (FIX-G) — before SAP_ESCROW_ENABLED is EVER flipped
 *   on for real money: settlement MUST stop accepting caller-supplied
 *   serviceHashParts/callsToSettle. `service_hash` MUST be derived server-side
 *   from PERSISTED invocation records with a backend (escrow, service_hash)
 *   idempotency check (replacing the 0.18.0-missing on-chain receipt), AND the
 *   ≥0.1 SOL self-stake precondition must be enforced backend-side (the 0.18.0
 *   create_escrow_v2 does not). Until then the rail stays dark. Escrow is also
 *   SOL-only (FIX-E) until the SPL remaining-accounts path is wired.
 * Metric to graduate: a deliberate founder decision to take agents on-chain
 *   (devnet smoke → mainnet code gate). No /dash metric drives this — it is an
 *   opt-in product layer, not an A/B'd feature.
 * Review deadline: 2026-09-20.
 * On deadline: if SAP is still disabled with no devnet smoke run, either flip on
 *   devnet for a real register/discovery smoke OR delete the routes + service
 *   (keep the on-chain IDL for a future revisit). Do NOT silently extend.
 * Reference: .claude/plans/sap-onchain-agents/PLAN.md, docs/sap-integration.md.
 *
 * ── RULE E5 PARITY ────────────────────────────────────────────────────────────
 * Every write route binds the acting agent to `c.get('identity').avatarId` (set
 * by `requireAuthOrAgentSession`), a REAL avatar for BOTH a Lucia-authed human
 * (a Trainer opting their agent in) AND a connected/hosted agent session. The
 * custodial signer is THAT avatar's own Phase-5.1 Solana wallet — the agent acts
 * as ITSELF on-chain. No body-supplied pubkey is ever a signer; no guest path.
 *   PARITY note — human path: POST /api/sap/* via Lucia cookie;
 *                 agent path: same endpoints via X-Clawville-Agent-Session →
 *                   bound avatar; settlement/signing binds to identity.avatarId.
 *
 * ── Gate → 503 BEFORE any chain work ──────────────────────────────────────────
 * `gate503()` short-circuits with `{ error:'sap_disabled' }` / `'sap_escrow_disabled'`
 * before resolving wallets or building a tx. The service layer ALSO re-checks the
 * gate (defense-in-depth) and returns the same structured codes, so a future
 * direct caller can't bypass the route gate.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';
import {
  sapConfigSnapshot,
  registerAgent,
  publishTool,
  giveFeedback,
  fetchAgentProfile,
  discoverAgents,
  initStake,
  depositStake,
  createEscrow,
  depositEscrow,
  settleCalls,
  withdrawEscrow,
  closeEscrow,
  type SapWriteResult,
  type SapFailure,
} from '../services/sap/sap-client';

type DualContext = AppContext & ActivityAuthContext;

export const sapRoutes = new Hono<DualContext>();

// `requireAuthOrAgentSession` (on write routes) reads `c.get('user')` for the
// human path, which `sessionMiddleware` populates. No-op for the public reads.
sapRoutes.use('*', sessionMiddleware);

// Public discovery reads — modest IP rate-limit (mirrors land.ts public reads).
const publicReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
// Write routes touch the chain (or simulate it) — keep a tighter cap.
const writeLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

// ─── gate helpers ─────────────────────────────────────────────────────────────

/** Returns a 503 response when the relevant gate is off, else null. */
function gate503(c: { json: (b: unknown, s?: 503) => Response }, needEscrow: boolean) {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled) {
    return c.json({ error: 'sap_disabled', code: 'sap_disabled' }, 503);
  }
  if (needEscrow && !cfg.escrowEnabled) {
    return c.json({ error: 'sap_escrow_disabled', code: 'sap_escrow_disabled' }, 503);
  }
  return null;
}

/**
 * FIX-C — ledger-capability gate for AGENT-SESSION writes.
 *
 * Every SAP write maps to the agent's CUSTODIAL Solana wallet (decrypt + sign).
 * A stale / restored / ownership-unproven agent session is `ledgerCapable=false`
 * (see `resolveAgentSession`) — it may perceive/chat in-world, but it must NEVER
 * trigger a custodial decrypt/sign on a money/identity path. Mirrors the cove
 * real-money routes: for an `kind:'agent'` identity, require `ledgerCapable===true`
 * BEFORE the handler reaches `registerAgent`/`createEscrow`/etc. (which is where
 * `loadAvatarWallet` decrypts the key). Returns a 403 response or null.
 *
 * The human (Lucia) path is `kind:'user'` and is implicitly ledger-capable — it
 * is never blocked here (a logged-in human owns their own avatar).
 */
function requireLedgerCapable(
  c: { json: (b: unknown, s?: 403) => Response },
  identity: DualContext['Variables']['identity'],
): Response | null {
  if (identity.kind === 'agent' && identity.ledgerCapable !== true) {
    return c.json(
      {
        error: 'agent_session_not_ledger_authorized',
        code: 'agent_session_not_ledger_authorized',
        message:
          'This agent session has not proven ownership of its avatar and cannot ' +
          'act on the on-chain (custodial-wallet) SAP path. Reconnect with a fresh ' +
          'connect-token or the signed-challenge reconnect to regain ledger authority.',
      },
      403,
    );
  }
  return null;
}

/** Map a service-layer `SapFailure` code → an HTTP status. */
function failureStatus(code: SapFailure['code']): 400 | 404 | 500 | 503 | 502 {
  switch (code) {
    case 'sap_disabled':
    case 'sap_escrow_disabled':
    case 'mainnet_broadcast_refused':
      // A refusal to broadcast to the wrong cluster is a server-side safety stop,
      // not a client error — surface as 503 (service unavailable for this config).
      return 503;
    case 'avatar_wallet_missing':
      return 404;
    case 'rpc_unreachable':
      return 502;
    case 'internal':
      // Generic internal failure (e.g. wallet decrypt) — no detail echoed.
      return 500;
    case 'invalid_pubkey':
    case 'invalid_mint':
    case 'sol_only_for_now':
    case 'invalid_amount':
    case 'on_chain_error':
    default:
      return 400;
  }
}

/** Serialize a write result to a clean JSON response (never a 5xx stack leak). */
function respondWrite(
  c: { json: (b: unknown, s?: number) => Response },
  result: SapWriteResult,
) {
  if (result.ok === false) {
    return c.json(
      { error: result.code, code: result.code, message: result.message },
      failureStatus(result.code),
    );
  }
  if (result.dryRun) {
    return c.json({
      ok: true,
      dryRun: true,
      // `accepted` is honest now (FIX-B): true ONLY when the program was actually
      // invoked + decoded the instruction. `programReached:'inconclusive'` means
      // the sim aborted before the program ran (under-funded wallet) — read it as
      // "fund the avatar wallet on devnet and retry", NOT as success.
      accepted: result.accepted,
      programReached: result.programReached,
      accounts: result.accounts,
      simulation: {
        err: result.simulation.err ?? null,
        unitsConsumed: result.simulation.unitsConsumed ?? null,
        logs: result.simulation.logs ?? [],
      },
    });
  }
  return c.json({ ok: true, dryRun: false, signature: result.signature, accounts: result.accounts });
}

// ─── status (public, no chain work) ───────────────────────────────────────────

sapRoutes.get('/status', (c) => {
  // Never leak the RPC URL (may carry an API key) — report only gate + cluster.
  const cfg = sapConfigSnapshot();
  return c.json({
    enabled: cfg.enabled,
    escrowEnabled: cfg.escrowEnabled,
    dryRun: cfg.dryRun,
    cluster: cfg.cluster,
    programId: cfg.programId,
  });
});

// ─── Phase 1 — identity / reputation / tool ───────────────────────────────────

const registerSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(512).default(''),
    capabilities: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          description: z.string().max(256).nullish(),
          protocolId: z.string().max(64).nullish(),
          version: z.string().max(32).nullish(),
        }),
      )
      .max(32)
      .default([]),
    protocols: z.array(z.string().min(1).max(64)).max(16).default(['clawville']),
    agentId: z.string().max(64).nullish(),
    agentUri: z.string().url().max(256).nullish(),
    x402Endpoint: z.string().url().max(256).nullish(),
  })
  .strict();

sapRoutes.post('/register', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await registerAgent({
    avatarId: identity.avatarId,
    name: parsed.data.name,
    description: parsed.data.description,
    capabilities: parsed.data.capabilities,
    protocols: parsed.data.protocols,
    agentId: parsed.data.agentId ?? null,
    agentUri: parsed.data.agentUri ?? null,
    x402Endpoint: parsed.data.x402Endpoint ?? null,
  });
  return respondWrite(c, result);
});

const publishToolSchema = z
  .object({
    toolName: z.string().min(1).max(64),
    schemaJson: z.string().max(8192).optional(),
    description: z.string().max(512).optional(),
    httpMethod: z.number().int().min(0).max(255).optional(),
    category: z.number().int().min(0).max(255).optional(),
    paramsCount: z.number().int().min(0).max(255).optional(),
    requiredParams: z.number().int().min(0).max(255).optional(),
    isCompound: z.boolean().optional(),
  })
  .strict();

sapRoutes.post('/tools/publish', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = publishToolSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await publishTool({ avatarId: identity.avatarId, ...parsed.data });
  return respondWrite(c, result);
});

const feedbackSchema = z
  .object({
    targetAgentPda: z.string().min(32).max(64),
    score: z.number().int().min(0).max(1000),
    tag: z.string().min(1).max(32),
    comment: z.string().max(2048).optional(),
  })
  .strict();

sapRoutes.post('/feedback', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = feedbackSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await giveFeedback({
    reviewerAvatarId: identity.avatarId,
    targetAgentPda: parsed.data.targetAgentPda,
    score: parsed.data.score,
    tag: parsed.data.tag,
    comment: parsed.data.comment,
  });
  return respondWrite(c, result);
});

// ─── discovery (read-only, public) ────────────────────────────────────────────

sapRoutes.get('/agents', async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000));
  const result = await discoverAgents(limit);
  if (result.ok === false) {
    return c.json({ error: result.code, code: result.code, message: result.message }, failureStatus(result.code));
  }
  return c.json({ agents: result.data });
});

sapRoutes.get('/agent/:pubkey', async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const result = await fetchAgentProfile(c.req.param('pubkey'));
  if (result.ok === false) {
    return c.json({ error: result.code, code: result.code, message: result.message }, failureStatus(result.code));
  }
  if (!result.data) {
    return c.json({ error: 'not_registered', code: 'not_registered' }, 404);
  }
  return c.json({ agent: result.data });
});

// ─── Phase 2 — escrow money rail (SAP_ESCROW_ENABLED) ─────────────────────────

const u64Str = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string (lamports / u64)')
  .max(20);

const stakeSchema = z.object({ lamports: u64Str }).strict();

sapRoutes.post('/escrow/stake', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = stakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await initStake({ avatarId: identity.avatarId, lamports: BigInt(parsed.data.lamports) });
  return respondWrite(c, result);
});

sapRoutes.post('/escrow/deposit-stake', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = stakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await depositStake({ avatarId: identity.avatarId, lamports: BigInt(parsed.data.lamports) });
  return respondWrite(c, result);
});

const createEscrowSchema = z
  .object({
    serviceAgentPda: z.string().min(32).max(64),
    nonce: u64Str,
    pricePerCall: u64Str,
    maxCalls: u64Str,
    initialDeposit: u64Str,
    expiresAt: z.string().regex(/^\d+$/).max(20),
    // null/omitted = SOL; else MUST be the cluster USDC mint (service re-checks).
    tokenMint: z.string().min(32).max(64).nullish(),
  })
  .strict();

sapRoutes.post('/escrow/create', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = createEscrowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await createEscrow({
    depositorAvatarId: identity.avatarId,
    serviceAgentPda: parsed.data.serviceAgentPda,
    nonce: BigInt(parsed.data.nonce),
    pricePerCall: BigInt(parsed.data.pricePerCall),
    maxCalls: BigInt(parsed.data.maxCalls),
    initialDeposit: BigInt(parsed.data.initialDeposit),
    expiresAt: BigInt(parsed.data.expiresAt),
    tokenMint: parsed.data.tokenMint ?? null,
  });
  return respondWrite(c, result);
});

const depositEscrowSchema = z
  .object({
    serviceAgentPda: z.string().min(32).max(64),
    nonce: u64Str,
    amount: u64Str,
  })
  .strict();

sapRoutes.post('/escrow/deposit', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = depositEscrowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await depositEscrow({
    depositorAvatarId: identity.avatarId,
    serviceAgentPda: parsed.data.serviceAgentPda,
    nonce: BigInt(parsed.data.nonce),
    amount: BigInt(parsed.data.amount),
  });
  return respondWrite(c, result);
});

const settleSchema = z
  .object({
    depositorWallet: z.string().min(32).max(64),
    nonce: u64Str,
    callsToSettle: u64Str,
    // Anti-replay service-hash inputs (joined → sha256). At least one part.
    serviceHashParts: z.array(z.string().min(1).max(256)).min(1).max(8),
  })
  .strict();

sapRoutes.post('/escrow/settle', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = settleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The SERVICE agent (the one receiving lamports) is the acting avatar — it
  // settles its OWN escrows. The depositor is identified by its wallet pubkey.
  const result = await settleCalls({
    serviceAvatarId: identity.avatarId,
    depositorWallet: parsed.data.depositorWallet,
    nonce: BigInt(parsed.data.nonce),
    callsToSettle: BigInt(parsed.data.callsToSettle),
    serviceHashParts: parsed.data.serviceHashParts,
  });
  return respondWrite(c, result);
});

const withdrawSchema = z
  .object({
    serviceAgentPda: z.string().min(32).max(64),
    nonce: u64Str,
    amount: u64Str,
  })
  .strict();

sapRoutes.post('/escrow/withdraw', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = withdrawSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await withdrawEscrow({
    depositorAvatarId: identity.avatarId,
    serviceAgentPda: parsed.data.serviceAgentPda,
    nonce: BigInt(parsed.data.nonce),
    amount: BigInt(parsed.data.amount),
  });
  return respondWrite(c, result);
});

const closeSchema = z
  .object({ serviceAgentPda: z.string().min(32).max(64), nonce: u64Str })
  .strict();

sapRoutes.post('/escrow/close', requireAuthOrAgentSession, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = closeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await closeEscrow({
    depositorAvatarId: identity.avatarId,
    serviceAgentPda: parsed.data.serviceAgentPda,
    nonce: BigInt(parsed.data.nonce),
  });
  return respondWrite(c, result);
});
