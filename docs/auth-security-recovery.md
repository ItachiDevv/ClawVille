# Auth + Money Path — Security Recovery Playbook

> Last updated 2026-05-22 in the same diff that fixed the cookie-domain split-brain (`apps/api/src/lib/auth.ts` + `apps/web/src/lib/auth.ts`) and instrumented the previously-unlogged exchange + auth state-transitions.

This doc answers "if X went wrong, how do we recover" for the four highest-risk failure modes on ClawVille's auth + money paths. It is the recovery counterpart to `ARCHITECTURE.md §6` (agent connection), `§7` (Phase 5.1 wallet identity), and `§8` (schema). Every query below targets the `events` table from `packages/database/src/schema/events.ts` — the canonical audit spine. The supplementary `claw_token_transactions` ledger (`packages/database/src/schema/...` via `services/claw-token-ledger.ts`) is the per-CT-cent truth for ClawTokens specifically; SOL/USDC flows live in `lobby_events` (wager program) and the on-chain log.

---

## 1. Background — the split-brain that triggered this doc

**2026-05-22 incident.** A logged-in user (`RenameTester`, `user_id=30a1dc7d-ec42-458b-88e8-0f17155fd731`) reported the developer console showing `clawville.world/api/auth/me → 401` while the page UI was fully authenticated. Root cause:

- ClawVille runs two Lucia backends:
  - **Hono API** at `api.clawville.world` (`apps/api/src/lib/auth.ts`)
  - **Next.js** at `clawville.world` (`apps/web/src/lib/auth.ts`)
- Both read/write the same `sessions` table (Drizzle adapter, same DB).
- Neither set `domain=` on the Lucia session cookie ⇒ both issued **host-only** cookies scoped to whichever origin minted the cookie.
- The canonical signup/login path (`apps/web/src/lib/api.ts → api.signup / api.login`) hits `api.clawville.world`, so the resulting cookie was only sent back to `api.*`.
- Any Next.js route on `clawville.world` that called `validateSession()` found no cookie ⇒ 401, even though the user was fully authenticated.

**Fix shipped in this diff:** in production (`NODE_ENV=production`) both Lucia configs now set `domain: '.clawville.world'` (overridable via `SESSION_COOKIE_DOMAIN` env var for staging). Dev keeps host-only so localhost:3000 and localhost:4000 stay isolated. **Cookies issued before this deploy remain host-only** until they expire or are rotated by a fresh-cookie response; no destructive forced-logout was applied.

The lesson driving the rest of this doc: **without comprehensive audit logging, we couldn't have proven who was affected.** The recovery queries below assume the new event types added in this diff (`auth.login`, `auth.logout`, `auth.signup`, `auth.login.failed`, `auth.magic_link.enter`, `auth.password.reset`, `auth.guest.created`, `auth.milady_session.exchanged`, `exchange.listing.created`, `exchange.order.placed/.submitted/.confirmed/.cancelled`, `exchange.listing.cancelled`) plus the existing money emitters (`wager.lobby.*`, `cosmetic.purchased/.equipped/.unequipped`, `cove.slots.session.*`, `item.purchased`, `portal.scape.*`).

---

## 2. Scenario A — "A route was unprotected from date X to date Y. Which actions happened?"

Suppose CodeReview discovers that `POST /api/foo` was missing `requireAuth` for a window. To enumerate every action that touched the route:

```sql
-- All events from a leaky route in the affected window. The `route`
-- field is set on every event emitter we added in 2026-05-22+. For
-- pre-2026-05-22 events the route is inferred from event_type.
SELECT
  e.ts,
  e.user_id,
  e.avatar_id,
  e.agent_id,
  e.session_id,
  e.event_type,
  e.fp_hash,
  e.ip_prefix_hash,
  e.payload->>'route'        AS route,
  e.payload->>'outcome'      AS outcome,
  e.payload->>'beforeBalance' AS before_ct,
  e.payload->>'afterBalance'  AS after_ct,
  e.payload                   AS full_payload
FROM events e
WHERE e.payload->>'route' LIKE '%/api/foo%'
  AND e.ts >= $1::timestamptz  -- start of leak window
  AND e.ts <  $2::timestamptz  -- end of leak window
ORDER BY e.ts ASC;
```

To get a unique-actor count by fingerprint (which captures even unauth callers — fp_hash is set even when user_id is null):

```sql
SELECT
  COALESCE(e.user_id::text, 'unauth:' || e.fp_hash, 'unknown') AS actor,
  COUNT(*) AS event_count,
  MIN(e.ts) AS first_seen,
  MAX(e.ts) AS last_seen,
  COUNT(DISTINCT e.ip_prefix_hash) AS distinct_ip_prefixes
FROM events e
WHERE e.payload->>'route' LIKE '%/api/foo%'
  AND e.ts >= $1 AND e.ts < $2
GROUP BY actor
ORDER BY event_count DESC;
```

**Remediation steps** once the actor list is known:

1. If any row is `outcome != 'success'`, that's noise — drop it from the affected set.
2. Cross-reference `user_id` against `users.created_at` — accounts created INSIDE the leak window with no prior activity are the highest-risk (sock puppets).
3. For each affected `user_id`, query `claw_token_transactions WHERE avatar_id IN (SELECT id FROM avatars WHERE user_id = $1)` to enumerate every CT move during the leak. Total the deltas — that's the exposure in ClawTokens.
4. For SOL/USDC paths (only `/api/wager/*` today), additionally pull `lobby_events WHERE created_at BETWEEN $1 AND $2 AND actor_user_id = $userId` and the chain explorer for `tx_sig`.

---

## 3. Scenario B — "User reports balance is wrong. Reconstruct the chain."

The single canonical query — chronological full history of every CT debit/credit, with the session_id that triggered each:

```sql
WITH avatar_for_user AS (
  SELECT id, name, claw_tokens, user_id
  FROM avatars
  WHERE user_id = $1 AND is_active = true
),
ledger AS (
  SELECT
    t.created_at,
    t.kind,                -- 'credit' | 'debit'
    t.amount,
    t.reason,
    t.source,
    t.metadata,
    t.balance_after,
    a.name AS avatar_name
  FROM claw_token_transactions t
  JOIN avatar_for_user a ON a.id = t.avatar_id
),
event_corr AS (
  -- Try to correlate each ledger row to the events row that triggered
  -- it. Heuristic: same avatar_id, ts within +/- 2s, event_type
  -- references the same `reason` (`buy_book` ↔ `item.purchased`,
  -- `buy_cosmetic` ↔ `cosmetic.purchased`, etc.).
  SELECT
    l.created_at         AS ledger_ts,
    l.kind,
    l.amount,
    l.reason,
    l.source,
    l.balance_after,
    e.id                 AS event_id,
    e.event_type,
    e.session_id,
    e.fp_hash,
    e.ip_prefix_hash,
    e.payload->>'route'  AS route,
    e.payload            AS event_payload
  FROM ledger l
  LEFT JOIN LATERAL (
    SELECT *
    FROM events ev
    WHERE ev.avatar_id = (SELECT id FROM avatar_for_user)
      AND ev.ts BETWEEN l.created_at - interval '2 seconds'
                   AND l.created_at + interval '2 seconds'
    ORDER BY ABS(EXTRACT(EPOCH FROM (ev.ts - l.created_at)))
    LIMIT 1
  ) e ON TRUE
)
SELECT * FROM event_corr ORDER BY ledger_ts ASC;
```

Output columns let support read off:
- `ledger_ts` — when the CT moved
- `kind / amount / reason` — what happened
- `balance_after` — running CT total (cross-check against `avatars.claw_tokens` on the most recent row)
- `session_id / fp_hash / ip_prefix_hash` — which session triggered it
- `route` — which endpoint
- `event_payload` — full JSONB context

If the user has multiple historical avatars (rare — `avatars.userId` is unique, but `is_active = false` rows exist), drop the `is_active = true` filter and `GROUP BY` on avatar.

For SOL/USDC reconciliation, add a parallel query on `lobby_events`:

```sql
SELECT le.created_at, le.kind, le.tx_sig, le.raw_event_json, l.activity_id, l.wager_amount_lamports
FROM lobby_events le
JOIN lobbies l ON l.id = le.lobby_id
WHERE le.actor_user_id = $1
   OR le.lobby_id IN (
     SELECT lobby_id FROM lobby_players WHERE user_id = $1
   )
ORDER BY le.created_at ASC;
```

---

## 4. Scenario C — "Session theft suspected. List every action by that session_id."

```sql
-- Step 1: pull every event keyed on this session_id (includes
-- chat turns, money moves, building visits, anything that called
-- logEventFromContext).
SELECT
  e.ts,
  e.event_type,
  e.user_id,
  e.avatar_id,
  e.ip_prefix_hash,
  e.fp_hash,
  e.payload->>'route' AS route,
  e.payload
FROM events e
WHERE e.session_id = $1
ORDER BY e.ts ASC;

-- Step 2: distinct IP prefixes the session was used from. A "good"
-- session usually has 1-2 distinct prefixes (home + mobile); a
-- stolen session often shows 3+ within hours.
SELECT
  e.ip_prefix_hash,
  COUNT(*) AS event_count,
  MIN(e.ts) AS first_seen,
  MAX(e.ts) AS last_seen
FROM events e
WHERE e.session_id = $1
GROUP BY e.ip_prefix_hash
ORDER BY event_count DESC;

-- Step 3: distinct fp_hashes — a stolen cookie pasted into another
-- browser produces a DIFFERENT fingerprint than the legit owner.
SELECT
  e.fp_hash,
  COUNT(*) AS event_count,
  MIN(e.ts) AS first_seen,
  MAX(e.ts) AS last_seen
FROM events e
WHERE e.session_id = $1
GROUP BY e.fp_hash
ORDER BY event_count DESC;
```

**Invalidation flow:**

```sql
-- Kill THIS session only (other devices stay logged in).
DELETE FROM sessions WHERE id = $1;

-- Or: kill EVERY session for a user (the "I lost my laptop" button).
DELETE FROM sessions WHERE user_id = $1;
```

Equivalent via the Hono API (preferred when accessible) — `lucia.invalidateSession(id)` or `lucia.invalidateUserSessions(userId)`. The `/api/auth/reset-password` flow already calls `invalidateUserSessions` so a password reset is the user-visible nuclear option.

If you suspect a route was used to issue duplicate sessions (cookie domain bug variant), pair the session_id list with the user_id:

```sql
SELECT s.id, s.user_id, s.expires_at, u.email
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.user_id = $1
ORDER BY s.expires_at DESC;
```

Real cookies will have one row per active device; >5 rows with no recent activity on most of them is a smell.

---

## 5. Scenario D — "We shipped a login regression. Detect users on wrong sessions and force re-login."

This is the recovery path for "Lucia adapter bug attached session N to user M instead of user N" or "the cookie-domain fix temporarily caused dual sessions." Detection signal: a session whose `fp_hash` history diverges sharply from the user's prior fp_hashes.

```sql
-- For each currently-active session, count distinct fp_hashes
-- observed for that user across ALL their events (lifetime). If the
-- session's current fp_hash is new (not in the lifetime set), the
-- session is suspect.
WITH user_fps AS (
  SELECT user_id, fp_hash, COUNT(*) AS hit_count, MIN(ts) AS first_seen
  FROM events
  WHERE user_id IS NOT NULL AND fp_hash IS NOT NULL
  GROUP BY user_id, fp_hash
),
session_fps AS (
  SELECT
    e.session_id,
    e.user_id,
    e.fp_hash,
    MAX(e.ts) AS last_seen
  FROM events e
  WHERE e.session_id IS NOT NULL
    AND e.user_id IS NOT NULL
    AND e.fp_hash IS NOT NULL
    AND e.ts >= now() - interval '7 days'
  GROUP BY e.session_id, e.user_id, e.fp_hash
)
SELECT
  sf.session_id,
  sf.user_id,
  sf.fp_hash AS current_fp,
  sf.last_seen,
  uf.hit_count AS lifetime_hits_for_this_fp,
  uf.first_seen AS first_time_user_used_this_fp
FROM session_fps sf
LEFT JOIN user_fps uf
  ON uf.user_id = sf.user_id AND uf.fp_hash = sf.fp_hash
WHERE uf.hit_count IS NULL OR uf.hit_count < 3   -- fp brand-new or used <3x
ORDER BY sf.last_seen DESC;
```

**Force re-login flow** for the suspicious set:

```sql
-- ONE-OFF — kill flagged sessions. Wrap in a transaction so a partial
-- run can be rolled back if the flagged set is too large.
BEGIN;
DELETE FROM sessions
WHERE id IN (
  SELECT sf.session_id
  FROM session_fps sf  -- as defined above
  LEFT JOIN user_fps uf
    ON uf.user_id = sf.user_id AND uf.fp_hash = sf.fp_hash
  WHERE uf.hit_count IS NULL OR uf.hit_count < 3
);
COMMIT;
```

Browsers receive 401 on the next API call, hit the `/?error=...` redirect, and complete the standard login flow. Users who legitimately got a new fingerprint (new browser, new device) are forced through one extra login — acceptable cost vs the false-positive risk of letting a hijacked session continue.

**Proactive monitoring** — alert when `auth.login.failed` events spike for a single `user_id`:

```sql
SELECT user_id, COUNT(*) AS fails_15min
FROM events
WHERE event_type = 'auth.login.failed'
  AND user_id IS NOT NULL
  AND ts >= now() - interval '15 minutes'
GROUP BY user_id
HAVING COUNT(*) >= 5;
```

Five failed logins for a single user in 15 minutes ⇒ credential stuffing attempt. Trigger `lucia.invalidateUserSessions($userId)` defensively and email the user.

---

## 6. Standing recovery contacts + runbook entry points

| Need | Where |
|---|---|
| Production DB shell | `ssh root@$PROD_VPS_IP` (uses `~/.ssh/clawville_hillsboro` via Windows ssh-agent — post-2026-05-23 migration), then `docker exec -it coolify-db psql -U coolify -d coolify` (Coolify DB — NOT the ClawVille app DB). For ClawVille DB: connection string in Coolify env (single Supabase instance shared prod+staging), run `psql $DATABASE_URL` from your local machine. Staging box: `ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP`. |
| Tinker recipes | `CLAUDE.md` "Coolify SSH Operations" section |
| Event taxonomy | `apps/api/src/services/event-logger.ts` |
| Money ledger source | `apps/api/src/services/claw-token-ledger.ts` |
| Wager program client | `apps/api/src/services/wager-program-client.ts` |
| Telegram alert path | `apps/api/src/services/alert-error.ts` (fires to `ITACHI_DEBUG_*`) |

---

## 7. What this doc deliberately does NOT cover

- **On-chain rollback** of a settled wager — not possible. The Solana program is the source of truth; off-chain compensation only.
- **PII redaction** of historical events — events are append-only and we don't currently support targeted deletion (GDPR vs. anti-farm forensics tradeoff is unresolved; see `improvements.md` §pending).
- **Cookie revocation by domain** — once Cloudflare's edge serves a Set-Cookie response, the cookie lives client-side until expiry or until a same-domain Set-Cookie overwrites it. Server-side `DELETE FROM sessions` invalidates the session but the cookie itself can't be forcibly purged.

---

*This doc was written as part of the 2026-05-22 auth+money audit. If you're updating it, also update `ARCHITECTURE.md §7` for any new auth flow that needs a recovery path.*
