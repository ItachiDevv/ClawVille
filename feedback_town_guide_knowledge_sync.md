---
name: Three-Surface Game-Flow Knowledge Sync
description: Every ClawVille game-flow change MUST propagate to all three operational-knowledge surfaces in the same diff — Nori's knowledge[], the external-agent connection SKILL.md, and the hosted-agent runtime equivalent. Replaces the earlier town-guide-only rule (2026-05-25).
type: feedback
originSessionId: 4c585d3f-1734-477a-99c9-6e996bdb4272
---

**Rule:** Any new game flow, world addition, or edit to a current mechanic (modes, buildings, currencies, quests, wager rules, casino/arcade games, table rules, connect flow, disconnect/timer behavior, leaderboard weights, paused features, etc.) must update **all three** in the same diff:

1. **Nori the Town Guide's `knowledge[]`** at `packages/agent-templates/src/locations/town-guide.ts` — world-orientation surface, re-seeded by `ensureSystemAgents()` on every API boot.
2. **Connection SKILL.md** — protocol/operating manual served at the magic-link handshake to external agents. Auth, WebSocket protocol, event/action schemas, table rules, disconnect/timer behavior, content-hash version. **CRITICAL:** fetched fresh on every connect; stale manual = playing field broken.
3. **Hosted-agent runtime knowledge of #2** — server-side equivalent via `createMemory()` injection into each hosted Milady/Hermes runtime on restart, `subtype: 'protocol-knowledge'`.

**Why:** The game's competitive premise is that agents with up-to-date manual knowledge play the right game. If a mechanic changes and connected agents are still running on a stale manual, they're playing a different game than hosted agents — fairness and measurability are broken. Same-diff propagation is the forcing function.

**How to apply:** Touch a game mechanic → in the same PR, edit (1) `town-guide.ts` knowledge[], (2) the connection SKILL.md content, (3) the hosted-agent skill-injection content. Skip any of the three = unmergeable PR.

**NOT in this rule:** earned/exportable per-agent gameplay skills (blackjack hand outcomes, basic-strategy mastery, count-tracking accuracy, teacher knowledge fetched by visiting a building). Those are per-agent state written continuously during play, not world-state — no same-diff requirement.

**Infra gap (binds when shipped):** the global connection SKILL.md endpoint + content-hash manifest doesn't exist today. Until shipped, content updates are required (rule binds), but eager-on-connect enforcement is TODO/best-effort.

**Enforcement:** CLAUDE.md + AGENTS.md "## MANDATORY: Game-flow changes propagate to all three operational-knowledge surfaces in the same diff" section. Supersedes the earlier town-guide-only version.

Related: [[project_phase5_1]] (magic-link handshake) · [[feedback_three_doc_standing_rule]] (3dStructure.md / GameFeatures.md / ARCHITECTURE.md sync — separate from this rule but same spirit).
