// FEATURE_GATE: doordash_operator_beta
// Status: founder-only DoorDash ordering from the in-game chat box. Gated to
//   DOORDASH_OPERATOR_USER_ID intersected with ADMIN_USER_IDS. Every other
//   caller resolves to no capability. Runs on the founder's real DoorDash
//   account and card (founder ruling 2026-09-16). Dark on any box without the
//   /opt/ddcli bind-mount.
// Metric to graduate: >= 10 successful submits by the operator across >= 3
//   distinct UTC days, with zero unintended orders
//   (count doordash_orders WHERE status='submitted').
// Current reading: historical evidence records one submitted order on 2026-09-18;
//   the current production count is not measured by the 2026-09-22 source audit.
// Review deadline: 2026-11-16.
// On deadline: if the metric is not met, DELETE the routes, the actions, the
//   wrapper, the bind-mount and the env vars. Do not extend without a new
//   metric reading. The DD_CLI_ACCESS_TOKEN re-export burden is the reason
//   this gate is short.
// Reference: .claude/plans/doordash-cli-integration.md

import { Hono } from 'hono';
import { sessionMiddleware } from '../middleware/auth';
import { doordashOperatorOnly, type DoordashOperatorContext } from '../middleware/doordash-operator-only';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { doordashDarkState, isDoordashAvailable, runDdCli } from '../services/doordash-cli';

export const doordashRoutes = new Hono<DoordashOperatorContext>();
const healthLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

doordashRoutes.get('/health', noStorePrivate, sessionMiddleware, doordashOperatorOnly, async (c) => {
  if (!healthLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // An explicit version probe can recover the latch; do not pre-gate on availability.
  const probe = await runDdCli<{ version: string }>('version', []);
  return c.json({
    available: isDoordashAvailable(),
    ...doordashDarkState(),
    binVersion: probe.ok ? probe.data.version : null,
  });
});
