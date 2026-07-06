# Add a Hono route

## Steps

1. **Create the route file** at `apps/api/src/routes/<route-name>.ts`. Pattern (see `auth.ts`, `avatars.ts`, `chat.ts` for reference):
   ```ts
   import { Hono } from 'hono';
   import { db } from '@clawville/database';
   import { requireAuth } from '../middleware/auth';

   export const myRoutes = new Hono();

   myRoutes.post('/path', requireAuth, async (c) => {
     // ...
   });
   ```
2. **Mount it** in `apps/api/src/index.ts` (or wherever your sibling routes get mounted).
3. **Zod-validate every input.** No exceptions. Use `c.req.valid('json')` after a `zValidator('json', schema)` middleware, or parse manually with `schema.parse(await c.req.json())`.
4. **Resolve `c.get('user')` / `c.get('session')`** for auth'd routes. They're populated by the global `sessionMiddleware`. `requireAuth` does the 401 throw if missing.
5. **Emit an event if user-meaningful.** Call `logEvent({ eventType, userId, agentId, avatarId, buildingId, sessionId, payload })`. The event lands in the `events` table and surfaces on `/dash`.
6. **Rate limit if public.** Use `createRateLimiter()` from `apps/api/src/middleware/rate-limit.ts`. Public endpoints: per-IP. Lucia-authed endpoints can be per-user (see the Phase 5.1 follow-on todo).
7. **Typecheck on the API side:**
   ```bash
   cd apps/api && bun x tsc --noEmit -p tsconfig.json && echo OK
   ```
8. **Ship** via [`ship-a-feature.md`](./ship-a-feature.md).

## Doc updates required (same diff)

- [ ] **`ARCHITECTURE.md §2`** — add a row to the route table. Mention auth, rate limit, payload shape if non-obvious.
- [ ] **`ARCHITECTURE.md §3`** — only if you added or changed middleware.
- [ ] **`ARCHITECTURE.md §5a`** — only if you added a new event type via `logEvent({...})`. New event types might also need a row in **`§5b`** if they're leaderboard-relevant.
- [ ] **`ARCHITECTURE.md §8`** — only if the route writes to a new DB column / table.
- [ ] **`GameFeatures.md §X`** — if the route powers a player-facing flow (modes / economy / quests / portal / activities), update the matching gameplay section.
- [ ] **`CLAUDE.md` path → doc matrix** — add a row if the new route file becomes a "go-to" path that future doc updates should reference.

## Watch out for

- Next 15+ async APIs: `cookies()`, `headers()`, `params` are async. `.toString()` on a Promise silently yields `"[object Promise]"`. Always `await` first.
- Coolify does NOT run migrations. If you added a new schema file under `packages/database/src/schema/*.ts`, run `bun run db:push` from root BEFORE pushing the route change. See `ARCHITECTURE.md §12`.
- Paused write paths: `bazaar.ts`, `marketplace.ts`, `auctions.ts` return 503 on POST/PUT/PATCH/DELETE. Don't accidentally un-pause them — that's a feature-gate decision, not a casual route change.
