import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth';
import { petRoutes } from './routes/pets';
import { locationRoutes } from './routes/locations';
import { chatRoutes } from './routes/chat';
import { itemRoutes } from './routes/items';
import { npcRoutes } from './routes/npc-sse';
import { openclawRoutes } from './routes/openclaw';
import { activityRoutes } from './routes/activity';
import { activitiesV2Routes } from './routes/activities';
import { activityRoomManager } from './services/activity/activity-room-manager';
import { activityQueueService } from './services/activity/activity-queue';
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
import type { AppContext } from './types';

const app = new Hono<AppContext>();

// Global middleware
app.use('*', logger());
app.use('*', secureHeaders());
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
app.route('/api/pets', petRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/locations', chatRoutes);
app.route('/api/items', itemRoutes);
app.route('/api/npc', npcRoutes);
app.route('/api/openclaw', openclawRoutes);
app.route('/api/pets', activityRoutes);
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
app.route('/api/leaderboard', leaderboardRoutes);
app.route('/api/agent-setup', agentSetupRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/v2/agent', agentV2Routes);
app.route('/api/dashboard', dashboardRoutes);
// Phase 5.1 — cross-world portal + account linking (see plan §6.2 + §15).
app.route('/api/portal', portalRoutes);
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
    const { ensureElizaMigrated } = await import('./services/eliza-migrator');
    const migrated = await ensureElizaMigrated();
    if (migrated.ok) {
      console.log('[API] ElizaOS schema ready');
    } else {
      console.error('[API] ElizaOS migration failed:', migrated.error);
    }
  } catch (err) {
    console.error('[API] ElizaOS migration crashed:', err);
  }

  try {
    const { ensureSystemNpcs } = await import('./services/system-npc-seeder');
    const results = await ensureSystemNpcs();
    const withSkills = results.filter((r) => r.skillLoaded).length;
    const totalChunks = results.reduce((sum, r) => sum + r.knowledgeChunks, 0);
    console.log(
      `[API] Seeded ${results.length} system NPCs (${withSkills} with compiled SKILL.md, ${totalChunks} knowledge chunks)`,
    );
  } catch (err) {
    console.error('[API] System NPC seeder failed:', err);
  }

  // Q2 Activity Portals — recover orphaned LIVE/COUNTDOWN rooms (pod
  // crash recovery per backend §12.1), hydrate persisted queue entries,
  // then start the room sweeper + matchmaker intervals. Order matters:
  // recovery must finish before the sweeper runs so it doesn't try to
  // GC rows the recovery is mid-update on.
  try {
    await activityRoomManager.recoverOrphanedRooms();
    await activityQueueService.hydrateFromDb();
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
    await Promise.allSettled([
      npcSimulation.petAutonomyManager.shutdown(),
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

export default {
  port,
  fetch: app.fetch,
};
