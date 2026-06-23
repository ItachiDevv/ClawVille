---
name: skill-md-gating-leaderboard-tag
description: "per-building skill.md dual-gate (end-user organic vs partner-import via tag), clawville-play always public, the DISABLED avatar-ownership FEATURE_GATE, manifest poll"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: skill-md-gating-leaderboard-tag
description: per-building skill.md dual-gate (end-user organic vs partner-import via tag carved out of the leaderboard); clawville-play always public; avatar-ownership paywall DISABLED behind FEATURE_GATE.
category: pattern
confidence: 0.85
date: 2026-06-22
---

# Skill.md dual-gate + leaderboard tagging

## The two emitters (the served knowledge surface)

`apps/api/src/routes/skills.ts`:
- `GET /api/skills/manifest.json` — single poll target carrying protocol + orientation + per-building contentHashes; partners re-pull on hash/version change.
- `GET /api/skills/protocol/skill.md` — the connection manual / protocol (partner-key gated; the stable token-free protocol surface).
- per-building `/:buildingId/skill.md` — dual-gated (below).

## Dual-gate

- **End-user** (Lucia cookie OR live agent session, `hasEndUserIdentity()`) passes with NO partner key → tagged **organic** (`via=undefined`), counts toward the leaderboard `skill_md.fetched` under the 11/day cap.
- **Everyone else** needs a `skills:read` partner key + per-partner rate limit → tagged `via='partner-import'`, **carved OUT** of the leaderboard so a partner can't farm rank.
- Never trust a bare `X-Clawville-Agent-Id` header as identity.
- The `clawville-play` meta skill is ALWAYS public (open-onboarding brand priority) — registered BEFORE the gated wildcard.

## Disabled paywall (FEATURE_GATE)

`skills.ts:420` — the avatar-ownership paywall (`avatarOwnsBuilding` + 402 teaser) is DISABLED/commented (user direction 2026-05-21 'not payment-gated'). Re-enable is a ~3-line uncomment when peer-skill commerce un-pauses. All SKILL.md bodies are public to authed end-users today.

## Open issue (LOW)

`POST /api/skills/forge` (`skills.ts:559`) is a 501 stub — conversation→skill distillation is contract-stable but doesn't run the OpenAI pass; no `custom_skills` table yet.

## Status: LIVE.

Related: [[protocol-version-consumed-seam]] · [[three-surface-knowledge-sync]]
