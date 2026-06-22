---
name: asset-cache-bust-v-query
description: "INVARIANT: mutating an existing /cosmetics/*.glb or thumbnail PNG at a stable URL without bumping a ?v=N query is a silent 7-day Cloudflare-edge regression (deploy token has no cache_purge scope). Plus the seed env hazard: a wrong-cwd seed run can write PROD; Nori has no shop orientation entry."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: asset-cache-bust-v-query
description: "Bump ?v=N when mutating any cosmetic GLB/thumbnail at a stable URL (Cloudflare 7-day edge, no purge scope). Seed env hazard + Nori shop-knowledge gap."
category: constraint
confidence: 0.9
date: 2026-06-22
---

## Asset cache-bust (process invariant)
Mutating an existing static asset at a stable URL (`/cosmetics/<cat>/<slug>.glb`, a thumbnail PNG) WITHOUT bumping a `?v=N` query in EVERY reference (the seeded `cosmetic_variants.assetUrl` + any hardcoded path) is a **silent 7-day regression on prod**: Cloudflare edge TTL is 7 days and the deploy token has zone:edit but **no cache_purge scope**, so the URL query is the only invalidator. Diagnostic: `curl '...?cache_bust=$(date +%s)'` returns the NEW file; the bare URL returns the STALE one. (`CLAUDE.md` Kill-the-build 'Asset cache-bust' + `3dStructure.md` 6f rule 9.)

## Seed env hazard
The seed scripts (`seed-{milady-cosmetics,surfboards,emote-cosmetics}.ts`) `config({path:'.env.local'})` + read `DATABASE_URL`. **Bun auto-loads `<cwd>/.env.local`**, so a script run from the wrong cwd can silently hit PROD (this pattern caused a real prod write 2026-06-16 -- global lesson `feedback_no_prod_url_in_env_bun_autoload`). Keep every local `.env.local` staging-only; pass the DB URL explicitly. Verify `SELECT count(*) FROM cosmetic_skus` on the target DB before assuming the shop is stocked (empty table = empty shop while GLBs sit on disk). Seeds are idempotent UPSERT by slug; staging + prod are now ISOLATED Supabase DBs.

## Nori shop-knowledge gap (same-diff rule)
Nori the Town Guide (`packages/agent-templates/src/locations/town-guide.ts knowledge[]`) has **NO cosmetic-shop orientation entry** -- cosmetic appears only in the pending-quest lines (Style Statement / Big Spender gated on the shop shipping) + a manifest-export mention. Any shop ship/change MUST add a what-the-Wardrobe-is / how-to-buy+equip orientation entry SAME-DIFF (re-seeded by `ensureSystemAgents()` on boot), plus the connection SKILL.md + hosted-runtime per the 3-surfaces rule.

## State
Asset cache-bust + seed hazard = **INVARIANT**; Nori entry = **OPEN gap**.

Related: [[sku-needs-row-asset-mesh]], [[proportion-aware-autofit]].
