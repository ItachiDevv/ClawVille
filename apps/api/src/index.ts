import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth';
import { avatarRoutes } from './routes/avatars';
import { userRoutes } from './routes/users';
import { locationRoutes } from './routes/locations';
import { chatRoutes } from './routes/chat';
import { transientChatRoutes } from './routes/chat-transient';
import { itemRoutes } from './routes/items';
import { npcRoutes } from './routes/npc-sse';
import { openclawRoutes } from './routes/openclaw';
import { activityRoutes } from './routes/activity';
import { activitiesV2Routes } from './routes/activities';
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
import { adminIdentityRoutes } from './routes/admin-identity';
import { startSimulation } from './services/npc-simulation';
import { alertError } from './services/alert-error';
import { getPublishedIssuerInfo } from './services/service-issuer';
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
// Phase 6.5.0 — cove Texas Hold'em mock route (visual shell, no engine yet).
import { coveHoldemRouter } from './routes/cove-holdem';
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
// Gemini for NPC mode (controlMode === 'npc') talking to nearby wanderers.
// No Eliza, no rooms, no DB writes. See routes/chat-transient.ts for why.
app.route('/api/chat/transient', transientChatRoutes);
app.route('/api/items', itemRoutes);
app.route('/api/cosmetics', cosmeticsRoutes);
app.route('/api/dash-auth', dashAuthRoutes);
app.route('/api/npc', npcRoutes);
app.route('/api/openclaw', openclawRoutes);
app.route('/api/avatars', activityRoutes);
// Q2 Activity Portals — chunk #2 backend skeleton (REST routes; WS hub
// + sim land in chunk #3). Mount path mirrors the Q2 plan §"API routes".
app.route('/api/activities', activitiesV2Routes);
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
app.route('/api/dashboard', dashboardRoutes);
// Phase 5.1 — cross-world portal + account linking (see plan §6.2 + §15).
app.route('/api/portal', portalRoutes);
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

    await activityRoomManager.recoverOrphanedRooms();
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
    console.log('[API] Activity room manager + queue ready');
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
