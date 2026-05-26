---
name: project-claude-md-structure
description: "CLAUDE.md structure rule — always-on policies inline, scoped detail in canonical docs gated by file-path trigger table. Don't reintroduce duplicated detail."
metadata: 
  node_type: memory
  type: project
  originSessionId: a70db89b-03c8-40fd-9903-cac1a300e4c6
---

CLAUDE.md was deduped on 2026-05-19 (commit `b4b5c30`, 41886 → 38392 chars). The structure decision came from a conversation that explicitly rejected three other patterns: nested per-directory CLAUDE.mds, an Obsidian-style `rules/` graph under `.claude/`, and a `rules/` graph at root. User landed on: "use what already exists — the three canonical docs."

**Why:** CLAUDE.md is the only doc auto-loaded into every session. Anything moved to a separate file (memory, plan, sub-rules file) is functionally demoted to "load if I think to." So the rule shape is binary:

- **Always-on:** kill-the-build invariants (Iris Xe Text/Billboard crash, wallet.secretKey one-shot, push-auth fallback chain, no-claim-without-verify, no `bun run dev` local) + always-on policies (team pattern, four priorities, canonical-doc precedence, memory rules, zero-laziness, no-lazy-handoffs). Stay INLINE regardless of length.
- **Scoped (gated by file path):** Phase 5.1 wallet, wager program, ClawToken economy, agent connect, db schema, 10 buildings. Live in the canonical doc that already tracks them same-diff with code (`ARCHITECTURE.md` §6/§7/§8/§13, `GameFeatures.md` §2/§4/§5/§8/§9a). CLAUDE.md has a one-line pointer + the explicit file-path trigger table.

**How to apply:** when CLAUDE.md grows past ~40k again, check if the new content is scoped (only matters when editing certain files). If yes: fold into the canonical doc that owns the scope, add a trigger-table row mapping file glob → doc section, leave a one-line pointer. NEVER add content to a `.claude/plans/...` file and reference it from CLAUDE.md — plan docs are point-in-time artifacts, they drift from current truth.

**Anti-patterns we explicitly rejected:**

1. **Per-directory `CLAUDE.md` nesting** (`apps/web/CLAUDE.md`, `apps/api/CLAUDE.md`, etc.) — Claude Code's path-based inheritance is real but the orchestrator session usually opens at root, so sub-CLAUDE.mds don't auto-load. Worse than inline.
2. **`.claude/rules/<topic>.md` graph** (Obsidian/Zettelkasten style with `[[wikilinks]]`) — structure for structure's sake, demotes to memory-tier (advisory), and `.claude/` signals "machine-only" to humans + Codex audits.
3. **`rules/` at root** — same demotion problem as `.claude/rules/`, just more visible. Doesn't actually solve anything the canonical docs don't already solve.
4. **Plan-doc references from CLAUDE.md** (e.g. "see `.claude/plans/phase5.1-...md`") — plans are intent-at-time-of-design, not current truth. They drift from shipped code.

**File-path trigger table is the load-bearing mechanism.** Every code change in a matched path requires reading the named doc first AND a same-diff doc update. Soft "tech-stack code → ARCHITECTURE.md" is too vague — concrete globs like `apps/api/src/routes/portal/*` are unmissable.

**Caveat / known weakness:** the mechanism is "agent reads CLAUDE.md trigger table → follows the pointer." A future session that ignores the trigger table could miss a scoped rule. Hook-level enforcement (pre-tool-use blocker requiring matching doc read before edits) is the true backstop — not yet wired. If/when scope rules start getting violated, wire it in `.claude/settings.json`.

Related: [[feedback_three_doc_standing_rule]], [[feedback_repo_docs_are_canonical]], [[feedback_update_docs_every_change]], [[feedback_3d_doc_sync]].
