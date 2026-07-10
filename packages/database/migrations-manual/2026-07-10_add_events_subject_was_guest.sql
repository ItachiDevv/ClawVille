-- 2026-07-10 — DURABLE guest stamp on the events spine.
--
-- Freezes the subject's guest-ness on each event at write time so the free-agent
-- leaderboard (buildAgentSnapshot in apps/api/src/routes/leaderboard.ts) can
-- exclude guests EVEN AFTER ownership changes — a bot rebind via /connect or a
-- guest-account delete — which the live `is_guest` flag-join alone cannot
-- survive (events.agent_id is immutable TEXT; user_id/avatar_id are ON DELETE
-- SET NULL). Guest-ness is anchored on the SoT users.is_guest.
--
-- ⚠️ DEPLOY ORDERING — TWO hard constraints:
--   (1) APPLY THIS MIGRATION *BEFORE* deploying this branch's code: event-logger
--       writes the `subject_was_guest` column on every insert and
--       buildAgentSnapshot READS it — code before the column would send events
--       to `event_write_failures` and 500 the leaderboard query.
--   (2) The companion branch `fix/guest-owned-agent-real-ct` (auth-identity-
--       session, @ 05416424) — which makes connect-token 403 guests, demotes
--       guest-owned agent sessions, and gates requireNonGuestIdentity for AGENT
--       identities — MUST merge BEFORE or WITH this branch, NEVER after. That
--       branch is what actually BLOCKS guest→agent binding; once it ships, no
--       guest can own a bot, so no NEW guest agent-leg event can exist and this
--       migration's agent-path residual (below) is closed at the source by
--       construction. Do NOT deploy this leaderboard exclusion while guests can
--       still bind agents.
--   • Apply with an EXPLICIT :5432 connection, NEVER `db:push` (drizzle-kit push
--     is destructive — it drops tables not in the checkout schema).
--   • IDEMPOTENT + re-runnable.

-- Bound the brief ACCESS EXCLUSIVE lock the ALTER needs so a long-running reader
-- can't make it (and everything queued behind it) hang — fail fast and retry
-- instead. Adding a NULLable column with no default is metadata-only (no table
-- rewrite), so the lock is held only momentarily once acquired.
SET lock_timeout = '3s';

-- 1. Add the column (nullable; NULL = pre-stamp / unresolved subject).
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_was_guest boolean;

RESET lock_timeout;

-- 2. Backfill existing GUEST events to true. FULL, non-grandfathered exclusion
--    (founder-confirmed 2026-07-10), so we OR ALL THREE guest signals — userId's
--    user, avatarId's owner, AND agentId's bot-owner — mirroring the write-time
--    resolver, so no historical guest row is left NULL to resurrect on a later
--    rebind.
--
--    RECONSTRUCTION LIMIT — INHERENT, documented + accepted (adversarial review
--    rounds 4-6). userId/avatarId are IMMUTABLE (users.is_guest never flips in
--    place) -> exact. The agentId->bot-owner path reads CURRENT
--    `openclaw_bots.user_id`, which is MUTABLE (/connect can rebind), so it is
--    EXACT for a bot that was never rebound (the norm — a guest bot's events are
--    all guest-era) but CANNOT reconstruct write-time identity for a bot rebound
--    BEFORE this runs. This is an UNAVOIDABLE property of any retroactive
--    backfill: for a rebound/deleted bot the write-time signal is simply gone.
--    Two directions: a real->guest rebind would false-stamp the pre-rebind real
--    events (deleting a real user's earned points); a guest->real rebind (or a
--    deleted guest owner -> user_id NULL) leaves the pre-rebind guest events NULL
--    -> the live join then re-admits them (a residual grandfathering window).
--    REACHABILITY: hitting either direction requires a guest to acquire a bot.
--    `connect-token` does NOT currently gate is_guest (agent-gateway.ts) and
--    `requireNonGuestIdentity` only blocks USER identities — BUT the DEPLOY-
--    ORDERING constraint above requires the companion branch
--    `fix/guest-owned-agent-real-ct` @ 05416424 to ship BEFORE/WITH this, and it
--    blocks guest→agent binding at the source. So going forward the residual
--    class cannot grow. (Do NOT restate this as "already blocked" in isolation —
--    it is blocked ONLY once the companion branch merges, which the deploy order
--    enforces.)
--    EVIDENCE (read-only counts of the unreconstructable class = agent-only
--    scored rows, user_id/avatar_id NULL) — the ACTIONABLE class is guest_owned:
--      STAGING (ref mtpixvtclsjqjguouxes, 2026-07-10): total=19, guest_owned=0,
--        real_owned=0, ownerless=19 — ALL `agent.connected` (weight 1) from 5
--        test/mock agents (`hatcher:mock-*`, `p0gate-b1-test-*`).
--      PROD (2026-07-10, read-only SET TRANSACTION READ ONLY + rollback, run by
--        auth-guest-gate from the api container's DATABASE_URL): total=100,
--        guest_owned=0, real_owned=35, ownerless=65 — the 65 ownerless match the
--        same mock/hatcher/p0gate connected pattern.
--    => guest_owned = 0 on BOTH DBs: the genuine guest grandfather residue is
--    PROVEN EMPTY, so the founder's full-exclusion holds with no tradeoff to
--    rule on. The ownerless rows (test/mock agents, non-guest) rank but are not
--    guest residue; going forward the companion branch (deploy-ordering above)
--    stops any new guest agent binding. The audit block below RAISE-NOTICEs the
--    live breakdown; guest_owned MUST stay 0.
UPDATE events e
SET subject_was_guest = true
WHERE e.subject_was_guest IS NULL
  AND (
    EXISTS (SELECT 1 FROM users u  WHERE u.id = e.user_id   AND u.is_guest)
    OR EXISTS (
      SELECT 1 FROM avatars a
      JOIN users au ON au.id = a.user_id
      WHERE a.id = e.avatar_id AND au.is_guest
    )
    OR EXISTS (
      SELECT 1 FROM openclaw_bots ob
      JOIN users gu ON gu.id = ob.user_id
      WHERE ob.agent_id = e.agent_id AND gu.is_guest
    )
  );

-- 3. AUDIT (non-fatal, informational) — after the backfill, break the remaining
--    NULL-stamped agent-only rows (the rank-eligible residue) down BY CURRENT
--    OWNER CLASS. This is NOT "expect 0" — an ownerless/real-owned count is
--    EXPECTED (staging: 19 test/mock `agent.connected` rows, all ownerless, non-
--    guest). What MUST be 0 is `guest_owned` (a live guest agent event that
--    somehow escaped the backfill's own agent-owner stamp). Enumerate any
--    ownerless rows manually (they're unreconstructable — see above) before
--    relying on full exclusion; on prod, record the breakdown alongside §5b.
DO $$
DECLARE n_guest bigint; n_real bigint; n_none bigint;
BEGIN
  SELECT
    count(*) FILTER (WHERE gu.is_guest IS TRUE),
    count(*) FILTER (WHERE gu.is_guest IS FALSE),
    count(*) FILTER (WHERE gu.is_guest IS NULL)
  INTO n_guest, n_real, n_none
  FROM events e
  LEFT JOIN openclaw_bots ob ON ob.agent_id = e.agent_id
  LEFT JOIN users gu ON gu.id = ob.user_id
  WHERE e.subject_was_guest IS NULL
    AND e.agent_id IS NOT NULL
    AND e.user_id IS NULL
    AND e.avatar_id IS NULL;
  RAISE NOTICE 'subject_was_guest residue (NULL-stamped agent-only): guest_owned=% (MUST be 0), real_owned=%, ownerless=% (enumerate if nonzero)', n_guest, n_real, n_none;
END $$;
