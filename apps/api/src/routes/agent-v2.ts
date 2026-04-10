/**
 * Phase 4 demo endpoints behind the x402 Solana paywall.
 *
 * These routes are registered under `/api/v2/agent/*` and gated by the
 * `X402_ENABLED` env var. When disabled (default), the routes still exist but
 * the paymentMiddleware is not attached — so a plain GET returns the payload
 * without any 402 dance. This lets us iterate on the request/response shape
 * locally before flipping the paywall on in prod.
 *
 * NOTE: No production endpoint (building shops, NPC chat, agent connect) is
 * touched by this file. Existing agent/gateway/skills APIs remain free.
 */

import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import type { AppContext } from '../types';
import { loadX402Config, buildX402ResourceServer, buildX402Routes } from '../services/x402-config';

export const agentV2Routes = new Hono<AppContext>();

const x402Config = loadX402Config();

if (x402Config.enabled) {
  const resourceServer = buildX402ResourceServer(x402Config);
  if (resourceServer) {
    const routes = buildX402Routes(x402Config);
    agentV2Routes.use('*', paymentMiddleware(routes, resourceServer));
    console.log(
      `[x402] Paywall ENABLED on /api/v2/agent/* — merchant=${x402Config.merchantWalletPubkey.slice(0, 8)}... network=${x402Config.network}`,
    );
  }
} else {
  console.log('[x402] Paywall DISABLED (set X402_ENABLED=true to activate).');
}

agentV2Routes.get('/ping', (c) => {
  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    merchant: x402Config.merchantWalletPubkey || null,
    network: x402Config.network,
    x402Enabled: x402Config.enabled,
  });
});
