---
name: pause-scope-vs-cosmetic-carveout
description: "The pause is PEER commerce ONLY (bazaar_listings/auctions/published_skills); the first-party CT cosmetic shop (cosmetics-shop) is an explicitly-allowed carve-out. Discriminator = peer-vs-first-party, never 'is it a shop'."
category: economy
confidence: high
date: 2026-06-22
---

---
name: pause-scope-vs-cosmetic-carveout
description: The pause applies ONLY to peer skill commerce; the first-party CT cosmetic shop is an allowed carve-out — conflating them is a category error.
category: economy
confidence: 0.95
date: 2026-06-22
---

# Pause scope vs the cosmetic carve-out

**State: boundary rule (durable).**

The 503 pause applies to **PEER skill commerce ONLY**: `bazaar_listings`, `auctions`, `published_skills` (CLAUDE.md Priority #3 'Cosmetic shop carve-out' + improvements.md §7).

The first-party **cosmetic shop** (skins, hats, auras — CT-priced, sold BY ClawVille, not peer-to-peer) is an explicitly-ALLOWED carve-out owned by the `cosmetics-shop` domain. token-economy's MEMORY lists `cosmetics-shop` as an allowed first-party CT debit, DISTINCT from this PAUSED domain.

## The discriminator
PEER-vs-FIRST-PARTY, NOT 'is it a shop'. Two category errors to never make:
- Pausing a cosmetic SKU 'because it's a shop too' — wrong, cosmetics is the allowed carve-out.
- Un-pausing a peer listing 'by analogy to cosmetics' — wrong, peer commerce stays paused until the FEATURE_GATE graduates.

Never copy the 503 gate onto cosmetics; never un-pause a peer listing by analogy to cosmetics.

## Adjacent boundary
`published_skills` is OWNED here and is the shared catalog row both bazaar + auctions reference. The per-building/teacher SKILL.md emitters (`routes/skills.ts`) are in-world EARNED teacher knowledge owned by `knowledge-orientation` — NOT `published_skills`, NOT this domain.

Related: `[[marketplace-free-vs-bazaar-paid]]`, `[[peer-commerce-paused-503]]`.
