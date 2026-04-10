import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { authRoutes } from './routes/auth';
import { avatarRoutes } from './routes/avatars';
import { locationRoutes } from './routes/locations';
import { chatRoutes } from './routes/chat';
import { itemRoutes } from './routes/items';
import { npcRoutes } from './routes/npc-sse';
import { openclawRoutes } from './routes/openclaw';
import { activityRoutes } from './routes/activity';
import { researchSseRoutes } from './routes/research-sse';
import { researchApiRoutes } from './routes/research';
import { marketplaceRoutes } from './routes/marketplace';
import { clawRoutes } from './routes/claws';
import { agentGatewayRoutes } from './routes/agent-gateway';
import { bazaarRoutes } from './routes/bazaar';
import { auctionRoutes } from './routes/auctions';
import { questRoutes } from './routes/quests';
import { bountyRoutes } from './routes/bounties';
import { agentSetupRoutes } from './routes/agent-setup';
import { skillsRoutes } from './routes/skills';
import { startSimulation } from './services/npc-simulation';
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
      if (origin?.startsWith('http://localhost:')) return origin;
      return allowedOrigins[0];
    },
    credentials: true,
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/avatars', avatarRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/locations', chatRoutes);
app.route('/api/items', itemRoutes);
app.route('/api/npc', npcRoutes);
app.route('/api/openclaw', openclawRoutes);
app.route('/api/avatars', activityRoutes);
app.route('/api/research', researchSseRoutes);
app.route('/api/research', researchApiRoutes);
app.route('/api/marketplace', marketplaceRoutes);
app.route('/api/claws', clawRoutes);
app.route('/api/agent', agentGatewayRoutes);
app.route('/api/bazaar', bazaarRoutes);
app.route('/api/auctions', auctionRoutes);
app.route('/api/quests', questRoutes);
app.route('/api/bounties', bountyRoutes);
app.route('/api/agent-setup', agentSetupRoutes);
app.route('/api/skills', skillsRoutes);

// Error handler
app.onError((err, c) => {
  console.error('API Error:', err);
  if (err instanceof HTTPException) {
    return c.json({ error: err.message, code: err.status }, err.status);
  }
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
