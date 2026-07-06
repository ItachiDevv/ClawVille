# Add a service under `apps/api/src/services/`

Services are the production dependencies that route handlers compose against. New services should be:

- Pure-ish (depend on `db` + other services, not on Hono context)
- Idempotent on retry where reasonable
- Either synchronous on the wire (sub-50ms) OR fire-and-forget (e.g. `event-logger`)

## Steps

1. **Create the file** at `apps/api/src/services/<service-name>.ts`. Pattern:
   ```ts
   import { db } from '@clawville/database';

   export async function myServiceFunction(args: MyArgs): Promise<MyResult> {
     // ...
   }
   ```
2. **No singletons by default.** Prefer exporting plain functions. Use a top-level `Map` only for in-process caches (e.g. `system-agent-reward-limiter`, `auth-challenge`) — migrate to Redis when we go multi-pod.
3. **Wire into the route(s) that need it.** Services are composed in route handlers, not auto-mounted.
4. **If it runs at boot** (sweepers, seeders, migrators): register it in `apps/api/src/index.ts`. Wire into `gracefulShutdown` if it has state to flush.
5. **If it emits events:** use `event-logger.logEvent({...})`. Don't write to the `events` table directly.
6. **Typecheck:** `cd apps/api && bun x tsc --noEmit -p tsconfig.json && echo OK`.
7. **Ship** via [`ship-a-feature.md`](./ship-a-feature.md).

## Doc updates required (same diff)

- [ ] **`ARCHITECTURE.md §4`** — add a row to the service catalog with a 1-2 sentence description of what the service does + its env requirements if any.
- [ ] **`ARCHITECTURE.md §5a`** — if the service emits new event types.
- [ ] **`ARCHITECTURE.md §8`** — if the service introduces a new DB column / table.
- [ ] **`CLAUDE.md` path → doc matrix** — add a row if this becomes a load-bearing service.

## Watch out for

- **`claw-token-ledger.transferClawTokens()`** is the ONLY approved write path for ClawToken movements. If your service moves tokens, route through this — never write `avatars.clawTokens` directly.
- **`keypair-vault`** for encrypted secrets. v1 = legacy direct, v2 = envelope (per-row DEK wrapped by Cloudflare KEK). New writes always go to v2. Use the `decryptWalletRow(row)` dispatcher.
- **`system-npc-seeder`** is run on boot. If you add a new boot-time idempotent step, add it to the same seeder rather than spawning a parallel one.
- **`event-logger`** never throws by design. Three-tier fallback (`events` → `event_write_failures` → console + Telegram). Don't wrap it in try/catch.
- **Single-pod assumptions:** several services use module-scope `Map` for in-memory caches. If you add another, document the assumption and the migration path to Redis (see `ARCHITECTURE.md §4` entries flagged "single-pod only").
