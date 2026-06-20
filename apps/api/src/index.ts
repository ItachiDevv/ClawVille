import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth';
import { avatarRoutes } from './routes/avatars';
import { userRoutes } from './routes/users';
import { locationRoutes } from './routes/locations';
import { chatRoutes } from './routes/chat';
import { transientChatRoutes } from './routes/chat-transient';
import { i18nRoutes } from './routes/i18n';
import { itemRoutes } from './routes/items';
import { npcRoutes } from './routes/npc-sse';
import { worldRoutes } from './routes/world';
import { openclawRoutes } from './routes/openclaw';
import { activityRoutes } from './routes/activity';
import { activitiesV2Routes } from './routes/activities';
import { landRoutes } from './routes/land';
import { activityRoomManager } from './services/activity/activity-room-manager';
import { activityQueueService } from './services/activity/activity-queue';
import { activityWsHub } from './services/activity/activity-ws-hub';
import { bumperShellsSim } from './services/activity/sim/bumper-shells-sim';
import { reefRaceSim } from './services/activity/sim/reef-race-sim';
import { reefRaceSplineSim } from './services/activity/sim/reef-race-spline-sim';
import { REEF_RACE_USE_SPLINE } from './services/activity/sim/reef-race-config';

/**
 * Reef Race v2 sim selector. Mirrors the activity-ws-hub one — the env flag
 * routes every reef-race lifecycle entry point (startRoom, broadcastFn,
 * endedFn, integrityForfeitFn, computeResults) to the spline sim when true,
 * the ellipse sim when false. Both sims expose identical public method
 * shapes for the methods this dispatcher calls.
 */
const reefRaceImpl = REEF_RACE_USE_SPLINE
  ? (reefRaceSplineSim as unknown as typeof reefRaceSim)
  : reefRaceSim;
import { loadRacingProfiles } from './services/activity/avatar-profile-loader';
import { botPool } from './services/activity/bots/bot-pool';
import { getBotControllerFactory } from './services/activity/bots/bot-controller';
// Texas Hold'em (P1.2b) — live poker table sim singleton + the demo config the
// `texas-holdem` LIVE transition starts each hand with (in-memory chips only;
// CT settlement + persistence are out of scope this phase).
import { pokerTableSim } from './services/poker/poker-table-sim-singleton';
import { logEvent } from './services/event-logger';
import { randomBytes } from 'node:crypto';
import { getBunWebSocketHelper } from './lib/bun-ws-adapter';
import { researchSseRoutes } from './routes/research-sse';
import { researchApiRoutes } from './routes/research';
import { marketplaceRoutes } from './routes/marketplace';
import { clawRoutes } from './routes/claws';
import { agentGatewayRoutes } from './routes/agent-gateway';
// pendingConnections is exported but only used internally by agent-gateway routes
import { agentExportRoutes } from './routes/agent-export';
import { bazaarRoutes } from './routes/bazaar';
import { auctionRoutes } from './routes/auctions';
import { questRoutes } from './routes/quests';
import { bountyRoutes } from './routes/bounties';
import { exchangeRoutes } from './routes/exchange';
import { leaderboardRoutes } from './routes/leaderboard';
import { agentSetupRoutes } from './routes/agent-setup';
import { skillsRoutes } from './routes/skills';
import { agentV2Routes } from './routes/agent-v2';
import { dashboardRoutes } from './routes/dashboard';
import { portalRoutes } from './routes/portal';
import { partnerHatcherRoutes } from './routes/partner-hatcher';
import { partnerHatcherLaunchRoutes } from './routes/partner-hatcher-launch';
import { partnerStorefrontRoutes } from './routes/partner-storefront';
import { agentRegistrationRoutes } from './routes/agent-registration';
import { adminIdentityRoutes } from './routes/admin-identity';
import { startSimulation } from './services/npc-simulation';
import { alertError } from './services/alert-error';
import { getPublishedIssuerInfo } from './services/service-issuer';
import { warnIfTestPartnerPubkeyEnabled } from './services/partner-signature';
import { fingerprintMiddleware } from './middleware/fingerprint';
import { cosmeticsRoutes } from './routes/cosmetics';
import { dashAuthRoutes } from './routes/dash-auth';
import { wagerRoutes } from './routes/wager';
// Phase 6.1 slice 3 — cove slots fun-money backend wire (ClawTokens live;
// SOL/USDC return 501 until Phase 6.2 custody).
import { coveSlotsRouter } from './routes/cove-slots';
// Phase 6.4.1 — cove blackjack AUTHORITATIVE route (6-deck shoe, S17, BJ 3:2,
// commit-reveal provably-fair engine, ClawToken ledger; SOL/USDC seam returns 501).
import { coveBlackjackRouter } from './routes/cove-blackjack';
import { ctTopupRoutes } from './routes/ct-topup';
import { buildMockFacilitator } from './services/x402-mock-facilitator';
// Phase 6.5.0 — cove Texas Hold'em mock route (visual shell, no engine yet).
import { coveHoldemRouter } from './routes/cove-holdem';
// Poker MTT (P3) — single-table tournament registration + status route.
// Agent-capable (Rule E5): human cookie OR X-Clawville-Agent-Session both reach
// the same real-CT buy-in/settle path. Full lobby UI is a later phase.
import { covePokerMttRouter } from './routes/cove-poker-mtt';
// The process-wide TournamentManager singleton — boot starts its start-trigger
// sweeper (the LIVE seat/cancel path) + graceful shutdown stops it.
import { tournamentManager } from './services/poker/tournament-manager';
// Special Events (2026-06-16) — the GENERIC PARENT layer for one-time events.
// The poker tournament is a DEPENDENT subtable (FK points UP). Agent-capable
// (Rule E5): human cookie OR X-Clawville-Agent-Session both reach the same
// gate-evaluated signup → real-CT/SOL/hold settlement → tournament entry.
import { specialEventsRouter } from './routes/special-events';
// Poker MTT (P3.5) — the DEDICATED tournament-table sim + the WS bridge that
// makes tournament tables PLAYABLE over WebSocket (long-lived `texas-holdem-mtt`
// room, sim-frame fan-out, room↔table mapping). Wired at boot alongside the demo.
import { pokerMttSim } from './services/poker/poker-mtt-sim-singleton';
import { wirePokerMttToHub } from './services/poker/poker-mtt-ws-bridge';
// Phase 6.6.1 — cove Baccarat (Punto Banco) AUTHORITATIVE route (8-deck shoe,
// fixed tableau, commit-reveal provably-fair engine, ClawToken ledger; SOL/USDC seam 501).
import { coveBaccaratRouter } from './routes/cove-baccarat';
// Phase 6.7.0 — cove cross-game history + per-event provable-fair verifier.
import { coveHistoryRouter } from './routes/cove-history';
// Economy fix 2026-05-29 — admin-only CT-economy monitor (minted/burned/houseNet
// per gameType; faucet detector). FEATURE_GATE: cove_ct_economy_monitor.
import { coveEconomyRouter } from './routes/cove-economy';
import type { AppContext } from './types';

const app = new Hono<AppContext>();

// Global middleware
app.use('*', logger());
// secureHeaders defaults Cross-Origin-Resource-Policy to "same-origin", which
// blocks api.clawville.world responses from being read by clawville.world
// (different origins). The web app's SSE/fetch calls fail with "blocked by
// CORS policy" even though Access-Control-Allow-Origin is correct, because
// browsers honor CORP independently of CORS. We override to "cross-origin"
// since the entire purpose of this API is to be consumed by the web app on
// a sibling origin. The actual access control still goes through the cors()
// middleware below + per-route auth.
app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
        .split(',')
        .map((o) => o.trim());
      if (origin && allowedOrigins.includes(origin)) return origin;

      // Local dev across any port (Next.js dev server, Milady port 2138, etc.)
      if (origin?.startsWith('http://localhost:')) return origin;
      if (origin?.startsWith('http://127.0.0.1:')) return origin;

      // Milady desktop shell origins — Electrobun / Capacitor / Tauri embed
      // the Milady webview with these URL schemes. When the
      // @clawville/app-clawville plugin fetches api.clawville.world from
      // inside a Milady viewer, the Origin header looks like `electrobun://`
      // or `capacitor://localhost` depending on the host platform.
      if (origin === 'electrobun://localhost') return origin;
      if (origin === 'capacitor://localhost') return origin;
      if (origin === 'tauri://localhost') return origin;
      if (origin === 'app://localhost') return origin;
      // file:// has no explicit origin but some Electrobun builds send null

      return allowedOrigins[0];
    },
    credentials: true,
  })
);

// Phase 1 anti-farm — compute fpHash + ipPrefixHash once per request and
// stash on context so event-logger and rate-limit consumers can read them
// without re-hashing. Must run AFTER cors (preflights skip it cleanly via
// `OPTIONS` returning early in the cors handler) but BEFORE any route so
// every emitted event carries the hash. Throws at module load if
// FINGERPRINT_SECRET is missing — fail-fast is intentional.
app.use('*', fingerprintMiddleware);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Phase 5.1 — Service issuer pubkey publication
// ---------------------------------------------------------------------------
// Partner worlds (scape, future partner games) verify outbound ClawVille
// signatures by fetching this URL and comparing the key against the
// X-Clawville-Issuer-Pubkey header on each request. Served by Hono (not
// Next.js) to avoid Next's special-case handling of `.well-known/*`.
// Safe to cache at CDN level — the pubkey is public.
app.get('/.well-known/clawville-issuer.json', (c) => {
  try {
    const info = getPublishedIssuerInfo();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(info);
  } catch (err) {
    // Env var missing → 503 so partners know to retry after rotation.
    return c.json({ error: 'issuer_key_unconfigured', detail: String(err) }, 503);
  }
});

// ---------------------------------------------------------------------------
// ERC-8004-ready agent registration files (off-chain tier)
// ---------------------------------------------------------------------------
// Public, per-agent ERC-8004 registration-file FORMAT served at
//   GET /.well-known/agents/:fingerprint/agent-registration.json
// keyed on users.identity_fingerprint. Self-signed with the service-issuer
// key; `registrations:[]` always (NOT on-chain-anchored — BSC upgrade
// deferred per .claude/plans/hatcher-integration.md §12). Mounted beside
// the issuer well-known route above; both are Hono-served (not Next.js) so
// `.well-known/*` isn't special-cased. The sub-app holds only the
// `:fingerprint/...` path so the full mount path is the canonical URL.
app.route('/.well-known/agents', agentRegistrationRoutes);

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/avatars', avatarRoutes);
app.route('/api/users', userRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/locations', chatRoutes);
// Also mount under `/api/chat` so the system-agent route is addressable as
// `/api/chat/system/:slug` (canonical path for the generalized system-agent
// chat surface — Town Guide today, future world-wide NPCs tomorrow). The
// legacy `POST /api/locations/:id/chat` path continues to work under the
// first mount above; nothing moves. Both mounts share the same handler map.
app.route('/api/chat', chatRoutes);
// Transient world-NPC chat — POST /api/chat/transient. Stateless one-shot
// OpenAI for NPC mode (controlMode === 'npc') talking to nearby wanderers.
// No Eliza, no rooms, no DB writes. See routes/chat-transient.ts for why.
app.route('/api/chat/transient', transientChatRoutes);
// Game-wide UI translation — POST /api/i18n/translate. Batch translates visible
// /game DOM strings through OpenAI so language support is a page-level surface,
// not a one-off NPC-response hook.
app.route('/api/i18n', i18nRoutes);
app.route('/api/items', itemRoutes);
app.route('/api/cosmetics', cosmeticsRoutes);
app.route('/api/dash-auth', dashAuthRoutes);
app.route('/api/npc', npcRoutes);
// Multiplayer Phase 1 — room registry + per-room snapshot SSE.
app.route('/api/world', worldRoutes);
app.route('/api/openclaw', openclawRoutes);
app.route('/api/avatars', activityRoutes);
// Q2 Activity Portals — chunk #2 backend skeleton (REST routes; WS hub
// + sim land in chunk #3). Mount path mirrors the Q2 plan §"API routes".
app.route('/api/activities', activitiesV2Routes);
// Land Economy — Phase 1 / Slice A: free starter-parcel claim + read seams.
// PARITY (Rule E5): writes bind to identity.avatarId (human cookie OR agent
// session → bound avatar). No ledger touch this slice (free claim).
app.route('/api/land', landRoutes);
app.route('/api/research', researchSseRoutes);
app.route('/api/research', researchApiRoutes);
app.route('/api/marketplace', marketplaceRoutes);
app.route('/api/claws', clawRoutes);
app.route('/api/agent', agentGatewayRoutes);
// Phase 3 — character export ("take my agent home") endpoint. Mounted at
// the same `/api/agent` prefix so the route path becomes
// `POST /api/agent/export-character`, matching the path in
// `.claude/plans/phase3-character-export-api.md`.
app.route('/api/agent', agentExportRoutes);
// Alias: /api/skills/connect → /api/agent/connect-skill (user-facing SKILL.md URL)
app.get('/api/skills/connect', (c) => {
  const token = c.req.query('token') ?? '';
  const url = new URL(c.req.url);
  return c.redirect(`${url.origin}/api/agent/connect-skill?token=${token}`);
});
app.route('/api/bazaar', bazaarRoutes);
app.route('/api/auctions', auctionRoutes);
app.route('/api/quests', questRoutes);
app.route('/api/bounties', bountyRoutes);
app.route('/api/exchange', exchangeRoutes);
app.route('/api/leaderboard', leaderboardRoutes);
app.route('/api/agent-setup', agentSetupRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/v2/agent', agentV2Routes);
// USDC→CT on-ramp (Phase A) — x402/PayAI quote+settle → ClawToken credit.
// Human (Lucia) + connected-agent (X-Clawville-Agent-Session) parity via
// requireAuthOrAgentSession. Devnet-first; mainnet is a config flip after a
// funded settled smoke. See routes/ct-topup.ts + services/x402-payai.ts.
app.route('/api/ct/topup', ctTopupRoutes);
app.route('/api/dashboard', dashboardRoutes);
// Phase 5.1 — cross-world portal + account linking (see plan §6.2 + §15).
app.route('/api/portal', portalRoutes);
// SEC-1 / FIX-6 — bound the request body on EVERY partner-hatcher route BEFORE
// the handlers run. `readSignedBody` does `await c.req.text()` (buffering the
// WHOLE body into memory) and verifies the ed25519 signature AFTER the read, so
// without this an UNAUTHENTICATED caller could stream a multi-hundred-MB body
// and exhaust memory/GC on the single API replica before the 401 ever fires.
// 64 KB is comfortably above any legitimate Hatcher payload — their client only
// sends compact JSON (register/PATCH bodies, an empty `{}` launch body), so a
// 64 KB cap never rejects a real partner request (CONTRACT.md / hatcher-methods.ts).
// Mounted BEFORE both `/api/partner/hatcher` route groups so it gates register/
// PATCH/DELETE/stats AND the launch-exchange callback. `*` covers the nested
// `/agents/:id`, `/agents/:id/stats`, and `/launch/exchange` paths.
app.use(
  '/api/partner/hatcher/*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
  }),
);
// Hatcher partner #2 — partner-signed agent registration API (proxy
// cognition). See routes/partner-hatcher.ts + plan §13/§14 (Phase A).
app.route('/api/partner/hatcher', partnerHatcherRoutes);
// Hatcher partner #2 — owner-side launch-exchange entry (redeems the
// dashboard launch grant; Lucia-session-gated, signed server-to-server).
// POST /api/partner/hatcher/launch/exchange. See routes/partner-hatcher-launch.ts
// + plan .claude/plans/hatcher-launch-exchange.md (§A).
app.route('/api/partner/hatcher', partnerHatcherLaunchRoutes);
// Partner DIRECT-USDC storefront (PayAI x402 Phase D — VISIBLE-BUT-GATED). NEW,
// ADDITIVE router at `/api/partner/:partnerId/storefront/*` — STRICTLY separate
// from the live `/api/partner/hatcher/*` registration/cognition/launch routes
// above (Hono matches the more-specific `/api/partner/hatcher` mount FIRST, so
// this router's middleware NEVER runs on a hatcher path). POST register
// (ed25519 partner-signed, ±5 min), POST admin/fulfillment (adminOnly flip —
// NEVER the partner key), POST purchase (503 `partner_fulfillment_gated` before
// any settlement while fulfillment is off). Buyer→partner USDC direct, WE NEVER
// CUSTODY. See routes/partner-storefront.ts + services/x402-payai.ts +
// PLAN.md §2 Phase D. FEATURE_GATE partner_storefront_tier.
app.route('/api/partner', partnerStorefrontRoutes);
// Wager lobbies + escrow (gambling-contracts vertical slice).
// See routes/wager.ts header for the full surface + feature gates.
app.route('/api/wager', wagerRoutes);
// Phase 6.1 slice 3 — Cove slots (commit-reveal RNG + session escrow).
// ClawTokens path is fully wired; SOL/USDC routes return 501 with a
// friendly message until Phase 6.2 lands real-money custody.
app.route('/api/cove/slots', coveSlotsRouter);
// Phase 6.4.1 — cove blackjack authoritative engine (replaces the 6.4.0 mock).
app.route('/api/cove/blackjack', coveBlackjackRouter);
// Phase 6.5.0 — cove Texas Hold'em mock (visual shell; pokerpocket engine in 6.5.1).
app.route('/api/cove/holdem', coveHoldemRouter);
// Poker MTT (P3) — single-table tournament: POST /:id/register (user|agent),
// GET /:id (status+standings). Real-CT buy-in/prize via claw-token-ledger.
app.route('/api/cove/poker/mtt', covePokerMttRouter);
// Special Events (2026-06-16) — generic PARENT layer: POST /create|/:slug/open|
// /:slug/start (admin), GET / + /:slug (public), POST /:slug/signup (user|agent,
// gate-evaluated). The dependent poker tournament links UP via special_event_id.
app.route('/api/events', specialEventsRouter);
// Phase 6.6.1 — cove Baccarat (Punto Banco) authoritative engine (8-deck shoe,
// fixed third-card tableau, commit-reveal provably-fair; ClawToken ledger;
// SOL/USDC seam returns 501).
app.route('/api/cove/baccarat', coveBaccaratRouter);
// Phase 6.7.0 — cross-game history (owner-only list + owner|admin verify).
// Slots integration ships in-line with this mount (see cove-slots.ts spin txn).
app.route('/api/cove/history', coveHistoryRouter);
// Economy fix 2026-05-29 — admin-only CT-economy monitor: GET /api/cove/economy/
// summary aggregates cove_game_events minted/burned/houseNet by gameType to
// detect any game that has gone net-positive to players (a faucet).
app.route('/api/cove/economy', coveEconomyRouter);
// Phase 5.1 — admin identity recovery stub. Returns 501 behind a
// FEATURE_GATE until the support-chat verification workflow lights up.
app.route('/api/admin', adminIdentityRoutes);

// MOCK x402 facilitator — local stand-in for PayAI's hosted facilitator
// (`https://facilitator.payai.network`) so the x402 payment handshake (and the
// USDC→CT on-ramp) can be exercised end-to-end without real funds. It rubber-
// stamps every settlement, so it is gated OFF by default and MUST NEVER be
// enabled in production. Pair with X402_FACILITATOR_PRESET=mock (or
// X402_FACILITATOR_URL pointing here).
//
// PROD CRASH-LOUD GUARD: the AUTHORITATIVE fail-boot invariant lives at module
// load in x402-config.ts (it fires before any request and covers both the
// X402_MOCK_FACILITATOR flag AND the `mock` preset). This second check at the
// literal mount site is belt-and-suspenders: a mounted mock on a prod box
// (CLAWVILLE_ENV=production) would mint free CT, so we refuse to boot here too.
if (process.env.X402_MOCK_FACILITATOR === 'true') {
  if (process.env.CLAWVILLE_ENV === 'production') {
    throw new Error(
      '[x402-mock] Refusing to mount the MOCK facilitator: X402_MOCK_FACILITATOR=true while ' +
        'CLAWVILLE_ENV=production. The mock rubber-stamps settlement and would MINT FREE ClawTokens. ' +
        'Unset X402_MOCK_FACILITATOR on this box (see x402-config.ts for the authoritative guard).',
    );
  }
  app.route('/api/x402-mock', buildMockFacilitator());
  console.log(
    '[x402-mock] Mock facilitator MOUNTED at /api/x402-mock — TEST ONLY, never enable in prod.',
  );
}

// Error handler — expected errors (HTTPException, InsufficientTokens) return
// typed responses without alerting; unexpected exceptions fire an immediate
// Telegram alert via alertError so we catch 500s on their first occurrence.
app.onError((err, c) => {
  console.error('API Error:', err);
  if (err instanceof HTTPException) {
    return c.json({ error: err.message, code: err.status }, err.status);
  }
  // InsufficientTokensError from claw-token-ledger should return 400, not 500
  if (err.name === 'InsufficientTokensError') {
    return c.json({ error: err.message, code: 400 }, 400);
  }

  // Genuinely unexpected — fire a critical alert (rate-limited in alertError).
  void alertError({
    severity: 'critical',
    source: 'api-route',
    message: `Uncaught error on ${c.req.method} ${c.req.path}`,
    context: {
      error: String(err),
      stack: (err as Error)?.stack,
      userId: c.get('user')?.id,
    },
  });

  return c.json({ error: 'Internal server error', code: 500 }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found', code: 404 }, 404);
});

const port = parseInt(process.env.PORT || '4000', 10);
console.log(`Starting ClawVille API on port ${port}...`);

// ---------------------------------------------------------------------------
// Boot preflight — CLOUDFLARE_WORKER_* are HARD-REQUIRED on boot
// ---------------------------------------------------------------------------
// CLAUDE.md ("Crash-loud rule") declares FINGERPRINT_SECRET + CLOUDFLARE_WORKER_*
// hard-required on boot: missing ⇒ API refuses to start. FINGERPRINT_SECRET is
// already enforced by middleware/fingerprint.ts throwing at module load. The CF
// Worker vars, however, were only validated LAZILY inside keypair-vault.ts
// (requireWorkerEnv, first envelope-encryption use), so a misconfigured box
// would boot fine and only fail on the first wallet op — making the documented
// boot guarantee false. Assert them here at startup so the doc is true and a
// missing var is caught immediately (the lazy check in keypair-vault.ts stays
// as defense-in-depth). Mirrors the FINGERPRINT_SECRET crash-loud pattern.
{
  const missingWorkerEnv = (['CLOUDFLARE_WORKER_URL', 'CLOUDFLARE_WORKER_BEARER'] as const).filter(
    // `?.trim()` so a whitespace-only value ("  ") is treated as missing — else
    // it passes the boot gate and fails lazily on the first wallet op.
    (k) => !process.env[k]?.trim(),
  );
  if (missingWorkerEnv.length > 0) {
    console.error(
      `[API] FATAL: ${missingWorkerEnv.join(' + ')} ${missingWorkerEnv.length > 1 ? 'are' : 'is'} required at boot ` +
        'for envelope encryption (Phase 5.1 custodial wallets). Deploy the CF secrets ' +
        'Worker (infra/cf-secrets-worker/README.md) and set both env vars on this box. ' +
        'Refusing to boot.',
    );
    process.exit(1);
  }
}

// Loud one-line warning if the staging-only mock-Hatcher test partner pubkey is
// enabled — this MUST NEVER appear in prod logs (see ARCHITECTURE.md).
warnIfTestPartnerPubkeyEnabled();

// Start NPC simulation (arena mode runs combat, world mode is peaceful)
const arenaMode = process.env.NPC_ARENA_MODE === 'true';
startSimulation(arenaMode);

// Pre-migrate ElizaOS schema + seed system-owned building NPCs so every user
// can chat with Patrick/Gary/etc. without any setup. Non-blocking — a failure
// must not crash API startup, but every deploy gets a fresh attempt.
//
// The migration step ensures plugin-sql's 20 tables (agents, memories, rooms,
// ...) exist BEFORE any lazy-start runtime tries to query them — otherwise the
// first user chat times out at Bun.serve's 10s idleTimeout while migrations
// churn in the background.
(async () => {
  try {
    const { ensureElizaMigrated, assertAgentsTableExists } = await import(
      './services/eliza-migrator'
    );
    const migrated = await ensureElizaMigrated();
    if (migrated.ok) {
      console.log('[API] ElizaOS schema ready');
    } else {
      console.error('[API] ElizaOS migration failed:', migrated.error);
    }

    // Hard assertion: if `agents` table is missing, plugin-sql's migrator
    // short-circuited (2026-04-16 + 2026-04-23 both happened this way).
    // Refuse to keep running; failing loud beats silently breaking every chat.
    // Recovery: scripts/recover-eliza-schema.mjs.
    const agentsCheck = await assertAgentsTableExists();
    if (!agentsCheck.ok) {
      console.error(
        '[API] FATAL: ElizaOS `agents` table is missing after migration!\n' +
          '[API] This means plugin-sql skipped its schema creation and all chat\n' +
          '[API] routes would silently 500. Refusing to boot.\n' +
          '[API] Cause: ' +
          agentsCheck.error +
          '\n[API] Recovery: run `scripts/recover-eliza-schema.mjs` against prod,\n' +
          '[API] then redeploy. See the script header for instructions.',
      );
      process.exit(1);
    }
  } catch (err) {
    console.error('[API] ElizaOS migration crashed:', err);
  }

  try {
    const {
      ensureSystemAgents,
      ensureSystemNpcs,
      getSystemUserId,
    } = await import('./services/system-npc-seeder');
    const { SYSTEM_AGENT_TEMPLATES } = await import('@clawville/agent-templates');
    const { agentOrchestrator } = await import('./services/agent-orchestrator');

    // Seed system agents FIRST — they are world-wide (Town Guide et al.) and
    // not tied to a map_location row, so their readiness is independent of
    // (and should precede) the per-building seeder. Seeding them first cuts
    // the boot-race window during which `POST /api/chat/system/:slug` 503s.
    const systemAgents = await ensureSystemAgents();
    const sysTotalChunks = systemAgents.reduce((sum, r) => sum + r.knowledgeChunks, 0);
    console.log(
      `[API] Seeded ${systemAgents.length} system agent(s) (${sysTotalChunks} knowledge chunks): ${systemAgents
        .map((r) => `${r.slug}${r.created ? ':new' : ''}`)
        .join(', ')}`,
    );

    // Eager warmup — pre-boot every system-agent runtime so the first visitor
    // doesn't eat the lazy-start latency (~2-3s). Errors swallowed so a single
    // warmup failure doesn't crash boot; the lazy-start path catches the next
    // attempt on first chat.
    const systemUserId = await getSystemUserId();
    for (const { slug, platformAgentId } of systemAgents) {
      void agentOrchestrator
        .ensureAgentRuntime(platformAgentId, systemUserId)
        .then(() => console.log(`[API] Warmed system agent runtime: ${slug}`))
        .catch((err) => console.error(`[API] Warmup failed for ${slug}:`, err));
    }

    // Sanity: every template registered in SYSTEM_AGENT_TEMPLATES should
    // have been seeded. If a future slug gets skipped (e.g. DB error), log
    // it so the gap shows up in logs.
    const seededSlugs = new Set(systemAgents.map((r) => r.slug));
    for (const slug of Object.keys(SYSTEM_AGENT_TEMPLATES)) {
      if (!seededSlugs.has(slug)) {
        console.warn(`[API] SYSTEM_AGENT_TEMPLATES slug '${slug}' was NOT seeded`);
      }
    }

    const results = await ensureSystemNpcs();
    const withSkills = results.filter((r) => r.skillLoaded).length;
    const totalChunks = results.reduce((sum, r) => sum + r.knowledgeChunks, 0);
    console.log(
      `[API] Seeded ${results.length} system NPCs (${withSkills} with compiled SKILL.md, ${totalChunks} knowledge chunks)`,
    );
  } catch (err) {
    console.error('[API] System NPC seeder failed:', err);
  }

  // Phase 6 — start the openclaw_bots session TTL sweeper. Runs every 5
  // min, reaps rows whose `session_expires_at` has passed and stops any
  // still-mounted Eliza runtimes. Without this, a disconnected Hermes /
  // OpenClaw agent row lives forever and `/api/agent/session-status`
  // keeps answering `connected: true` until someone calls the explicit
  // unregister. See `services/openclaw-session-sweeper.ts`.
  try {
    const { startSessionSweeper } = await import(
      './services/openclaw-session-sweeper'
    );
    startSessionSweeper();
  } catch (err) {
    console.error('[API] Session sweeper failed to start:', err);
  }

  // 2026-06-12 — start the agent BODY idle-despawn sweeper. Runs every 1 min,
  // removes the in-world body (NOT the session) of any agent idle past
  // AGENT_BODY_IDLE_DESPAWN_MS so dormant agents stop costing sim CPU. The
  // session stays valid + restorable; the body re-spawns on the agent's next
  // authenticated activity. See `services/agent-body-idle-sweeper.ts`.
  try {
    const { startBodyIdleSweeper } = await import(
      './services/agent-body-idle-sweeper'
    );
    startBodyIdleSweeper();
  } catch (err) {
    console.error('[API] Body idle sweeper failed to start:', err);
  }

  // Q2 Activity Portals — recover orphaned LIVE/COUNTDOWN rooms (pod
  // crash recovery per backend §12.1), hydrate persisted queue entries,
  // then start the room sweeper + matchmaker intervals. Order matters:
  // recovery must finish before the sweeper runs so it doesn't try to
  // GC rows the recovery is mid-update on.
  try {
    // Wire chunk #3 hub + sim callbacks BEFORE starting the sweeper so
    // the first FSM transition hits the real broadcast path.
    activityRoomManager.setBroadcastFn((roomId, frame) => {
      activityWsHub.broadcastEvent(roomId, frame);
    });
    activityRoomManager.setLiveTransitionFn(async (room) => {
      // Wager bridge — if this room has a wager lobby attached, flip it
      // from `open` → `locked` on chain in lockstep with the FSM
      // transition. Best-effort (errors logged) so a lock failure doesn't
      // crash the match start; the lobby just stays open and we can
      // refund via cancel later. See services/activity/wager-lobby-bridge.ts.
      try {
        const { lockLobbyForRoom } = await import(
          './services/activity/wager-lobby-bridge'
        );
        await lockLobbyForRoom(room.id);
      } catch (err) {
        console.error('[API] wager-lobby-bridge lock failed:', err);
      }
      // Chunk #10 — instantiate bot controllers for any bot participants.
      // The factory is per-activity so each sim (Bumper, Reef, future)
      // pulls its own controller class without touching this dispatcher.
      const factory = getBotControllerFactory(room.activityId);
      const bots = factory
        ? Array.from(room.participants.values())
            .filter((p) => p.subjectType === 'bot')
            .map((p) => factory(p.avatarId))
        : [];
      const participantIds = Array.from(room.participants.keys());
      switch (room.activityId) {
        case 'bumper-shells':
          bumperShellsSim.startRoom(
            room.id,
            room.activityId,
            participantIds,
            { bots },
          );
          break;
        case 'reef-race': {
          // Phase 1 (audit C4 + S10) — pull pre-launch verdicts from the
          // room manager BEFORE starting the sim so bodies init with the
          // correct activeBoosts entry on tick 0. `room.startedAt` is set
          // by persistLiveTransition just before liveTransitionFn fires.
          const launchBoosts =
            activityRoomManager.computeLaunchVerdicts(room);

          // Phase 3 (audit C2) — split human/bot avatarIds, pre-load racing
          // profiles SYNCHRONOUSLY (await) BEFORE startRoom so the sim's
          // first tick has correct mults. ~1-2 ms blocking on the Drizzle
          // pool query — well below the 33 ms tick budget.
          const humanAvatarIds: string[] = [];
          const botAvatarIds: string[] = [];
          for (const p of room.participants.values()) {
            (p.subjectType === 'bot' ? botAvatarIds : humanAvatarIds).push(p.avatarId);
          }
          const avatarProfiles = await loadRacingProfiles(humanAvatarIds, botAvatarIds);

          reefRaceImpl.startRoom(
            room.id,
            room.activityId,
            participantIds,
            {
              bots,
              startedAt: room.startedAt ?? Date.now(),
              launchBoosts,
              avatarProfiles,
            },
          );
          break;
        }
        case 'texas-holdem': {
          // P1.2b — start one demo hand with in-memory chips (NO CT
          // settlement / persistence this phase). Seat participants in
          // insertion order (matchmaker fill = seat order); each gets a flat
          // 1000-chip demo stack. Commit-reveal seeds are freshly generated
          // per hand (the seed is revealed in HandResult at showdown).
          const seatAssignments = Array.from(
            room.participants.values(),
          ).map((p, seatIndex) => ({
            seatIndex,
            avatarId: p.avatarId,
            name: p.avatarId, // demo: no display-name lookup this phase
            // The sim's seat subjectType is 'human' | 'agent' only — map the
            // room's 'bot' fill onto 'agent' so they get the agent turn grace.
            subjectType: (p.subjectType === 'human' ? 'human' : 'agent') as
              | 'human'
              | 'agent',
            agentId: p.agentId ?? undefined,
            chipStack: 1000,
          }));
          if (seatAssignments.length < 2) {
            console.warn(
              `[API] texas-holdem room ${room.id} has <2 seats — not starting a hand`,
            );
            break;
          }
          try {
            // The provable-RNG requires serverSeed == EXACTLY 64 hex chars
            // (32 bytes) and a non-empty hex clientSeed. A UUID-minus-dashes is
            // only 32 hex chars and would throw — use 32 random bytes hex.
            const serverSeed = randomBytes(32).toString('hex');
            const clientSeed = randomBytes(16).toString('hex');
            pokerTableSim.startHand({
              tableId: room.id,
              handNumber: 1,
              seatAssignments,
              blinds: { sb: 10, bb: 20, ante: 0 },
              buttonSeatIndex: 0,
              serverSeed,
              clientSeed,
              turnClockMs: 30_000,
              agentTurnGraceMs: 5_000,
            });
          } catch (err) {
            console.error(
              `[API] texas-holdem startHand failed for room ${room.id}:`,
              err,
            );
          }
          break;
        }
        case 'texas-holdem-mtt':
          // P3.5 — a tournament TABLE's room goes LIVE here, but the
          // TournamentManager (NOT this dispatcher) owns hand-starting: the TM's
          // multi-hand loop already called `pokerMttSim.startHand` for hand 1
          // before flipping the room live (see poker-mtt-ws-bridge.ts onSeatFn).
          // So this case is a DELIBERATE no-op — starting a hand here would race /
          // double-start the TM's loop. The room just hosts the WS transport.
          break;
        default:
          console.warn(
            `[API] No sim registered for activityId='${room.activityId}' — room ${room.id} will sit LIVE without a sim`,
          );
      }
    });

    // Chunk #10 — return reserved bot avatarIds to the pool when ANY room
    // ends (RESULTS→GC / ABORTED / ABORTED_CRASH). Idempotent.
    activityRoomManager.setEvictionFn((room) => {
      botPool.releaseRoom(room.id);
    });

    // Phase 4 (S7 fix) — wire the reward-pipeline's per-recipient match-
    // end delivery to the WS hub's `sendToAvatar`. Done via callback (not
    // direct import) so the reward-pipeline module doesn't pull
    // `activity-ws-hub → activity-room-manager → activityLog` schema
    // chain into every reward-pipeline test that mocks `@clawville/database`.
    {
      const { setMatchEndDeliveryFn } = await import(
        './services/activity/reward-pipeline'
      );
      setMatchEndDeliveryFn((roomId, avatarId, frame) => {
        activityWsHub.sendToAvatar(roomId, avatarId, frame);
      });
    }
    // Chunk #7 — register the per-activity placement resolver so the
    // room manager's RESULTS transition can pull placements without
    // importing each sim directly. Future activities (Reef Race, …)
    // plug in additional cases here.
    activityRoomManager.setComputeResultsFn((room) => {
      switch (room.activityId) {
        case 'bumper-shells':
          return bumperShellsSim
            .computeResults(room.id)
            .map((r) => ({
              avatarId: r.avatarId,
              placement: r.placement,
              score: r.score,
              scoreMs: null,
            }));
        case 'reef-race':
          return reefRaceImpl
            .computeResults(room.id)
            .map((r) => ({
              avatarId: r.avatarId,
              placement: r.placement,
              score: r.score,
              scoreMs: r.scoreMs,
            }));
        default:
          return [];
      }
    });
    // Sim broadcast → WS hub, with snapshot frames routed through the
    // backpressure-aware path.
    bumperShellsSim.setBroadcastFn((roomId, frame) => {
      if (frame.type === 'snapshot.delta' || frame.type === 'snapshot.keyframe') {
        activityWsHub.broadcastSnapshot(roomId, frame);
      } else {
        activityWsHub.broadcastEvent(roomId, frame);
      }
    });
    // Sim end → room manager LIVE→RESULTS transition + wager settle bridge.
    bumperShellsSim.setEndedFn((roomId) => {
      void activityRoomManager
        .transitionRoom(roomId, 'results')
        .then(async () => {
          bumperShellsSim.stopRoom(roomId);
          // Wager bridge — settle the wager lobby (if attached) to the
          // first-placed avatar from the sim's computeResults.
          try {
            const results = bumperShellsSim.computeResults(roomId);
            const winner = results.find((r) => r.placement === 1) ?? null;
            const { settleLobbyForRoom } = await import(
              './services/activity/wager-lobby-bridge'
            );
            await settleLobbyForRoom(roomId, winner?.avatarId ?? null);
          } catch (err) {
            console.error('[API] wager-lobby-bridge settle failed (bumper):', err);
          }
        })
        .catch((err) => {
          console.error('[API] Sim end → RESULTS transition failed:', err);
        });
    });
    bumperShellsSim.setIntegrityForfeitFn((roomId, avatarId) => {
      // Chunk #3 §4.7 — send a close frame and drop the connection.
      activityWsHub.sendToAvatar(roomId, avatarId, {
        type: 'error',
        code: 'integrity',
        message: 'anti-cheat forfeit (5 flags)',
      });
      // Unregister is triggered by the close; the hub's notifyForfeit
      // path runs with reason='integrity' because we set internalCloseCode
      // before safeClose.
    });

    // ─── Chunk #5 — Reef Race sim wiring (mirrors Bumper above) ─────────
    // v2: routed through `reefRaceImpl` so REEF_RACE_USE_SPLINE flips both
    // the lifecycle wires AND the lookup paths in lockstep. The OTHER sim
    // is left silent (no broadcast/end wiring) so a misrouted call is loud.
    reefRaceImpl.setBroadcastFn((roomId, frame) => {
      if (frame.type === 'snapshot.delta' || frame.type === 'snapshot.keyframe') {
        activityWsHub.broadcastSnapshot(roomId, frame);
      } else {
        activityWsHub.broadcastEvent(roomId, frame);
      }
    });
    reefRaceImpl.setEndedFn((roomId) => {
      void activityRoomManager
        .transitionRoom(roomId, 'results')
        .then(async () => {
          reefRaceImpl.stopRoom(roomId);
          // Wager bridge — settle the wager lobby (if attached) for the
          // first-placed avatar (placement 1 = race winner).
          try {
            const results = reefRaceImpl.computeResults(roomId);
            const winner = results.find((r) => r.placement === 1) ?? null;
            const { settleLobbyForRoom } = await import(
              './services/activity/wager-lobby-bridge'
            );
            await settleLobbyForRoom(roomId, winner?.avatarId ?? null);
          } catch (err) {
            console.error('[API] wager-lobby-bridge settle failed (reef):', err);
          }
        })
        .catch((err) => {
          console.error('[API] Reef sim end → RESULTS transition failed:', err);
        });
    });
    reefRaceImpl.setIntegrityForfeitFn((roomId, avatarId) => {
      activityWsHub.sendToAvatar(roomId, avatarId, {
        type: 'error',
        code: 'integrity',
        message: 'anti-cheat forfeit (5 flags)',
      });
    });

    // ─── Texas Hold'em (P1.2b) — poker table sim wiring ─────────────────────
    //
    // The sim's PUBLIC snapshot rides `broadcastEvent` (NEVER broadcastSnapshot
    // — poker is turn-based and a dropped turn-state frame desyncs the betting
    // UI). The PRIVATE per-seat view rides `sendToAvatar` (carries hole cards —
    // must never broadcast). On hand-complete we emit the public showdown +
    // hand-ended frames, then transition the room toward RESULTS. NO CT
    // settlement / reward issuance this phase (no setComputeResultsFn case for
    // texas-holdem — the room manager logs "no sim results" and credits
    // nothing, which is the intended demo behavior).
    //
    // The sim's own types (PublicTableSnapshot / PrivateSeatView / HandResult
    // from poker-table-types.ts) are structural mirrors of the shared wire
    // types (PokerPublicTableSnapshot / PokerPrivateSeatView / PokerHandResult),
    // so they assign directly into the frame payloads below.
    pokerTableSim.setBroadcastFn((tableId, snapshot) => {
      // tableId === roomId (one live hand per room).
      activityWsHub.broadcastEvent(tableId, {
        type: 'poker.table_state',
        snapshot,
      });
    });
    pokerTableSim.setSendToSeatFn((tableId, avatarId, view) => {
      // Deliver BOTH the dedicated private hole-card frame AND the your-turn
      // view (the sim only invokes this for the seat that is on the clock, so
      // both ride the per-seat channel to exactly that one seat).
      activityWsHub.sendToAvatar(tableId, avatarId, {
        type: 'poker.hole_cards',
        handNumber: 1,
        seatIndex: view.seatIndex,
        holeCards: view.holeCards,
      });
      activityWsHub.sendToAvatar(tableId, avatarId, {
        type: 'poker.your_turn',
        handNumber: 1,
        view,
      });
    });
    pokerTableSim.setHandCompleteFn((tableId, result) => {
      // Public showdown reveal — ONLY on a genuine showdown. On a fold-around
      // (endedAt !== 'showdown') no one shows, so we skip the showdown frame
      // entirely; the hand_ended payload below still settles the pot. The sim
      // already nulls every seat's holeCards on a non-showdown end.
      if (result.endedAt === 'showdown') {
        activityWsHub.broadcastEvent(tableId, {
          type: 'poker.showdown',
          handNumber: result.handNumber,
          board: result.board,
          seats: result.perSeat,
        });
      }
      activityWsHub.broadcastEvent(tableId, {
        type: 'poker.hand_ended',
        result,
      });
      void logEvent({
        eventType: 'activity.poker.hand_ended',
        payload: {
          roomId: tableId,
          handNumber: result.handNumber,
          endedAt: result.endedAt,
          winners: result.perSeat
            .filter((s) => s.isWinner)
            .map((s) => s.avatarId),
        },
      });
      // Transition the room toward results (demo: one hand per room, no CT).
      // The sim already broadcast the final state; tear it down + flip the FSM.
      // Best-effort — a missing room (already torn down) is a silent no-op.
      const room = activityRoomManager.getRoom(tableId);
      if (room && room.state === 'live') {
        void activityRoomManager
          .transitionRoom(tableId, 'results')
          .then(() => {
            pokerTableSim.stopTable(tableId);
          })
          .catch((err) => {
            console.error(
              '[API] poker hand end → RESULTS transition failed:',
              err,
            );
            pokerTableSim.stopTable(tableId);
          });
      } else {
        pokerTableSim.stopTable(tableId);
      }
    });

    // ─── Poker MTT (P3.5) — tournament-table WS bridge ──────────────────────
    // Wire the DEDICATED `pokerMttSim` + the TournamentManager to the WS hub so
    // tournament tables are PLAYABLE over WebSocket (long-lived `texas-holdem-mtt`
    // room, public table_state + private hole-cards/your-turn fan-out, showdown /
    // hand-ended broadcast, room↔table mapping for inbound action dispatch). This
    // is fully isolated from the demo `texas-holdem` wiring above — separate sim,
    // separate activityId, separate room namespace. The TM's hand-complete handler
    // (its multi-hand loop) is UNTOUCHED; the bridge only registers the SEPARATE
    // showdown-broadcast slot + the broadcast/per-seat slots on the MTT sim.
    wirePokerMttToHub(pokerMttSim, tournamentManager);

    await activityRoomManager.recoverOrphanedRooms();
    // Poker MTT (P4) — MONEY-side crash recovery. `recoverOrphanedRooms()` above
    // only flips the `texas-holdem-mtt` ROOMS to `aborted_crash` via a direct bulk
    // UPDATE that BYPASSES `persistAbortedTransition`, so the `abortNotifyFn` →
    // `onRoomAborted` → `cancelAndRefundOrphan` chain never fires for boot-orphaned
    // rooms. And the start-trigger sweeper below only scans status IN
    // ('registering','seating') — a crashed `running` tournament is invisible to it.
    // This driver is the ONLY code that scans status IN ('running','seating') AND
    // settled_at IS NULL AND cancelled_at IS NULL to CANCEL + REFUND the escrowed
    // buy-ins. Without this call a pod crash mid-tournament strands every entrant's
    // buy-in in `prize_pool_ct` PERMANENTLY (no sweeper path, no abort-notify path,
    // no boot path would ever refund it). Idempotent (FOR UPDATE + per-entrant
    // `status <> 'refunded'` guard) so re-boot never double-refunds.
    await tournamentManager.recoverOrphanedTournaments();
    await activityQueueService.hydrateFromDb();
    // Chunk #10 — hydrate the bot avatarId pool BEFORE the matcher starts
    // sweeping so the first solo-Bumper queuer at 45s gets bots, not a
    // "pool empty" warning. Failure is non-fatal — the matcher will
    // simply skip backfill and humans wait longer.
    try {
      await botPool.hydrate();
    } catch (err) {
      console.error('[API] Bot pool hydration failed:', err);
    }
    activityRoomManager.startSweeper();
    activityQueueService.startMatchmaker();
    // Poker MTT (P4) — idempotently seed the DEFAULT rising-blind ladder so the
    // create path (and any tournament referencing the default) always has a row to
    // point at. Fixed-uuid + ON CONFLICT DO NOTHING → safe on every boot. Non-fatal:
    // a create with an explicit blindScheduleId doesn't need it.
    try {
      await tournamentManager.ensureDefaultBlindSchedule();
    } catch (err) {
      console.error('[API] poker-MTT default blind schedule seed failed:', err);
    }
    // Poker MTT (P3) — the LIVE start-trigger sweep. THE path that seats a
    // window-closed field (or cancels+refunds a short field). Without it (and the
    // cap-hit auto-trigger in the register route) a registered tournament could
    // never seat/play/settle/refund and buy-ins would stay escrowed forever.
    tournamentManager.startStartTriggerSweeper();
    console.log('[API] Activity room manager + queue + poker-MTT sweeper ready');
  } catch (err) {
    console.error('[API] Activity portal init failed:', err);
  }
})();

// Graceful shutdown — clean up the many long-lived runtimes and intervals
// we accumulate across Phase 1/2/3. Without this, Hetzner/Coolify SIGTERM
// leaks 10+ ElizaRuntime instances, their DB pools, and the broker/registry
// setIntervals on every container restart.
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[API] Received ${signal}, shutting down gracefully...`);

  try {
    // Import inside the handler so a failed import doesn't crash startup
    const { stopSimulation, npcSimulation } = await import('./services/npc-simulation');
    const { agentOrchestrator } = await import('./services/agent-orchestrator');
    const { getCollaborationBroker } = await import('@clawville/agent-runtime');

    stopSimulation();
    activityRoomManager.stopSweeper();
    activityQueueService.stopMatchmaker();
    tournamentManager.stopStartTriggerSweeper();
    try {
      const { stopSessionSweeper } = await import(
        './services/openclaw-session-sweeper'
      );
      stopSessionSweeper();
    } catch {
      // If the sweeper module failed to load earlier, there's nothing to stop.
    }
    await Promise.allSettled([
      npcSimulation.avatarAutonomyManager.shutdown(),
      getCollaborationBroker().shutdown(),
      agentOrchestrator.shutdown(),
    ]);
    console.log('[API] Shutdown complete.');
  } catch (err) {
    console.error('[API] Shutdown error:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Q2 Activity Portals — WebSocket handler plumbing. The adapter is
// shared with `apps/api/src/routes/activities.ts` so both halves see the
// same `createBunWebSocket` instance. Bun.serve reads `websocket` off
// the default export to drive the WS lifecycle.
const { websocket: activityWebsocketHandler } = getBunWebSocketHelper();

export default {
  port,
  fetch: app.fetch,
  websocket: activityWebsocketHandler,
  // Bun.serve idleTimeout — DO NOT lower below 30. SSE keepalives fire every
  // 15s on /api/research/stream and /api/npc/stream; with the default 10s,
  // Bun reaps the socket between writes and the client surfaces
  // ERR_HTTP2_PROTOCOL_ERROR 200. Verified live 2026-04-25 via in-container
  // probe: ECONNRESET on localhost:4000 after the initial 'connected' event,
  // never reaching even the upstream proxy. 255 is Bun's max value.
  idleTimeout: 255,
};
