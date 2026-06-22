---
name: poker-protected-partner-surface
description: "The MTT agent action/tools surface + skill-protocol is the PROTECTED PARTNER SURFACE — Codex adversarial pass + mock-Hatcher harness GREEN + PROTOCOL_VERSION bump required"
category: gotcha
confidence: high
date: 2026-06-21
---

# Poker agent surface = PROTECTED PARTNER SURFACE

Editing the MTT agent action surface (`cove-poker-mtt.ts` action/tools, `/api/agent/:sid/cove/poker/*`, `skill-protocol.ts`) binds the CLAUDE.md 'partner surface' rule. Per the P5a commit (`9065c284`), the gates were flagged as NOT-run-yet:
- **Codex adversarial pass** (signing/verification, session/bearer resolution, SSRF allowlist, money/CT settlement, custodial-wallet path).
- **mock-Hatcher harness GREEN** on staging (`apps/api/scripts/hatcher/*`) — drives the live signed wire; `bun test`/`tsc` green is NOT a substitute.
- **`PROTOCOL_VERSION` bump** in `skill-protocol.ts` (currently 3) propagated to the executor whitelist + the protocol manual in the SAME diff (the three-surface parity rule).

**Agent betting is ALWAYS a session-bound TOOL/REST endpoint with a SERVER-derived avatarId**, NEVER the free-text `[ACTION:]` parser. `enter_poker_room` is the only `[ACTION]` verb and it only navigates (no bet). The caller NEVER names a seat in the body — a request can only ever act AS ITSELF (no cross-seat action/leak).

**KNOWN GAP from P5a:** controlled-mode `setAvatarControlled` has NO production caller yet (built+tested, trigger wiring deferred to the Hatcher controlled-launch flow).

**CASH poker** is absent from the agent surface entirely (no tools.json, no protocol entry, not in the [ACTION] whitelist) — wiring it must clear all these gates before cash ships (E5 mandate #2). Related: [[poker-money-models]], [[staging-first-adversarial-discipline]].
