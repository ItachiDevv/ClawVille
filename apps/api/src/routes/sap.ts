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
import { registerSchema } from './sap-route-schemas';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';
import {
  sapConfigSnapshot,
  registerAgent,
  publishTool,
  giveFeedback,
  createAttestation,
  revokeAttestation,
  fetchAgentProfile,
  discoverAgents,
  initStake,
  depositStake,
  createEscrow,
  depositEscrow,
  settleCalls,
  withdrawEscrow,
  closeEscrow,
  // V2 (SDK 1.0.0) funding-side executors — SAFE to route directly (the DEPOSITOR
  // funds its OWN escrow; the OWNER stakes its OWN SOL — no unauthorized release).
  // V2 settle/finalize are routed below only through the escrow gate; these
  // direct imports remain funding/self-custody operations.
  provisionAgentStake,
  updateAgentPricingUsdc,
  createEscrowV2Usdc,
  type SapWriteResult,
  type SapFailure,
} from '../services/sap/sap-client';
import {
  openEscrow,
  openEscrowV2,
  depositEscrowV2Idempotent,
  withdrawEscrowV2Idempotent,
  submitJob,
  approveJob,
  settleJob,
  settleJobV2,
  finalizeJobV2,
  refundEscrow,
  type EscrowGateResult,
  type EscrowGateFailure,
} from '../services/sap/escrow-gate';

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
function gate503(
  c: { json: (b: unknown, s?: 503) => Response },
  needEscrow: boolean,
  needUsdcEscrow = false,
) {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled) {
    return c.json({ error: 'sap_disabled', code: 'sap_disabled' }, 503);
  }
  if ((needEscrow || needUsdcEscrow) && !cfg.escrowEnabled) {
    return c.json({ error: 'sap_escrow_disabled', code: 'sap_escrow_disabled' }, 503);
  }
  // Option C USDC gate sits ON TOP OF the SOL escrow gate.
  if (needUsdcEscrow && !cfg.usdcEscrowEnabled) {
    return c.json({ error: 'sap_usdc_escrow_disabled', code: 'sap_usdc_escrow_disabled' }, 503);
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
    case 'sap_usdc_escrow_disabled':
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

/**
 * Serialize a write result to a clean JSON response (never a 5xx stack leak).
 * `extra` merges extra top-level fields into EVERY branch (e.g. the deposit
 * idempotency `replayed` flag); undefined spreads to nothing for all other callers.
 * L2 — `...extra` is spread FIRST in every branch so a future extra field can never
 * clobber a contract field (error/code/message, ok/dryRun/signature/accounts).
 */
function respondWrite(
  c: { json: (b: unknown, s?: number) => Response },
  result: SapWriteResult,
  extra?: Record<string, unknown>,
) {
  if (result.ok === false) {
    return c.json(
      { ...extra, error: result.code, code: result.code, message: result.message },
      failureStatus(result.code),
    );
  }
  if (result.dryRun) {
    return c.json({
      ...extra,
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
  return c.json({ ...extra, ok: true, dryRun: false, signature: result.signature, accounts: result.accounts });
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

sapRoutes.post('/register', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/tools/publish', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/feedback', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

// ── attestation (cross-agent web-of-trust; Light = identity + attestation) ──────
// REPUTATION, not money → gated on SAP_ENABLED only (gate503(c,false)), same as
// /feedback. A custodial sign still occurs, so requireLedgerCapable runs BEFORE
// the handler reaches createAttestation/revokeAttestation (which decrypt the key).
const attestationSchema = z
  .object({
    // The SUBJECT agent's on-chain AgentAccount PDA — a NON-SIGNER account. Never
    // a signer; only the caller's own avatar wallet signs.
    subjectAgentPda: z.string().min(32).max(64),
    // attestation_type — program caps at 32 chars.
    attestationType: z.string().min(1).max(32),
    // Optional off-chain metadata (URI/note) → sha256 → the 32-byte metadata_hash.
    metadata: z.string().max(2048).optional(),
    // Unix-seconds expiry (i64); 0 = never. Default 0 when omitted.
    expiresAt: z.string().regex(/^\d+$/).max(20).optional(),
  })
  .strict();

sapRoutes.post('/attestation', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = attestationSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await createAttestation({
    attesterAvatarId: identity.avatarId,
    subjectAgentPda: parsed.data.subjectAgentPda,
    attestationType: parsed.data.attestationType,
    metadata: parsed.data.metadata,
    expiresAt: parsed.data.expiresAt !== undefined ? BigInt(parsed.data.expiresAt) : 0n,
  });
  return respondWrite(c, result);
});

const revokeAttestationSchema = z
  .object({ subjectAgentPda: z.string().min(32).max(64) })
  .strict();

// POST (not DELETE-with-body): the codebase's DELETE routes are all path-param
// based (`/:id`); a JSON-body DELETE is awkward across some HTTP clients/proxies.
// A POST sub-route keeps the body contract unambiguous and consistent.
sapRoutes.post('/attestation/revoke', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, false);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = revokeAttestationSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  }
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await revokeAttestation({
    attesterAvatarId: identity.avatarId,
    subjectAgentPda: parsed.data.subjectAgentPda,
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

const U64_MAX = 18446744073709551615n;
const u64Str = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string (lamports / u64)')
  .max(20)
  .refine((s) => BigInt(s) <= U64_MAX, 'exceeds u64::MAX');

const stakeSchema = z.object({ lamports: u64Str }).strict();

sapRoutes.post('/escrow/stake', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/escrow/deposit-stake', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/escrow/create', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/escrow/deposit', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

// ─── V2 escrow — OWNER CONFIG + FUNDING-SIDE routes only ──────────────────────
// These expose self-custody V2 operations: an OWNER staking its own SOL or
// replacing its own pricing menu, and a DEPOSITOR funding its OWN escrow. None
// can release another party's
// funds, so they are safe to route directly (behind requireAuthOrAgentSession +
// requireLedgerCapable + the gates + SAP_DRY_RUN). E5 parity: BOTH a human and a
// connected/hosted agent act AS THEMSELVES (bound to identity.avatarId). The V2
// Settle/finalize are exposed separately below through the escrow gate's
// approval/ceiling/at-most-once two-phase lifecycle. Withdraw remains
// depositor-only self-custody and cannot withdraw reserved pending principal.

const provisionStakeSchema = z.object({ targetLamports: u64Str }).strict();

const updateAgentPricingUsdcSchema = z
  .object({
    tierId: z.string().trim().min(1).max(32),
    pricePerCall: u64Str,
    rateLimit: z.number().int().positive().max(2_147_483_647).optional(),
    maxCallsPerSession: z.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict();

// Self-custody config: the acting worker replaces ITS OWN on-chain pricing menu.
// The request body contains tier data only; identity.avatarId is the sole signer source.
sapRoutes.post('/agent/pricing', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = updateAgentPricingUsdcSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await updateAgentPricingUsdc({
    workerAvatarId: identity.avatarId,
    tierId: parsed.data.tierId,
    pricePerCall: BigInt(parsed.data.pricePerCall),
    rateLimit: parsed.data.rateLimit,
    maxCallsPerSession: parsed.data.maxCallsPerSession,
  });
  return respondWrite(c, result);
});

sapRoutes.post('/escrow/v2/provision-stake', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = provisionStakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar stakes its OWN SOL up to the target (init-or-deposit).
  const result = await provisionAgentStake({
    avatarId: identity.avatarId,
    targetLamports: BigInt(parsed.data.targetLamports),
  });
  return respondWrite(c, result);
});

const createEscrowV2Schema = z
  .object({
    workerWalletPubkey: z.string().min(32).max(64),
    escrowNonce: u64Str,
    pricePerCall: u64Str,
    maxCalls: u64Str,
    initialDeposit: u64Str,
    expiresAt: z.string().regex(/^\d+$/).max(20),
  })
  .strict();

sapRoutes.post('/escrow/v2/create', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = createEscrowV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar is the DEPOSITOR funding its OWN escrow against the worker.
  const result = await createEscrowV2Usdc({
    depositorAvatarId: identity.avatarId,
    workerWalletPubkey: parsed.data.workerWalletPubkey,
    escrowNonce: BigInt(parsed.data.escrowNonce),
    pricePerCall: BigInt(parsed.data.pricePerCall),
    maxCalls: BigInt(parsed.data.maxCalls),
    initialDeposit: BigInt(parsed.data.initialDeposit),
    expiresAt: BigInt(parsed.data.expiresAt),
  });
  return respondWrite(c, result);
});

const depositEscrowV2Schema = z
  .object({
    workerWalletPubkey: z.string().min(32).max(64),
    escrowNonce: u64Str,
    amount: u64Str,
    // FIX 1 (doc line 591) — REQUIRED idempotency token. A duplicate POST with the
    // same requestId + same (escrow, amount) replays the recorded outcome instead
    // of double-funding the depositor's own escrow. Trimmed, 8–128 charset-safe.
    requestId: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, 'requestId must be 8–128 chars of [A-Za-z0-9._:-]'),
  })
  .strict();

sapRoutes.post('/escrow/v2/deposit', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = depositEscrowV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // FIX 1 — DB-backed idempotency: a duplicate POST (same subject+requestId, same
  // escrow+amount) replays the recorded outcome (replayed:true) and NEVER re-funds.
  const result = await depositEscrowV2Idempotent({
    depositorAvatarId: identity.avatarId,
    workerWalletPubkey: parsed.data.workerWalletPubkey,
    escrowNonce: BigInt(parsed.data.escrowNonce),
    amount: BigInt(parsed.data.amount),
    requestId: parsed.data.requestId,
  });
  if (!result.ok) {
    // 409 for the idempotency conflicts (in-flight duplicate / key reuse); the
    // remaining codes map to their natural status (missing wallet 404, else 400/500).
    const status =
      result.code === 'deposit_in_flight' || result.code === 'deposit_request_mismatch'
        ? 409
        : result.code === 'avatar_wallet_missing'
          ? 404
          : result.code === 'invalid_pubkey'
            ? 400
            : 500;
    return c.json({ error: result.code, code: result.code, message: result.message }, status);
  }
  return respondWrite(c, result.chain, { replayed: result.replayed });
});

const withdrawEscrowV2Schema = z
  .object({
    workerWalletPubkey: z.string().min(32).max(64),
    escrowNonce: u64Str,
    amount: u64Str,
    // R4-B (doc line 623) — REQUIRED idempotency token (mirrors deposit). A duplicate
    // POST with the same requestId + same (escrow, amount) replays the recorded
    // outcome instead of submitting a second real withdraw. Trimmed, 8–128 charset-safe.
    requestId: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, 'requestId must be 8–128 chars of [A-Za-z0-9._:-]'),
  })
  .strict();

// withdraw is SELF-CUSTODY: the DEPOSITOR reclaims its OWN unspent (free) balance
// (on-chain enforces free = balance − pendingAmount, so reserved/pending funds can't
// be pulled). No counterparty is paid → no gate approval needed; safe bucket with create/deposit.
sapRoutes.post('/escrow/v2/withdraw', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = withdrawEscrowV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // FIX 2b + R4-B (doc line 623) — book the withdraw into the gate ledger AND make it
  // idempotent: a duplicate POST (same subject+requestId, same escrow+amount) replays
  // the recorded outcome (replayed:true) and NEVER submits a second real withdraw.
  const result = await withdrawEscrowV2Idempotent({
    depositorAvatarId: identity.avatarId,
    workerWalletPubkey: parsed.data.workerWalletPubkey,
    escrowNonce: BigInt(parsed.data.escrowNonce),
    amount: BigInt(parsed.data.amount),
    requestId: parsed.data.requestId,
  });
  if (!result.ok) {
    // 409 for the idempotency conflicts (in-flight duplicate / key reuse); missing
    // wallet 404, bad pubkey 400, else 500 — mirrors the deposit route.
    const status =
      result.code === 'withdraw_in_flight' || result.code === 'withdraw_request_mismatch'
        ? 409
        : result.code === 'avatar_wallet_missing'
          ? 404
          : result.code === 'invalid_pubkey'
            ? 400
            : 500;
    return c.json({ error: result.code, code: result.code, message: result.message }, status);
  }
  return respondWrite(c, result.chain, { replayed: result.replayed });
});

// -- V2 escrow-gate release lifecycle (triple-gated, default OFF) --
// Funding and release are one durable claim-first flow here. The acting wallet is
// always resolved from identity.avatarId; the body names only the counterparty
// avatar/PDA coordinates and never supplies a signer.
const openEscrowV2GateSchema = z
  .object({
    workerAvatarId: z.string().uuid(),
    jobId: z.string().min(1).max(128),
    escrowNonce: u64Str,
    pricePerCall: u64Str,
    maxCalls: u64Str,
    initialDeposit: u64Str,
    expiresAt: u64Str.default('0'),
  })
  .strict();

sapRoutes.post('/escrow/v2/open', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = openEscrowV2GateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await openEscrowV2({
    depositorAvatarId: identity.avatarId,
    workerAvatarId: parsed.data.workerAvatarId,
    jobId: parsed.data.jobId,
    escrowNonce: BigInt(parsed.data.escrowNonce),
    pricePerCall: BigInt(parsed.data.pricePerCall),
    maxCalls: BigInt(parsed.data.maxCalls),
    initialDeposit: BigInt(parsed.data.initialDeposit),
    expiresAt: BigInt(parsed.data.expiresAt),
  });
  return respondGate(c, result, true);
});

const settleJobV2Schema = z
  .object({
    escrowPda: z.string().min(32).max(64),
    jobId: z.string().min(1).max(128),
    callsToSettle: u64Str,
  })
  .strict();

sapRoutes.post('/escrow/v2/settle', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = settleJobV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  const result = await settleJobV2({
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    callerAvatarId: identity.avatarId,
    callsToSettle: BigInt(parsed.data.callsToSettle),
  });
  return respondGate(c, result, true);
});

const finalizeJobV2Schema = z
  .object({
    escrowPda: z.string().min(32).max(64),
    jobId: z.string().min(1).max(128),
  })
  .strict();

sapRoutes.post('/escrow/v2/finalize', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = finalizeJobV2Schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // Permissionless crank: any authenticated, ledger-capable avatar pays as itself.
  const result = await finalizeJobV2({
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    callerAvatarId: identity.avatarId,
  });
  return respondGate(c, result, true);
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

sapRoutes.post('/escrow/settle', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/escrow/withdraw', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

sapRoutes.post('/escrow/close', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
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

// ─── Option C — USDC SelfReport escrow GATE (SAP_USDC_ESCROW_ENABLED) ──────────
//
// The verify-before-release USDC commerce gate. ALL routes are triple-gated
// (SAP_ENABLED + SAP_ESCROW_ENABLED + SAP_USDC_ESCROW_ENABLED) → 503 before any
// chain work, Zod-validated, behind requireAuthOrAgentSession + requireLedgerCapable.
//
// ── RULE E5 PARITY (USDC escrow gate) ─────────────────────────────────────────
// BOTH a human AND a connected/hosted agent session drive their role AS
// THEMSELVES (resolved to their bound avatar's own Phase-5.1 custodial wallet,
// REAL settlement — never a guest fallback):
//   - REQUESTER role (open / approve-and-settle's funder / refund): the DEPOSITOR
//     acts as `identity.avatarId`; the on-chain create/deposit/withdraw is signed
//     by THAT avatar's wallet.
//   - WORKER role (settle beneficiary): the WORKER acts as `identity.avatarId`;
//     the on-chain settle_calls is signed by THAT avatar's wallet (= the gate key).
// PARITY note — human path: POST /api/sap/escrow/usdc/* via Lucia cookie;
//   agent path: same endpoints via X-Clawville-Agent-Session → bound avatar;
//   settlement/signing binds to identity.avatarId (depositor on open/refund,
//   worker on settle). No body-supplied pubkey is ever a signer; no guest path.

/** Map an escrow-gate failure code → an HTTP status. */
function gateFailureStatus(
  code: EscrowGateFailure['code'],
  v2Release = false,
): 400 | 403 | 404 | 409 | 500 | 502 | 503 {
  // The founder-authorized V2 release contract exposes chain/program refusals
  // as an upstream 502. Keep this scoped to the three V2 gate routes: legacy V1
  // gate callers historically map these codes to 400 and must remain unchanged.
  if (v2Release) {
    switch (code) {
      case 'on_chain_error':
      case 'insufficient_escrow_balance':
      case 'stake_below_minimum':
      case 'pricing_tier_not_found':
      case 'pending_settlement_deprecated':
        return 502;
    }
  }
  switch (code) {
    case 'gate_disabled':
    case 'sap_disabled':
    case 'sap_escrow_disabled':
    case 'sap_usdc_escrow_disabled':
    case 'payai_rail_disabled':
    case 'mainnet_broadcast_refused':
      return 503;
    case 'wallet_pubkey_missing':
    case 'avatar_wallet_missing':
    case 'job_not_found':
      return 404;
    case 'verification_failed':
    case 'not_approved':
    case 'approver_mismatch':
    case 'self_dealing_forbidden':
    case 'unauthorized_caller':
      // Authorization refusals on the release path — the caller is not entitled to
      // (or has not been approved for) this transition. 403 Forbidden.
      return 403;
    case 'over_release':
      // The requested release exceeds the authorized/approved/funded ceiling — a
      // client-side over-request. 400 Bad Request.
      return 400;
    case 'already_settled':
    case 'settle_in_progress':
    case 'refund_in_progress':
    case 'funding_unconfirmed':
    case 'settle_unconfirmed':
    case 'finalize_unconfirmed':
    case 'finalize_not_ready':
    case 'finalize_in_progress':
    case 'job_not_open':
    case 'rail_mixed_forbidden':
    case 'release_rail_forbidden':
    // R4-A — an unowned on-chain pending exists (out-of-band / settle_unknown-landed);
    // ops must reconcile before settling. R4-D — a stale finalize whose pending PDA is
    // absent is unresolvable. R5-1 — a stale settle whose slot was consumed on-chain but
    // its pending is gone (finalized+closed). All lifecycle/ops conflicts (ops reconcile). 409.
    case 'unreconciled_onchain_pending':
    case 'finalize_unresolvable':
    case 'settle_slot_consumed':
      // Lifecycle conflicts — the job is in a state that forbids this transition.
      return 409;
    case 'rpc_unreachable':
    case 'payai_unavailable':
    case 'payai_release_failed':
    // R4-A — could not READ the escrow's on-chain pending_amount; the unowned-pending
    // guard fails CLOSED and refuses (retryable). Treat like an upstream read failure. 502.
    case 'pending_state_unverifiable':
      return 502;
    case 'internal':
      return 500;
    case 'invalid_pubkey':
    case 'invalid_mint':
    case 'sol_only_for_now':
    case 'invalid_amount':
    default:
      return 400;
  }
}

/** Serialize an escrow-gate result to a clean JSON response. */
function respondGate(
  c: { json: (b: unknown, s?: number) => Response },
  result: EscrowGateResult,
  v2Release = false,
) {
  if (result.ok === false) {
    return c.json(
      { error: result.code, code: result.code, message: result.message },
      gateFailureStatus(result.code, v2Release),
    );
  }
  // Trim the settlement row to a safe DTO (never echo internal ids the caller
  // doesn't need; expose the lifecycle-relevant fields).
  const s = result.settlement;
  const settlement = {
    escrowPda: s.escrowPda,
    jobId: s.jobId,
    escrowVersion: s.escrowVersion,
    escrowNonce: s.escrowNonce,
    status: s.status,
    pricePerCall: s.pricePerCall,
    maxCalls: s.maxCalls,
    callsSettled: s.callsSettled,
    fundedAmount: s.fundedAmount,
    releasedAmount: s.releasedAmount,
    reservedPrincipalAmount: s.reservedPrincipalAmount,
    feeAmount: s.feeAmount,
    refundedAmount: s.refundedAmount,
    verificationProvider: s.verificationProvider,
    verificationPassed: s.verificationPassed,
    auditRootHex: s.auditRootHex,
    settleSignature: s.settleSignature,
    settlementIndex: s.settlementIndex,
    finalizeSignature: s.finalizeSignature,
    fundingSignature: s.fundingSignature,
    dryRun: s.dryRun,
    settledAt: s.settledAt,
  };
  const base: Record<string, unknown> = { ok: true, phase: result.phase, settlement };
  if ('replay' in result) base.replay = result.replay;
  if ('next' in result) base.next = result.next;
  if (result.phase === 'approved') base.approvedCalls = result.approvedCalls;
  if ('chain' in result && result.chain) {
    const chain = result.chain;
    if (chain.ok && chain.dryRun) {
      base.chain = {
        dryRun: true,
        accepted: chain.accepted,
        programReached: chain.programReached,
        accounts: chain.accounts,
        simulation: {
          err: chain.simulation.err ?? null,
          unitsConsumed: chain.simulation.unitsConsumed ?? null,
          logs: chain.simulation.logs ?? [],
        },
      };
    } else if (chain.ok) {
      base.chain = { dryRun: false, signature: chain.signature, accounts: chain.accounts };
    }
  }
  return c.json(base);
}

// ── open (depositor funds a USDC escrow against a worker for a job) ──
const openEscrowSchema = z
  .object({
    /** The worker/service avatar this depositor is prepaying. */
    workerAvatarId: z.string().uuid(),
    /** Off-chain job id — the (escrow, job) idempotency key's job half. */
    jobId: z.string().min(1).max(128),
    /** USDC base units (6 decimals) as u64 strings. */
    pricePerCall: u64Str,
    maxCalls: u64Str,
    initialDeposit: u64Str,
    /** Absolute unix-seconds expiry. 0 = no expiry. */
    expiresAt: z.string().regex(/^\d+$/).max(20).default('0'),
  })
  .strict();

sapRoutes.post('/escrow/usdc/open', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = openEscrowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar IS the depositor (requester) — it funds as itself (E5).
  const result = await openEscrow({
    depositorAvatarId: identity.avatarId,
    workerAvatarId: parsed.data.workerAvatarId,
    jobId: parsed.data.jobId,
    pricePerCall: BigInt(parsed.data.pricePerCall),
    maxCalls: BigInt(parsed.data.maxCalls),
    initialDeposit: BigInt(parsed.data.initialDeposit),
    expiresAt: BigInt(parsed.data.expiresAt),
  });
  return respondGate(c, result);
});

// ── submit (worker records a deliverable submission) ──
const submitJobSchema = z
  .object({ escrowPda: z.string().min(32).max(64), jobId: z.string().min(1).max(128) })
  .strict();

sapRoutes.post('/escrow/usdc/submit', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = submitJobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // FIX 1 — bind the acting avatar; submitJob asserts it IS the recorded worker.
  const result = await submitJob({
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    callerAvatarId: identity.avatarId,
  });
  return respondGate(c, result);
});

// ── approve (DEPOSITOR-ONLY authenticated approval; BLOCKING #1 fix) ──
// The depositor (and ONLY the depositor) records the persisted approval that gates
// a settle. This REPLACES the old forgeable request-body `approval` object on the
// settle route: a worker can no longer fabricate an approval to self-release. The
// acting avatar MUST be the recorded depositor (asserted in the gate). Optional
// `approvedCalls` caps the calls the approval authorizes for release.
const approveJobSchema = z
  .object({
    escrowPda: z.string().min(32).max(64),
    jobId: z.string().min(1).max(128),
    /** Optional cap on approved calls (u64). Omitted ⇒ approve the job's maxCalls. */
    approvedCalls: u64Str.optional(),
  })
  .strict();

sapRoutes.post('/escrow/usdc/approve', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = approveJobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar IS the depositor (requester) — only it may approve a release
  // of its own escrow. The gate re-asserts `callerAvatarId === row.depositorAvatarId`.
  const result = await approveJob({
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    callerAvatarId: identity.avatarId,
    approvedCalls: parsed.data.approvedCalls ? BigInt(parsed.data.approvedCalls) : undefined,
  });
  return respondGate(c, result);
});

// ── settle (worker releases the escrow ONLY after the DEPOSITOR's PERSISTED
//    approval; BLOCKING #1/#2/#3 fix) ──
// The verification signal is built SERVER-SIDE from the persisted approval row —
// the route NO LONGER accepts a body `approval` (it was forgeable by the worker).
// `callsToSettle` is an UPPER REQUEST: the gate clamps/rejects it against the
// job's maxCalls, the depositor's approvedCalls, and the escrow's remaining funded
// balance. The WORKER is the acting avatar (signs the release as itself).
const settleJobSchema = z
  .object({
    escrowPda: z.string().min(32).max(64),
    jobId: z.string().min(1).max(128),
    callsToSettle: u64Str,
  })
  .strict();

sapRoutes.post('/escrow/usdc/settle', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = settleJobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar IS the worker (settle beneficiary + the only settle signer).
  // The gate asserts `callerAvatarId === row.workerAvatarId` (E5: worker settles
  // as itself), READS the depositor's PERSISTED approval (never a body claim), and
  // clamps the release to the authorized/approved/funded ceiling.
  const result = await settleJob({
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    callerAvatarId: identity.avatarId,
    callsToSettle: BigInt(parsed.data.callsToSettle),
  });
  return respondGate(c, result);
});

// ── refund (depositor reclaims unspent USDC on cancel/expiry/verify-fail) ──
const refundEscrowSchema = z
  .object({
    escrowPda: z.string().min(32).max(64),
    jobId: z.string().min(1).max(128),
    amount: u64Str,
  })
  .strict();

sapRoutes.post('/escrow/usdc/refund', requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const gated = gate503(c, true, true);
  if (gated) return gated;
  if (!writeLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const parsed = refundEscrowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const notLedger = requireLedgerCapable(c, identity);
  if (notLedger) return notLedger;
  // The acting avatar IS the depositor — only it can reclaim its unspent USDC.
  const result = await refundEscrow({
    depositorAvatarId: identity.avatarId,
    escrowPda: parsed.data.escrowPda,
    jobId: parsed.data.jobId,
    amount: BigInt(parsed.data.amount),
  });
  return respondGate(c, result);
});
