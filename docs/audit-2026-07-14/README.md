# ClawVille Forensic Audit — 2026-07-14

A full read-only forensic audit of the production codebase (`origin/master` @ `61d7aa2c`), run by **two independent agent fleets** so their coverage overlaps and cross-checks:

- **5 Codex** auditors (`gpt-5.6-sol`, high/medium effort)
- **5 Opus** auditors

one pair per domain, each auditing against the codified CLAUDE.md invariants and producing a severity-ranked report + a "governing invariants" section. Their findings are consolidated, de-duplicated, and verdict-tagged here.

## What's in this folder
- **`FINDINGS.md`** — the consolidated, de-duplicated, severity-ranked findings ledger (~57 findings) with my **CONFIRMED / PLAUSIBLE / REFUTED** verdicts and `file:line`.
- **`raw/`** — all 10 original fleet reports (`{codex,opus}-D{1..5}.md`), preserved verbatim.
- **`../GOVERNANCE.md`** — the hard rules for every future change, extracted from the audit (the "steering guide").
- **`../clawville-economy.md`** — the legible, shareable economy explainer for players + token holders (design-level; **requires founder/legal review before external distribution**).

## Domains
| | Domain | Codex | Opus |
|--|--------|-------|------|
| D1 | Economy & money-paths | ✓ | ✓ |
| D2 | Security: auth, sessions, wallets, partner signing, SSRF | ✓ | ✓ |
| D3 | Backend / API / DB integrity + E5 parity | ✓ | ✓ |
| D4 | Agent runtime, ElizaOS, protocol parity | ✓ | ✓ |
| D5 | 3D / render / perf / frontend | ✓ | ✓ |

## Headline — overall health
**The system is fundamentally sound and shows the scar tissue of many prior adversarial rounds.** The core money rails (canonical ledger, EARNED redemption with verified-conserving 444bps math, CLV swap guard, withdraw executor), the auth core (`require-auth-or-agent.ts`), the leaderboard scoring engine, and the entire render layer were each independently rated **strong / production-grade** and **verified clean** on their central invariants. No fleet found a way to drain custody, double-spend the exit rail, or crash the shipped render path.

The findings are concentrated in **adjacent/older paths and governance gaps**, not the crown-jewel cores.

### Severity roll-up (consolidated, post-verification)
| Severity | Count | The ones that matter most |
|---|---|---|
| **BLOCKER** | 6 | S1 portal replay→login takeover · S2 Hatcher-reg replay→fresh bearer · M1 x402 cross-rail double-credit · M2 wager E5 parity · M3 cosmetics E5 parity · M4 unguarded token-grant script + `db:push --force` |
| **HIGH** | ~19 | M5 fake-facilitator mint · M6 baccarat over-mint · M7 awardXp double-credit · M10 research-SSE data leak · S3 agentId takeover · S7 admin cookie on money routes · A1 second `[ACTION:]` executor · A2 write-only protocol knowledge · R2 NDC-z labels |
| **MEDIUM** | ~13 | activity idempotency · touch-detection · device misroute · SW cache budget · special-events GET writes |
| **LOW** | ~10 | provenance downgrade, rake rounding, naming, doc-drift cleanups |
| **REFUTED** | 2 | camera `far` "too small" (deliberate, fog-masked) · guest `items.ts` write (sanctioned carve-out) |

### The 6 things to fix first (in order)
1. **S1 + S2 — partner-signature replay** (portal login-ticket takeover + Hatcher-registration bearer minting). Protected surface; Codex-authored + harness.
2. **M5 — x402 facilitator trust** (mint vCLAW with no on-chain proof) + **M1** (cross-rail signature double-credit). Real-money integrity.
3. **M2 + M3 — E5 parity BLOCKERs** (wager + cosmetics human-only). Mechanical gate; the "RESOLVED" claim is false.
4. **M4 — `grant-test-tokens.ts` prod guard + retire `db:push --force`.** One env slip mints on mainnet / drops tables.
5. **M6 + M7 — supply mints** (baccarat over-mint, awardXp concurrency). vCLAW inflation.
6. **M10 + S7 — data-leak + admin-cookie** (research-SSE broadcasts private artifacts; unrevocable dash cookie authorizes wager settlement).

### Systemic themes (what the rules in GOVERNANCE.md target)
- **Idempotency at the DB boundary**, not in-memory FSM state (activity rewards, awardXp, wager, x402 receipts).
- **E5 parity is not actually complete** — wager, cosmetics, tutorial, avatar/location-agent/research are human-only; the "resolved" note is optimistic.
- **Partner signatures** need timestamp+nonce windows on ALL mutating/credential routes, not just the one that got the upgrade.
- **Documented safety controls that don't exist in code** (wager mainnet guard, "protocol_version 6", "`CLV_SWAP_EXECUTE` never true") — precedence says code wins; the docs must be corrected.
- **Three-surface protocol sync is mechanical-not-functional** — injected hosted knowledge is never read back.

## Method notes
- Read-only. No source was modified, no tests/DB/deploys were run by the auditors.
- Divergences between the two fleets were resolved by direct code re-verification (documented inline in `FINDINGS.md`): the fleets **agreed** on the highest-severity items (portal replay, wager parity, cosmetics parity, admin cookie, activity idempotency), which raises confidence; they **diverged** usefully on a few (protocol-knowledge read path, camera far-plane, guest write) where verification settled it.
- Coverage gaps deliberately left for a follow-up pass are listed at the end of `FINDINGS.md` (poker manager conservation, hold'em bot EV, market deed-transfer, meshlet `?meshlets=1` on Iris Xe).
