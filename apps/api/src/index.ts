import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { redactBearerTokens } from './services/log-redact';
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
import { clawRoutes } from './routes/claws';
import { agentGatewayRoutes } from './routes/agent-gateway';
// pendingConnections is exported but only used internally by agent-gateway routes
import { agentExportRoutes } from './routes/agent-export';
import { avatarManifestRoutes } from './routes/avatar-manifest';
import { questRoutes } from './routes/quests';
import { bountyRoutes } from './routes/bounties';
import { exchangeRoutes } from './routes/exchange';
import { leaderboardRoutes } from './routes/leaderboard';
import { agentSetupRoutes } from './routes/agent-setup';
import { skillsRoutes } from './routes/skills';
import { agentV2Routes } from './routes/agent-v2';
import { dashboardRoutes } from './routes/dashboard';
// Tokenomics F2 — USDC→vCLAW on-ramp (Phase A) + the TEST-ONLY mock facilitator.
import { ctTopupRoutes } from './routes/ct-topup';
// Tokenomics C2 (2026-07-07) — MoonPay TEST-MODE card→USDC rail: signed
// SANDBOX widget URL (funds the caller's OWN custodial wallet; E5 parity via
// requireAuthOrAgentSession) + the signature-verified, DB-idempotent webhook
// recorder. NO custodial auto-sign (Codex-gated seam), NO CT movement.
import { moonpayRoutes } from './routes/moonpay';
// Tokenomics C — checkout stage (2026-07-07): generic x402 USDC checkout for
// ANY vCLAW-priced thing. Importing the route ALSO side-effect-imports the
// fulfillers (cosmetic-purchase + rent-prepay + marketplace-purchase register
// themselves) — the registry is populated before any request runs.
import { x402CheckoutRoutes } from './routes/x402-checkout';
// Tokenomics C4 (2026-07-07): P2P marketplace v1 — list/browse/cancel with the
// CLV seller license + deed escrow-lock. SETTLEMENT flag-gated OFF
// (MARKETPLACE_SETTLE_ENABLED); the buyer path is the x402 checkout above.
import { marketRoutes } from './routes/market';
import { buildMockFacilitator } from './services/x402-mock-facilitator';
import { portalRoutes } from './routes/portal';
import { partnerHatcherRoutes } from './routes/partner-hatcher';
import { partnerHatcherLaunchRoutes } from './routes/partner-hatcher-launch';
import { partnerCovenantRoutes } from './routes/partner-covenant';
import { partnerStorefrontRoutes } from './routes/partner-storefront';
import { agentRegistrationRoutes } from './routes/agent-registration';
import { agentEip8004Routes } from './routes/agent-eip8004';
import { adminIdentityRoutes } from './routes/admin-identity';
import { startSimulation } from './services/npc-simulation';
import { alertError } from './services/alert-error';
import { getPublishedIssuerInfo } from './services/service-issuer';
import { warnIfTestPartnerPubkeyEnabled } from './services/partner-signature';
import { fingerprintMiddleware } from './middleware/fingerprint';
import { cosmeticsRoutes } from './routes/cosmetics';
import { dashAuthRoutes } from './routes/dash-auth';
import { wagerRoutes } from './routes/wager';
// SAP Option C — on-chain agent identity + USDC escrow rail (gated OFF + devnet +
// dry-run by default; mainnet is a code gate, not an env). See routes/sap.ts.
import { sapRoutes } from './routes/sap';
// Phase 6.1 slice 3 — cove slots fun-money backend wire (ClawTokens live;
// SOL/USDC return 501 until Phase 6.2 custody).
import { coveSlotsRouter } from './routes/cove-slots';
// Phase 6.4.1 — cove blackjack AUTHORITATIVE route (6-deck shoe, S17, BJ 3:2,
// commit-reveal provably-fair engine, ClawToken ledger; SOL/USDC seam returns 501).
import { coveBlackjackRouter } from './routes/cove-blackjack';
// Phase 6.5.0 — cove Texas Hold'em mock route (visual shell, no engine yet).
import { coveHoldemRouter } from './routes/cove-holdem';
// Poker MTT (P3) — single-table tournament registration + status route.
// Agent-capable (Rule E5): human cookie OR X-Clawville-Agent-Session both reach
// the same real-CT buy-in/settle path. Full lobby UI is a later phase.
import { covePokerMttRouter } from './routes/cove-poker-mtt';
// Poker CASH (ring) games (P1) — sit-down/leave/action ring tables, chips==CT 1:1.
// Agent-capable (Rule E5): human cookie OR X-Clawville-Agent-Session both reach the
// same real-CT sit-debit / cash-out-credit / per-hand settle path.
import { coveCashPokerRouter } from './routes/cove-cash-poker';
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
// Lean in-product support tickets — POST /api/support/tickets (user/agent/guest).
import { supportRouter } from './routes/support';
// Economy fix 2026-05-29 — admin-only CT-economy monitor (minted/burned/houseNet
// per gameType; faucet detector). FEATURE_GATE: cove_ct_economy_monitor.
import { coveEconomyRouter } from './routes/cove-economy';
import { treasuryRouter } from './routes/treasury';
// Tokenomics T0 (2026-07-07) — admin-only CLV price-oracle read surface
// (GET /api/oracle/clv). READ-ONLY price feed; never touches the CT ledger.
import { oracleRouter } from './routes/oracle';
// Tokenomics C3 (2026-07-07) — CLV buy-queue DRY-RUN worker. STATIC import is
// deliberate: clv-swap-executor.ts throws AT MODULE LOAD when
// CLV_SWAP_EXECUTE=true (live execution is Codex-review-gated), so a box
// carrying that flag refuses to boot — the x402-config crash-loud pattern.
import { startClvSwapWorker, stopClvSwapWorker } from './services/clv-swap-executor';
import { walletLinkRoutes } from './routes/wallet-link';
// Custodial wallet withdraw (2026-07-08) — DARK behind default-OFF
// WALLET_WITHDRAW_ENABLED; the route itself refuses with a typed 503 while
// the flag is unset, so this static import is dark-safe.
import { walletWithdrawRoutes } from './routes/wallet-withdraw';
import type { AppContext } from './types';

const app = new Hono<AppContext>();

// Global middleware
// Redact agent bearer sessionIds from the request log: several agent routes
// carry the real-CT bearer as a `/:sessionId/…` PATH param, and hono/logger
// prints every path — so an un-redacted logger writes the replayable credential
// into stdout / the Coolify log drain (real-CT theft on log access). The custom
// print fn scrubs only the LOG string; URLs/responses to the Hatcher partner are
// unchanged. Pre-existing leak folded in at the P0 Codex gate (2026-07-01), same
// class as the B1 body-id leak. See services/log-redact.ts.
app.use(
  '*',
  logger((message: string, ...rest: string[]) => {
    console.log(
      redactBearerTokens(message),
      ...rest.map((r) => (typeof r === 'string' ? redactBearerTokens(r) : r)),
    );
  }),
);
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

// ---------------------------------------------------------------------------
// EIP-8004 registration JSON for SAP/Metaplex-registered agents (identity rail)
// ---------------------------------------------------------------------------
// Public, per-SAP-agent EIP-8004 document served at
//   GET /agents/:sapAgentPda/eip-8004.json
// This exact URL is baked into each agent's MPL Core AgentIdentity plugin
// (attached via the 1DREG / mpl-agent-014 registry), so the path is
// immutable once an asset is minted. Covenant + the SAP SDK's
// MetaplexBridge verifyLink/tripleCheckLink fetch it to validate the
// asset ↔ SAP-agent link. Distinct from the fingerprint-keyed
// /.well-known/agents route above (different key, different consumer).
app.route('/agents', agentEip8004Routes);

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/avatars', avatarRoutes);
// Agent export & portability (2026-06-19) — signed, content-addressed avatar
// manifest. SINGULAR `/api/avatar` (distinct from plural `/api/avatars` above):
//   GET /api/avatar/:id/manifest.json. See `.claude/plans/agent-export-portability.md`.
app.route('/api/avatar', avatarManifestRoutes);
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
app.route('/api/quests', questRoutes);
app.route('/api/bounties', bountyRoutes);
app.route('/api/exchange', exchangeRoutes);
app.route('/api/leaderboard', leaderboardRoutes);
app.route('/api/agent-setup', agentSetupRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/v2/agent', agentV2Routes);
app.route('/api/dashboard', dashboardRoutes);
// Tokenomics F2 — USDC→vCLAW on-ramp (Phase A): x402/PayAI quote+settle →
// BOUGHT (non-cashable) vCLAW credit. Human (Lucia) + connected-agent
// (X-Clawville-Agent-Session) parity via requireAuthOrAgentSession. Devnet-first;
// mainnet is a config flip after a funded settled smoke. GATED: the route 503s
// when CLAWVILLE_MERCHANT_WALLET_PUBKEY is unset, and X402_ENABLED stays off
// until a funded smoke. See routes/ct-topup.ts + services/x402-payai.ts.
app.route('/api/ct/topup', ctTopupRoutes);
// Tokenomics C2 — MoonPay TEST-MODE card rail. POST /widget-url (human OR
// connected-agent via requireAuthOrAgentSession — each funds ITS OWN custodial
// wallet) + POST /webhook (Moonpay-Signature-V2-verified; idempotent by the
// moonpay_events.external_tx_id UNIQUE index; records arrivals ONLY — never
// signs, never moves CT). Sandbox-pinned; live is a Codex-reviewed code change.
app.route('/api/moonpay', moonpayRoutes);
// Tokenomics C — generic x402 checkout: ANY vCLAW-priced thing settles as a
// REAL USDC payment (¢-peg quote unit; buyer's internal vCLAW NEVER debited).
// POST /quote (server-priced, 402 challenge + pending x402_checkouts row) +
// POST /settle (verify→settle→ONE tx {flip + kind fulfiller}; exactly-once by
// the partial-UNIQUE tx_signature). Human + connected-agent parity via
// requireAuthOrAgentSession (agent settles for ITS OWN avatar; non-ledger
// sessions 403). GATED like ct-topup: 503 until the merchant wallet is set;
// devnet-first. See routes/x402-checkout.ts + services/x402-checkout.ts.
app.route('/api/x402/checkout', x402CheckoutRoutes);
// Tokenomics C4 (2026-07-07) — P2P marketplace v1: sellers list (CLV Resident
// license ≥ 50k uiAmount, fail-soft REFUSE; land_deed only — earned_bundle
// refused; deed escrow-locked in market_deed_locks), buyers settle via the
// x402 checkout above (itemKind 'marketplace_purchase'). SETTLEMENT IS
// FLAG-GATED OFF (MARKETPLACE_SETTLE_ENABLED — quote/preflight/fulfiller all
// refuse while unset). Seller CLV payout (95.56%) + treasury rake (4.44%) are
// QUEUED pending_review intents; on-chain sends + the deed owner-flip are
// Codex-gated seams. E5 parity via requireAuthOrAgentSession on every write.
app.route('/api/market', marketRoutes);
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
// Covenant partner — READ-ONLY verification read surface (bounty evidence/verdict/
// escrow linkage + agent-services identity). GET-only, no mutations, so no body-
// size cap is needed (unlike the partner-hatcher write surface's 64 KB bodyLimit).
// Fronted by requireCovenantPartner: ed25519 partner signature (same GET wire
// scheme as Hatcher) + IP allowlist, fail-closed 503 when unprovisioned.
// See routes/partner-covenant.ts + docs/sap-covenant-payai-architecture.md.
app.route('/api/partner/covenant', partnerCovenantRoutes);
// Phase D — ADDITIVE gated partner direct-USDC storefront (FEATURE_GATE
// partner_storefront_tier). Buyer → partner USDC, WE NEVER CUSTODY, credits NO
// CT. Mounted AFTER both `/api/partner/hatcher` groups so the LIVE partner-hatcher
// routes match FIRST — this NEW `/api/partner/storefront` base never shadows them.
// /quote + /settle 503 `partner_fulfillment_gated` until an admin enables a
// custody-reviewed storefront (always, today). See routes/partner-storefront.ts.
app.route('/api/partner/storefront', partnerStorefrontRoutes);
// Wager lobbies + escrow (gambling-contracts vertical slice).
// See routes/wager.ts header for the full surface + feature gates.
app.route('/api/wager', wagerRoutes);
// SAP — on-chain agent identity / reputation / tool / discovery + escrow USDC
// money rail. Triple-gated DARK by default (SAP_ENABLED=false,
// SAP_ESCROW_ENABLED=false, SAP_USDC_ESCROW_ENABLED=false, SAP_DRY_RUN=true) +
// devnet-first; mainnet is a code gate (SAP_ALLOW_MAINNET in sap-config.ts), not
// an env. The in-game economy stays ClawTokens. See routes/sap.ts FEATURE_GATE +
// docs/sap-integration.md. Rule E5 parity: human cookie OR agent session both
// bind to identity.avatarId's own custodial Phase-5.1 wallet.
app.route('/api/sap', sapRoutes);
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
// Poker CASH (P1) — ring tables: GET /tables (public lobby), POST /tables (create),
// /tables/join-by-code, /tables/:id/sit|leave|action (user|agent), /tables/:id +
// /:id/state-for-agent. chips==CT 1:1; sit DEBIT / leave CASH-OUT CREDIT via
// claw-token-ledger. Per-hand settle writes cove_game_events (gameType='poker').
app.route('/api/cove/poker/cash', coveCashPokerRouter);
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
// Lean support tickets — filable by user / connected-agent / guest.
app.route('/api/support', supportRouter);
// Economy fix 2026-05-29 — admin-only CT-economy monitor: GET /api/cove/economy/
// summary aggregates cove_game_events minted/burned/houseNet by gameType to
// detect any game that has gone net-positive to players (a faucet).
app.route('/api/cove/economy', coveEconomyRouter);
// Tokenomics T0 (2026-07-07) — admin-only house-treasury read surface:
// GET /api/treasury/summary reports the fee-sink avatar's balance (total +
// soft/bought/earned) with an optional ?byReason=true per-fee-site breakdown.
app.route('/api/treasury', treasuryRouter);
// Tokenomics T0 (2026-07-07) — admin-only CLV price-oracle read surface:
// GET /api/oracle/clv reports the current house-favorable quote (min(spot,
// 30-min TWAP)) + optional ?history=N raw snapshots. READ-ONLY USD price feed.
app.route('/api/oracle', oracleRouter);
// Tokenomics Phase A / Slice A1 (2026-07-07) — self-custody wallet link:
// POST /api/wallet/link/challenge → issue a nonce; POST /api/wallet/link →
// prove control (sign the nonce) + persist the pubkey pointer; GET
// /api/wallet/link → linked wallet + its (cached, mainnet) CLV balance. The
// non-custodial balance-read link backing the hold-tier / seller-license checks.
app.route('/api/wallet', walletLinkRoutes);
// Custodial wallet WITHDRAW (2026-07-08, DARK behind default-OFF
// WALLET_WITHDRAW_ENABLED): POST /api/wallet/withdraw (E5 human+agent, guest/
// non-ledger 403; Idempotency-Key REQUIRED; capture-before-send exactly-once
// executor — see services/wallet-withdraw-executor.ts) · GET /api/wallet/
// balances (read-only custodial SOL+USDC+CLV, live regardless of the flag).
// LEDGER-UNTOUCHED — on-chain custody assets only, never avatars.clawTokens.
app.route('/api/wallet', walletWithdrawRoutes);
// Phase 5.1 — admin identity recovery stub. Returns 501 behind a
// FEATURE_GATE until the support-chat verification workflow lights up.
app.route('/api/admin', adminIdentityRoutes);

// Tokenomics F2 — TEST-ONLY mock x402 facilitator. Lets the USDC→vCLAW on-ramp
// be exercised end-to-end without real funds. It RUBBER-STAMPS every settlement,
// so it is gated OFF by default and MUST NEVER run in production. Pair with
// X402_FACILITATOR_PRESET=mock (or X402_FACILITATOR_URL pointing here).
//
// PROD CRASH-LOUD GUARD: the AUTHORITATIVE fail-boot invariant lives at module
// load in x402-config.ts (it fires before any request and covers BOTH the
// X402_MOCK_FACILITATOR flag AND the `mock` preset). This second check at the
// literal mount site is belt-and-suspenders: a mounted mock anywhere but staging
// (production OR unset) would mint free vCLAW, so we refuse to boot here too.
if (process.env.X402_MOCK_FACILITATOR === 'true') {
  if (process.env.CLAWVILLE_ENV !== 'staging') {
    throw new Error(
      `[x402-mock] Refusing to mount the MOCK facilitator: X402_MOCK_FACILITATOR=true while ` +
        `CLAWVILLE_ENV is not 'staging' (it is ${process.env.CLAWVILLE_ENV ?? 'UNSET'}). The mock ` +
        `rubber-stamps settlement and would MINT FREE vCLAW — it may run ONLY on staging. Unset ` +
        `X402_MOCK_FACILITATOR on this box (see x402-config.ts for the authoritative guard).`,
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
  // Redact any agent bearer from the stringified error (its message/stack can
  // carry the request URL `/api/agent/oc-<bearer>/…`) before it hits stdout /
  // the Coolify log drain. The alertError() call below redacts message+context
  // internally; this covers the direct console.error. (redactBearerTokens is
  // imported at the top of this file.)
  console.error('API Error:', redactBearerTokens(String(err)));
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

// ── Process-level crash guards (2026-07-02 — boot-crush crash-loop fix) ──────
// Registered BEFORE the boot IIFE so they cover boot-time faults. This IS the
// fix for the observed crash-loop (staging `restarts=2`, `Bun` crash footers).
// Root cause: on a COLD/CONTENDED boot — cold Supabase + the ElizaOS migration
// still holding the plugin-sql advisory lock + Coralia's driver lazy-warm racing
// the town-guide boot warm — a single ElizaOS runtime's `initialize()` exceeded
// the bootstrap plugin's internal 30s service-registration timeout (task /
// embedding-generation / trajectory_logger). That timeout REJECTED on a promise
// chain we do NOT own → an UNHANDLED REJECTION; with no handler, Bun killed the
// whole API → Coolify restart → crash-loop until the boot was warm enough
// (migration done, DB cached) that init finished under 30s. These handlers catch
// that reject so it can't down the server. Both LOG LOUDLY and REDACTED (an
// agent route path/stack can carry a real-CT bearer, cf. M1) so nothing is
// hidden. (NB: it is a SINGLE-runtime contention, not a thundering herd — only
// ONE system agent (town-guide) warms at boot today; the sequential warm below
// is future-proofing, not the primary fix.)
//
// Split policy (deliberate):
//  • unhandledRejection → NON-fatal (log + keep serving). This is the exact
//    crash vector (a stray async reject from a third-party promise chain we
//    don't own); a rejected optional-service registration must not take the
//    server down, and the runtime lazy-restarts on next use.
//  • uncaughtException → log + EXIT(1). A sync throw that escaped every
//    try/catch means UNDEFINED process state; resuming risks a zombie serving
//    on corrupt in-memory state (e.g. a poker/cove sim-tick on a bad table)
//    with /health still green, so Coolify would never restart to self-heal.
//    Exiting restores crash-ONLY self-healing. It does NOT re-introduce the
//    crash-LOOP — that came from the rejection (now handled) + the concurrent
//    warm (now serialized), not from a sync throw. The deliberate crash-loud
//    boot invariants (FINGERPRINT_SECRET, ALLOW_TEST_PARTNER_PUBKEY-on-prod,
//    CF-worker preflight) are unaffected: they throw at MODULE LOAD (before
//    these handlers register) or call process.exit() directly, which
//    uncaughtException does not intercept.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[API] Unhandled promise rejection (kept alive, non-fatal):', redactBearerTokens(msg));
});
process.on('uncaughtException', (err) => {
  console.error(
    '[API] Uncaught exception — exiting for a clean restart:',
    redactBearerTokens(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );
  process.exit(1);
});

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

    // SEQUENTIAL warmup — pre-boot the system-agent runtime(s) one at a time,
    // DEFENSIVE/future-proofing (NOT the crash-loop fix — that is the process
    // guards above). Today `SYSTEM_AGENT_TEMPLATES` has exactly ONE entry
    // (town-guide/Nori), so this loop warms a single runtime; the 10 building
    // teachers are seeded as DB rows by `ensureSystemNpcs` and lazy-start on
    // first chat, NOT warmed here. Was a concurrent fire-and-forget; kept
    // sequential so that IF more system agents are added later, their warms
    // funnel one-at-a-time through the global init mutex
    // (`packages/agent-runtime/src/eliza-runtime.ts`) + plugin-sql advisory lock
    // instead of stacking pipelines whose peak contention could push a runtime's
    // ElizaOS bootstrap service-registration past its internal 30s timeout
    // (house-agent-seeder.ts defers Coralia's warm for the same reason). Detached
    // (void IIFE) so boot + /health readiness never wait on the warm chain;
    // per-agent errors swallowed (lazy-start re-warms on first chat).
    const systemUserId = await getSystemUserId();
    void (async () => {
      for (const { slug, platformAgentId } of systemAgents) {
        try {
          // ensureAgentRuntime RESOLVES null (does not throw) on a missing row /
          // start-failure / the R1 wait-return-null branch — so a bare "Warmed"
          // log would falsely claim success. Only log warm on a real runtime;
          // otherwise WARN (lazy-start re-warms on first chat).
          const runtime = await agentOrchestrator.ensureAgentRuntime(platformAgentId, systemUserId);
          if (runtime) {
            console.log(`[API] Warmed system agent runtime: ${slug}`);
          } else {
            console.warn(`[API] Warmup incomplete for ${slug} — runtime not ready (will lazy-start on first chat)`);
          }
        } catch (err) {
          console.error(`[API] Warmup failed for ${slug}:`, err);
        }
      }
    })();

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

  // Agent-metaverse P1 — activate the ONE ClawVille-hosted autonomous "house"
  // agent (warms its ElizaOS runtime, registers its in-world body, hands it to
  // the autonomy driver) then START the driver's own ~30s perceive→decide→act
  // loop. Ordered AFTER the system-NPC seeder (shares the system user + a warmed
  // runtime) and AFTER startSimulation() above (registerAgentBot needs the live
  // sim). Non-fatal: a house-agent failure must not crash boot — the world still
  // runs, just without the autonomous agent. Driver starts regardless so a later
  // (re)register still gets driven.
  try {
    const { ensureHouseAgent } = await import('./services/house-agent-seeder');
    const { agentAutonomyDriver } = await import('./services/agent-autonomy-driver');
    const house = await ensureHouseAgent();
    if (house) {
      console.log(
        `[API] House agent active: body ${house.bodyId}${house.created ? ' [new]' : ''}`,
      );
    }
    // Pre-warm the local fleet boxes so the driver's first decisions don't eat a
    // cold-load (both boxes stay warm; work is load-balanced across them). Fire-and-
    // forget + fault-tolerant — a down box just fails silently and the breaker handles
    // it. Logs the resolved endpoint/route config for boot observability.
    try {
      const { getInferenceRouter, describeInferenceConfig } = await import('@clawville/agent-runtime');
      console.log(describeInferenceConfig());
      void getInferenceRouter()
        .warmup()
        .then(() => console.log('[API] Inference local boxes warmed'))
        .catch(() => {});
    } catch (e) {
      console.warn('[API] Inference warmup skipped:', (e as Error)?.message);
    }
    agentAutonomyDriver.start();
  } catch (err) {
    console.error('[API] House agent activation failed (non-fatal):', err);
  }

  // P0 lifecycle-truth — NO eager boot-rehydration. v7 already survives a restart
  // via LAZY restore (`agent-session-restore.ts`, wired into
  // `validateLiveAgentSession`): on the first post-restart bearer use it rebuilds
  // the session under the agent's ORIGINAL bearer. An eager rehydrator minting a
  // fresh sessionId would COLLIDE with that (double body / override lockout), so
  // it is intentionally absent. session-status (D-2) is restore-aware and the
  // sweeper (D-3) removes the body on expiry.

  // Phase 6 — start the openclaw_bots session TTL sweeper. Runs every 5
  // min, reaps rows whose `session_expires_at` has passed and stops any
  // still-mounted Eliza runtimes. Without this, a disconnected Hermes /
  // OpenClaw agent row lives forever and `/api/agent/session-status`
  // keeps answering `connected: true` until someone calls the explicit
  // unregister. See `services/agent-session-sweeper.ts`.
  try {
    const { startSessionSweeper } = await import(
      './services/agent-session-sweeper'
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

  // 2026-06-24 — start the LAND RENT sweeper (builder-economics). Runs hourly,
  // charges each due weekly rent on rented parcels, opens a grace window on a
  // failed charge, and evicts after grace (parcel back to the pool, structure
  // archived). The recurring CT sink. See `services/land-rent-sweeper.ts`.
  try {
    const { startLandRentSweeper } = await import('./services/land-rent-sweeper');
    startLandRentSweeper();
  } catch (err) {
    console.error('[API] Land rent sweeper failed to start:', err);
  }

  // 2026-07-08 — start the MARKETPLACE LISTING-EXPIRY sweeper (Tokenomics C4
  // follow-up). Runs hourly, flips expired `active` land_deed listings to the
  // terminal `expired` state and RELEASES their `market_deed_locks` row, so an
  // abandoned expired listing can't hold its deed lock forever and park land's
  // rent-lapse eviction (the squatting hole once the land deed-lock guard
  // shipped). NOT a money path — no CT/CLV/USDC; safe to run live. See
  // `services/market-listing-expiry-sweeper.ts`.
  try {
    const { startMarketListingExpirySweeper } = await import(
      './services/market-listing-expiry-sweeper'
    );
    startMarketListingExpirySweeper();
  } catch (err) {
    console.error('[API] Market listing-expiry sweeper failed to start:', err);
  }

  // 2026-07-09 — custodial-wallet WITHDRAW RESUME worker, DARK-GATED: starts
  // ONLY when WALLET_WITHDRAW_ENABLED==='true' (the withdraw feature's
  // default-OFF flag), so no worker runs while the feature is dark — and none
  // is needed: 'sending' rows can only exist once the flag has been on. Each
  // tick chain-checks stale 'sending' claims FORWARD-ONLY (confirmed→sent /
  // on-chain err→failed / unresolved→reconcile; a captured signature is NEVER
  // re-signed or re-sent) and pages ops (alertError, warning severity) for
  // every row that resolves to 'reconcile'. Cadence:
  // WALLET_WITHDRAW_RESUME_POLL_MS (default 5 min, floor 60s). The worker
  // itself re-asserts the flag inside startWithdrawResumeWorker() —
  // belt-and-suspenders. See services/wallet-withdraw-executor.ts.
  try {
    if (process.env.WALLET_WITHDRAW_ENABLED === 'true') {
      const { startWithdrawResumeWorker } = await import(
        './services/wallet-withdraw-executor'
      );
      startWithdrawResumeWorker();
    }
  } catch (err) {
    console.error('[API] Wallet-withdraw resume worker failed to start:', err);
  }

  // 2026-07-10 — composed-bounty FINALIZE/PAYOUT resume worker (SAP B1 slice 3),
  // DARK-GATED: starts ONLY when the composed bounty rail is fully live
  // (SAP_ENABLED + SAP_ESCROW_ENABLED + SAP_USDC_ESCROW_ENABLED +
  // SAP_PAYAI_SETTLEMENT_ENABLED ⇒ bountySettlementRail()==='sap-payai-composed'),
  // so no worker polls a dark rail (and no awaiting_finalize/reconcile rows can
  // exist while it is off). Each pass idempotently re-drives stuck composed
  // bounties: finalize leg 1c once the dispute window elapses, then retry the
  // leg-2 hunter payout. Cadence SAP_BOUNTY_RESUME_POLL_MS (default 5 min, floor
  // 1 min). The worker re-asserts the gate inside startComposedBountyResumeWorker().
  try {
    const { bountySettlementRail } = await import('./services/bounty-escrow-link');
    if (bountySettlementRail() === 'sap-payai-composed') {
      const { startComposedBountyResumeWorker } = await import(
        './services/bounty-composition-worker'
      );
      startComposedBountyResumeWorker();
    }
  } catch (err) {
    console.error('[API] Composed-bounty resume worker failed to start:', err);
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

    // Poker CASH GAMES — HOUSE TABLES + seeded bots (2026-06-22). Order matters:
    //   1. `cashHouseSeeder.ensure()` provisions the house-bank avatar (one-time
    //      guarded bankroll mint) + the M bot avatars. MUST complete BEFORE the
    //      scaler/tick run — the scaler reads `houseBankAvatarId()` (throws until
    //      ensured) and the tick's fill claims bots from the pool.
    //   2. `startCashHouseScaler()` keeps N open house tables/tier alive (gated on
    //      CASH_HOUSE_SCALER_ENABLED; runs an immediate first pass so the lobby is
    //      populated at boot).
    //   3. `startCashTableTick()` self-drives seeded bots so a solo human + bots
    //      (or a bot-only) table keeps dealing with no human poke.
    // Non-fatal: a seeder/scaler/tick failure must not crash the whole API boot —
    // cash poker just won't have house tables until the next restart.
    try {
      const { cashHouseSeeder } = await import('./services/poker/cash-house-seeder');
      const { startCashHouseScaler } = await import('./services/poker/cash-house-scaler');
      const { startCashTableTick } = await import('./services/poker/cash-table-tick');
      await cashHouseSeeder.ensure();
      startCashHouseScaler();
      startCashTableTick();
      console.log('[API] Poker cash-house seeder + scaler + tick ready');
    } catch (err) {
      console.error('[API] Poker cash-house init failed (non-fatal):', err);
    }

    // HOUSE TREASURY (Tokenomics T0, 2026-07-07) — the named fee-sink subject.
    // `ensure()` provisions the system user + 0-CT avatar + the
    // `treasury_subjects` ('house-fees') registry row, idempotently, with NO
    // bankroll mint (pure revenue sink — contrast the cash-house bank above).
    // Every routed fee site (cove rakes, baccarat commission, MTT rake,
    // cosmetics/books, land sale/upgrade/rent) resolves the id lazily at settle
    // time via `getHouseTreasuryAvatarId()`, which self-heals by re-running
    // `ensure()` if this boot pass failed — so a failure here degrades fee
    // routing to the pre-T0 burn behavior, never blocks a player settlement,
    // and never crashes boot.
    try {
      const { houseTreasurySeeder } = await import('./services/house-treasury-seeder');
      await houseTreasurySeeder.ensure();
      console.log('[API] House-treasury seeder ready');
    } catch (err) {
      console.error(
        '[API] House-treasury init failed (non-fatal; fees burn until the lazy resolver heals):',
        err,
      );
    }

    // CLV PRICE ORACLE (Tokenomics T0, 2026-07-07) — READ-ONLY price feed.
    // Seeds the 30-min TWAP window from `clv_price_snapshots`, then polls the
    // CLV price (Helius primary → keyless DexScreener fallback) every ~60s,
    // writing a snapshot row + refreshing an in-memory spot/TWAP cache behind
    // `getClvPrice()`. Fire-and-forget: a fetch/DB failure logs + degrades to
    // last-known, never crashes boot. Read surface: GET /api/oracle/clv (admin).
    // Never touches `avatars.clawTokens` or the ledger — all values are USD.
    try {
      const { startClvPriceOracle } = await import('./services/clv-price-oracle');
      startClvPriceOracle();
      console.log('[API] CLV price oracle started');
    } catch (err) {
      console.error('[API] CLV price oracle init failed (non-fatal):', err);
    }

    // CLV SWAP WORKER (Tokenomics C3 + GoLive executors; CONDITIONAL wiring,
    // Codex re-review 2026-07-08). Default (CLV_SWAP_EXECUTE unset/false): the
    // DRY-RUN worker scans `clv_buy_queue` planned rows and LOGS the clip plan
    // it WOULD execute — NO signing, NO tx, NO row mutation. With
    // CLV_SWAP_EXECUTE='true': the LIVE worker (clv-swap-live.ts) is selected
    // instead. TODAY the live branch is UNREACHABLE — the module-load throw in
    // clv-swap-executor.ts (static import above) already refused boot under
    // the flag — so this wiring is dark-safe. AFTER the Codex-reviewed go-live
    // change (remove ONLY that module-load throw), the flag cleanly selects
    // the live worker here instead of crash-looping the whole API on the
    // dry-run worker's `assertNoLiveClvSwapExecution()` gate.
    try {
      if (process.env.CLV_SWAP_EXECUTE === 'true') {
        const { startClvSwapLiveWorker } = await import('./services/clv-swap-live');
        startClvSwapLiveWorker();
        console.log('[API] CLV swap LIVE worker started (CLV_SWAP_EXECUTE=true)');
      } else {
        startClvSwapWorker();
        console.log('[API] CLV swap dry-run worker started');
      }
    } catch (err) {
      if ((err as Error)?.message?.includes('Codex-review-gated')) {
        console.error('[API] FATAL:', (err as Error).message);
        process.exit(1);
      }
      console.error('[API] CLV swap worker init failed (non-fatal):', err);
    }
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
    // Agent-metaverse P1 — stop the autonomy driver's 30s loop.
    try {
      const { agentAutonomyDriver } = await import('./services/agent-autonomy-driver');
      agentAutonomyDriver.stop();
    } catch {
      // If the driver module failed to load earlier, there's nothing to stop.
    }
    activityRoomManager.stopSweeper();
    activityQueueService.stopMatchmaker();
    tournamentManager.stopStartTriggerSweeper();
    // Poker cash-house intervals (scaler + self-drive tick). Import inside the
    // handler so a failed import doesn't crash shutdown; both stops are idempotent.
    try {
      const { stopCashHouseScaler } = await import('./services/poker/cash-house-scaler');
      const { stopCashTableTick } = await import('./services/poker/cash-table-tick');
      stopCashHouseScaler();
      stopCashTableTick();
    } catch {
      // If the modules failed to load earlier, there's nothing to stop.
    }
    try {
      const { stopSessionSweeper } = await import(
        './services/agent-session-sweeper'
      );
      stopSessionSweeper();
    } catch {
      // If the sweeper module failed to load earlier, there's nothing to stop.
    }
    try {
      const { stopLandRentSweeper } = await import('./services/land-rent-sweeper');
      stopLandRentSweeper();
    } catch {
      // If the sweeper module failed to load earlier, there's nothing to stop.
    }
    try {
      const { stopMarketListingExpirySweeper } = await import(
        './services/market-listing-expiry-sweeper'
      );
      stopMarketListingExpirySweeper();
    } catch {
      // If the sweeper module failed to load earlier, there's nothing to stop.
    }
    try {
      // Withdraw resume worker — idempotent no-op when the withdraw flag was
      // off and the worker never started.
      const { stopWithdrawResumeWorker } = await import(
        './services/wallet-withdraw-executor'
      );
      stopWithdrawResumeWorker();
    } catch {
      // If the executor module failed to load earlier, there's nothing to stop.
    }
    try {
      // Composed-bounty resume worker — idempotent no-op when the composed rail
      // was dark and the worker never started.
      const { stopComposedBountyResumeWorker } = await import(
        './services/bounty-composition-worker'
      );
      stopComposedBountyResumeWorker();
    } catch {
      // If the module failed to load earlier, there's nothing to stop.
    }
    try {
      const { stopClvPriceOracle } = await import('./services/clv-price-oracle');
      stopClvPriceOracle();
    } catch {
      // If the oracle module failed to load earlier, there's nothing to stop.
    }
    // Tokenomics C3 + GoLive — stop whichever CLV swap worker boot selected
    // (dry-run statically imported; the LIVE module is imported only when the
    // flag selected it — mirror the boot condition). Both stops idempotent.
    try {
      if (process.env.CLV_SWAP_EXECUTE === 'true') {
        const { stopClvSwapLiveWorker } = await import('./services/clv-swap-live');
        stopClvSwapLiveWorker();
      }
      stopClvSwapWorker();
    } catch {
      // Nothing to stop.
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
