# CI Gates & Protection — Turning ClawVille's Rules Into Keys, Not Prompts

**Plan doc — `.claude/plans/ci-gates-protection.md`** · Authored 2026-06-22 · Branch context: `feat/poker-mtt-tournament`

## Thesis (keys, not prompts)

Every "rule" in `CLAUDE.md` / `Crypto/CLAUDE.md` / the three canonical docs is, today, an **advisory prompt** — a fresh session or a fresh agent reads it or silently ignores it, and money/gameplay code regresses regardless. Telling an agent "update Nori when you add a game mode" is a *suggestion*, not a *safety setting*. This plan converts the mechanizable subset of those rules into **mechanical CI gates that BLOCK a merge when violated**, enforced by GitHub Actions + branch protection on the repo itself — the only layer no session can talk its way past. The flagship: a gameplay feature added **without** updating Nori's `knowledge[]` (`town-guide.ts`) **fails CI** via a registry-driven changed-files coupling gate. The knowledge stays plain-text, version-controlled, and co-located with the code (an in-repo `.claude/gates/` registry, NOT an external Obsidian vault), but enforcement moves from "the agent chose to honor it" to "the workflow read the gate file and failed the build."

## Verified baseline (this session, working tree)

- Only `rtp-gate.yml` is a real PR gate (invariant-test, RTP band). `deploy.yml`/`deploy-staging.yml` are Coolify SSH triggers with **no** test/lint/grep step.
- **All four canonical docs (`GameFeatures.md`, `3dStructure.md`, `ARCHITECTURE.md`, `WorldContent.md`) are TRACKED** — the inventory's "gitignored, degrade to checklist" caveat is WRONG; every doc-coupling gate is **fully mechanizable**.
- No `test` task in `turbo.json`; only `apps/api` has `bun test`; the large money/cove/poker invariant suite **exists but never runs in CI** (dead backstop).
- `PROTOCOL_VERSION = 3` at `apps/api/src/services/skill-protocol.ts:31`.
- `partner-signature.ts` references **neither** `ALLOW_TEST_PARTNER_PUBKEY` **nor** `CLAWVILLE_ENV` (0 matches) — the crash-loud env guard described in CLAUDE.md is genuinely **absent** on this branch → the static gate is doubly justified.
- `docs/hatcher-integration-spec.md` **absent**; hatcher scripts = `selftest-e2e.ts` + `verify-avatar-provision.ts` only (`mock-hatcher-client.ts` is branch-skewed) → coupling gates assert **changed-set membership, never `fs.existsSync`**, emitting "create this file" on a missing target.
- No direct `avatars.clawTokens` writes outside `claw-token-ledger.ts` (clean baseline for the static ban).
- No `CODEOWNERS`, no branch protection.

## Obsidian decision

**AGAINST an external Obsidian vault; ADOPT the principles in-repo.** Obsidian cannot gate a PR — a vault note is just another prompt a session ignores exactly like CLAUDE.md. The repo already IS the vault and does plain-text/version-controlled knowledge better (co-located, diffs in the same PR the gate inspects, visible to the Actions checkout). An external vault would fork the source of truth — the precise failure mode restated. We keep the article's two good ideas (keys-not-prompts; plain-text model-agnostic knowledge) via `.claude/gates/`: one markdown file per gate that is simultaneously documentation, version-controlled knowledge, AND the data the CI runner parses to pass/fail.

## Two-layer model

- **Layer 1 — CI GATES = enforcement (un-bypassable):** `gates.yml` jobs + branch protection + CODEOWNERS. Run on every PR, no judgment, either pass or block. The "key."
- **Layer 2 — DOMAIN SUBAGENTS = authoring/review/knowledge (the cove pattern + curated memory):** specialists write the code that satisfies the gates, run the adversarial audits gates can't express, and own the gate FILES for their domain. A subagent can be lazy; the gate is the backstop. A gate is blunt; the subagent supplies nuance.

### Subagent ownership map

| Domain agent | Owns gates (ids) | New agent? |
|---|---|---|
| **cove** (Cove casino; reference template, carries casino-economy + live-smoke memory) | gameplay-change-updates-nori-knowledge, slot-net-balance-conservation, slot-idempotency-replay-409, blackjack-hidden-state-no-leak, blackjack-stale-epoch-409, holdem-board-leak-route, slot-rtp-monte-carlo, baccarat-commission-no-edge-leak, guest-demo-isolation, provable-fair-commit-reveal, holdem-side-pot-rake, e5-agent-real-ct-parity (route), cosmetic-sku-requires-skin-row | no (existing composition) |
| **wallet** (Phase5.1 + wager + custody; pairs w/ solana-auditor) | phase51-wallet-identity-doc-coupling, wager-program-change-updates-architecture, wallet-secretkey-returned-exactly-once | no |
| **partner** (Hatcher protected surface; every change → Codex adversarial pass) | gameplay-updates-connection-skillmd, action-whitelist-bumps-protocol-version, protocol-version-propagates-three-surfaces, protected-partner-surface-updates-spec-and-harness, partner-dependency-binds-surface, agent-connect-updates-docs, allow-test-partner-pubkey-env-guarded, hatcher-namespace-reserved, harness-partner-selftest-ci | no |
| **world-Nori** (orientation surface) | (the knowledge[] authoring side of all gameplay gates), map-locations-updates-worldcontent, leaderboard-weight-updates-nori | no |
| **3da** (Three.js/WebGPU; curated `.claude/memory/threejs/`) | three-d-updates-3dstructure, static-asset-version-bump, animation-clip-updates-sw-and-3dstructure, no-drei-text-billboard, no-instancedmesh+shadermaterial, no-per-frame-new-vector3, mobile-useIsMobile, no-dark-text-on-dark-panel | no (existing specialized) |
| **general** (infra/docs/economy) | new-route-table-service-env-updates-architecture, env-var-updates-architecture, gameplay-economy-ui-updates-gamefeatures, ci-run-money-invariant-suite, ledger-only-settlement, no-direct-clawtokens-write, no-bun-run-dev-in-ci, no-dbpush-force, sol-usdc-501-gate, no-committed-secrets, no-raw-coolify-envvar-write, no-agpl-gpl, codeowners, branch-protection | no |

**New agents to create: none required.** The five role-slots are existing team compositions; 3da + solana-auditor exist. Only net-new artifact is a documented orchestrator responsibility ("when code moves, update the gate file in the same diff") and an optional thin `gates-maintainer` to validate new gate-file frontmatter.

## Gate registry (full taxonomy)

| id | rule (short) | mechanism | trigger | required assertion | owner | lev | current enforcement |
|---|---|---|---|---|---|---|---|
| gameplay-change-updates-nori-knowledge | gameplay/mechanic change → Nori knowledge[] | coupling | cove-*.ts, quests/bounties/activities/leaderboard/exchange, map-locations/building-types/knowledge-books, cove*/poker*/blackjack/baccarat/holdem/quests/bounties schema | town-guide.ts ∈ changed (escape `[skip-nori-update]`) | cove | high | NONE |
| gameplay-updates-connection-skillmd | same change → connection SKILL.md + hosted runtime | coupling | cove-*.ts, skill-protocol.ts, npc-simulation.ts, cove*/poker* schema | skill-protocol.ts ∈ changed; warn if seeder absent | partner | high | NONE |
| action-whitelist-bumps-protocol-version | [ACTION:] verb change → manual + PROTOCOL_VERSION++ | coupling | npc-simulation.ts (diff hunk hits executeHatcherAction/whitelist) | skill-protocol.ts ∈ changed AND PROTOCOL_VERSION integer increased | partner | high | NONE |
| protocol-version-propagates-three-surfaces | PROTOCOL_VERSION bump → partner spec doc | coupling | skill-protocol.ts | if version changed → docs/hatcher-integration-spec.md ∈ changed (create if absent) | partner | high | NONE |
| protected-partner-surface-updates-spec-and-harness | partner-surface edit → spec doc | coupling | partner-hatcher*/portal/skills routes, partner-signature/service-issuer/skill-protocol/openclaw-client/agent-session-config/hatcher-config/hatcher-session-webhook/reserved-namespaces/openclaw-session-restore services, require-auth-or-agent mw, shared openclaw types | docs/hatcher-integration-spec.md ∈ changed | partner | high | NONE |
| partner-dependency-binds-surface | unrelated dep change pulls partner into scope | coupling | require-auth-or-agent.ts, openclaw types, openclaw-client.ts, npc-simulation.ts, leaderboard.ts | docs/hatcher-integration-spec.md ∈ changed | partner | med | NONE |
| new-route-table-service-env-updates-architecture | new route/schema/service/env/CI → ARCHITECTURE.md | coupling | added routes/services, ANY schema/*.ts, .github/workflows/*, scripts/deploy/* | ARCHITECTURE.md ∈ changed | general | high | NONE |
| env-var-updates-architecture | new env key → ARCHITECTURE.md + CLAUDE.md | coupling | .env.example, apps/api/**/*.ts (new process.env.*) | ARCHITECTURE.md ∈ changed | general | med | NONE |
| gameplay-economy-ui-updates-gamefeatures | gameplay/economy/UI → GameFeatures.md | coupling | components/game/**, knowledge-books/avatar-archetypes/map-locations, quests/claws routes, claw-token-ledger/daily-login | GameFeatures.md ∈ changed (TRACKED → full) | general | med | NONE |
| three-d-updates-3dstructure | 3D code → 3dStructure.md | coupling | lib/three/**, components/three/**, public/models/** | 3dStructure.md ∈ changed (TRACKED → full) | 3da | med | NONE |
| map-locations-updates-worldcontent | building roster → WorldContent.md §2 | coupling | map-locations.ts, building-types.ts | WorldContent.md ∈ changed | world-Nori | med | NONE |
| phase51-wallet-identity-doc-coupling | Phase 5.1 files → ARCHITECTURE.md §7 | coupling | portal routes, cf-secrets/service-issuer/auth-challenge/identity-service/keypair-vault/wallet-service | ARCHITECTURE.md ∈ changed | wallet | med | NONE |
| wager-program-change-updates-architecture | wager client/route/contracts → ARCHITECTURE.md | coupling | wager-program-client.ts, wager.ts, contracts/wager/**, packages/wager-program/** | ARCHITECTURE.md ∈ changed | wallet | med | NONE |
| agent-connect-updates-docs | agent.ts / connect modal / /api/agent/* → GameFeatures §2 + ARCHITECTURE §6 | coupling | agent*.ts routes, agent-connect/connect-agent components | ARCHITECTURE.md ∈ changed; warn GameFeatures.md | partner | med | NONE |
| static-asset-version-bump | mutated asset → ?v=N bump in every ref | coupling | public/avatars/**.vrm, animations/**.glb, cosmetics/**.glb, models/**.glb (MODIFIED) | a referencing registry file ∈ changed; ?v= integer increased | 3da | high | NONE |
| animation-clip-updates-sw-and-3dstructure | clip change → sw.js prefixes + 3dStructure §6f | coupling | animations/**, _emotes.glb, vrm-character-animator.ts | sw.js ∈ changed (warn) + 3dStructure.md (warn) | 3da | med | NONE |
| leaderboard-weight-updates-nori | weight/cap change → Nori knowledge[] | coupling | leaderboard.ts, leaderboard*/reward-pipeline (diff hits weight/cap) | town-guide.ts ∈ changed | world-Nori | med | NONE |
| cosmetic-sku-requires-skin-row | new SKU → asset exists + skin seed | invariant-test (+coupling fallback) | cosmetics constants/route/schema | each SKU assetUrl resolves to a file; skin seed present | cove | low | NONE |
| ci-run-money-invariant-suite | run `bun test` on money/game PRs, block on fail | invariant-test | apps/api/**, database schema, slot-paytables | api-tests job RED blocks merge (Postgres service + DATABASE_URL) | general | high | NONE (suite exists, never runs) |
| slot-net-balance-conservation | slot lifecycle mints/burns nothing | invariant-test | cove-slots.ts, slot-engine.ts, ledger | cove-slots.test net-balance GREEN | cove | high | covered, un-armed |
| slot-idempotency-replay-409 | replay mismatched stake → 409; .strict() schema | invariant-test | cove-slots.ts, .types.ts | cove-slots.test GREEN | cove | high | covered, un-armed |
| blackjack-hidden-state-no-leak | /hand/current leaks no hole/shoe/serverSeed | invariant-test | cove-blackjack.ts | flattenStrings deep-walk GREEN | cove | high | covered, un-armed |
| blackjack-stale-epoch-409 | stale deal/action/settle → 409 | invariant-test | cove-blackjack.ts | 3 tests GREEN | cove | high | covered, un-armed |
| poker-tournament-ct-conservation | Σbuy-ins == Σprizes + rake; chips conserved | invariant-test | poker/tournament-manager.ts, poker-table-sim.ts | tournament-manager.test GREEN | general | high | covered, un-armed |
| poker-settle-idempotent | re-settle no double-credit; floor-not-met full refund | invariant-test | poker/tournament-manager.ts | tournament-manager.test GREEN | general | high | covered, un-armed |
| cash-table-no-ct-faucet | seeded chips house-bank-backed; exact-stack cashout | invariant-test | poker/cash-table-manager.ts | cash-table-manager.test GREEN | general | high | covered, un-armed |
| e5-agent-real-ct-parity | agent plays as itself on real-CT path | invariant-test | poker managers, cove-holdem/baccarat/cash-poker routes, require-auth-or-agent | poker tests GREEN; **WRITE** route-level parity tests | cove | high | partial (poker only) |
| poker-agent-action-idempotent | applyAgentAction idempotent on (hand,seq); advisor non-staking; controlled-mode suppress | invariant-test | poker/tournament-manager.ts, cove-poker-mtt.ts, agent-gateway.ts | tournament-agent-play.test GREEN | general | med | covered, un-armed |
| holdem-board-leak-route | in-progress wire leaks no board/opp-hole/seed | invariant-test | cove-holdem.ts, cove-baccarat.ts | **WRITE** route deep-walk tests | cove | high | GAP — write |
| slot-rtp-monte-carlo | RTP within band | invariant-test | slot-paytables/slot-engine/provable-rng/rtp-sim | 100k Monte Carlo bands | cove | med | **ARMED** (rtp-gate.yml) |
| baccarat-commission-no-edge-leak | banker win = floor(stake*0.95) | invariant-test | baccarat-engine.ts, cove-baccarat.ts | floor assertion (add if absent) | cove | med | partial |
| ledger-only-settlement | InsufficientTokensError, no partial write | invariant-test | claw-token-ledger.ts, cove routes, poker/** | manager tests GREEN | general | high | covered, un-armed |
| guest-demo-isolation | guest writes 0 to avatars; unbound agent 403 | invariant-test | cove routes, require-auth-or-agent | **WRITE** zero-write + 403 assertions | cove | med | GAP — write |
| special-event-prepaid-no-double-charge | seated once, SOL replay rejected, agent parity | invariant-test | special-event-manager.ts, special-events.ts | special-event-manager.test GREEN | general | med | covered, un-armed |
| provable-fair-commit-reveal | seed committed at open, revealed at close, sha256 matches | invariant-test | provable-rng.ts, cove-slots.ts, cove-history.ts | provable-rng + verify-compat GREEN | cove | med | covered, un-armed |
| holdem-side-pot-rake-conservation | side pots + rake conserve chips (BUG5) | invariant-test | holdem-engine.ts | holdem-betting-machine.test GREEN | cove | med | covered, un-armed |
| no-direct-clawtokens-write | no `.set({clawTokens})` outside ledger | static-grep | apps/api/src/**/*.ts | regex matches ZERO (allow claw-token-ledger.ts) | general | high | NONE |
| no-drei-text-billboard | no drei Text/Billboard in game scenes | static-grep/eslint | lib/three, components/three, components/game, components/cove | no import of Text/Billboard from @react-three/drei | world/3da | high | NONE |
| no-instancedmesh+shadermaterial | co-occurrence WebGPU crash | static-grep | lib/three, components/three | WARN + CODEOWNERS on co-occurrence | world/3da | med | NONE |
| no-per-frame-new-vector3 | no `new Vector3()` inside useFrame body | static-grep (AST) | lib/three, components/three | ts-morph walk of useFrame bodies | world/3da | med | NONE |
| no-bun-run-dev-in-ci | no dev-server invocation in scripts/CI/skills | static-grep | scripts/**, .github/workflows/**, .claude/**, *.sh | zero `bun run dev`/`turbo run dev`/`next dev` (exclude package.json def) | general | low | NONE |
| no-dbpush-force-in-deploy-paths | no db:push / drizzle-kit push in CI/deploy | static-grep | .github/workflows/**, scripts/deploy/**, *deploy*.sh | zero db:push invocations | general | high | NONE |
| sol-usdc-501-gate | non-CT currency rejects, never settles | static-grep (required-pattern) | cosmetics/bazaar/auctions/marketplace/cove/agent-v2 routes | CT-guard present; 503 present on paused writes | general | med | NONE |
| allow-test-partner-pubkey-env-guarded | test signer only under CLAWVILLE_ENV=staging + module throw | static-grep | partner-signature.ts | if ALLOW_TEST_PARTNER_PUBKEY present → CLAWVILLE_ENV==='staging' + throw present | partner | high | NONE (guard absent on branch) |
| no-committed-secrets | no keys/prod URL committed; .env.local gitignored | static-grep (gitleaks) | repo (excl .example/docs) | gitleaks clean + token grep clean + .env.local ignored | general | high | NONE |
| wallet-secretkey-returned-once | secretKey only in first-connect allowlist | static-grep (snapshot-allowlist) | routes/**, wallet-service, keypair-vault | no new secretKey-in-response beyond allowlist | wallet | high | NONE |
| hatcher-namespace-reserved | public registration rejects hatcher: | static-grep (grep -L) | agent-gateway/agent-registration/openclaw routes, reserved-namespaces | each public route references reserved guard | partner | med | NONE |
| no-raw-coolify-envvar-write | no raw DB::update/Crypt::encryptString on env value | static-grep | scripts/deploy/**, docs, *.sh | zero raw-encrypt env writes | general | low | NONE |
| no-agpl-gpl | no (A)GPL deps; no @payai/* | static-grep + license-checker | package.jsons, bun.lock | zero GPL/AGPL; zero @payai | general | med | NONE |
| mobile-useIsMobile | touch gating via useIsMobile not bare md: | static-grep (warn) | components/game, components/cove, lib/three | touch-control files import useIsMobile | world | low | NONE |
| no-dark-text-on-dark-panel | no text-*-700/800/900 in dark panels | static-grep (warn) | components/game, components/cove, *modal*, *toast* | WARN on dark-text tokens | world | low | NONE |
| codeowners-protected-paths | money/partner/custody/schema need owner review | codeowners | partner routes/services, schema/**, ledger, wager, contracts, gates, workflows | CODEOWNERS review required | general | high | NONE |
| branch-protection | no direct push master/staging; required checks | branch-protection | master, staging | PR + CODEOWNERS + required checks | general | high | NONE |
| harness-partner-selftest-ci | partner change passes selftest-e2e.ts | harness | apps/api/scripts/hatcher/** + protected surface | selftest-e2e GREEN | partner | high | NONE |
| quality-verbs | "polish/elite/feels-like-X" + adversarial judgment | advisory | n/a | documented, not enforced | n/a | n/a | inherently advisory |

## `.claude/gates/` registry format

One markdown file per gate (`coupling/`, `static/`, `invariant/`, `harness/`, `process/`, `advisory/`) + generated `INDEX.md` + `schema.md`. YAML frontmatter is machine-readable (`id`, `mechanism`, `owner`, `leverage`, `mechanizable`, `status`, plus mechanism-specific keys: coupling→`trigger`/`requires`/`escapeHatch`; static→`scope`/`banned`/`allow`/`require`; invariant→`testCmd`/`needsDb`); the body holds the verbatim source rule + rationale + "what the runner does." Coupling gates assert **changed-set membership, never `fs.existsSync`** (branch-skew tolerant — a missing `requires` target yields "create + edit this file"). `partial`-mechanizable gates declare an `escapeHatch` commit-trailer; the bypass is LOGGED as a CI warning, never silent. `INDEX.md` is regenerated by `bun .claude/gates/build-index.ts` and a CI step asserts it's in sync. **Adding a coupling or static gate = adding one `.md` file — no workflow edit.**

## CI architecture — `.github/workflows/gates.yml`

PR-triggered (`master` + `staging`), `fetch-depth: 0`, `BASE=origin/${{ github.base_ref }}`. Four jobs:

- **(i) coupling-gates** — `scripts/ci/run-coupling-gates.ts` globs `.claude/gates/coupling/*.md`, parses frontmatter, and for each: arm if `git diff --name-only origin/$BASE...HEAD` matches any `trigger` glob; FAIL if any `requires` path is NOT in the changed set and the commit body lacks `escapeHatch`. Special non-changed-files sub-checks (PROTOCOL_VERSION integer must increase, asset `?v=` must increment) run as per-gate `assertScript` hooks. **Registry-driven** = the centerpiece that kills the "feature added but Nori not updated" class.
- **(ii) static-gates** — `scripts/ci/run-static-gates.ts` over `.claude/gates/static/*.md`: `banned` regex → fail on any hit (minus `allow`); `require` regex → fail if missing. Per-gate `block`/`warn` severity (noisy gates land soft, harden later). drei-Text via ESLint `no-restricted-imports` override (avoids "TextureLoader" false-positives); useFrame-alloc via ts-morph AST; secrets via gitleaks.
- **(iii) api-tests** — `bun install --frozen-lockfile` → build `@clawville/database` → Postgres service container + `DATABASE_URL` (so `describeIfDb` EXECUTES) → `cd apps/api && bun test`. Arms the entire existing money/cove/poker suite + the new route-level tests (holdem/baccarat board-leak, agent-CT parity, guest zero-write). Also add a turbo `test` task.
- **(iv) partner-harness** — `if:` protected-surface paths changed → run `apps/api/scripts/hatcher/selftest-e2e.ts` GREEN. Staging env (`CLAWVILLE_ENV=staging`, `ALLOW_TEST_PARTNER_PUBKEY`) as job-scoped secrets.

`.github/CODEOWNERS` gates partner/custody/schema/ledger/wager/contracts/gates/workflows paths to `@ItachiDevv`. Branch protection (via committed `gh api` recipe) on master+staging: require PR + CODEOWNERS review + required checks (`coupling-gates`, `static-gates`, `api-tests`, `rtp-monte-carlo`, conditional `partner-harness`) + up-to-date branch; block direct push (mechanically replaces the advisory "NEVER push directly to master"); dismiss stale approvals. `rtp-gate.yml` stays as-is.

## Rollout (leverage-ordered)

- **Phase 0 — arm the backstop:** api-tests job + turbo `test` task. Arms the already-written suite (max value, ~near-zero diff). Verify: flip a payout constant → test RED.
- **Phase 1 — flagship coupling runner + registry:** `.claude/gates/` scaffold + `run-coupling-gates.ts` + 14 coupling gate files (all FULL-mechanizable — docs are tracked). Verify: `cove-slots.ts` without `town-guide.ts` → RED with exact message.
- **Phase 2 — static bans (block-severity first):** ledger-write, db:push, dev-server, secrets, test-partner-env-guard, agpl/@payai, drei-Text. Verify: stray `.set({clawTokens})` → RED.
- **Phase 3 — branch protection + CODEOWNERS:** converts "no direct push to master" from prompt to mechanism. Verify: `git push origin master` rejected.
- **Phase 4 — partner harness + WRITE missing tests:** holdem/baccarat board-leak, route agent-CT parity, guest zero-write, baccarat floor-commission; selftest-e2e conditional job. Verify: `skill-protocol.ts` without PROTOCOL_VERSION++ → RED.
- **Phase 5 — WARN→BLOCK tail + advisory docs:** AST useFrame-alloc, instancedmesh+shader co-occurrence, mobile-useIsMobile, dark-text, secretKey-allowlist land as WARN; `advisory/quality-verbs.md` documents the un-mechanizable. Promote to BLOCK after the false-positive window.

Each phase's smallest visible diff is a single workflow job + the registry files it reads; reverting a phase = deleting that job + its gate files.