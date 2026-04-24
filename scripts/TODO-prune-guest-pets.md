# TODO — `scripts/prune-guest-pets.ts`

Deferred from the guest-pet auto-create PR (2026-04-23) so the play-now
feature isn't blocked on cron infra.

## What it should do

Run daily (cron / Coolify scheduled task) and delete `users` + cascading
`pets` rows where:

```sql
SELECT id FROM users
WHERE is_guest = true
  AND guest_expires_at < now();
```

`pets.userId` has `ON DELETE CASCADE` so a single `DELETE FROM users
WHERE ...` removes both rows. The `idx_users_guest_expires` partial
index added in `0004_guest_pet_columns.sql` keeps the scan O(expired
guests) rather than O(all users).

## Why deferred

- Guest TTL is 24 h, so the database accumulates at most ~ a day of
  rows before we ship the pruner. Hetzner Postgres has plenty of
  headroom for that.
- The cron infrastructure (Coolify scheduled tasks vs. a Bun loop in
  the API process vs. an external cron pod) needs a separate decision.
- A naive prune would also need to handle `activity_results` /
  `events` / `wallets` foreign-key fanout — the schema FKs are mostly
  `ON DELETE CASCADE` or `ON DELETE SET NULL`, but a sweep should be
  done before the first prune runs against prod data.

## Owner

Whoever picks this up next: file as a follow-up issue + ship the script
+ wire it into Coolify's scheduled-task UI (or as a `cron.ts` worker in
`apps/api/src/services/`).
