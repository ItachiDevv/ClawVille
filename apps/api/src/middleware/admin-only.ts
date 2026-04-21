/**
 * Admin-only middleware for /api/dashboard/* and other internal surfaces.
 *
 * Gated by the ADMIN_USER_IDS env var — a comma-separated allowlist of
 * user UUIDs. Runs AFTER sessionMiddleware so `c.get('user')` is populated.
 *
 * Returns 401 when the caller isn't logged in, 403 when they are logged in
 * but not on the allowlist. Distinct codes make deploy-time debugging
 * easier (401 = cookie issue, 403 = env var issue).
 *
 * Parsing happens at module load: ADMIN_IDS is computed once from the env
 * var. Changing the allowlist requires a redeploy to take effect.
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types';

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const adminOnly = createMiddleware<AppContext>(async (c, next) => {
  const user = c.get('user');

  if (!user) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  if (!ADMIN_IDS.includes(user.id)) {
    throw new HTTPException(403, { message: 'Admin access required' });
  }

  await next();
});
